import fs from 'node:fs/promises';
import { DEFAULT_SETTINGS, LIMITS, paths } from './config.ts';
import { ensureDir } from './paths.ts';
import type { HistoryEntry, Settings } from '../shared/types.ts';

interface SettingsFile {
  settings: Settings;
}

interface HistoryFile {
  entries: HistoryEntry[];
}

const QUALITIES: Settings['quality'][] = ['best', '1080', '720', '480', 'worst'];

function cloneDefaults(): Settings {
  return { ...DEFAULT_SETTINGS };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    // A corrupt file must not take the app down; park a copy and start clean.
    try {
      await fs.rename(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* ignore */
    }
    return null;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  ensureDir(paths.dataDir);
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

/** Serialised writes keep settings/history consistent under concurrent requests. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class Store {
  private settings: Settings = cloneDefaults();
  private history: HistoryEntry[] = [];
  private loaded = false;
  private settingsMutex = new Mutex();
  private historyMutex = new Mutex();

  async load(): Promise<void> {
    ensureDir(paths.dataDir);
    const settingsFile = await readJson<SettingsFile>(paths.settingsFile);
    if (settingsFile?.settings && typeof settingsFile.settings === 'object') {
      this.settings = sanitizeSettings(settingsFile.settings as unknown as Record<string, unknown>);
    } else {
      this.settings = cloneDefaults();
    }

    const historyFile = await readJson<HistoryFile>(paths.historyFile);
    if (Array.isArray(historyFile?.entries)) {
      this.history = historyFile.entries.filter(isHistoryEntry).slice(0, LIMITS.maxHistory);
    }
    this.loaded = true;
  }

  getSettings(): Settings {
    return { ...this.settings };
  }

  async updateSettings(patch: Record<string, unknown>): Promise<Settings> {
    return this.settingsMutex.run(async () => {
      const next = sanitizeSettings({ ...this.settings, ...patch });
      this.settings = next;
      await writeJsonAtomic(paths.settingsFile, { settings: next });
      return { ...next };
    });
  }

  getHistory(): HistoryEntry[] {
    return [...this.history].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getHistoryEntry(key: string): HistoryEntry | undefined {
    return this.history.find((entry) => entry.key === key);
  }

  /** Most recent entry for a series, used for resume + "continue watching". */
  getSeriesEntry(provider: string, animeId: string): HistoryEntry | undefined {
    return this.history
      .filter((entry) => entry.provider === provider && entry.animeId === animeId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  async upsertHistory(entry: HistoryEntry): Promise<void> {
    return this.historyMutex.run(async () => {
      const index = this.history.findIndex((item) => item.key === entry.key);
      if (index >= 0) this.history.splice(index, 1);
      this.history.unshift(entry);
      if (this.history.length > LIMITS.maxHistory) {
        this.history.length = LIMITS.maxHistory;
      }
      await writeJsonAtomic(paths.historyFile, { entries: this.history });
    });
  }

  async removeHistory(key: string): Promise<boolean> {
    return this.historyMutex.run(async () => {
      const before = this.history.length;
      this.history = this.history.filter((item) => item.key !== key);
      if (this.history.length === before) return false;
      await writeJsonAtomic(paths.historyFile, { entries: this.history });
      return true;
    });
  }

  async clearHistory(): Promise<void> {
    return this.historyMutex.run(async () => {
      this.history = [];
      await writeJsonAtomic(paths.historyFile, { entries: [] });
    });
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

function sanitizeSettings(input: Record<string, unknown>): Settings {
  const settings = cloneDefaults();

  if (input.preferredAudio === 'dub' || input.preferredAudio === 'sub') {
    settings.preferredAudio = input.preferredAudio;
  }
  if (typeof input.autoNext === 'boolean') settings.autoNext = input.autoNext;
  if (typeof input.resumePlayback === 'boolean') settings.resumePlayback = input.resumePlayback;
  if (input.quality && QUALITIES.includes(input.quality as Settings['quality'])) {
    settings.quality = input.quality as Settings['quality'];
  }
  if (typeof input.autoNextDelaySeconds === 'number' && Number.isFinite(input.autoNextDelaySeconds)) {
    settings.autoNextDelaySeconds = Math.min(
      LIMITS.maxAutoNextDelay,
      Math.max(0, Math.round(input.autoNextDelaySeconds)),
    );
  }
  if (typeof input.volume === 'number' && Number.isFinite(input.volume)) {
    settings.volume = Math.min(130, Math.max(0, Math.round(input.volume)));
  }
  if (typeof input.localLibraryDir === 'string') {
    settings.localLibraryDir = input.localLibraryDir.trim().slice(0, 1000);
  }
  if (typeof input.mpvPath === 'string') {
    settings.mpvPath = input.mpvPath.trim().slice(0, 1000);
  }
  return settings;
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.key === 'string' &&
    typeof entry.animeId === 'string' &&
    typeof entry.animeTitle === 'string' &&
    typeof entry.episodeNumber === 'number' &&
    (entry.audio === 'sub' || entry.audio === 'dub') &&
    typeof entry.updatedAt === 'number'
  );
}

export const store = new Store();