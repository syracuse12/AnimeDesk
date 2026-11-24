import { LIMITS } from './config.ts';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/** A stable desktop browser UA; the source pages serve plain HTML to it. */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class FetchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Reject anything that is not a plain http(s) URL. */
export function assertHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FetchError(400, `Not a valid URL: ${input.slice(0, 200)}`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new FetchError(400, `Unsupported protocol ${url.protocol}`);
  }
  if (url.username || url.password) throw new FetchError(400, 'URL credentials are not allowed');
  return url;
}

const blockedV4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new net.BlockList();
for (const [address, prefix] of [['2001:db8::', 32], ['2001::', 32], ['2002::', 16]] as const) {
  blockedV6.addSubnet(address, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family === 6) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  return false;
}

async function lookupWithTimeout(hostname: string, timeoutMs: number): Promise<Array<{ address: string; family: number }>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FetchError(504, 'DNS lookup timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolve each hop, reject non-public addresses, and pin the checked address to the socket. */
export async function requestPublic(
  input: string,
  headers: Record<string, string> = {},
  timeoutMs: number = LIMITS.httpTimeoutMs,
  options: { method?: 'GET' | 'POST'; body?: string; redirect?: 'follow' | 'reject'; httpsOnly?: boolean } = {},
): Promise<{ response: http.IncomingMessage; finalUrl: string }> {
  let url = assertHttpUrl(input);
  const deadline = Date.now() + timeoutMs;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FetchError(504, 'Upstream request timed out');
    if (options.httpsOnly && (url.protocol !== 'https:' || (url.port && url.port !== '443'))) {
      throw new FetchError(403, 'HTTPS on the standard port is required');
    }
    const literal = net.isIP(url.hostname.replace(/^\[|\]$/g, ''));
    const addresses = literal
      ? [{ address: url.hostname.replace(/^\[|\]$/g, ''), family: literal }]
      : await lookupWithTimeout(url.hostname, remaining);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new FetchError(403, 'Stream destination is not a public Internet address');
    }
    const chosen = addresses[0]!;
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const requestOptions = {
        method: options.method ?? 'GET',
        headers,
        lookup: (_hostname: string, options: { all?: boolean }, callback: (error: null, address: string | typeof addresses, family?: number) => void) => {
          if (options.all) callback(null, [chosen]);
          else callback(null, chosen.address, chosen.family);
        },
      };
      const req = options.method === 'POST'
        ? transport.request(url, requestOptions, resolve)
        : transport.get(url, requestOptions, resolve);
      const timer = setTimeout(() => req.destroy(new Error('timed out')), Math.max(1, deadline - Date.now()));
      req.on('error', (error) => { clearTimeout(timer); reject(error); });
      req.on('response', (res) => res.on('close', () => clearTimeout(timer)));
      if (options.method === 'POST') req.end(options.body);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const location = response.headers.location;
      response.destroy();
      if (options.redirect === 'reject' || options.method === 'POST') throw new FetchError(502, 'Unexpected upstream redirect');
      if (!location) throw new FetchError(502, 'Redirect has no location');
      url = assertHttpUrl(new URL(location, url).toString());
      continue;
    }
    return { response, finalUrl: url.toString() };
  }
  throw new FetchError(502, 'Too many stream redirects');
}

/** Read a bounded upstream body; callers validate its media type and structure. */
export async function readLimited(response: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of response) {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      response.destroy();
      throw new FetchError(413, 'Upstream response exceeded size limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export interface FetchOptions {
  referer?: string;
  timeoutMs?: number;
  accept?: string;
  maxBytes?: number;
  redirect?: 'follow' | 'manual';
}

/**
 * Fetch text with a hard timeout and a byte ceiling so a hostile or broken
 * upstream cannot exhaust memory. Redirects are followed but re-validated.
 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const target = assertHttpUrl(url);
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: options.accept ?? 'text/html,application/xhtml+xml',
    'accept-language': 'en-GB,en;q=0.9',
  };
  if (options.referer) headers.referer = options.referer;

  try {
    const { response } = await requestPublic(target.toString(), headers, options.timeoutMs);
    if ((response.statusCode ?? 500) >= 400) {
      response.destroy();
      throw new FetchError(response.statusCode ?? 502, `Upstream returned HTTP ${response.statusCode} for ${target.host}`);
    }

    const max = options.maxBytes ?? LIMITS.maxResponseBytes;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const value of response) {
      total += value.byteLength;
      if (total > max) {
        response.destroy();
        throw new FetchError(413, `Response from ${target.host} exceeded ${max} bytes`);
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(merged);
  } catch (error) {
    if (error instanceof FetchError) throw error;
    const reason = (error as Error).message;
    throw new FetchError(504, `Request to ${target.host} failed: ${reason}`);
  }
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  // Keep a caller's media type: Kitsu rejects application/json with a 406.
  const body = await fetchText(url, { ...options, accept: options.accept ?? 'application/json' });
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new FetchError(502, `Invalid JSON from ${assertHttpUrl(url).host}`);
  }
}

/** Collapse whitespace and decode the handful of entities these pages emit. */
export function cleanText(input: string, maxLength = 500): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** Resolve a possibly relative URL against a base, returning null on failure. */
export function absoluteUrl(candidate: string, base: string): string | null {
  try {
    const url = new URL(candidate.trim(), base);
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return '';
  }
}
