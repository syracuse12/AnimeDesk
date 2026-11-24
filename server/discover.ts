/**
 * AniList-backed discovery.
 *
 * This is metadata only. AniList can say what a show *is*; it cannot say that a
 * provider will serve it. Every item therefore carries the title the UI should
 * search a provider for, and the catalogue remains the only place that decides
 * whether something is playable.
 *
 * Answers are cached with a bounded key count and a short expiry: discovery is
 * a browse surface, not a live feed, and AniList is a free API with a published
 * rate limit. Two things keep the free tier usable:
 *
 *  - rows and suggestions cache separately, because typing a six-letter title
 *    would otherwise evict the browse rows that the home screen is still showing;
 *  - a failed refresh serves the last good answer instead of blanking the row,
 *    so a 429 or a timeout degrades to stale content rather than to nothing.
 */
import { ANILIST_ENDPOINT, KITSU_ENDPOINT, LIMITS } from './config.ts';
import { FetchError, cleanText, fetchJson, readLimited, requestPublic, USER_AGENT } from './http.ts';
import { searchTitle } from './titles.ts';
import type { DiscoverItem, DiscoverKind } from '../shared/types.ts';

/** How long an answer counts as current. */
const TTL = 10 * 60_000;
/** How long a stale answer may still be served while refreshes keep failing. */
const STALE_TTL = 60 * 60_000;
const MAX_ROWS = 40;
const MAX_SUGGESTS = 120;
const MAX_ITEMS = 30;

interface Entry {
  at: number;
  items: DiscoverItem[];
}

/**
 * A small map with least-recently-used eviction.
 *
 * Reading refreshes a key's position, so a row the viewer keeps coming back to
 * survives a burst of one-shot suggestion terms. The previous version evicted
 * by insertion order, which meant every keystroke pushed out the oldest browse
 * row even when it was still on screen.
 */
class BoundedCache {
  private readonly map = new Map<string, Entry>();
  // Declared explicitly rather than as a constructor parameter property:
  // Node runs these files through strip-only type removal, which cannot emit one.
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  clear(): void {
    this.map.clear();
  }

  get(key: string): Entry | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, items: DiscoverItem[]): void {
    this.map.delete(key);
    this.map.set(key, { at: Date.now(), items });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

const rows = new BoundedCache(MAX_ROWS);
const suggestions = new BoundedCache(MAX_SUGGESTS);
/** One in-flight request per key, so rapid typing cannot stack upstream calls. */
const inflight = new Map<string, Promise<DiscoverItem[]>>();

/** Genres AniList publishes, in the order the catalogue offers them. */
export const GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mystery',
  'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
] as const;

export function isGenre(value: string): boolean {
  return (GENRES as readonly string[]).includes(value);
}

interface MediaNode {
  id?: number | null;
  title?: { romaji?: string | null; english?: string | null };
  coverImage?: { extraLarge?: string | null; large?: string | null };
  bannerImage?: string | null;
  description?: string | null;
  format?: string | null;
  episodes?: number | null;
  averageScore?: number | null;
  genres?: (string | null)[] | null;
  seasonYear?: number | null;
  status?: string | null;
}

interface GqlResponse {
  data?: { Page?: { media?: (MediaNode | null)[] | null } | null } | null;
  errors?: { message?: string }[] | null;
}

const FIELDS =
  'id title{romaji english} coverImage{extraLarge large} bannerImage description(asHtml:false) format episodes averageScore genres seasonYear status';

const QUERY =
  `query($page:Int,$perPage:Int,$sort:[MediaSort],$genre:String,$season:MediaSeason,$seasonYear:Int,$search:String){
     Page(page:$page,perPage:$perPage){
       media(type:ANIME,isAdult:false,sort:$sort,genre:$genre,season:$season,seasonYear:$seasonYear,search:$search){${FIELDS}}
     }
   }`;

/** Northern-hemisphere season names; AniList uses the same four words. */
export function currentSeason(now: Date): { season: string; year: number } {
  const month = now.getUTCMonth();
  const season = month <= 1 || month === 11 ? 'WINTER' : month <= 4 ? 'SPRING' : month <= 7 ? 'SUMMER' : 'FALL';
  // December belongs to the following winter cour.
  const year = month === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return { season, year };
}

