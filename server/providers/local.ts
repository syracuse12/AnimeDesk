/**
 * Local library provider: a folder of video files, grouped into series by
 * sub-folder. Metadata is honest — it is whatever the file names say.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from '../config.ts';
import { isDirectory } from '../paths.ts';
import { mintFileToken } from '../proxy.ts';
import type { AnimeDetail, Episode, SearchResult, StreamSource } from '../../shared/types.ts';
import { ProviderError, type Provider } from './types.ts';

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v']);

/** Sidecar artwork names, in preference order, next to the episodes. */
const COVER_NAMES = ['cover.png', 'cover.jpg', 'cover.jpeg', 'cover.webp', 'poster.png', 'poster.jpg'];

/**
 * The local provider has no metadata service, so a cover is only ever a sidecar
 * file the viewer dropped in the folder. Absent one, the UI keeps its initials
 * fallback rather than inventing art.
 */
async function coverFor(dir: string): Promise<string | undefined> {
  for (const name of COVER_NAMES) {
    const candidate = path.join(dir, name);
    try {
      const stat = await fs.lstat(candidate);
      // A bare token is not a URL; the card needs the full proxy route.
      if (stat.isFile() && stat.size > 0) return `/api/stream/${mintFileToken(candidate)}`;
    } catch {
      /* try the next name */
    }
  }
  return undefined;
}

let rootDir = '';

export function setLibraryDir(dir: string): void {
  rootDir = dir;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

function encodeId(relative: string): string {
  return Buffer.from(relative, 'utf8').toString('base64url');
}

function decodeId(id: string): string {
  const relative = Buffer.from(id, 'base64url').toString('utf8');
  if (!relative || relative.includes('..')) {
    // Fall through: resolve + prefix check below is the real guard.
  }
  return relative;
}

/** Resolve a library-relative path and refuse anything outside the root. */
async function safeJoin(relative: string): Promise<string> {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new ProviderError(400, 'Library path escapes the configured folder');
  }
  // A caller can supply a base64 ID for a symlinked folder that discovery
  // never listed. Check the actual target as well as the lexical path.
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new ProviderError(400, 'Library path escapes the configured folder');
  }
  return target;
}

interface WalkResult {
  relativeDir: string;
  files: string[];
}

async function walk(dir: string, depth: number, budget: { left: number }): Promise<WalkResult[]> {
  const groups: WalkResult[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return groups;
  }

  const files: string[] = [];
  const dirs: string[] = [];
  for (const entry of entries) {
    if (budget.left <= 0) break;
    if (entry.isDirectory()) dirs.push(entry.name);
    else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
      files.push(entry.name);
      budget.left -= 1;
    }
  }

  if (files.length) {
    groups.push({ relativeDir: path.relative(rootDir, dir), files: files.sort(naturalCompare) });
  }
  if (depth < LIMITS.maxLibraryDepth) {
    for (const name of dirs.sort(naturalCompare)) {
      if (budget.left <= 0) break;
      groups.push(...(await walk(path.join(dir, name), depth + 1, budget)));
    }
  }
  return groups;
}

async function collect(): Promise<WalkResult[]> {
  if (!rootDir || !isDirectory(rootDir)) {
    throw new ProviderError(400, 'No local library folder is configured');
  }
  return walk(rootDir, 0, { left: LIMITS.maxLibraryFiles });
}

async function toResult(group: WalkResult): Promise<SearchResult> {
  const name = path.basename(group.relativeDir) || path.basename(rootDir) || 'Library';
  const dir = path.join(rootDir, group.relativeDir);
  return {
    provider: 'local',
    id: encodeId(group.relativeDir),
    title: name,
    episodeCount: group.files.length,
    audio: ['sub', 'dub'],
    badge: 'Local file',
    coverUrl: await coverFor(dir),
  };
}

async function search(query: string): Promise<SearchResult[]> {
  const needle = query.trim().toLowerCase();
  const groups = await collect();
  const results = await Promise.all(groups.map(toResult));
  return results
    .filter((result) => !needle || result.title.toLowerCase().includes(needle))
    .slice(0, 60);
}

async function detail(id: string): Promise<AnimeDetail> {
  const relative = decodeId(id);
  const dir = await safeJoin(relative);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort(naturalCompare);
  if (!files.length) throw new ProviderError(404, 'No video files in this folder');

  const episodes: Episode[] = files.map((file, index) => ({
    number: index + 1,
    label: path.basename(file, path.extname(file)),
    audio: ['sub', 'dub'],
  }));

  return {
    provider: 'local',
    id,
    title: path.basename(dir),
    episodes,
    episodeCount: episodes.length,
    audio: ['sub', 'dub'],
    availableAudio: ['sub', 'dub'],
    badge: 'Local file',
    coverUrl: await coverFor(dir),
    description: 'Files read from the local library folder. Dub/sub labels reflect the file only.',
  };
}

async function resolve(id: string, episodeNumber: number): Promise<StreamSource> {
  const dir = await safeJoin(decodeId(id));
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort(naturalCompare);
  const file = files[episodeNumber - 1];
  if (!file) throw new ProviderError(404, `Episode ${episodeNumber} not found on disk`);
  return { url: path.join(dir, file) };
}

export const localProvider: Provider = {
  info: {
    id: 'local',
    name: 'Local library',
    description: 'Your own video folder, grouped one series per sub-folder.',
    searchable: true,
    sourceNote: 'Nothing leaves the machine.',
    setupHint: 'Set a library folder in Settings.',
  },
  search,
  detail,
  resolve,
  async ready() {
    return Boolean(rootDir) && isDirectory(rootDir);
  },
};
