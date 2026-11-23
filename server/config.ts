import { appDataDir } from './paths.ts';
import type { Settings } from '../shared/types.ts';

export interface Paths {
  dataDir: string;
  settingsFile: string;
  historyFile: string;
  skipsFile: string;
  malFile: string;
  tempDir: string;
}

export const paths: Paths = (() => {
  const dataDir = process.env.ANIMEDESK_PROFILE === 'distribution' ? `${appDataDir()}\\distribution` : appDataDir();
  return {
    dataDir,
    settingsFile: `${dataDir}\\settings.json`,
    historyFile: `${dataDir}\\history.json`,
    skipsFile: `${dataDir}\\skips.json`,
    malFile: `${dataDir}\\mal.json`,
    tempDir: `${dataDir}\\tmp`,
  };
})();

export const DEFAULT_SETTINGS: Settings = {
  preferredAudio: 'sub',
  autoNext: true,
  autoNextDelaySeconds: 5,
  quality: 'best',
  localLibraryDir: '',
  mpvPath: '',
  resumePlayback: true,
  volume: 100,
  embeddedPlayer: true,
  autoSkipIntro: false,
  autoSkipOutro: false,
  aniskipEnabled: true,
  playbackRate: 1,
};

export const LIMITS = {
  maxSearchLength: 120,
  maxHistory: 500,
  maxLibraryFiles: 5000,
  maxLibraryDepth: 4,
  maxDescriptionLength: 1200,
  maxEpisodeNumber: 10000,
  maxAutoNextDelay: 60,
  /** Per-request upstream ceiling. */
  httpTimeoutMs: 20_000,
  /** Hard cap on a single upstream HTML/JSON body. */
  maxResponseBytes: 6 * 1024 * 1024,
  /** mpv start-up watchdog. */
  playerStartTimeoutMs: 25_000,
  /**
   * Concurrent stream-proxy tokens kept alive before the oldest is dropped.
   * A long episode playlist alone can mint several hundred, and the subtitle
   * track must survive that, so this is sized for a whole episode plus slack.
   */
  maxStreamTokens: 6000,
  /** AniSkip answer cache entries. */
  maxSkipCache: 400,
  /** Manual skip ranges stored per episode. */
  maxSkipRanges: 2000,
  maxPlaybackRate: 3,
} as const;

export const VERSION = '0.2.4';

/** Providers are separated so the UI can label and gate them honestly. */
export const PROVIDER_TIMEOUT = 25_000;

/** AniSkip is a free community API; identify the client politely. */
export const ANISKIP_BASE = 'https://api.aniskip.com/v2';
export const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