async function post(variables: Record<string, unknown>): Promise<MediaNode[]> {
  if (ANILIST_ENDPOINT !== 'https://graphql.anilist.co') throw new FetchError(500, 'Invalid AniList endpoint');
  const body = JSON.stringify({ query: QUERY, variables });
  const { response } = await requestPublic(
    ANILIST_ENDPOINT,
    {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      accept: 'application/json',
      'user-agent': USER_AGENT,
    },
    12_000,
    { method: 'POST', body, redirect: 'reject', httpsOnly: true },
  );
  if (response.statusCode !== 200) {
    response.destroy();
    // 429 is worth its own word: the caller is being asked to slow down, and
    // the message reaches the viewer rather than a generic upstream failure.
    const status = response.statusCode === 429 ? 429 : 502;
    throw new FetchError(status, `AniList HTTP ${response.statusCode}`);
  }
  let parsed: GqlResponse;
  try {
    parsed = JSON.parse((await readLimited(response, 512 * 1024)).toString('utf8')) as GqlResponse;
  } catch {
    throw new FetchError(502, 'Invalid AniList JSON');
  }
  const media = parsed?.data?.Page?.media;
  if (!Array.isArray(media)) throw new FetchError(502, 'Malformed AniList response');
  return media.filter((item): item is MediaNode => Boolean(item) && typeof item === 'object');
}

function https(value: unknown): string | undefined {
  return typeof value === 'string' && /^https:\/\//.test(value) ? value : undefined;
}

/** AniList marks up descriptions with `<br>` and entities; flatten to prose. */
function synopsis(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = cleanText(value.replace(/<br\s*\/?>/gi, ' '), LIMITS.maxDescriptionLength);
  return text || undefined;
}

/**
 * Turn a media node into a discovery card. The English title is preferred for
 * display, and the title used to search a provider is the romaji one, which is
 * what the indexes are keyed on.
 */
export function toItem(node: MediaNode): DiscoverItem | null {
  const romaji = typeof node.title?.romaji === 'string' ? node.title.romaji.trim() : '';
  const english = typeof node.title?.english === 'string' ? node.title.english.trim() : '';
  const display = english || romaji;
  if (!display || display.length > 200) return null;
  const searchFor = searchTitle(romaji || english).slice(0, LIMITS.maxSearchLength) || display;
  const year = typeof node.seasonYear === 'number' && node.seasonYear > 1900 ? String(node.seasonYear) : undefined;
  const episodes = typeof node.episodes === 'number' && node.episodes > 0 ? node.episodes : undefined;
  const score = typeof node.averageScore === 'number' && node.averageScore > 0 ? node.averageScore : undefined;
  return {
    id: typeof node.id === 'number' ? String(node.id) : undefined,
    title: display.slice(0, 200),
    searchTitle: searchFor,
    coverUrl: https(node.coverImage?.extraLarge) ?? https(node.coverImage?.large),
    bannerUrl: https(node.bannerImage),
    description: synopsis(node.description),
    format: typeof node.format === 'string' ? node.format.replace(/_/g, ' ') : undefined,
    year,
    episodes,
    score,
    genres: (node.genres ?? []).filter((genre): genre is string => typeof genre === 'string').slice(0, 4),
    status: typeof node.status === 'string' ? node.status.replace(/_/g, ' ').toLowerCase() : undefined,
  };
}

interface KitsuNode {
  id?: string | null;
  attributes?: {
    canonicalTitle?: string | null;
    titles?: { en?: string | null; en_jp?: string | null; ja_jp?: string | null } | null;
    synopsis?: string | null;
    subtype?: string | null;
    episodeCount?: number | null;
    averageRating?: string | null;
    startDate?: string | null;
    status?: string | null;
    posterImage?: { large?: string | null; medium?: string | null } | null;
    coverImage?: { large?: string | null } | null;
  } | null;
}

interface KitsuResponse {
  data?: (KitsuNode | null)[] | null;
}

/** Same card shape, sourced from Kitsu's JSON:API payload. */
export function toKitsuItem(node: KitsuNode | null): DiscoverItem | null {
  const attrs = node?.attributes;
  if (!node) return null;
  const canonical = typeof attrs?.canonicalTitle === 'string' ? attrs.canonicalTitle.trim() : '';
  const english = typeof attrs?.titles?.en === 'string' ? attrs.titles.en.trim() : '';
  const romaji = typeof attrs?.titles?.en_jp === 'string' ? attrs.titles.en_jp.trim() : '';
  const display = english || canonical || romaji;
  if (!display || display.length > 200) return null;
  const searchFor = searchTitle(canonical || romaji || english).slice(0, LIMITS.maxSearchLength) || display;
  const rating = Number(attrs?.averageRating);
  const yearMatch = /^(\d{4})/.exec(attrs?.startDate ?? '');
  return {
    id: typeof node.id === 'string' ? node.id : undefined,
    title: display.slice(0, 200),
    searchTitle: searchFor,
    coverUrl: https(attrs?.posterImage?.large) ?? https(attrs?.posterImage?.medium),
    bannerUrl: https(attrs?.coverImage?.large),
    description: synopsis(attrs?.synopsis),
    format: typeof attrs?.subtype === 'string' ? attrs.subtype.replace(/_/g, ' ').toUpperCase() : undefined,
    year: yearMatch?.[1],
    episodes: typeof attrs?.episodeCount === 'number' && attrs.episodeCount > 0 ? attrs.episodeCount : undefined,
    score: Number.isFinite(rating) && rating > 0 ? Math.round(rating) : undefined,
    status: typeof attrs?.status === 'string' ? attrs.status.replace(/_/g, ' ').toLowerCase() : undefined,
  };
}

