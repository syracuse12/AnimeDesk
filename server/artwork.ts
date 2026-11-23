import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import net from 'node:net';
import { FetchError, assertHttpUrl, isPublicAddress, readLimited, requestPublic } from './http.ts';

const MAX_TOKENS = 1000;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_CACHE = 32 * 1024 * 1024;
const TTL = 30 * 60_000;
const sources = new Map<string, { url: string; at: number }>();
const reverse = new Map<string, string>();
const images = new Map<string, { body: Buffer; type: string; at: number }>();
let cacheBytes = 0;

/** Only server-discovered image URLs receive opaque, short-lived route tokens. */
export function artworkUrl(source?: string): string | undefined {
  if (!source || source.startsWith('/api/stream/')) return source;
  if (process.env.ANIMEDESK_PROFILE === 'distribution') return undefined;
  let url: URL;
  try { url = assertHttpUrl(source); } catch { return undefined; }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || source.length > 2048) return undefined;
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal) && !isPublicAddress(literal)) return undefined;
  const existing = reverse.get(url.href);
  if (existing && sources.has(existing)) return `/api/artwork/${existing}`;
  const token = randomBytes(24).toString('base64url');
  sources.set(token, { url: url.href, at: Date.now() });
  reverse.set(url.href, token);
  while (sources.size > MAX_TOKENS) {
    const first = sources.keys().next().value as string;
    const old = sources.get(first);
    if (old) reverse.delete(old.url);
    sources.delete(first);
  }
  return `/api/artwork/${token}`;
}

function imageType(body: Buffer): string | null {
  if (body.length >= 3 && body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (body.length >= 6 && ['GIF87a', 'GIF89a'].includes(body.toString('ascii', 0, 6))) return 'image/gif';
  if (body.length >= 12 && body.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(body.toString('ascii', 8, 12))) return 'image/avif';
  return null;
}

function putImage(token: string, body: Buffer, type: string): void {
  while (cacheBytes + body.length > MAX_CACHE && images.size) {
    const first = images.keys().next().value as string;
    cacheBytes -= images.get(first)!.body.length;
    images.delete(first);
  }
  images.set(token, { body, type, at: Date.now() });
  cacheBytes += body.length;
}

export async function serveArtwork(token: string, res: http.ServerResponse): Promise<void> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new FetchError(404, 'Artwork unavailable');
  const source = sources.get(token);
  if (!source || Date.now() - source.at > TTL) throw new FetchError(404, 'Artwork unavailable');
  let cached = images.get(token);
  if (cached && Date.now() - cached.at > TTL) {
    cacheBytes -= cached.body.length;
    images.delete(token);
    cached = undefined;
  }
  if (!cached) {
    const { response } = await requestPublic(source.url, { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif', 'user-agent': 'AnimeDesk/0.2.4' }, 8_000, { httpsOnly: true });
    if (response.statusCode !== 200) {
      response.destroy();
      throw new FetchError(502, 'Artwork source unavailable');
    }
    const contentLength = Number(response.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE) {
      response.destroy();
      throw new FetchError(413, 'Artwork exceeds size limit');
    }
    const body = await readLimited(response, MAX_IMAGE);
    const type = imageType(body);
    if (!type) throw new FetchError(415, 'Unsupported artwork content');
    putImage(token, body, type);
    cached = { body, type, at: Date.now() };
  }
  res.writeHead(200, {
    'content-type': cached.type,
    'content-length': cached.body.length,
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  res.end(cached.body);
}
