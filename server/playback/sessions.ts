import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getProvider } from '../providers/index.ts';
import { ProviderError } from '../providers/types.ts';
import { MpvPlayer } from '../player/mpv.ts';
import { store } from '../store.ts';
import { skips } from '../aniskip.ts';
import { mintUrlToken, streamUrlFor } from '../proxy.ts';
import type {
  AudioMode,
  HistoryEntry,
  PlaybackMode,
  PlaybackSession,
  PlayRequest,
  SkipInfo,
} from '../../shared/types.ts';

/**
 * The bit of a player the manager needs. mpv implements it over JSON IPC; the
 * embedded player is a plain record because the browser owns the real element.
 * Keeping both behind one shape means the autoplay state machine below is
 * identical whichever one is driving.
 */
export interface PlaybackDriver {
  readonly alive: boolean;
  setPaused(paused: boolean): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  setRate(rate: number): void;
  close(): void;
}

/** A driver for in-app playback: state only, no process. */
class EmbeddedDriver implements PlaybackDriver {
  alive = true;
  setPaused(): void {}
  seek(): void {}
  setVolume(): void {}
  setRate(): void {}
  close(): void {
    this.alive = false;
  }
}

interface Internal {
  session: PlaybackSession;
  driver: PlaybackDriver;
  countdown: NodeJS.Timeout | null;
  lastSaved: number;
  stopped: boolean;
  /** Guards the one-shot end transition against duplicate end reports. */
  ended: boolean;
  /** Guards the one-shot skip lookup against every timeupdate. */
  skipsAsked: boolean;
  /**
   * Series artwork, carried on the session so every history write keeps it.
   * Without it a Continue Watching card has no picture to show.
   */
  coverUrl: string | null;
  /**
   * Quality this session resolved at. Autoplay and manual Next build a fresh
   * PlayRequest, so without this the viewer's per-play choice would be lost at
   * exactly the moment it matters: the next episode.
   */
  quality: Quality;
}

interface BeginParams {
  provider: PlaybackSession['provider'];
  animeId: string;
  animeTitle: string;
  episodeNumber: number;
  episodeCount: number;
  episodeLabel: string;
  audio: AudioMode;
  url: string;
  referer?: string;
  subtitleUrl?: string;
  subtitleLang?: string;
  startAt: number;
  volume: number;
  mode: PlaybackMode;
  nextEpisode?: { number: number; label: string } | null;
  previousEpisode?: { number: number; label: string } | null;
  /** Session this one replaces, when it was created by a hand-off. */
  supersedes?: string | null;
  coverUrl?: string;
  /** The quality this play resolved at, carried so a hand-off keeps it. */
  quality?: Quality;
  /** Height actually served, and a note when it differs from the request. */
  resolvedHeight?: number | null;
  qualityNote?: string | null;
}

/** A resolved quality preference; the union lives on PlayRequest. */
type Quality = NonNullable<PlayRequest['quality']>;