/**
 * The two upstream calls, behind one object so tests can swap them without a
 * module loader. Production never touches this.
 */
interface Transport {
  anilist: (variables: Record<string, unknown>) => Promise<MediaNode[]>;
  kitsu: (url: string) => Promise<KitsuResponse>;
}

let transport: Transport = {
  anilist: (variables) => post(variables),
  kitsu: (url) =>
    fetchJson<KitsuResponse>(url, {
      accept: 'application/vnd.api+json',
      timeoutMs: 12_000,
      maxBytes: 512 * 1024,
      httpsOnly: true,
    }),
};

export function __setTransport(next: Partial<Transport>): void {
  transport = { ...transport, ...next };
}

/** Drop every cached answer and in-flight entry. Tests only. */
export function __resetCache(): void {
  rows.clear();
  suggestions.clear();
  inflight.clear();
}

/**
 * Read through a cache: fresh answers are returned directly, and a failed
 * refresh falls back to a stale one. Nothing here retries; a retry storm is
 * worse than an hour-old row on a browse surface.
 */
async function cached(
  store: BoundedCache,
  key: string,
  load: () => Promise<DiscoverItem[]>,
): Promise<DiscoverItem[]> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.items;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      const items = await load();
      // Only cache a real answer; a transient failure should be retried next time.
      if (items.length) store.set(key, items);
      return items;
    } catch (error) {
      if (hit && Date.now() - hit.at < STALE_TTL) return hit.items;
      throw error;
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/**
 * Discovery rows. `kind` decides the ordering; an unknown kind degrades to
 * trending rather than failing, because a browse surface should still paint.
 */
export async function discover(kind: DiscoverKind, genre?: string): Promise<DiscoverItem[]> {
  const safeGenre = genre && isGenre(genre) ? genre : undefined;
  const effective: DiscoverKind = kind === 'genre' && !safeGenre ? 'trending' : kind;
  const key = `${effective}:${safeGenre ?? ''}`;

  return cached(rows, key, async () => {
    const variables: Record<string, unknown> = { page: 1, perPage: MAX_ITEMS };
    if (effective === 'genre' && safeGenre) {
      variables.sort = ['POPULARITY_DESC'];
      variables.genre = safeGenre;
    } else if (effective === 'seasonal') {
      const { season, year } = currentSeason(new Date());
      variables.sort = ['POPULARITY_DESC'];
      variables.season = season;
      variables.seasonYear = year;
    } else if (effective === 'top') {
      variables.sort = ['SCORE_DESC'];
    } else {
      variables.sort = ['TRENDING_DESC'];
    }

    const media = await transport.anilist(variables);
    return media
      .map(toItem)
      .filter((item): item is DiscoverItem => item !== null && Boolean(item.title))
      .slice(0, MAX_ITEMS);
  });
}

/**
 * Title suggestions for the search box.
 *
 * These come from Kitsu rather than AniList: AniList `search` only matches whole
 * words, so "frier" finds nothing until the token is complete, which is useless
 * while someone is still typing. Kitsu matches on a prefix.
 */
export async function suggest(term: string): Promise<DiscoverItem[]> {
  const trimmed = term.trim().slice(0, LIMITS.maxSearchLength);
  if (trimmed.length < 2) return [];
  const key = `suggest:${trimmed.toLowerCase()}`;
  if (KITSU_ENDPOINT !== 'https://kitsu.io/api/edge') throw new FetchError(500, 'Invalid Kitsu endpoint');

  return cached(suggestions, key, async () => {
    const url =
      `${KITSU_ENDPOINT}/anime?filter[text]=${encodeURIComponent(trimmed)}&page[limit]=6`;
    // Same guarded path as AniList: HTTPS-only, hard timeout, small body cap.
    const parsed = await transport.kitsu(url);
    return (parsed?.data ?? [])
      .map(toKitsuItem)
      .filter((item): item is DiscoverItem => item !== null)
      .slice(0, 6);
  });
}