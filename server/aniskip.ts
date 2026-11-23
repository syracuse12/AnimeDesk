/**
 * Intro/outro skip timestamps.
 *
 * AniSkip is keyed by MyAnimeList id, which the hianime pages do not expose, so
 * a MAL id is resolved through AniList's title search first and cached. Nothing
 * is ever guessed: an unmatched title yields no timestamps at all.
 *
 * AniSkip *requires* an `episodeLength` query parameter — without it the API
 * answers 400 for every request. It is also matched against a tolerance, so the
 * duration has to be reported before a lookup is attempted, and the real
 * duration is validated again afterwards.
 */
import fs from 'node:fs/promises';
import { ANISKIP_BASE, LIMITS, paths } from './config.ts';
import { fetchJson } from './http.ts';
import { lookupMalId } from './anilist.ts';
import { ProviderError } from './providers/types.ts';
import type { SkipInfo, SkipRange } from '../shared/types.ts';
import { MAX_INTRO_START_FRACTION, MIN_OUTRO_START_FRACTION, type SkipKind } from '../shared/skip-timing.ts';

export { normalizeTitle, searchTitle, titlesMatch } from './titles.ts';

/** Shortest interval worth a button. */
export const MIN_SKIP_SECONDS = 3;
/** An intro this close to the end is useless to jump to. */
export const MIN_REMAINING_SECONDS = 2;

/** Shortest usable interval before the real duration is known. */
export const MIN_SKIP_SECONDS_UNKNOWN_DURATION = 1;

export interface SkipReport {
  skipType?: string;
  interval?: { startTime?: number | string; endTime?: number | string };
  episodeLength?: number;
}

interface AniSkipResponse {
  found?: boolean;
  results?: SkipReport[];
  statusCode?: number;
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

/** AniSkip sends some timestamps as strings; coerce without inventing values. */
function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return Number.NaN;
}

/**
 * Turn raw AniSkip reports into at most one intro and one outro, validated
 * against the real duration. Pure, so the rules are testable.
 *
 * With a known duration the range must fit inside the video. Without one it
 * only has to be ordered and at least a second long — the player re-validates
 * against the element's own duration before showing anything.
 */
export function pickRanges(
  reports: SkipReport[],
  duration: number | null,
): { intro: SkipRange | null; outro: SkipRange | null } {
  const known = typeof duration === 'number' && Number.isFinite(duration) && duration > 0;

  // Structural checks only: ordering, length and an end clamped into the file.
  // Which side of the episode a window belongs on is judged after the swap.
  const usable = (range: SkipRange | null): SkipRange | null => {
    if (!range) return null;
    const { start, end } = range;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end <= start) return null;
    if (known) {
      if (end - start < MIN_SKIP_SECONDS) return null;
      if (start >= duration - MIN_REMAINING_SECONDS) return null;
      return { start, end: Math.min(end, duration) };
    }
    if (end - start < MIN_SKIP_SECONDS_UNKNOWN_DURATION) return null;
    return { start, end };
  };

  // Some records are tagged `mixed-op`/`mixed-ed`; treat those as the type.
  const of = (type: string): SkipRange | null => {
    const matches = reports.filter((item) => item.skipType === type || item.skipType === `mixed-${type}`);
    let best: SkipRange | null = null;
    for (const report of matches) {
      const candidate = usable({ start: num(report.interval?.startTime), end: num(report.interval?.endTime) });
      if (candidate && (!best || candidate.end - candidate.start > best.end - best.start)) best = candidate;
    }
    return best;
  };

  let intro = of('op');
  let outro = of('ed');

  // A whole record is sometimes filed under the wrong type, so an opening that
  // starts after the ending is really the ending and vice versa.
  if (intro && outro && intro.start > outro.start) [intro, outro] = [outro, intro];

  // Whatever survives is re-checked against the side it now claims to be on, so
  // a lone window filed in the wrong half is dropped rather than mislabelled.
  const onSide = (range: SkipRange | null, kind: SkipKind): SkipRange | null => {
    if (!range || !known) return range;
    if (kind === 'intro' && range.start / duration >= MAX_INTRO_START_FRACTION) return null;
    if (kind === 'outro' && range.start / duration < MIN_OUTRO_START_FRACTION) return null;
    return range;
  };

  return { intro: onSide(intro, 'intro'), outro: onSide(outro, 'outro') };
}

/** Resolves MAL ids, caches AniSkip answers, stores manual ranges. */
export class SkipService {
  private manual = new Map<string, SkipRangeRecord>();
  private cache = new Map<string, SkipInfo>();
  private loaded = false;
  private writeQueue: Promise<unknown> = Promise.resolve();

  async load(): Promise<void> {
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
    return this.writeQueue.then(() => undefined);
  }

  /**
   * Skip info for one episode. Manual ranges always win; AniSkip is only asked
   * when enabled, a MAL id could be resolved and the duration is known.
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
      return { intro: manual.intro, outro: manual.outro, source: 'manual', malId: null, reason: 'ok' };
    }

    const empty = (reason: SkipInfo['reason'], malId: number | null = null): SkipInfo => ({
      intro: null,
      outro: null,
      source: 'none',
      malId,
      reason,
    });

    if (!params.enabled) return empty('disabled');

    const malId = await lookupMalId(params.title);
    if (!malId) return empty('no-mal-id');

    // AniSkip 400s without this, and matches it against a tolerance.
    const duration = params.duration && params.duration > 0 ? Math.round(params.duration) : null;
    if (!duration) return empty('no-duration', malId);

    const cacheKey = `${malId}:${params.episodeNumber}:${duration}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let body: AniSkipResponse;
    try {
      const query = new URLSearchParams({ types: 'op' });
      query.append('types', 'ed');
      query.set('episodeLength', String(duration));
      body = await fetchJson<AniSkipResponse>(
        `${ANISKIP_BASE}/skip-times/${malId}/${params.episodeNumber}?${query.toString()}`,
        { accept: 'application/json', timeoutMs: 12_000 },
      );
    } catch {
      // AniSkip answers 404 with a JSON body when it simply has no entry.
      return empty('lookup-failed', malId);
    }

    const picked = body.found ? pickRanges(body.results ?? [], duration) : { intro: null, outro: null };
    const info: SkipInfo = {
      intro: picked.intro,
      outro: picked.outro,
      source: picked.intro || picked.outro ? 'aniskip' : 'none',
      malId,
      reason: picked.intro || picked.outro ? 'ok' : 'no-data',
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