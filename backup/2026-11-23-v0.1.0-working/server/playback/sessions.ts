import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getProvider } from '../providers/index.ts';
import { ProviderError } from '../providers/types.ts';
import { MpvPlayer } from '../player/mpv.ts';
import { store } from '../store.ts';
import type {
  AudioMode,
  HistoryEntry,
  PlaybackSession,
  PlayRequest,
} from '../../shared/types.ts';

interface Internal {
  session: PlaybackSession;
  player: MpvPlayer;
  countdown: NodeJS.Timeout | null;
  lastSaved: number;
  stopped: boolean;
}

interface BeginParams {
  provider: PlaybackSession['provider'];
  animeId: string;
  animeTitle: string;
  episodeNumber: number;
  episodeLabel: string;
  audio: AudioMode;
  url: string;
  referer?: string;
  subtitleUrl?: string;
  extraArgs?: string[];
  startAt: number;
  volume: number;
  nextEpisode?: { number: number; label: string } | null;
  previousEpisode?: { number: number; label: string } | null;
}

/**
 * Owns the lifetime of every playback. Autoplay is driven by mpv's real
 * `end-file`/`eof` event; the configured delay is only a countdown before the
 * next spawn, never an estimate of when the episode finishes.
 */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, Internal>();
  private mpvPath: string | null;

  constructor(mpvPath: string | null) {
    super();
    this.mpvPath = mpvPath;
  }

  setMpvPath(path: string | null): void {
    this.mpvPath = path;
  }

  setVolume(volume: number): void {
    for (const item of this.sessions.values()) item.player.setVolume(volume);
  }

  get(sessionId: string): PlaybackSession | null {
    const item = this.sessions.get(sessionId);
    return item ? { ...item.session } : null;
  }

  list(): PlaybackSession[] {
    return [...this.sessions.values()].map((item) => ({ ...item.session }));
  }

  private publish(item: Internal): void {
    this.emit('session', { ...item.session });
  }

  /** Resolve through a provider, then hand off to the shared launcher. */
  async start(request: PlayRequest): Promise<PlaybackSession> {
    if (!this.mpvPath) throw new ProviderError(500, 'mpv was not found; run `npm run setup:mpv`');
    const provider = getProvider(request.provider);

    const detail = await provider.detail(request.animeId);
    const episode = detail.episodes.find((item) => item.number === request.episodeNumber);
    if (!episode) throw new ProviderError(404, `Episode ${request.episodeNumber} does not exist`);

    // Never claim a dub the provider does not actually offer.
    const audio: AudioMode = detail.availableAudio.includes(request.audio)
      ? request.audio
      : (detail.availableAudio[0] ?? 'sub');

    const stream = await provider.resolve(request.animeId, episode.number, audio);

    const index = detail.episodes.findIndex((item) => item.number === episode.number);
    const next = index >= 0 ? detail.episodes[index + 1] : undefined;
    const previous = index > 0 ? detail.episodes[index - 1] : undefined;

    const settings = store.getSettings();
    let startAt = request.startAt ?? 0;
    if (!request.startAt && settings.resumePlayback) {
      const saved = store.getHistoryEntry(
        this.historyKey(request.provider, request.animeId, episode.number, audio),
      );
      if (saved && !saved.completed && saved.positionSeconds > 30) startAt = saved.positionSeconds;
    }

    return this.begin({
      provider: request.provider,
      animeId: request.animeId,
      animeTitle: detail.title,
      episodeNumber: episode.number,
      episodeLabel: episode.label,
      audio,
      url: stream.url,
      referer: stream.referer,
      subtitleUrl: stream.subtitleUrl,
      extraArgs: stream.extraArgs,
      startAt,
      volume: settings.volume,
      nextEpisode: next ? { number: next.number, label: next.label } : null,
      previousEpisode: previous ? { number: previous.number, label: previous.label } : null,
    });
  }

  /** Play a raw URL with no provider behind it. */
  async startDirect(params: Omit<BeginParams, 'startAt'> & { startAt?: number }): Promise<PlaybackSession> {
    if (!this.mpvPath) throw new ProviderError(500, 'mpv was not found; run `npm run setup:mpv`');
    return this.begin({ ...params, startAt: params.startAt ?? 0, nextEpisode: null, previousEpisode: null });
  }

  private async begin(params: BeginParams): Promise<PlaybackSession> {
    if (!this.mpvPath) throw new ProviderError(500, 'mpv was not found');
    await this.stopAll();

    const session: PlaybackSession = {
      sessionId: randomUUID(),
      provider: params.provider,
      animeId: params.animeId,
      animeTitle: params.animeTitle,
      episodeNumber: params.episodeNumber,
      episodeLabel: params.episodeLabel,
      audio: params.audio,
      state: 'starting',
      position: params.startAt,
      duration: null,
      paused: false,
      completed: false,
      nextEpisode: params.nextEpisode ?? null,
      previousEpisode: params.previousEpisode ?? null,
      nextAt: null,
      startedAt: Date.now(),
    };

    const player = new MpvPlayer(this.mpvPath);
    const item: Internal = { session, player, countdown: null, lastSaved: 0, stopped: false };
    this.sessions.set(session.sessionId, item);
    this.publish(item);

    player.on('loaded', (duration: unknown) => {
      item.session.duration = typeof duration === 'number' && duration > 0 ? duration : null;
      item.session.state = 'playing';
      this.publish(item);
      void this.saveHistory(item);
    });

    player.on('property', (name: string, value: unknown) => {
      if (name === 'time-pos' && typeof value === 'number') {
        item.session.position = value;
        const now = Date.now();
        if (now - item.lastSaved > 5000) {
          item.lastSaved = now;
          void this.saveHistory(item);
        }
        this.publish(item);
      } else if (name === 'pause' && typeof value === 'boolean') {
        item.session.paused = value;
        if (item.session.state !== 'countdown' && item.session.state !== 'ended') {
          item.session.state = value ? 'paused' : 'playing';
        }
        this.publish(item);
      } else if (name === 'duration' && typeof value === 'number') {
        item.session.duration = value;
      }
    });

    player.on('end', (reason: string) => {
      if (reason === 'eof') void this.onEnded(item);
    });
    player.on('exit', () => void this.onExit(item));
    player.on('failed', (message: string) => {
      item.session.state = 'error';
      item.session.error = message;
      this.publish(item);
    });

    try {
      await player.open({
        url: params.url,
        referer: params.referer,
        subtitleUrl: params.subtitleUrl,
        extraArgs: params.extraArgs,
        title: `${params.animeTitle} - ${params.episodeLabel}`,
        startAt: params.startAt,
        volume: params.volume,
      });
    } catch (error) {
      item.session.state = 'error';
      item.session.error = (error as Error).message;
      this.publish(item);
      player.close();
      throw error;
    }

    return { ...session };
  }

  private async onEnded(item: Internal): Promise<void> {
    if (item.stopped) return;
    item.session.completed = true;
    item.session.position = item.session.duration ?? item.session.position;

    // Decide the next state synchronously: mpv exits the moment the file ends,
    // so an await here would let onExit see a non-countdown state and tear the
    // session down before the timer is even scheduled.
    const settings = store.getSettings();
    const next = item.session.nextEpisode;
    if (settings.autoNext && next) {
      const delay = Math.max(0, settings.autoNextDelaySeconds) * 1000;
      item.session.state = 'countdown';
      item.session.nextAt = Date.now() + delay;
      this.publish(item);
      item.countdown = setTimeout(() => {
        item.countdown = null;
        void this.advance(item, next.number).catch((error) => {
          item.session.state = 'error';
          item.session.error = (error as Error).message;
          this.publish(item);
        });
      }, delay);
    } else {
      item.session.state = 'ended';
      this.publish(item);
    }

    await this.saveHistory(item, true);
  }

  private async onExit(item: Internal): Promise<void> {
    // A pending autoplay countdown must outlive the mpv process that just
    // exited; the timer owns the hand-off to the next episode.
    const waiting = item.session.state === 'countdown';
    if (!waiting) {
      if (item.countdown) {
        clearTimeout(item.countdown);
        item.countdown = null;
      }
      if (item.session.state !== 'error') {
        item.session.state = item.session.completed ? 'ended' : 'closed';
      }
      this.sessions.delete(item.session.sessionId);
    }
    await this.saveHistory(item, item.session.completed);
    this.publish(item);
  }

  async advance(item: Internal, episodeNumber: number): Promise<void> {
    // Retire the old record first so the session list only shows what is live,
    // whichever path triggered the hand-off.
    this.sessions.delete(item.session.sessionId);
    const next = await this.start({
      provider: item.session.provider,
      animeId: item.session.animeId,
      episodeNumber,
      audio: item.session.audio,
    });
    this.emit('advanced', { from: item.session.sessionId, to: next.sessionId });
  }

  private clearCountdown(item: Internal): void {
    if (item.countdown) {
      clearTimeout(item.countdown);
      item.countdown = null;
    }
    item.session.nextAt = null;
  }

  async action(sessionId: string, action: string, value?: number): Promise<PlaybackSession | null> {
    const item = this.sessions.get(sessionId);
    if (!item) return null;

    switch (action) {
      case 'pause':
        item.player.setPaused(true);
        break;
      case 'resume':
        item.player.setPaused(false);
        break;
      case 'seek':
        if (typeof value === 'number' && Number.isFinite(value)) {
          item.player.seek(value);
          item.session.position = Math.max(0, value);
        }
        break;
      case 'volume':
        if (typeof value === 'number' && Number.isFinite(value)) item.player.setVolume(value);
        break;
      case 'fullscreen':
        item.player.setFullscreen(true);
        break;
      case 'windowed':
        item.player.setFullscreen(false);
        break;
      case 'skipCountdown':
        if (item.countdown && item.session.nextEpisode) {
          this.clearCountdown(item);
          await this.advance(item, item.session.nextEpisode.number);
          return null;
        }
        break;
      case 'next':
        if (item.session.nextEpisode) {
          this.clearCountdown(item);
          await this.advance(item, item.session.nextEpisode.number);
          return null;
        }
        break;
      case 'previous':
        if (item.session.previousEpisode) {
          this.clearCountdown(item);
          await this.advance(item, item.session.previousEpisode.number);
          return null;
        }
        break;
      case 'stop':
        item.stopped = true;
        item.player.close();
        break;
      default:
        break;
    }
    this.publish(item);
    return { ...item.session };
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(
      ids.map(
        (id) =>
          new Promise<void>((resolve) => {
            const item = this.sessions.get(id);
            if (!item) return resolve();
            item.stopped = true;
            // An already-exited player never emits `exit` again, so waiting on it
            // would stall every hand-off by the full timeout.
            if (!item.player.alive) return resolve();
            const timer = setTimeout(resolve, 2500);
            item.player.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            item.player.close();
          }),
      ),
    );
  }

  private historyKey(provider: string, animeId: string, episode: number, audio: AudioMode): string {
    return `${provider}:${animeId}:${episode}:${audio}`;
  }

  private async saveHistory(item: Internal, completed = false): Promise<void> {
    const entry: HistoryEntry = {
      key: this.historyKey(
        item.session.provider,
        item.session.animeId,
        item.session.episodeNumber,
        item.session.audio,
      ),
      provider: item.session.provider,
      animeId: item.session.animeId,
      animeTitle: item.session.animeTitle,
      episodeNumber: item.session.episodeNumber,
      episodeLabel: item.session.episodeLabel,
      audio: item.session.audio,
      positionSeconds: Math.round(item.session.position),
      durationSeconds: item.session.duration,
      completed: completed || item.session.completed,
      updatedAt: Date.now(),
    };
    await store.upsertHistory(entry).catch(() => undefined);
  }
}