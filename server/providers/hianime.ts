/**
 * hianime provider — the same public HTML endpoints ani-cli uses, reimplemented
 * in TypeScript so the desktop app does not shell out.
 *
 * Discovery, metadata and stream resolution are separate methods. Nothing here
 * touches playback; a broken CDN cannot break search.
 */
import { cleanText, fetchText, FetchError, absoluteUrl } from '../http.ts';
import { LIMITS } from '../config.ts';
import { lookupArtwork } from '../anilist.ts';
import type { AnimeDetail, AudioMode, Episode, SearchResult, StreamSource } from '../../shared/types.ts';
import { ProviderError, type Provider } from './types.ts';

const BASE = 'https://hianime.at';
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

/**
 * The embed page ships base64(json XOR "otaku-embed-v1") where each byte is then
 * re-encoded the way printf's octal escape would render it. Replicate that
 * exactly: add the transform, mask to a byte, then read the digits as octal and
 * keep any trailing non-octal digits literally (printf stops at '8'/'9').
 */
const KEY = Buffer.from('otaku-embed-v1', 'utf8');

export function deobfuscate(blob: string): string {
  const raw = Buffer.from(blob, 'base64');
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const byte = (raw[i] ?? 0) ^ (KEY[i % KEY.length] ?? 0);
    const value = (byte + 2 * Math.floor(byte / 8) + 20 * Math.floor(byte / 64)) & 0xff;
    const digits = String(value);
    let consumed = 0;
    let octal = '';
    while (consumed < digits.length && consumed < 3) {
      const char = digits[consumed] as string;
      if (char < '0' || char > '7') break;
      octal += char;
      consumed += 1;
    }
    out += String.fromCharCode(octal ? parseInt(octal, 8) : 0);
    out += digits.slice(consumed);
  }
  return out;
}

/** Episode/servers endpoints return backslash-escaped JSON-in-HTML. */
function unescapeHtmlJson(body: string): string {
  return body.split('\\').join('');
}

function numericIdFromSlug(slug: string): string {
  const match = slug.match(/-([0-9]+)$/);
  return match?.[1] ?? '';
}

function assertSlug(id: string): string {
  if (!SLUG.test(id)) throw new ProviderError(400, `Invalid anime id: ${id.slice(0, 60)}`);
  return id;
}

/** "Sub | Dub" style availability strings from the search cards. */
function parseAudio(html: string): AudioMode[] {
  const audio: AudioMode[] = [];
  if (/\bdub\b/i.test(html)) audio.push('dub');
  if (/\bsub\b/i.test(html)) audio.push('sub');
  return audio.length ? audio : ['sub'];
}

/**
 * Search cards put the poster `<img>` before the title block, and its `src`
 * precedes the `class` attribute, so both are captured in one ordered pattern
 * instead of assuming attribute order.
 */
async function search(query: string): Promise<SearchResult[]> {
  const url = `${BASE}/search?keyword=${encodeURIComponent(query)}`;
  const page = await fetchText(url);
  if (/<title>Just a moment/i.test(page)) {
    throw new ProviderError(503, 'hianime is behind a browser challenge right now');
  }
  // The top-ten sidebar repeats the card markup; cut it before matching.
  const main = page.split('id="main-sidebar"')[0] ?? page;
  const results: SearchResult[] = [];
  const pattern =
    /<img[^>]*?src="([^"]+)"[^>]*?class="film-poster-img"[^>]*>[\s\S]{0,1200}?<h3 class="film-name">\s*<a href="[^"]*\/([a-z0-9][a-z0-9-]*)"\s+title="([^"]*)"/g;
  for (const match of main.matchAll(pattern)) {
    const slug = match[2];
    if (!slug || results.length >= 40) continue;
    const title = cleanText(match[3] ?? '', 200);
    if (!title) continue;
    results.push({
      provider: 'hianime',
      id: slug,
      title,
      coverUrl: absoluteUrl(match[1] ?? '', BASE) ?? undefined,
      audio: parseAudio(match[0]),
      badge: 'Streaming',
    });
  }
  await fillMissingCovers(results);
  return results;
}

/**
 * Cards sometimes ship a thumbnail that 404s. Any result still without a cover
 * is topped up from AniList, a few at a time so a search stays one round trip
 * rather than forty parallel requests.
 */
async function fillMissingCovers(results: SearchResult[]): Promise<void> {
  const missing = results.filter((result) => !result.coverUrl);
  for (let index = 0; index < missing.length; index += 6) {
    await Promise.allSettled(
      missing.slice(index, index + 6).map(async (result) => {
        const art = await lookupArtwork(result.title).catch(() => null);
        if (art?.coverUrl) result.coverUrl = art.coverUrl;
      }),
    );
  }
}

