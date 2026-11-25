/**
 * Local library provider: a folder of video files, grouped into series by
 * sub-folder. Metadata is honest — it is whatever the file names say.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from '../config.ts';
import { isDirectory } from '../paths.ts';
import type { AnimeDetail, Episode, SearchResult, StreamSource } from '../../shared/types.ts';
import { ProviderError, type Provider } from './types.ts';

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v']);

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
function safeJoin(relative: string): string {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
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

function toResult(group: WalkResult): SearchResult {
  const name = path.basename(group.relativeDir) || path.basename(rootDir) || 'Library';
  return {
    provider: 'local',
    id: encodeId(group.relativeDir),
    title: name,
    episodeCount: group.files.length,
    audio: ['sub', 'dub'],
    badge: 'Local file',
  };
}

async function search(query: string): Promise<SearchResult[]> {
  const needle = query.trim().toLowerCase();
  const groups = await collect();
  return groups
    .map(toResult)
    .filter((result) => !needle || result.title.toLowerCase().includes(needle))
    .slice(0, 60);
}

async function detail(id: string): Promise<AnimeDetail> {
  const relative = decodeId(id);
  const dir = safeJoin(relative);
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
    description: 'Files read from the local library folder. Dub/sub labels reflect the file only.',
  };
}

async function resolve(id: string, episodeNumber: number): Promise<StreamSource> {
  const dir = safeJoin(decodeId(id));
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