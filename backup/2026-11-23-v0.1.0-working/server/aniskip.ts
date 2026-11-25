/**
 * Intro/outro skip timestamps.
 *
 * AniSkip is keyed by MyAnimeList id, which the hianime pages do not expose, so
 * a MAL id is resolved through AniList's title search first and cached. Nothing
 * is ever guessed: an unmatched title yields no timestamps at all.
 *
 * Every candidate interval is validated against the real video duration, so a
 * stale or wrong-length report cannot produce a button that seeks past the end.
 */
import fs from 'node:fs/promises';
import { ANILIST_ENDPOINT, ANISKIP_BASE, LIMITS, paths } from './config.ts';
import { USER_AGENT, fetchJson } from './http.ts';
import { ProviderError } from './providers/types.ts';
import type { SkipInfo, SkipRange } from '../shared/types.ts';

/** Minimum useful interval; anything shorter is noise. */
export const MIN_SKIP_SECONDS = 3;
/** An intro this close to the end is useless to jump to. */
export const MIN_REMAINING_SECONDS = 2;

export interface SkipReport {
  skipType?: string;
  interval?: { startTime?: number; endTime?: number };
  episodeLength?: number;
}

interface AniSkipResponse {
  found?: boolean;
  results?: SkipReport[];
  statusCode?: number;
}

interface AniListResponse {
  data?: { Page?: { media?: { idMal?: number | null; title?: { romaji?: string; english?: string }; format?: string }[] } };
}

/**
 * Reduce a title to comparable words: lowercase, no punctuation, no season or
 * part markers, single spaces. "Frieren: Beyond Journey's End" and
 * "Sousou no Frieren" do not normalise together, so matching also tries the
 * provider title verbatim.
 */
