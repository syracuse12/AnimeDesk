/**
 * AniList metadata: MyAnimeList ids for AniSkip and real cover artwork.
 *
 * AniList's GraphQL endpoint only answers POST, and a GET returns 404, so the
 * request is always a POST. Answers are cached per normalised title, including
 * negative answers, so a dead title is not re-queried for every request.
 */
import { ANILIST_ENDPOINT, LIMITS } from './config.ts';
import { cleanText, FetchError, readLimited, requestPublic, USER_AGENT } from './http.ts';
import { normalizeTitle, searchTitle, titlesMatch } from './titles.ts';

export interface AniListMedia {
  idMal?: number | null;
  title?: { romaji?: string; english?: string };
  format?: string;
  description?: string;
  startDate?: { year?: number | null };
  coverImage?: { extraLarge?: string; large?: string };
  bannerImage?: string;
}

interface AniListResponse {
  data?: { Page?: { media?: AniListMedia[] } };
}

export interface Artwork {
  coverUrl?: string;
  bannerUrl?: string;
  description?: string;
  year?: string;
}

const cache = new Map<string, AniListMedia | null>();
const ART_CACHE = 500;

const QUERY =
  'query($s:String){Page(perPage:8){media(search:$s,type:ANIME){idMal title{romaji english} format description startDate{year} coverImage{extraLarge large} bannerImage}}}';

async function post(search: string): Promise<AniListMedia[]> {
  // The endpoint is fixed in config. Never accept a provider-supplied URL.
  if (ANILIST_ENDPOINT !== 'https://graphql.anilist.co') throw new FetchError(500, 'Invalid AniList endpoint');
  const body = JSON.stringify({ query: QUERY, variables: { s: search.slice(0, LIMITS.maxSearchLength) } });
  const { response } = await requestPublic(ANILIST_ENDPOINT, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    accept: 'application/json',
    'user-agent': USER_AGENT,
  }, 12_000, { method: 'POST', body, redirect: 'reject', httpsOnly: true });
  if (response.statusCode !== 200) {
    response.destroy();
    throw new FetchError(502, `AniList HTTP ${response.statusCode}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse((await readLimited(response, 512 * 1024)).toString('utf8')); }
  catch { throw new FetchError(502, 'Invalid AniList JSON'); }
  const media = (parsed as AniListResponse | null)?.data?.Page?.media;
  if (!Array.isArray(media)) throw new FetchError(502, 'Malformed AniList response');
  return media.filter((item): item is AniListMedia =>
    item !== null && typeof item === 'object' &&
    item.title !== null && typeof item.title === 'object' &&
    [item.title.romaji, item.title.english].some((name) => typeof name === 'string') &&
    (item.idMal === undefined || item.idMal === null || (Number.isInteger(item.idMal) && item.idMal > 0))
  ).slice(0, 8);
}

/**
 * Best confident AniList entry for a title. Romaji and English names are both
 * compared, and only a real title match is accepted so a wrong show's
 * timestamps or artwork cannot leak in.
 */
export async function lookupMedia(title: string): Promise<AniListMedia | null> {
  const key = normalizeTitle(title);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key) ?? null;

  let hit: AniListMedia | null = null;
  try {
    // Search the bare title: AniList does not tokenise a release qualifier away,
    // so "...(TV)" finds nothing while the bare title finds the show. The match
    // below still runs against the original title.
    const media = await post(searchTitle(title) || title);
    hit =
      media.find((item) => {
        const names = [item.title?.romaji, item.title?.english].filter((name): name is string => typeof name === 'string');
        return names.some((name) => titlesMatch(title, name));
      }) ?? null;
  } catch {
    return null; // transport failures are not cached
  }

  if (cache.size >= ART_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, hit);
  return hit;
}

/** MyAnimeList id, or null when the title could not be matched confidently. */
export async function lookupMalId(title: string): Promise<number | null> {
  const media = await lookupMedia(title);
  return typeof media?.idMal === 'number' ? media.idMal : null;
}

/** Cover/banner artwork plus any metadata AniList has that the page lacked. */
export async function lookupArtwork(title: string): Promise<Artwork> {
  const media = await lookupMedia(title);
  if (!media) return {};
  const cover = media.coverImage?.extraLarge ?? media.coverImage?.large;
  const year = media.startDate?.year;
  return {
    coverUrl: typeof cover === 'string' && /^https:\/\//.test(cover) ? cover : undefined,
    bannerUrl: typeof media.bannerImage === 'string' && /^https:\/\//.test(media.bannerImage) ? media.bannerImage : undefined,
    description: typeof media.description === 'string' ? cleanText(media.description, LIMITS.maxDescriptionLength) : undefined,
    year: typeof year === 'number' && year > 1900 ? String(year) : undefined,
  };
}
