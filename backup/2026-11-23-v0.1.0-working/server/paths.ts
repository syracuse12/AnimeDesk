import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * Local application data lives under %APPDATA%\AnimeDesk unless an explicit
 * override is supplied (used by the automated tests).
 */
export function appDataDir(): string {
  const override = process.env.ANIMEDESK_DATA_DIR;
  if (override && override.trim()) return path.resolve(override.trim());

  const appData =
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'AnimeDesk');
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Resolve a user supplied local path without allowing environment expansion tricks. */
export function normalizeLocalPath(input: string): string {
  return path.resolve(input.trim());
}

export function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
