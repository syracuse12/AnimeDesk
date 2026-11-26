import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import { api, formatTime } from '../api.ts';
import { autoSkipTarget, clampRange, visibleSkip, type SkipKind } from '../../shared/skip-timing.ts';
import {
  SUBTITLES_OFF,
  hlsSubtitleState,
  resolveSubtitleSelection,
  sideTrackLabel,
  subtitleModes,
} from '../../shared/subtitles.ts';
import {
  classifyFatal,
  emptyRecovery,
  nextRecovery,
  noteProgress,
  type RecoveryState,
} from '../../shared/player-recovery.ts';
import type { PlaybackSession, Settings, SkipRange } from '../../shared/types.ts';

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const HIDE_DELAY = 2600;

interface Props {
  session: PlaybackSession;
  settings: Settings;
  /** Fired when embedded playback cannot proceed; caller may retry in mpv. */
  onFallback: (reason: string) => void;
  /** False in builds that do not bundle mpv, so the dead action is not offered. */
  fallbackAvailable: boolean;
  onLeave: () => void;
  onAction: (action: string, value?: number) => Promise<void>;
}

interface TrackInfo {
  index: number;
  label: string;
  lang?: string;
}

/**
 * In-app player. hls.js plays the service's same-origin proxy, so seeking,
 * tracks and subtitles all work without fighting CORS or the CDN's referer
 * check. Anything hls.js cannot decode hands back to the mpv fallback.
 */