export function normalizeTitle(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(season|part|cour)\s*\d+\b/g, ' ')
    .replace(/\b(s\d+|\d+(st|nd|rd|th)\s+season)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the candidate title is the same show, not merely similar. */
export function titlesMatch(wanted: string, candidate: string): boolean {
  const a = normalizeTitle(wanted);
  const b = normalizeTitle(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  // One being a strict word-prefix of the other covers "Naruto" vs "Naruto
  // Shippuden" poorly, so require equal token counts for that case.
  const at = a.split(' ');
  const bt = b.split(' ');
  if (at.length === bt.length) return a.replace(/ /g, '') === b.replace(/ /g, '');
  return false;
}

/**
 * Turn raw AniSkip reports into at most one intro and one outro, validated
 * against the real duration. Pure, so the rules are testable.
 */
export function pickRanges(
  reports: SkipReport[],
  duration: number | null,
): { intro: SkipRange | null; outro: SkipRange | null } {
  const valid = (range: SkipRange | null): SkipRange | null => {
    if (!range) return null;
    const { start, end } = range;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end <= start) return null;
    if (end - start < MIN_SKIP_SECONDS) return null;
    if (duration && Number.isFinite(duration) && duration > 0) {
      if (start >= duration - MIN_REMAINING_SECONDS) return null;
      return { start, end: Math.min(end, duration) };
    }
    return { start, end };
  };

  const of = (type: string): SkipRange | null => {
    const report = reports.find((item) => item.skipType === type);
    if (!report?.interval) return null;
    const start = Number(report.interval.startTime);
    const end = Number(report.interval.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return valid({ start, end });
  };

  return { intro: of('op'), outro: of('ed') };
}

interface MalCache {
  entries: Record<string, number | null>;
}

export interface SkipRangeRecord {
  key: string;
  intro: SkipRange | null;
  outro: SkipRange | null;
  updatedAt: number;
}

interface SkipFile {
  entries: SkipRangeRecord[];
}

/** Resolves MAL ids, caches AniSkip answers, stores manual ranges. */
export class SkipService {
  private malCache = new Map<string, number | null>();
  private manual = new Map<string, SkipRangeRecord>();
  private cache = new Map<string, SkipInfo>();
  private loaded = false;
  private writeQueue: Promise<unknown> = Promise.resolve();

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(paths.malFile, 'utf8');
      const parsed = JSON.parse(raw) as MalCache;
      for (const [key, value] of Object.entries(parsed.entries ?? {})) {
        this.malCache.set(key, typeof value === 'number' ? value : null);
      }
    } catch {
      /* first run or unreadable: start empty */
    }
    try {
      const raw = await fs.readFile(paths.skipsFile, 'utf8');
      const parsed = JSON.parse(raw) as SkipFile;
      for (const record of parsed.entries ?? []) {
        if (record?.key) this.manual.set(record.key, record);
      }
    } catch {
      /* optional */
    }
    this.loaded = true;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  private persistManual(): Promise<void> {
    const entries = [...this.manual.values()].slice(0, LIMITS.maxSkipRanges);
    const snapshot = { entries };
    this.writeQueue = this.writeQueue
      .then(() => fs.writeFile(paths.skipsFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'))
      .catch(() => undefined);
    return this.writeQueue;
  }

  private persistMal(): Promise<void> {
    const entries = Object.fromEntries(this.malCache);
    const snapshot: MalCache = { entries };
    this.writeQueue = this.writeQueue
      .then(() => fs.writeFile(paths.malFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'))
      .catch(() => undefined);
    return this.writeQueue;
  }

  /**
   * Resolve a MAL id by exact title match against AniList. Only a confident
   * match is accepted; ambiguous titles stay null rather than risk the wrong
   * show's timestamps.
   */
  async resolveMalId(title: string): Promise<number | null> {
    const key = normalizeTitle(title);
    if (!key) return null;
    if (this.malCache.has(key)) return this.malCache.get(key) ?? null;

    let resolved: number | null = null;
    try {
      const body = await fetchJson<AniListResponse>(ANILIST_ENDPOINT, {
        accept: 'application/json',
        timeoutMs: 12_000,
      }).catch(async () => {
        // AniList needs a POST; fetchJson only does GET, so post directly.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12_000);
        try {
          const response = await fetch(ANILIST_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
            body: JSON.stringify({
              query:
                'query($s:String){Page(perPage:8){media(search:$s,type:ANIME){idMal title{romaji english} format}}}',
              variables: { s: title },
            }),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`AniList HTTP ${response.status}`);
          return (await response.json()) as AniListResponse;
        } finally {
          clearTimeout(timer);
        }
      });

      const media = body.data?.Page?.media ?? [];
      const hit = media.find((item) => {
        if (!item.idMal) return false;
        const names = [item.title?.romaji, item.title?.english].filter(Boolean) as string[];
        return names.some((name) => titlesMatch(title, name));
      });
      resolved = hit?.idMal ?? null;
    } catch {
      return null; // do not cache transport failures
    }

    this.malCache.set(key, resolved);
    void this.persistMal();
    return resolved;
  }

  /**
   * Skip info for one episode. Manual ranges always win; AniSkip is only asked
   * when enabled and a MAL id could be resolved.
   */
  async forEpisode(params: {
    key: string;
    title: string;
    episodeNumber: number;
    duration: number | null;
    enabled: boolean;
  }): Promise<SkipInfo> {
    const manual = this.manual.get(params.key);
    if (manual && (manual.intro || manual.outro)) {
      return { intro: manual.intro, outro: manual.outro, source: 'manual', malId: null };
    }

    const empty: SkipInfo = { intro: null, outro: null, source: 'none', malId: null };
    if (!params.enabled) return empty;

    const malId = await this.resolveMalId(params.title);
    if (!malId) return empty;

    const cacheKey = `${malId}:${params.episodeNumber}:${params.duration ? Math.round(params.duration) : 0}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let body: AniSkipResponse;
    try {
      const query = new URLSearchParams({ types: 'op' });
      query.append('types', 'ed');
      if (params.duration && params.duration > 0) {
        query.set('episodeLength', String(Math.round(params.duration)));
      }
      body = await fetchJson<AniSkipResponse>(
        `${ANISKIP_BASE}/skip-times/${malId}/${params.episodeNumber}?${query.toString()}`,
        { accept: 'application/json', timeoutMs: 12_000 },
      );
    } catch {
      return { ...empty, malId };
    }

    const picked = body.found ? pickRanges(body.results ?? [], params.duration) : { intro: null, outro: null };
    const info: SkipInfo = {
      intro: picked.intro,
      outro: picked.outro,
      source: picked.intro || picked.outro ? 'aniskip' : 'none',
      malId,
    };

    if (this.cache.size >= LIMITS.maxSkipCache) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, info);
    return info;
  }

  getManual(key: string): SkipRangeRecord | null {
    return this.manual.get(key) ?? null;
  }

  /** Save a manual range. `null` for both clears the entry. */
  async setManual(key: string, intro: SkipRange | null, outro: SkipRange | null): Promise<SkipRangeRecord | null> {
    if (!key) throw new ProviderError(400, 'A skip key is required');
    if (!intro && !outro) {
      this.manual.delete(key);
      await this.persistManual();
      return null;
    }
    const clean = (range: SkipRange | null): SkipRange | null => {
      if (!range) return null;
      const start = Math.max(0, Number(range.start));
      const end = Math.max(0, Number(range.end));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new ProviderError(400, 'A skip range needs a finite start below its end');
      }
      return { start, end };
    };
    const record: SkipRangeRecord = {
      key,
      intro: clean(intro),
      outro: clean(outro),
      updatedAt: Date.now(),
    };
    this.manual.set(key, record);
    await this.persistManual();
    return record;
  }
}

export const skips = new SkipService();