/**
 * Owns the lifetime of every playback. Autoplay is driven by a real
 * end-of-stream signal — mpv's `end-file`/`eof` event or the browser's `ended`
 * event — never by a timer guessing when the episode finishes.
 */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, Internal>();
  private lastHistoryErrorAt = 0;
  private mpvPath: string | null;
  private proxyPort = Number(process.env.ANIMEDESK_PORT ?? 47821);
  private embeddedAllowed = true;

  constructor(mpvPath: string | null) {
    super();
    this.mpvPath = mpvPath;
  }

  setMpvPath(path: string | null): void {
    this.mpvPath = path;
  }

  setProxyPort(port: number): void { this.proxyPort = port; }

  setEmbeddedAllowed(allowed: boolean): void {
    this.embeddedAllowed = allowed;
  }

  setVolume(volume: number): void {
    for (const item of this.sessions.values()) item.driver.setVolume(volume);
  }

  setRate(rate: number): void {
    for (const item of this.sessions.values()) item.driver.setRate(rate);
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

  /**
   * Resolve through a provider, then hand off to the shared launcher.
   *
   * `supersedes` names the session being replaced by an episode hand-off. It is
   * carried on the new session so the UI can tell a real hand-off apart from a
   * late frame of the episode it just left.
   */
  async start(request: PlayRequest, supersedes: string | null = null): Promise<PlaybackSession> {
    const provider = getProvider(request.provider);

    const detail = await provider.detail(request.animeId);
    const episode = detail.episodes.find((item) => item.number === request.episodeNumber);
    if (!episode) throw new ProviderError(404, `Episode ${request.episodeNumber} does not exist`);

    // Never claim a dub the provider does not actually offer.
    const audio: AudioMode = detail.availableAudio.includes(request.audio)
      ? request.audio
      : (detail.availableAudio[0] ?? 'sub');

    const mode = this.pickMode(request.mode);
    const quality = request.quality ?? store.getSettings().quality;
    const stream = await provider.resolve(request.animeId, episode.number, audio, quality);

    const index = detail.episodes.findIndex((item) => item.number === episode.number);
    const next = index >= 0 ? detail.episodes[index + 1] : undefined;
    const previous = index > 0 ? detail.episodes[index - 1] : undefined;

    const settings = store.getSettings();
    let startAt = request.startAt ?? 0;
    // An explicit 0 means "start over" and must beat saved progress.
    if (request.startAt === undefined && settings.resumePlayback) {
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
      episodeCount: detail.episodes.length,
      episodeLabel: episode.label,
      audio,
      url: stream.url,
      referer: stream.referer,
      subtitleUrl: stream.subtitleUrl,
      subtitleLang: stream.subtitleLang,
      startAt,
      volume: settings.volume,
      mode,
      nextEpisode: next ? { number: next.number, label: next.label } : null,
      previousEpisode: previous ? { number: previous.number, label: previous.label } : null,
      supersedes,
      coverUrl: detail.coverUrl,
      quality,
      resolvedHeight: stream.resolvedHeight ?? null,
      qualityNote: stream.qualityNote ?? null,
    });
  }

  private pickMode(requested?: PlaybackMode): PlaybackMode {
    const wanted = requested ?? (store.getSettings().embeddedPlayer ? 'embedded' : 'external');
    if (wanted === 'external') {
      if (!this.mpvPath) throw new ProviderError(500, 'mpv was not found; run `npm run setup:mpv`');
      return 'external';
    }
    // Embedded is always offered: the service itself is the stream proxy.
    return 'embedded';
  }

  /** Play a raw URL with no provider behind it. */
  async startDirect(params: Omit<BeginParams, 'startAt'> & { startAt?: number }): Promise<PlaybackSession> {
    return this.begin({
      ...params,
      startAt: params.startAt ?? 0,
      nextEpisode: null,
      previousEpisode: null,
    });
  }

  private async begin(params: BeginParams): Promise<PlaybackSession> {
    if (params.mode === 'external' && !this.mpvPath) {
      throw new ProviderError(500, 'mpv was not found');
    }
    await this.stopAll();
    const streamPath = streamUrlFor({ url: params.url, referer: params.referer });
    const proxyBase = `http://127.0.0.1:${this.proxyPort}`;
    const externalUrl = /^https?:\/\//i.test(params.url) ? `${proxyBase}${streamPath}` : params.url;
    const subtitlePath = params.subtitleUrl
      ? `/api/stream/${mintUrlToken(params.subtitleUrl, params.referer)}`
      : null;

    const session: PlaybackSession = {
      sessionId: randomUUID(),
      supersedes: params.supersedes ?? null,
      provider: params.provider,
      animeId: params.animeId,
      animeTitle: params.animeTitle,
      episodeNumber: params.episodeNumber,
      episodeCount: params.episodeCount,
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
      mode: params.mode,
      streamUrl: params.mode === 'embedded' ? streamPath : null,
      hls: /\.m3u8(\?|$)/i.test(params.url),
      subtitleUrl:
        params.mode === 'embedded' ? subtitlePath : null,
      subtitleLang: params.subtitleLang ?? null,
      quality: params.quality ?? store.getSettings().quality,
      resolvedHeight: params.resolvedHeight ?? null,
      qualityNote: params.qualityNote ?? null,
      skips: null,
      startedAt: Date.now(),
    };

    const driver: PlaybackDriver =
      params.mode === 'external' ? new MpvPlayer(this.mpvPath as string) : new EmbeddedDriver();
    const item: Internal = {
      session,
      driver,
      countdown: null,
      lastSaved: 0,
      stopped: false,
      ended: false,
      skipsAsked: false,
      coverUrl: params.coverUrl ?? null,
      quality: params.quality ?? store.getSettings().quality,
    };
    this.sessions.set(session.sessionId, item);
    this.publish(item);

    if (params.mode === 'external') {
      const player = driver as MpvPlayer;
      player.on('loaded', (duration: unknown) => {
        item.session.duration = typeof duration === 'number' && duration > 0 ? duration : null;
        item.session.state = 'playing';
        this.publish(item);
        void this.saveHistory(item);
        void this.loadSkips(item);
      });
      player.on('property', (name: string, value: unknown) => {
        if (name === 'time-pos' && typeof value === 'number') {
          this.report(item, value);
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
      player.on('failed', (message: string) => this.fail(item, message));

      try {
        await player.open({
          url: externalUrl,
          subtitleUrl: subtitlePath ? `${proxyBase}${subtitlePath}` : undefined,
          title: `${params.animeTitle} - ${params.episodeLabel}`,
          startAt: params.startAt,
          volume: params.volume,
        });
      } catch (error) {
        this.fail(item, (error as Error).message);
        player.close();
        throw error;
      }
    }

    return { ...session };
  }

  private fail(item: Internal, message: string): void {
    item.session.state = 'error';
    item.session.error = message;
    this.publish(item);
  }

  /**
   * Record a position update from either driver. Called on every embedded
   * timeupdate and on mpv's time-pos, so history stays accurate without a poll.
   */
  report(item: Internal, position: number, duration?: number | null, force = false): void {
    if (!Number.isFinite(position) || position < 0) return;
    item.session.position = position;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      item.session.duration = duration;
      // The embedded player is the only source of a duration here, so this is
      // where its one-shot skip lookup is triggered.
      if (!item.skipsAsked) {
        item.skipsAsked = true;
        void this.loadSkips(item);
      }
    }
    if (item.session.state === 'starting') item.session.state = 'playing';
    const now = Date.now();
    // A forced report comes from a real exit point (pause, seek, unload), so it
    // bypasses the periodic throttle and always reaches disk.
    if (force || now - item.lastSaved > 5000) {
      item.lastSaved = now;
      void this.saveHistory(item);
    }
    this.publish(item);
  }

  /** Position report addressed by id, for the embedded player's updates. */
  reportById(sessionId: string, position: number, duration?: number | null, force = false): void {
    const item = this.sessions.get(sessionId);
    if (item) this.report(item, position, duration, force);
  }

  /** Fill in skip info once the real duration is known. */
  async loadSkips(item: Internal): Promise<SkipInfo | null> {
    const settings = store.getSettings();
    const info = await skips.forEpisode({
      key: this.historyKey(item.session.provider, item.session.animeId, item.session.episodeNumber, item.session.audio),
      title: item.session.animeTitle,
      episodeNumber: item.session.episodeNumber,
      duration: item.session.duration,
      enabled: settings.aniskipEnabled && process.env.ANIMEDESK_PROFILE !== 'distribution',
    }).catch(() => null);
    if (!info || item.stopped) return null;
    item.session.skips = info;
    this.publish(item);
    return info;
  }

  /** The browser says the media genuinely ended. */
  async endFromClient(sessionId: string, duration?: number | null): Promise<PlaybackSession | null> {
    const item = this.sessions.get(sessionId);
    if (!item) return null;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      item.session.duration = duration;
    }
    await this.onEnded(item);
    return { ...item.session };
  }

  private async onEnded(item: Internal): Promise<void> {
    if (item.stopped || item.ended) return;
    item.ended = true;
    item.session.completed = true;
    item.session.position = item.session.duration ?? item.session.position;

    // Decide the next state synchronously: an external player exits the moment
    // the file ends, so an await here would let onExit see a non-countdown
    // state and tear the session down before the timer is even scheduled.
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
          this.fail(item, (error as Error).message);
        });
      }, delay);
    } else {
      item.session.state = 'ended';
      this.publish(item);
    }

    await this.saveHistory(item, true);
  }

  private async onExit(item: Internal): Promise<void> {
    // A pending autoplay countdown must outlive the process that just exited;
    // the timer owns the hand-off to the next episode.
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
    // whichever path triggered the hand-off. Persist before it goes, or a
    // manual Next/Previous loses the position the viewer left behind.
    const from = item.session.sessionId;
    await this.saveHistory(item);
    this.sessions.delete(from);
    const next = await this.start(
      {
        provider: item.session.provider,
        animeId: item.session.animeId,
        episodeNumber,
        audio: item.session.audio,
        mode: item.session.mode,
        // Carry the choice across the hand-off; a fresh request would
        // otherwise fall back to the saved setting and change quality
        // mid-series without the viewer asking.
        quality: item.quality,
      },
      from,
    );
    this.emit('advanced', { from, to: next.sessionId });
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
        item.driver.setPaused(true);
        item.session.paused = true;
        if (item.session.state === 'playing') item.session.state = 'paused';
        // A pause is a natural stopping point: persist it now rather than
        // waiting for the 5s tick, which a quick close could outrun.
        await this.saveHistory(item);
        break;
      case 'resume':
        item.driver.setPaused(false);
        item.session.paused = false;
        if (item.session.state === 'paused') item.session.state = 'playing';
        break;
      case 'seek':
        if (typeof value === 'number' && Number.isFinite(value)) {
          const clamped = Math.max(0, item.session.duration ? Math.min(value, item.session.duration) : value);
          item.driver.seek(clamped);
          item.session.position = clamped;
          // The seek target is where the viewer now is; record it immediately
          // so a crash or close straight after a scrub keeps the new position.
          await this.saveHistory(item);
        }
        break;
      case 'volume':
        if (typeof value === 'number' && Number.isFinite(value)) item.driver.setVolume(value);
        break;
      case 'rate':
        if (typeof value === 'number' && Number.isFinite(value)) item.driver.setRate(value);
        break;
      case 'fullscreen':
        if (item.driver instanceof MpvPlayer) item.driver.setFullscreen(true);
        break;
      case 'windowed':
        if (item.driver instanceof MpvPlayer) item.driver.setFullscreen(false);
        break;
      case 'skipCountdown':
        if (item.countdown && item.session.nextEpisode) {
          this.clearCountdown(item);
          await this.advance(item, item.session.nextEpisode.number);
          return null;
        }
        break;
      case 'cancelCountdown':
        if (item.countdown) {
          this.clearCountdown(item);
          item.session.state = 'ended';
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
        item.driver.close();
        // The embedded driver never emits `exit`; close the record here.
        if (!(item.driver instanceof MpvPlayer)) {
          item.session.state = item.session.completed ? 'ended' : 'closed';
          this.sessions.delete(item.session.sessionId);
          await this.saveHistory(item, item.session.completed);
        }
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
            // Shutdown runs through here, so the position has to be written
            // before the record is dropped, not left to the periodic timer.
            void this.saveHistory(item, item.session.completed).finally(() => resolve());
            if (!(item.driver instanceof MpvPlayer)) {
              item.driver.close();
              this.sessions.delete(id);
              return;
            }
            // An already-exited player never emits `exit` again, so waiting on
            // it would stall every hand-off by the full timeout.
            if (!item.driver.alive) return;
            const timer = setTimeout(resolve, 2500);
            item.driver.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            item.driver.close();
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
      coverUrl: item.coverUrl ?? undefined,
      episodeNumber: item.session.episodeNumber,
      episodeLabel: item.session.episodeLabel,
      audio: item.session.audio,
      positionSeconds: Math.round(item.session.position),
      durationSeconds: item.session.duration,
      completed: completed || item.session.completed,
      updatedAt: Date.now(),
    };
    try {
      await store.upsertHistory(entry);
    } catch (error) {
      console.error('[animedesk] history save failed:', error);
      if (Date.now() - this.lastHistoryErrorAt > 30_000) {
        this.lastHistoryErrorAt = Date.now();
        this.emit('history-error', 'Watch history could not be saved. Check that the data folder is writable.');
      }
    }
  }
}
