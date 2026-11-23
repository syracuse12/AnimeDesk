/**
 * Internet Archive provider. The collection is not a rights filter: viewers
 * must check each item's licence and their own access rights before playback.
 */
import { cleanText, fetchJson, absoluteUrl } from '../http.ts';
import { LIMITS } from '../config.ts';
import type { AnimeDetail, Episode, SearchResult, StreamSource } from '../../shared/types.ts';
import { ProviderError, type Provider } from './types.ts';

const SEARCH = 'https://archive.org/advancedsearch.php';
const META = 'https://archive.org/metadata/';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

interface SearchDoc {
  identifier?: unknown;
  title?: unknown;
  year?: unknown;
  description?: unknown;
}

interface SearchResponse {
  response?: { docs?: SearchDoc[] };
}

interface ArchiveFile {
  name?: string;
  format?: string;
  size?: string;
}

interface MetadataResponse {
  metadata?: { title?: string; description?: string | string[]; year?: string };
  files?: ArchiveFile[];
}

function text(value: unknown, max = 300): string {
  if (value === null || value === undefined) return '';
  // Archive fields are inconsistent: strings, numbers and arrays all occur.
  const flat = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
  return cleanText(flat, max);
}

function videoFiles(meta: MetadataResponse): string[] {
  return (meta.files ?? [])
    .filter((file) => file.name && /\.(mp4|webm|ogv)$/i.test(file.name))
    .filter((file) => !/thumbs?\//i.test(file.name ?? ''))
    .map((file) => file.name as string)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

async function search(query: string): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const params = new URLSearchParams({
    q: `collection:(animationandcartoons) AND mediatype:(movies) AND (${trimmed})`,
    rows: '24',
    page: '1',
    output: 'json',
  });
  params.append('fl[]', 'identifier');
  params.append('fl[]', 'title');
  params.append('fl[]', 'year');
  params.append('fl[]', 'description');

  const body = await fetchJson<SearchResponse>(`${SEARCH}?${params.toString()}`);
  const docs = body.response?.docs ?? [];
  return docs
    .filter((doc): doc is SearchDoc & { identifier: string } =>
      typeof doc.identifier === 'string' && ID.test(doc.identifier),
    )
    .map((doc) => ({
      provider: 'archive' as const,
      id: doc.identifier,
      title: text(doc.title, 200) || doc.identifier,
      year: text(doc.year, 4) || undefined,
      description: text(doc.description, 240) || undefined,
      coverUrl: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
      audio: ['sub' as const],
      badge: 'Internet Archive',
    }));
}

async function detail(id: string): Promise<AnimeDetail> {
  if (!ID.test(id)) throw new ProviderError(400, `Invalid archive identifier: ${id}`);
  const meta = await fetchJson<MetadataResponse>(`${META}${encodeURIComponent(id)}`);
  const files = videoFiles(meta);
  if (!files.length) throw new ProviderError(404, 'This item has no playable video file');

  const episodes: Episode[] = files.map((file, index) => ({
    number: index + 1,
    label: file.replace(/\.[a-z0-9]+$/i, '').slice(0, 120),
    audio: ['sub'],
  }));

  return {
    provider: 'archive',
    id,
    title: text(meta.metadata?.title, 200) || id,
    description: text(meta.metadata?.description, LIMITS.maxDescriptionLength) || undefined,
    year: text(meta.metadata?.year, 4) || undefined,
    coverUrl: `https://archive.org/services/img/${encodeURIComponent(id)}`,
    episodes,
    episodeCount: episodes.length,
    audio: ['sub'],
    availableAudio: ['sub'],
    badge: 'Internet Archive',
    sourceUrl: `https://archive.org/details/${encodeURIComponent(id)}`,
  };
}

async function resolve(id: string, episodeNumber: number): Promise<StreamSource> {
  if (!ID.test(id)) throw new ProviderError(400, `Invalid archive identifier: ${id}`);
  const meta = await fetchJson<MetadataResponse>(`${META}${encodeURIComponent(id)}`);
  const file = videoFiles(meta)[episodeNumber - 1];
  if (!file) throw new ProviderError(404, `Episode ${episodeNumber} not found`);
  const url = absoluteUrl(
    `https://archive.org/download/${encodeURIComponent(id)}/${file.split('/').map(encodeURIComponent).join('/')}`,
    'https://archive.org/',
  );
  if (!url) throw new ProviderError(502, 'Could not build the archive download URL');
  return { url };
}

export const archiveProvider: Provider = {
  info: {
    id: 'archive',
    name: 'Internet Archive',
    description: 'Public-domain animation. No dub track, English subtitles only when the file has them.',
    searchable: true,
    sourceNote: 'Check each item’s rights before playback; archive.org collection membership is not a licence.',
  },
  search,
  detail,
  resolve,
  async ready() {
    try {
      await fetchJson(`${SEARCH}?q=collection:(animationandcartoons)&rows=1&output=json`, {
        timeoutMs: 8000,
      });
      return true;
    } catch {
      return false;
    }
  },
};