/**
 * Read the series title from a detail page. The heading carries extra classes
 * and a `data-jname` romaji attribute; the romaji is preferred because it is
 * what the AniSkip index is keyed on. Returns null when there is no heading.
 */
export function titleFromPage(page: string): string | null {
  const heading = page.match(/<h2 class="film-name[^"]*"[^>]*data-jname="([^"]*)"[^>]*>([\s\S]*?)<\/h2>/);
  if (heading) {
    const romaji = cleanText(heading[1] ?? '', 200);
    if (romaji) return romaji;
    const shown = cleanText(heading[2] ?? '', 200);
    if (shown) return shown;
  }
  const plain = cleanText(page.match(/<h2 class="film-name[^"]*"[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? '', 200);
  return plain || null;
}

async function detail(id: string): Promise<AnimeDetail> {
  assertSlug(id);
  const [page, episodes] = await Promise.all([fetchText(`${BASE}/${id}`), listEpisodes(id)]);

  // A slug is readable but wrong for lookups, so it is only the last resort.
  const title = titleFromPage(page) ?? id;
  const description = cleanText(
    page.match(/<div class="film-description[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? '',
    LIMITS.maxDescriptionLength,
  );
  const year = cleanText(page.match(/<span class="item">\s*<span[^>]*>[^<]*<\/span>\s*([0-9]{4})/)?.[1] ?? '', 4);

  const audio: AudioMode[] = [];
  if (episodes.some((episode) => episode.audio.includes('dub'))) audio.push('dub');
  audio.push('sub');

  // The poster block is the one piece of metadata the page can be missing or
  // broken on. AniList is the fallback, and it also fills in a description or
  // year the page left out. Its answers are matched on title, never guessed.
  const scraped = coverFromPage(page);
  const art = scraped ? null : await lookupArtwork(title).catch(() => null);

  return {
    provider: 'hianime',
    id,
    title,
    year: year || art?.year,
    description: description || art?.description,
    coverUrl: scraped ?? art?.coverUrl,
    bannerUrl: art?.bannerUrl,
    audio,
    availableAudio: audio,
    badge: 'Streaming',
    episodes,
    episodeCount: episodes.length,
    sourceUrl: `${BASE}/${id}`,
  };
}

/**
 * Poster from a detail page. The `src` attribute sits before `class` in the
 * current markup, which the old class-first pattern could never match, so the
 * image is located by its class and its source read out separately.
 */
export function coverFromPage(page: string): string | null {
  const tag = page.match(/<img[^>]*class="film-poster-img"[^>]*>/)?.[0] ?? '';
  const src = tag.match(/src="([^"]+)"/)?.[1] ?? '';
  return src ? absoluteUrl(src, BASE) : null;
}

async function listEpisodes(id: string): Promise<Episode[]> {
  const numeric = numericIdFromSlug(id);
  if (!numeric) throw new ProviderError(404, `Could not derive episode id from ${id}`);

  const body = unescapeHtmlJson(await fetchText(`${BASE}/api/theme/episode/list/${numeric}`));
  const episodes: Episode[] = [];
  const pattern = /data-number="([^"]*)"[\s\S]{0,120}?data-id="([0-9]+)"/g;
  for (const match of body.matchAll(pattern)) {
    const number = Number(match[1]);
    if (!Number.isFinite(number) || episodes.length >= LIMITS.maxEpisodeNumber) continue;
    episodes.push({
      number,
      label: `Episode ${match[1]}`,
      audio: ['sub', 'dub'],
    });
  }
  if (!episodes.length) throw new ProviderError(404, 'No episodes published for this series yet');
  episodes.sort((a, b) => a.number - b.number);
  return episodes;
}

interface ServerEntry {
  audio: AudioMode;
  name: string;
  hash: string;
}

