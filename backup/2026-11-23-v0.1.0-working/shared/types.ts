/**
 * Types shared by the UI and the local AnimeDesk service.
 * Runtime free: both sides import this file safely.
 */

export type AudioMode = 'sub' | 'dub';

export type ProviderId = 'hianime' | 'archive' | 'local';

/**
 * How a session is rendered. `embedded` plays in the app window through the
 * local stream proxy; `external` is the bundled mpv window and the fallback
 * whenever the browser cannot decode or reach a source.
 */
export type PlaybackMode = 'embedded' | 'external';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  description: string;
  searchable: boolean;
  /** Licence / access note shown next to the provider name. */
  sourceNote: string;
  /** Non-empty when the provider needs local setup before it returns anything. */
  setupHint?: string;
}

export interface SearchResult {
  provider: ProviderId;
  id: string;
  title: string;
  year?: string;
  description?: string;
  coverUrl?: string;
  bannerUrl?: string;
  episodeCount?: number;
  audio: AudioMode[];
  badge?: string;
}

export interface Episode {
  number: number;
  label: string;
  title?: string;
  audio: AudioMode[];
}

export interface AnimeDetail extends SearchResult {
  episodes: Episode[];
  /** Audio modes actually offered by the provider for this series. */
  availableAudio: AudioMode[];
  sourceUrl?: string;
}

export interface StreamSource {
  /** Playable URL (HLS playlist or progressive file). */
  url: string;
  /** Referer the CDN requires, if any. */
  referer?: string;
  subtitleUrl?: string;
  /** Extra mpv arguments; never built from untrusted text. */
  extraArgs?: string[];
}

export type PlaybackState =
  | 'starting'
  | 'playing'
  | 'paused'
  | 'countdown'
  | 'ended'
  | 'error'
  | 'closed';

/** A single opening or ending skip window, in seconds. */
export interface SkipRange {
  start: number;
  end: number;
}

export interface SkipInfo {
  intro: SkipRange | null;
  outro: SkipRange | null;
  /** Where the numbers came from, so the UI can be honest about it. */
  source: 'aniskip' | 'manual' | 'none';
  /** MyAnimeList id used for the lookup, when one was matched. */
  malId: number | null;
}

export interface PlaybackSession {
  sessionId: string;
  provider: ProviderId;
  animeId: string;
  animeTitle: string;
  episodeNumber: number;
  episodeLabel: string;
  audio: AudioMode;
  state: PlaybackState;
  position: number;
  duration: number | null;
  paused: boolean;
  /** True once the source reported a real end of stream for this session. */
  completed: boolean;
  /** Next episode in the series, if there is one. */
  nextEpisode: { number: number; label: string } | null;
  previousEpisode: { number: number; label: string } | null;
  /** Epoch ms when the autoplay countdown fires, null when not counting down. */
  nextAt: number | null;
  mode: PlaybackMode;
  /** Same-origin proxied playlist for embedded playback, null when external. */
  streamUrl: string | null;
  /** Same-origin proxied subtitle track, when the source offered one. */
  subtitleUrl: string | null;
  /** Opening/ending windows for this episode, when any are known. */
  skips: SkipInfo | null;
  error?: string;
  startedAt: number;
}

export interface HistoryEntry {
  key: string;
  provider: ProviderId;
  animeId: string;
  animeTitle: string;
  coverUrl?: string;
  episodeNumber: number;
  episodeLabel: string;
  audio: AudioMode;
  positionSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
  updatedAt: number;
}

export interface Settings {
  preferredAudio: AudioMode;
  autoNext: boolean;
  autoNextDelaySeconds: number;
  quality: 'best' | '1080' | '720' | '480' | 'worst';
  localLibraryDir: string;
  mpvPath: string;
  resumePlayback: boolean;
  volume: number;
  /** Play inside the app window. Off means always use mpv. */
  embeddedPlayer: boolean;
  /** Automatic intro/outro skipping. Both default to off. */
  autoSkipIntro: boolean;
  autoSkipOutro: boolean;
  /** Allow AniSkip lookups at all. */
  aniskipEnabled: boolean;
  playbackRate: number;
}

export interface AppStatus {
  version: string;
  mpv: { available: boolean; path: string | null; version: string | null };
  dataDir: string;
  providers: ProviderInfo[];
  settings: Settings;
  platform: string;
  shell: 'app-window' | 'browser';
  /** True when the service can proxy streams for in-app playback. */
  embedded: boolean;
}

export interface PlayRequest {
  provider: ProviderId;
  animeId: string;
  episodeNumber: number;
  audio: AudioMode;
  startAt?: number;
  mode?: PlaybackMode;
}

export interface PlayResponse {
  session: PlaybackSession;
}

export interface DirectPlayRequest {
  title: string;
  url: string;
  audio: AudioMode;
  episodeNumber?: number;
  subtitleUrl?: string;
}

export interface HomeFeed {
  continueWatching: HistoryEntry[];
  recentlyWatched: HistoryEntry[];
  featured: AnimeDetail[];
  errors?: string[];
}

export interface ApiError {
  error: string;
  detail?: string;
}