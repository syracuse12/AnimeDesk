import { LIMITS } from './config.ts';

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
  return url;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LIMITS.httpTimeoutMs);
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: options.accept ?? 'text/html,application/xhtml+xml',
    'accept-language': 'en-GB,en;q=0.9',
  };
  if (options.referer) headers.referer = options.referer;

  try {
    const response = await fetch(target, {
      headers,
      redirect: options.redirect ?? 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new FetchError(response.status, `Upstream returned HTTP ${response.status} for ${target.host}`);
    }
    if (!response.body) return '';

    const max = options.maxBytes ?? LIMITS.maxResponseBytes;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
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
    const reason = (error as Error).name === 'AbortError' ? 'timed out' : (error as Error).message;
    throw new FetchError(504, `Request to ${target.host} failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const body = await fetchText(url, { ...options, accept: 'application/json' });
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