async function listServers(episodeId: string): Promise<ServerEntry[]> {
  const body = unescapeHtmlJson(
    await fetchText(`${BASE}/api/theme/episode/servers?episodeId=${encodeURIComponent(episodeId)}`),
  );
  const entries: ServerEntry[] = [];
  const pattern = /data-type="(sub|dub)"[\s\S]{0,80}?data-server-name="([^"]*)"[\s\S]{0,60}?data-hash="([^"]*)"/g;
  for (const match of body.matchAll(pattern)) {
    entries.push({
      audio: match[1] as AudioMode,
      name: cleanText(match[2] ?? '', 40),
      hash: match[3] ?? '',
    });
  }
  return entries;
}

/** Pick the requested quality out of a master playlist. */
async function pickVariant(masterUrl: string, referer: string, quality: string): Promise<string> {
  const playlist = await fetchText(masterUrl, { referer, accept: 'application/vnd.apple.mpegurl' });
  const base = masterUrl.slice(0, masterUrl.lastIndexOf('/') + 1);

  const variants: { height: number; url: string }[] = [];
  const lines = playlist.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? '';
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    if (/EXT-X-I-FRAME/.test(line)) continue;
    const height = Number(line.match(/RESOLUTION=\d+x(\d+)/)?.[1] ?? 0);
    const next = lines[i + 1]?.trim() ?? '';
    if (!next || next.startsWith('#')) continue;
    const url = absoluteUrl(next, base);
    if (url) variants.push({ height, url });
  }
  if (!variants.length) return masterUrl;

  variants.sort((a, b) => b.height - a.height);
  if (quality === 'worst') return variants[variants.length - 1]?.url ?? masterUrl;
  if (quality === 'best') return variants[0]?.url ?? masterUrl;
  const wanted = Number(quality);
  return variants.find((variant) => variant.height === wanted)?.url ?? variants[0]?.url ?? masterUrl;
}

async function resolve(
  id: string,
  episodeNumber: number,
  audio: AudioMode,
  quality: 'best' | '1080' | '720' | '480' | 'worst' = 'best',
): Promise<StreamSource> {
  assertSlug(id);
  const episodes = await listEpisodes(id);
  const episode = episodes.find((item) => item.number === episodeNumber);
  if (!episode) throw new ProviderError(404, `Episode ${episodeNumber} does not exist`);

  const numeric = numericIdFromSlug(id);
  const body = unescapeHtmlJson(await fetchText(`${BASE}/api/theme/episode/list/${numeric}`));
  const episodeId = [...body.matchAll(/data-number="([^"]*)"[\s\S]{0,120}?data-id="([0-9]+)"/g)].find(
    (match) => Number(match[1]) === episodeNumber,
  )?.[2];
  if (!episodeId) throw new ProviderError(404, `Episode ${episodeNumber} has no source id`);

  const servers = await listServers(episodeId);
  const usable = servers.filter((server) => server.hash && server.audio === audio);
  // Only the ZokoAnime embed is understood; others use different players.
  const ordered = [
    ...usable.filter((server) => server.name === 'ZokoAnime'),
    ...usable.filter((server) => server.name !== 'ZokoAnime'),
  ];

  let lastError: Error | null = null;
  for (const server of ordered) {
    const embed = Buffer.from(server.hash, 'base64').toString('utf8');
    if (!/^https?:\/\//.test(embed)) continue;
    const referer = `${new URL(embed).origin}/`;
    try {
      const page = await fetchText(embed, { referer });
      const blob = page.match(/window\.__P="([^"]*)"/)?.[1];
      if (!blob) continue;

      const json = deobfuscate(blob);
      const master = json.match(/"src":"([^"]*?\.m3u8[^"]*)"/)?.[1];
      if (!master) continue;
      const masterUrl = absoluteUrl(master, referer);
      if (!masterUrl) continue;

      const subtitle = json.match(/"subtitles":\[[\s\S]*?"src":"([^"]*?\.vtt[^"]*)"/)?.[1];
      const url = await pickVariant(masterUrl, referer, quality);
      return {
        url,
        referer,
        subtitleUrl: subtitle ? (absoluteUrl(subtitle, referer) ?? undefined) : undefined,
      };
    } catch (error) {
      lastError = error as Error;
    }
  }

  const suffix = audio === 'dub' ? 'dubbed' : 'subtitled';
  throw new ProviderError(
    404,
    lastError instanceof FetchError
      ? `No ${suffix} source could be resolved (${lastError.message})`
      : `No ${suffix} source available for episode ${episodeNumber}`,
  );
}

export const hianimeProvider: Provider = {
  info: {
    id: 'hianime',
    name: 'hianime',
    description: 'Large catalogue with sub and dub audio, resolved through the public site.',
    searchable: true,
    sourceNote: 'Third-party streaming index. hianime.at terms apply.',
  },
  search,
  detail,
  resolve,
  async ready() {
    try {
      await fetchText(`${BASE}/search?keyword=test`, { timeoutMs: 8000 });
      return true;
    } catch {
      return false;
    }
  },
};