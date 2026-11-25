import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, formatTime, subscribe } from './api.ts';
import type {
  AnimeDetail,
  AppStatus,
  AudioMode,
  Episode,
  HistoryEntry,
  PlaybackSession,
  ProviderId,
  SearchResult,
  Settings,
} from '../shared/types.ts';

type View = 'search' | 'detail' | 'history' | 'settings';

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [view, setView] = useState<View>('search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchErrors, setSearchErrors] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [provider, setProvider] = useState<ProviderId | 'all'>('all');
  const [detail, setDetail] = useState<AnimeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [audio, setAudio] = useState<AudioMode>('sub');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const sessionRef = useRef<PlaybackSession | null>(null);

  sessionRef.current = session;

  const loadStatus = useCallback(async () => {
    try {
      const next = await api.status();
      setStatus(next);
      setSettings(next.settings);
      setAudio(next.settings.preferredAudio);
    } catch (error) {
      setBanner(`Service unreachable: ${(error as Error).message}`);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await api.history()).entries);
    } catch {
      /* history is optional */
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadHistory();
  }, [loadStatus, loadHistory]);

  // Session updates are pushed by the service; the player panel is a mirror.
  useEffect(() => {
    return subscribe((next) => {
      setSession((current) => {
        if (!current) return next;
        if (current.sessionId === next.sessionId) return next;
        // A new id is a real hand-off (autoplay, next/previous). Anything else is
        // a late frame from the episode we already left behind.
        return current.state === 'countdown' || current.state === 'ended' || current.state === 'closed'
          ? next
          : current;
      });
      if (next.state === 'ended' || next.state === 'countdown' || next.state === 'closed') {
        void loadHistory();
      }
    });
  }, [loadHistory]);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    setSearching(true);
    setSearchErrors([]);
    setResults([]);
    try {
      const response = await api.search(trimmed, provider === 'all' ? undefined : provider);
      setResults(response.results);
      setSearchErrors(response.errors ?? []);
      setView('search');
    } catch (error) {
      setBanner((error as Error).message);
    } finally {
      setSearching(false);
    }
  }, [provider, query]);

  const openDetail = useCallback(
    async (providerId: ProviderId, id: string) => {
      setDetailLoading(true);
      setBanner(null);
      try {
        const { anime } = await api.detail(providerId, id);
        setDetail(anime);
        setAudio(
          anime.availableAudio.includes(audio)
            ? audio
            : (anime.availableAudio[0] ?? 'sub'),
        );
        setView('detail');
      } catch (error) {
        setBanner((error as Error).message);
      } finally {
        setDetailLoading(false);
      }
    },
    [audio],
  );

  const playEpisode = useCallback(
    async (episode: Episode, startAt?: number) => {
      if (!detail) return;
      setBusy(true);
      setBanner(null);
      try {
        const response = await api.play({
          provider: detail.provider,
          animeId: detail.id,
          episodeNumber: episode.number,
          audio,
          startAt,
        });
        setSession(response.session);
      } catch (error) {
        const message = error instanceof ApiError ? error.message : (error as Error).message;
        setBanner(message);
      } finally {
        setBusy(false);
      }
    },
    [audio, detail],
  );

  const act = useCallback(async (action: string, value?: number) => {
    const current = sessionRef.current;
    if (!current) return;
    try {
      await api.action(current.sessionId, action, value);
    } catch (error) {
      setBanner((error as Error).message);
    }
  }, []);

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    try {
      const response = await api.saveSettings(patch);
      setSettings(response.settings);
      setAudio(response.settings.preferredAudio);
    } catch (error) {
      setBanner((error as Error).message);
    }
  }, []);

  const providers = status?.providers ?? [];
  const activeProvider = useMemo(
    () => providers.find((item) => item.id === (provider === 'all' ? 'hianime' : provider)),
    [provider, providers],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">AD</span>
          <div>
            <strong>AnimeDesk</strong>
            <small>{status ? `v${status.version}` : 'connecting'}</small>
          </div>
        </div>

        <form
          className="search"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search anime (blank browses your library)"
            maxLength={120}
            aria-label="Search anime"
          />
          <button type="submit" disabled={searching}>
            {searching ? '...' : 'Go'}
          </button>
        </form>

        <div className="filters">
          <button
            className={provider === 'all' ? 'chip active' : 'chip'}
            onClick={() => setProvider('all')}
          >
            All sources
          </button>
          {providers.map((item) => (
            <button
              key={item.id}
              className={provider === item.id ? 'chip active' : 'chip'}
              onClick={() => setProvider(item.id)}
              title={item.sourceNote}
            >
              {item.name}
            </button>
          ))}
        </div>

        <nav className="nav">
          <button className={view === 'search' ? 'nav-item active' : 'nav-item'} onClick={() => setView('search')}>
            Search
          </button>
          <button
            className={view === 'history' ? 'nav-item active' : 'nav-item'}
            onClick={() => {
              void loadHistory();
              setView('history');
            }}
          >
            History {history.length > 0 && <span className="count">{history.length}</span>}
          </button>
          <button className={view === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setView('settings')}>
            Settings
          </button>
        </nav>

        <div className="status-block">
          <span className={status?.mpv.available ? 'dot ok' : 'dot bad'} />
          <span>{status?.mpv.available ? 'mpv ready' : 'mpv missing'}</span>
        </div>
        {status && !status.mpv.available && (
          <p className="hint">Run <code>npm run setup:mpv</code> to install the bundled player.</p>
        )}
      </aside>

      <main className="main">
        {banner && (
          <div className="banner" role="alert">
            <span>{banner}</span>
            <button onClick={() => setBanner(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        {session && <PlayerBar session={session} onAction={act} />}

        {view === 'search' && (
          <section className="pane">
            <header className="pane-head">
              <h1>
                {query.trim()
                  ? `Results for "${query.trim()}"`
                  : results.length
                    ? 'Your library'
                    : 'Find something to watch'}
              </h1>
              {activeProvider && <p className="note">{activeProvider.sourceNote}</p>}
            </header>

            {searchErrors.length > 0 && (
              <div className="warn">
                {searchErrors.map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </div>
            )}

            {!results.length && !searching && (
              <p className="empty">
                Search the streaming index for a title, or switch to Internet Archive for
                public-domain animation that always plays.
              </p>
            )}

            <div className="grid">
              {results.map((result) => (
                <button
                  key={`${result.provider}:${result.id}`}
                  className="card"
                  onClick={() => void openDetail(result.provider, result.id)}
                >
                  <div className="poster">
                    {result.coverUrl ? (
                      <img src={result.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="poster-fallback">{result.title.slice(0, 2)}</span>
                    )}
                  </div>
                  <div className="card-body">
                    <strong>{result.title}</strong>
                    <small>
                      {result.badge ?? result.provider}
                      {result.episodeCount ? ` · ${result.episodeCount} ep` : ''}
                      {result.audio.includes('dub') ? ' · dub' : ''}
                    </small>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {view === 'detail' && detail && (
          <section className="pane">
            <button className="back" onClick={() => setView('search')}>
              ← Back
            </button>
            <div className="detail-head">
              {detail.coverUrl && (
                <img className="detail-poster" src={detail.coverUrl} alt="" referrerPolicy="no-referrer" />
              )}
              <div>
                <h1>{detail.title}</h1>
                <p className="note">
                  {detail.provider} {detail.year ? `· ${detail.year}` : ''}{' '}
                  {detail.episodeCount ? `· ${detail.episodeCount} episodes` : ''}
                </p>
                {detail.description && <p className="description">{detail.description}</p>}

                <div className="audio-toggle" role="group" aria-label="Audio">
                  <button
                    className={audio === 'sub' ? 'seg active' : 'seg'}
                    onClick={() => setAudio('sub')}
                  >
                    Subtitled
                  </button>
                  <button
                    className={audio === 'dub' ? 'seg active' : 'seg'}
                    onClick={() => setAudio('dub')}
                    disabled={!detail.availableAudio.includes('dub')}
                    title={
                      detail.availableAudio.includes('dub')
                        ? 'Play the English dub'
                        : 'No English dub listed for this series'
                    }
                  >
                    English dub
                  </button>
                </div>
                {!detail.availableAudio.includes('dub') && (
                  <p className="hint">No English dub is listed for this series.</p>
                )}
              </div>
            </div>

            <h2 className="section-title">Episodes</h2>
            <div className="episodes">
              {detail.episodes.map((episode) => (
                <button
                  key={episode.number}
                  className="episode"
                  disabled={busy}
                  onClick={() => void playEpisode(episode)}
                >
                  {episode.label}
                </button>
              ))}
            </div>
          </section>
        )}

        {view === 'detail' && !detail && detailLoading && <p className="empty">Loading…</p>}

        {view === 'history' && (
          <section className="pane">
            <header className="pane-head">
              <h1>Watch history</h1>
              {history.length > 0 && (
                <button
                  className="ghost"
                  onClick={async () => {
                    await api.clearHistory();
                    void loadHistory();
                  }}
                >
                  Clear all
                </button>
              )}
            </header>
            {!history.length && <p className="empty">Nothing watched yet.</p>}
            <ul className="history">
              {history.map((entry) => (
                <li key={entry.key}>
                  <div>
                    <strong>
                      {entry.animeTitle} · {entry.episodeLabel}
                    </strong>
                    <small>
                      {entry.audio === 'dub' ? 'Dub' : 'Sub'} ·{' '}
                      {entry.completed ? 'Finished' : `Stopped at ${formatTime(entry.positionSeconds)}`} ·{' '}
                      {new Date(entry.updatedAt).toLocaleString()}
                    </small>
                  </div>
                  <div className="history-actions">
                    <button
                      className="ghost"
                      onClick={() =>
                        void (async () => {
                          setBusy(true);
                          try {
                            const response = await api.play({
                              provider: entry.provider,
                              animeId: entry.animeId,
                              episodeNumber: entry.episodeNumber,
                              audio: entry.audio,
                              startAt: entry.completed ? 0 : entry.positionSeconds,
                            });
                            setSession(response.session);
                          } catch (error) {
                            setBanner((error as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        })()
                      }
                    >
                      Resume
                    </button>
                    <button
                      className="ghost"
                      onClick={async () => {
                        await api.removeHistory(entry.key);
                        void loadHistory();
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {view === 'settings' && settings && (
          <section className="pane narrow">
            <h1>Settings</h1>
            <label className="field">
              <span>Preferred audio</span>
              <select
                value={settings.preferredAudio}
                onChange={(event) => void saveSettings({ preferredAudio: event.target.value as AudioMode })}
              >
                <option value="sub">Subtitled</option>
                <option value="dub">English dub</option>
              </select>
            </label>

            <label className="field row">
              <span>Autoplay next episode</span>
              <input
                type="checkbox"
                checked={settings.autoNext}
                onChange={(event) => void saveSettings({ autoNext: event.target.checked })}
              />
            </label>

            <label className="field">
              <span>Autoplay countdown (seconds)</span>
              <input
                type="number"
                min={0}
                max={60}
                value={settings.autoNextDelaySeconds}
                onChange={(event) =>
                  void saveSettings({ autoNextDelaySeconds: Number(event.target.value) })
                }
              />
            </label>

            <label className="field">
              <span>Preferred quality</span>
              <select
                value={settings.quality}
                onChange={(event) =>
                  void saveSettings({ quality: event.target.value as Settings['quality'] })
                }
              >
                <option value="best">Best available</option>
                <option value="1080">1080p</option>
                <option value="720">720p</option>
                <option value="480">480p</option>
                <option value="worst">Lowest</option>
              </select>
            </label>

            <label className="field row">
              <span>Resume unfinished episodes</span>
              <input
                type="checkbox"
                checked={settings.resumePlayback}
                onChange={(event) => void saveSettings({ resumePlayback: event.target.checked })}
              />
            </label>

            <label className="field">
              <span>Local library folder</span>
              <input
                value={settings.localLibraryDir}
                placeholder="C:\\Videos\\Anime"
                onChange={(event) => setSettings({ ...settings, localLibraryDir: event.target.value })}
                onBlur={(event) => void saveSettings({ localLibraryDir: event.target.value })}
              />
            </label>

            <label className="field">
              <span>mpv executable (blank uses the bundled build)</span>
              <input
                value={settings.mpvPath}
                placeholder="tools\\mpv\\mpv.exe"
                onChange={(event) => setSettings({ ...settings, mpvPath: event.target.value })}
                onBlur={(event) => void saveSettings({ mpvPath: event.target.value })}
              />
            </label>

            <dl className="facts">
              <dt>Version</dt>
              <dd>{status?.version}</dd>
              <dt>Data folder</dt>
              <dd>{status?.dataDir}</dd>
              <dt>mpv</dt>
              <dd>{status?.mpv.version ?? 'not found'}</dd>
            </dl>

            <h2 className="section-title">Sources</h2>
            {providers.map((item) => (
              <div key={item.id} className="source-row">
                <strong>{item.name}</strong>
                <p>{item.description}</p>
                <small>{item.sourceNote}</small>
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

function PlayerBar({
  session,
  onAction,
}: {
  session: PlaybackSession;
  onAction: (action: string, value?: number) => Promise<void>;
}) {
  const [scrub, setScrub] = useState<number | null>(null);
  const percent = session.duration ? Math.min(100, (session.position / session.duration) * 100) : 0;
  const counting = session.state === 'countdown' && session.nextAt;
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!counting) return;
    const tick = () => setRemaining(Math.max(0, Math.round((session.nextAt! - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [counting, session.nextAt]);

  return (
    <section className={`player state-${session.state}`}>
      <div className="player-top">
        <div className="player-title">
          <strong>{session.animeTitle}</strong>
          <small>
            {session.episodeLabel} · {session.audio === 'dub' ? 'English dub' : 'Subtitled'} ·{' '}
            {session.state}
          </small>
        </div>
        <div className="player-buttons">
          <button
            className="ghost"
            disabled={!session.previousEpisode}
            onClick={() => void onAction('previous')}
            title="Previous episode"
          >
            ⏮
          </button>
          <button
            className="primary"
            onClick={() => void onAction(session.paused ? 'resume' : 'pause')}
            disabled={session.state === 'ended' || session.state === 'closed'}
          >
            {session.paused ? 'Resume' : 'Pause'}
          </button>
          <button
            className="ghost"
            disabled={!session.nextEpisode}
            onClick={() => void onAction('next')}
            title="Next episode"
          >
            ⏭
          </button>
          <button className="ghost" onClick={() => void onAction('fullscreen')} title="Fullscreen in mpv">
            ⛶
          </button>
          <button className="ghost" onClick={() => void onAction('stop')} title="Close player">
            ■
          </button>
        </div>
      </div>

      <div className="timeline">
        <span>{formatTime(scrub ?? session.position)}</span>
        <input
          type="range"
          min={0}
          max={session.duration ?? 100}
          step={1}
          value={scrub ?? Math.round(session.position)}
          onChange={(event) => setScrub(Number(event.target.value))}
          onMouseUp={() => {
            if (scrub !== null) {
              void onAction('seek', scrub);
              setScrub(null);
            }
          }}
          onKeyUp={() => {
            if (scrub !== null) {
              void onAction('seek', scrub);
              setScrub(null);
            }
          }}
          style={{ ['--fill' as string]: `${percent}%` }}
          aria-label="Seek"
        />
        <span>{session.duration ? formatTime(session.duration) : '--:--'}</span>
      </div>

      {session.state === 'countdown' && session.nextEpisode && (
        <div className="countdown">
          <span>
            Next: {session.nextEpisode.label} in {remaining}s
          </span>
          <button className="primary" onClick={() => void onAction('skipCountdown')}>
            Play now
          </button>
        </div>
      )}

      {session.state === 'ended' && !session.nextEpisode && (
        <div className="countdown"><span>Series finished.</span></div>
      )}

      {session.error && <div className="countdown error"><span>{session.error}</span></div>}
    </section>
  );
}