export function Player({ session, settings, onFallback, fallbackAvailable, onLeave, onAction }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hideTimer = useRef<number | null>(null);
  const handledRef = useRef<{ kind: SkipKind } | null>(null);
  const lastSent = useRef(0);
  const endedSent = useRef(false);
  const recovery = useRef<RecoveryState>(emptyRecovery());
  const recoveryTimer = useRef<number | null>(null);
  /** The viewer's own choice. Null until they pick one, so defaults still apply. */
  const subtitleChoice = useRef<number | null>(null);

  /**
   * Push the position now, ignoring the throttle. A seek or a pause can land
   * inside the 4s window and would otherwise be lost, leaving history (and any
   * resume) pointing at where the episode was a moment before.
   *
   * `keepalive` survives the page being torn down, which is the case that
   * matters when the window is closed mid-episode.
   */
  const flushProgress = useCallback(
    (options?: { keepalive?: boolean }) => {
      const video = videoRef.current;
      if (!video) return;
      lastSent.current = Date.now();
      void api
        .progress(session.sessionId, video.currentTime, video.duration || null, {
          keepalive: options?.keepalive,
          force: true,
        })
        .catch(() => undefined);
    },
    [session.sessionId],
  );

  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const [rate, setRate] = useState(settings.playbackRate);
  const [volume, setVolume] = useState(settings.volume / 100);
  const [muted, setMuted] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [audioTracks, setAudioTracks] = useState<TrackInfo[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackInfo[]>([]);
  const [audioIndex, setAudioIndex] = useState(-1);
  const [subtitleIndex, setSubtitleIndex] = useState(SUBTITLES_OFF);
  const [duration, setDuration] = useState<number | null>(session.duration);
  const [position, setPosition] = useState(session.position);
  const [panel, setPanel] = useState<'none' | 'audio' | 'subs' | 'speed'>('none');
  const [remaining, setRemaining] = useState(0);

  const counting = session.state === 'countdown' && session.nextAt;

  const isHls = session.hls;

  // The side-loaded VTT is not one of hls.js's renditions, so it lives in the
  // same index space but one past the end of them.
  const hasSideTrack = Boolean(session.subtitleUrl);
  const sideIndex = hasSideTrack ? subtitleTracks.length : SUBTITLES_OFF;
  const subtitleCount = subtitleTracks.length + (hasSideTrack ? 1 : 0);

  const poke = useCallback(() => {
    setVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setVisible(false), HIDE_DELAY);
  }, []);

  // The watch view stays mounted across episodes, so everything that tracks one
  // episode has to be reset when the session id changes — otherwise the second
  // episode never reports its own end and autoplay stalls.
  useEffect(() => {
    endedSent.current = false;
    lastSent.current = 0;
    handledRef.current = null;
    setReady(false);
    setFatal(null);
    setDuration(session.duration);
    setPosition(session.position);
    setScrub(null);
    setPanel('none');
    // A new episode publishes its own tracks; the old choice must not leak in.
    subtitleChoice.current = null;
    setSubtitleTracks([]);
    setSubtitleIndex(SUBTITLES_OFF);
    recovery.current = emptyRecovery();
    if (recoveryTimer.current) window.clearTimeout(recoveryTimer.current);
    // Only the session id: duration/position change on every progress push and
    // would otherwise re-run this and flash the loading overlay mid-episode.
  }, [session.sessionId]);

  // Attach the media source. hls.js for the proxied playlists, native for files.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !session.streamUrl) return;

    const startAt = session.position > 1 ? session.position : 0;
    let disposed = false;

    const onLoaded = () => {
      if (disposed) return;
      setReady(true);
      video.currentTime = startAt;
      video.playbackRate = rate;
      video.volume = volume;
      void video.play().catch(() => undefined);
    };

    if (Hls.isSupported() && isHls) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 90 });
      hlsRef.current = hls;
      hls.attachMedia(video);
      hls.loadSource(session.streamUrl);

      const applySubtitle = (selected: number) => {
        const state = hlsSubtitleState(selected, hls.subtitleTracks.length);
        hls.subtitleTrack = state.subtitleTrack;
        hls.subtitleDisplay = state.subtitleDisplay;
      };

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setAudioTracks(hls.audioTracks.map((track, index) => ({ index, label: track.name || `Track ${index + 1}`, lang: track.lang })));
        setSubtitleTracks(hls.subtitleTracks.map((track, index) => ({ index, label: track.name || track.lang || `Track ${index + 1}`, lang: track.lang })));
        // hls.js defaults subtitleDisplay to true, so a track would render even
        // with nothing chosen. Resolve the remembered choice against the list
        // that actually arrived and apply it before anything is painted.
        const count = hls.subtitleTracks.length + (hasSideTrack ? 1 : 0);
        const selected = resolveSubtitleSelection(subtitleChoice.current, session.audio, count);
        setSubtitleIndex(selected);
        applySubtitle(selected);
        onLoaded();
      });

      // A fragment that arrived is proof the source is alive again.
      hls.on(Hls.Events.FRAG_LOADED, () => {
        recovery.current = noteProgress(recovery.current);
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        const reason = data.details || data.type;
        const decision = nextRecovery(classifyFatal(data.details), recovery.current);
        recovery.current = decision.state;

        if (decision.action === 'give-up') {
          setFatal(`Playback failed: ${reason}`);
          onFallback(`hls.js: ${reason}`);
          return;
        }

        // Never restart from zero: the viewer keeps their place across the retry.
        const resumeAt = video.currentTime;
        flushProgress();
        recoveryTimer.current = window.setTimeout(() => {
          if (disposed) return;
          try {
            if (decision.action === 'recoverMedia') hls.recoverMediaError();
            else hls.startLoad(resumeAt > 1 ? resumeAt : undefined);
          } catch {
            setFatal(`Playback failed: ${reason}`);
            onFallback(`hls.js: ${reason}`);
          }
        }, decision.delayMs);
      });

      return () => {
        disposed = true;
        if (recoveryTimer.current) window.clearTimeout(recoveryTimer.current);
        hls.destroy();
        hlsRef.current = null;
      };
    }

    // Safari and progressive files go straight to the element.
    video.src = session.streamUrl;
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    const fail = () => {
      setFatal('This source could not be decoded in the app window.');
      onFallback('native decoder');
    };
    video.addEventListener('error', fail);
    return () => {
      disposed = true;
      video.removeEventListener('error', fail);
      video.removeAttribute('src');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId, session.streamUrl]);

  /**
   * Apply one subtitle choice to both namespaces. hls.js renditions are indexed
   * as they arrive; the side-loaded VTT sits one past the end of them, because
   * it is not a rendition at all. Everything not chosen is explicitly disabled —
   * leaving a track on its browser default is what let subtitles survive "Off".
   */
  const applySubtitle = useCallback((selected: number) => {
    const video = videoRef.current;
    const hls = hlsRef.current;
    const hlsCount = hls ? hls.subtitleTracks.length : 0;
    if (hls) {
      const state = hlsSubtitleState(selected, hlsCount);
      hls.subtitleTrack = state.subtitleTrack;
      hls.subtitleDisplay = state.subtitleDisplay;
    }
    if (!video) return;
    const side = session.subtitleUrl;
    // The element's own track is identified by identity, not by position, so a
    // late-arriving <track> cannot be confused with an hls.js rendition.
    const sideTracks = new Set<TextTrack>();
    for (const node of Array.from(video.querySelectorAll('track'))) sideTracks.add(node.track);
    const modes = subtitleModes(hlsCount + (side ? 1 : 0), selected);
    let hlsSeen = 0;
    Array.from(video.textTracks).forEach((track) => {
      if (sideTracks.has(track)) {
        track.mode = modes[hlsCount] ?? 'disabled';
        return;
      }
      track.mode = modes[hlsSeen] ?? 'disabled';
      hlsSeen += 1;
    });
  }, [session.subtitleUrl]);

  // Re-apply on every change, and again whenever a track element finishes
  // loading: a <track> that arrives late would otherwise keep its own mode.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    applySubtitle(subtitleIndex);
    const onApply = () => applySubtitle(subtitleIndex);
    const tracks = video.textTracks;
    tracks.addEventListener?.('addtrack', onApply);
    const nodes = Array.from(video.querySelectorAll('track'));
    for (const node of nodes) node.addEventListener('load', onApply);
    return () => {
      tracks.removeEventListener?.('addtrack', onApply);
      for (const node of nodes) node.removeEventListener('load', onApply);
    };
  }, [applySubtitle, ready, subtitleIndex]);

  const selectSubtitle = useCallback((next: number) => {
    subtitleChoice.current = next;
    setSubtitleIndex(next);
    setPanel('none');
  }, []);

  useEffect(() => {
    if (!counting) return;
    const tick = () => setRemaining(Math.max(0, Math.round((session.nextAt! - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 400);
    return () => window.clearInterval(timer);
  }, [counting, session.nextAt]);

  useEffect(() => () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  }, []);

  // Closing the window or switching away must not cost the last few seconds.
  // The periodic tick is only a backstop; these are the real exit points.
  useEffect(() => {
    const flush = () => flushProgress({ keepalive: true });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      // Unmounting the player (Back, Next, another episode) is also an exit.
      flush();
    };
  }, [flushProgress]);

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const target = duration ? Math.min(Math.max(0, seconds), duration - 0.25) : Math.max(0, seconds);
    video.currentTime = target;
    setPosition(target);
    lastSent.current = Date.now();
    void api.progress(session.sessionId, target, video.duration || null, { force: true }).catch(() => undefined);
  }, [duration, session.sessionId]);

  const skip = useCallback((kind: SkipKind) => {
    const range: SkipRange | null = kind === 'intro' ? session.skips?.intro ?? null : session.skips?.outro ?? null;
    if (!range) return;
    const clamped = clampRange(range, duration);
    seekTo(clamped.end);
    handledRef.current = { kind };
    poke();
  }, [duration, poke, seekTo, session.skips]);

  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const now = video.currentTime;
    setPosition(now);
    if (video.duration && Number.isFinite(video.duration)) setDuration(video.duration);

    // Release the auto-skip latch once the playhead leaves that window.
    const handled = handledRef.current;
    if (handled) {
      const range = handled.kind === 'intro' ? session.skips?.intro : session.skips?.outro;
      if (!range || now < range.start - 1 || now > range.end + 1) handledRef.current = null;
    }

    const target = autoSkipTarget(session.skips, now, video.duration || null, {
      intro: settings.autoSkipIntro,
      outro: settings.autoSkipOutro,
      handled: handledRef.current?.kind ?? null,
    });
    if (target) {
      handledRef.current = { kind: target.kind };
      video.currentTime = target.target;
      setPosition(target.target);
    }

    const stamp = Date.now();
    if (stamp - lastSent.current > 1000) {
      lastSent.current = stamp;
      void api.progress(session.sessionId, now, video.duration || null).catch(() => undefined);
    }
  }, [session.sessionId, session.skips, settings.autoSkipIntro, settings.autoSkipOutro]);

  const onEnded = useCallback(() => {
    if (endedSent.current) return;
    endedSent.current = true;
    const video = videoRef.current;
    void api.end(session.sessionId, video?.duration ?? null).catch(() => undefined);
  }, [session.sessionId]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
    poke();
  }, [poke]);

  const toggleFullscreen = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shell.requestFullscreen().catch(() => undefined);
  }, []);

  const changeRate = useCallback((next: number) => {
    setRate(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
    void api.saveSettings({ playbackRate: next }).catch(() => undefined);
    setPanel('none');
    poke();
  }, [poke]);

  // Keyboard shortcuts, ignored while typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
          target?.closest('button, a, [role="button"], [contenteditable="true"]')) return;
      const video = videoRef.current;
      if (!video) return;
      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault();
          togglePlay();
          break;
        case 'ArrowRight':
          event.preventDefault();
          seekTo(video.currentTime + (event.shiftKey ? 30 : 10));
          poke();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          seekTo(video.currentTime - (event.shiftKey ? 30 : 10));
          poke();
          break;
        case 'j':
          seekTo(video.currentTime - 10);
          poke();
          break;
        case 'l':
          seekTo(video.currentTime + 10);
          poke();
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'm':
          video.muted = !video.muted;
          setMuted(video.muted);
          poke();
          break;
        case 'n':
          if (session.nextEpisode) void onAction('next');
          break;
        case 'p':
          if (session.previousEpisode) void onAction('previous');
          break;
        case 'Escape':
          if (!document.fullscreenElement) onLeave();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAction, onLeave, poke, seekTo, session.nextEpisode, session.previousEpisode, toggleFullscreen, togglePlay]);

  const shown = visible || session.state !== 'playing';
  const skipKind = useMemo(
    () => visibleSkip(session.skips, position, duration),
    [duration, position, session.skips],
  );
  const percent = duration ? Math.min(100, (position / duration) * 100) : 0;
  const watchedPercent = duration ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <div
      className={`stage${shown ? ' shown' : ''}`}
      ref={shellRef}
      onMouseMove={poke}
      onTouchStart={poke}
    >
      <video
        ref={videoRef}
        className="video"
        playsInline
        crossOrigin="anonymous"
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onPlay={() => void onAction('resume')}
        onPause={() => {
          // A pause is the last chance to record where the viewer really was.
          flushProgress();
          void onAction('pause');
        }}
        onSeeked={() => flushProgress()}
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
      >
        {session.subtitleUrl && (
          <track
            kind="subtitles"
            src={session.subtitleUrl}
            srcLang={session.subtitleLang ?? 'en'}
            label={sideTrackLabel(session.subtitleLang)}
          />
        )}
      </video>

      {!ready && !fatal && (
        <div className="stage-loading">
          <span className="spinner" />
          <p>Starting stream…</p>
        </div>
      )}

      {fatal && (
        <div className="stage-error">
          <h3>Cannot play this source in the app</h3>
          <p>{fatal}</p>
          {!fallbackAvailable && (
            <p>This build plays in-app only. Try another quality or episode.</p>
          )}
          <div className="row">
            {fallbackAvailable && (
              <button className="btn primary" onClick={() => onFallback(fatal)}>Open in mpv</button>
            )}
            <button className={fallbackAvailable ? 'btn' : 'btn primary'} onClick={onLeave}>Back to episodes</button>
          </div>
        </div>
      )}

      <div className="stage-top">
        <button className="icon-btn" onClick={onLeave} title="Back to the series (Esc)">
          <Chevron />
        </button>
        <div className="stage-heading">
          <strong>{session.animeTitle}</strong>
          <span>
            {session.episodeLabel} · {session.audio === 'dub' ? 'English dub' : 'Subtitled'}
          </span>
        </div>
        <div className="stage-badge">{session.mode === 'embedded' ? 'In app' : 'mpv'}</div>
      </div>

      {session.qualityNote && (
        <div className="stage-quality-note" role="status">
          {session.qualityNote}
        </div>
      )}

      {skipKind && (
        <button className={`skip-btn ${skipKind}`} onClick={() => skip(skipKind)}>
          {skipKind === 'intro' ? 'Skip intro' : 'Skip outro'}
          <small>{Math.max(0, Math.round((skipKind === 'intro' ? (session.skips?.intro?.end ?? 0) : (session.skips?.outro?.end ?? 0)) - position))}s</small>
        </button>
      )}

      {counting && session.nextEpisode && (
        <div className="stage-countdown">
          <div>
            <span className="countdown-label">Up next</span>
            <strong>{session.nextEpisode.label}</strong>
            <span className="countdown-ring" style={{ ['--p' as string]: `${Math.max(0, Math.min(100, (remaining / Math.max(1, settings.autoNextDelaySeconds)) * 100))}%` }}>
              {remaining}
            </span>
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => void onAction('skipCountdown')}>Play now</button>
            <button className="btn" onClick={() => void onAction('cancelCountdown')}>Cancel</button>
          </div>
        </div>
      )}

      {session.state === 'ended' && !session.nextEpisode && !fatal && (
        <div className="stage-countdown">
          <div>
            <span className="countdown-label">Series complete</span>
            <strong>That was the last episode.</strong>
          </div>
          <div className="row">
            <button className="btn primary" onClick={onLeave}>Back to series</button>
          </div>
        </div>
      )}

      {session.error && !fatal && (
        <div className="stage-countdown error"><strong>{session.error}</strong></div>
      )}

      <div className="controls">
        <div className="scrub">
          <span>{formatTime(scrub ?? position)}</span>
          <div className="scrub-track">
            <div className="scrub-buffer" style={{ width: `${watchedPercent}%` }} />
            <div className="scrub-fill" style={{ width: `${percent}%` }} />
            <input
              type="range"
              min={0}
              max={duration ?? 100}
              step={0.5}
              value={scrub ?? position}
              onChange={(event) => setScrub(Number(event.target.value))}
              onPointerUp={() => {
                if (scrub !== null) {
                  seekTo(scrub);
                  setScrub(null);
                }
              }}
              aria-label="Seek"
            />
          </div>
          <span>{duration ? formatTime(duration) : '--:--'}</span>
        </div>

        <div className="control-row">
          <button className="icon-btn" onClick={() => void onAction('previous')} disabled={!session.previousEpisode} title="Previous episode (P)">
            <Prev />
          </button>
          <button className="icon-btn play" onClick={togglePlay} title="Play / pause (Space)">
            {session.paused ? <Play /> : <Pause />}
          </button>
          <button className="icon-btn" onClick={() => void onAction('next')} disabled={!session.nextEpisode} title="Next episode (N)">
            <Next />
          </button>

          <div className="control-spacer" />

          <button className="icon-btn" onClick={() => { const v = videoRef.current; if (v) { v.muted = !v.muted; setMuted(v.muted); } }} title="Mute (M)">
            {muted ? <Muted /> : <Speaker />}
          </button>
          <input
            className="volume"
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={muted ? 0 : volume}
            onChange={(event) => {
              const next = Number(event.target.value);
              setVolume(next);
              setMuted(next === 0);
              const v = videoRef.current;
              if (v) {
                v.volume = next;
                v.muted = next === 0;
              }
              void api.saveSettings({ volume: Math.round(next * 100) }).catch(() => undefined);
            }}
            aria-label="Volume"
          />

          <div className="menu-wrap">
            <button className="text-btn" onClick={() => setPanel(panel === 'speed' ? 'none' : 'speed')}>
              {rate}×
            </button>
            {panel === 'speed' && (
              <div className="menu">
                {RATES.map((value) => (
                  <button key={value} className={value === rate ? 'active' : ''} onClick={() => changeRate(value)}>
                    {value}×{value === 1 ? ' · normal' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>

          {subtitleCount > 0 && (
            <div className="menu-wrap">
              <button className="text-btn" onClick={() => setPanel(panel === 'subs' ? 'none' : 'subs')} title="Subtitles">CC</button>
              {panel === 'subs' && (
                <div className="menu">
                  <button className={subtitleIndex === SUBTITLES_OFF ? 'active' : ''} onClick={() => selectSubtitle(SUBTITLES_OFF)}>Off</button>
                  {subtitleTracks.map((track) => (
                    <button key={track.index} className={subtitleIndex === track.index ? 'active' : ''} onClick={() => selectSubtitle(track.index)}>
                      {track.label}
                    </button>
                  ))}
                  {hasSideTrack && (
                    <button className={subtitleIndex === sideIndex ? 'active' : ''} onClick={() => selectSubtitle(sideIndex)}>
                      {sideTrackLabel(session.subtitleLang)}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {audioTracks.length > 1 && (
            <div className="menu-wrap">
              <button className="text-btn" onClick={() => setPanel(panel === 'audio' ? 'none' : 'audio')} title="Audio track">Audio</button>
              {panel === 'audio' && (
                <div className="menu">
                  {audioTracks.map((track) => (
                    <button key={track.index} className={audioIndex === track.index ? 'active' : ''} onClick={() => { setAudioIndex(track.index); if (hlsRef.current) hlsRef.current.audioTrack = track.index; setPanel('none'); }}>
                      {track.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <button className="icon-btn" onClick={toggleFullscreen} title="Fullscreen (F)">
            <Expand />
          </button>
        </div>
      </div>
    </div>
  );
}

/* Inline icon set: no icon dependency, no brand marks. */
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function Play() { return <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>; }
function Pause() { return <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9 5v14M15 5v14" {...stroke} /></svg>; }
function Prev() { return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M18 6v12L9 12zM6 6v12" {...stroke} /></svg>; }
function Next() { return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6v12l9-6zM18 6v12" {...stroke} /></svg>; }
function Speaker() { return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" {...stroke} /><path d="M17 9.5a4 4 0 0 1 0 5" {...stroke} /></svg>; }
function Muted() { return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" {...stroke} /><path d="M17 10l4 4m0-4l-4 4" {...stroke} /></svg>; }
function Expand() { return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" {...stroke} /></svg>; }
function Chevron() { return <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5" {...stroke} /></svg>; }
