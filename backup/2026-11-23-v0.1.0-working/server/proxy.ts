/**
 * Local stream proxy.
 *
 * The hianime CDN answers 403 unless the request carries the embed page as its
 * Referer, and a browser <video>/hls.js request cannot set Referer across
 * origins. So the service fetches upstream with the right headers and re-serves
 * everything from 127.0.0.1. Playlists are rewritten so hls.js only ever talks
 * to us.
 *
 * Tokens are opaque and validated, so the proxy never becomes an open fetcher.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS } from './config.ts';
import { USER_AGENT, assertHttpUrl } from './http.ts';
import { ProviderError } from './providers/types.ts';

interface Token {
  kind: 'http' | 'file';
  /** Upstream URL for http tokens, absolute path for file tokens. */
  target: string;
  referer?: string;
  touched: number;
}

const TOKEN_RE = /^[a-f0-9]{20}$/;

const tokens = new Map<string, Token>();

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

/** Mint (or reuse) a token for a URL. Reuse keeps playlist rewrites stable. */
export function mintUrlToken(url: string, referer?: string): string {
  const target = assertHttpUrl(url).toString();
  const key = digest(`http\u0000${target}\u0000${referer ?? ''}`);
  const existing = tokens.get(key);
  if (existing) {
    existing.touched = Date.now();
    return key;
  }
  if (tokens.size >= LIMITS.maxStreamTokens) evictOldest();
  tokens.set(key, { kind: 'http', target, referer, touched: Date.now() });
  return key;
}

/** Mint a token for a file inside the local library. */
export function mintFileToken(absPath: string): string {
  const resolved = path.resolve(absPath);
  const key = digest(`file\u0000${resolved}`);
  if (tokens.has(key)) return key;
  if (tokens.size >= LIMITS.maxStreamTokens) evictOldest();
  tokens.set(key, { kind: 'file', target: resolved, touched: Date.now() });
  return key;
}

function evictOldest(): void {
  let oldestKey: string | null = null;
  let oldest = Infinity;
  for (const [key, token] of tokens) {
    if (token.touched < oldest) {
      oldest = token.touched;
      oldestKey = key;
    }
  }
  if (oldestKey) tokens.delete(oldestKey);
}

function requireToken(raw: string): Token {
  if (!TOKEN_RE.test(raw)) throw new ProviderError(400, 'Malformed stream token');
  const token = tokens.get(raw);
  if (!token) throw new ProviderError(404, 'Stream token expired; reload the episode');
  token.touched = Date.now();
  return token;
}

/** Re-point a playlist line at the proxy, resolving relative URIs first. */
function rewriteTarget(candidate: string, base: string, referer: string | undefined): string | null {
  try {
    const absolute = new URL(candidate.trim(), base);
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return null;
    return `/api/stream/${mintUrlToken(absolute.toString(), referer)}`;
  } catch {
    return null;
  }
}

const URI_ATTR = /URI="([^"]*)"/g;

/** Rewrite a whole HLS playlist so every child resource comes back through us. */
export function rewritePlaylist(body: string, base: string, referer: string | undefined): string {
  return body
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // Key and init-section URIs are the only attributes we must follow.
        return line.replace(URI_ATTR, (match, uri: string) => {
          const mapped = rewriteTarget(uri, base, referer);
          return mapped ? `URI="${mapped}"` : match;
        });
      }
      return rewriteTarget(trimmed, base, referer) ?? line;
    })
    .join('\n');
}

function isPlaylist(contentType: string, url: string): boolean {
  return (
    /mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(url)
  );
}

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified'] as const;

/** Serve a token. Streams the body through; never buffers whole media. */
export async function serveStream(
  rawToken: string,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const token = requireToken(rawToken);

  if (token.kind === 'file') {
    serveFile(token.target, req, res);
    return;
  }

  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: '*/*',
    'accept-language': 'en-GB,en;q=0.9',
  };
  if (token.referer) headers.referer = token.referer;
  if (typeof req.headers.range === 'string') headers.range = req.headers.range;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let upstream: Response;
  try {
    upstream = await fetch(token.target, { headers, signal: controller.signal, redirect: 'follow' });
  } catch (error) {
    clearTimeout(timer);
    const reason = (error as Error).name === 'AbortError' ? 'timed out' : (error as Error).message;
    throw new ProviderError(502, `Stream fetch failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    throw new ProviderError(502, `Upstream stream returned HTTP ${upstream.status}`);
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';

  if (isPlaylist(contentType, token.target)) {
    const body = rewritePlaylist(await upstream.text(), token.target, token.referer);
    res.writeHead(200, {
      'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(body);
    return;
  }

  const out: Record<string, string> = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }

  res.writeHead(upstream.status === 206 ? 206 : 200, out);
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } catch {
    /* client hung up or upstream stalled mid-segment */
  } finally {
    res.end();
  }
}

const FILE_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.vtt': 'text/vtt; charset=utf-8',
};

/** Range-aware static serving for the local library, so seeking works. */
function serveFile(
  target: string,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new ProviderError(404, 'Local file is gone');
  }
  if (!stat.isFile()) throw new ProviderError(404, 'Not a file');

  const type = FILE_MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;

  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (start <= end && start < stat.size) {
        res.writeHead(206, {
          'content-type': type,
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${stat.size}`,
          'accept-ranges': 'bytes',
          'access-control-allow-origin': '*',
        });
        fs.createReadStream(target, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
  });
  fs.createReadStream(target).pipe(res);
}

/** Public helper: the proxy URL the UI should hand to hls.js. */
export function streamUrlFor(source: { url: string; referer?: string }): string {
  if (/^[a-zA-Z]:\\|^\\\\/.test(source.url)) {
    return `/api/stream/${mintFileToken(source.url)}`;
  }
  return `/api/stream/${mintUrlToken(source.url, source.referer)}`;
}