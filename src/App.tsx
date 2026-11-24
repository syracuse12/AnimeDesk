import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { api, ApiError, formatTime, skipKey, subscribe } from './api.ts';
import { Player } from './components/Player.tsx';
import { acceptSession } from '../shared/session-merge.ts';
import { LatestRequest, resumeEpisode } from '../shared/selection.ts';
import type {
  AnimeDetail,
  AppStatus,
  AudioMode,
  DiscoverItem,
  DiscoverKind,
  Episode,
  HistoryEntry,
  HomeFeed,
  PlaybackSession,
  ProviderId,
  SearchResult,
  Settings,
  SkipRange,
} from '../shared/types.ts';

type View = 'home' | 'search' | 'detail' | 'watch' | 'history' | 'settings';

const EMPTY_FEED: HomeFeed = { continueWatching: [], recentlyWatched: [], featured: [] };
const SEARCH_DEBOUNCE = 320;
const QUICK_TERMS = ['One Piece', 'Frieren', 'Jujutsu Kaisen', 'Attack on Titan', 'Spy x Family'];
const SUGGEST_DEBOUNCE = 200;

/** Genres offered on the browse strip; AniList uses exactly these spellings. */
const GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mystery',
  'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
];

const ROW_SUB: Record<'trending' | 'top' | 'seasonal', string> = {
  trending: 'What people are watching',
  top: 'Highest rated of all time',
  seasonal: 'Airing this cour',
};

interface DiscoverRow {
  kind: DiscoverKind;
  title: string;
  sub: string;
  items: DiscoverItem[];
}

interface Toast {
  id: number;
  message: string;
  tone: 'error' | 'info';
}

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [view, setView] = useState<View>('home');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchErrors, setSearchErrors] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [provider, setProvider] = useState<ProviderId | 'all'>('all');
  const [detail, setDetail] = useState<AnimeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [audio, setAudio] = useState<AudioMode>('sub');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [feed, setFeed] = useState<HomeFeed>(EMPTY_FEED);
  const [feedLoading, setFeedLoading] = useState(true);
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<{ intro: SkipRange | null; outro: SkipRange | null } | null>(null);
  const [discover, setDiscover] = useState<DiscoverRow[]>([]);
  const [discoverGenre, setDiscoverGenre] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<DiscoverItem[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestActive, setSuggestActive] = useState(-1);
  const [origin, setOrigin] = useState<View>('home');
  const [quality, setQuality] = useState<Settings['quality']>('best');

  const suggestSeq = useRef(0);
  const sessionRef = useRef<PlaybackSession | null>(null);
  const detailRef = useRef<AnimeDetail | null>(null);
  const toastId = useRef(0);
  const lastRun = useRef('');
  const searchSeq = useRef(0);
  const detailSeq = useRef(new LatestRequest());
  const mainRef = useRef<HTMLElement | null>(null);
  const previousView = useRef<View>('home');

  sessionRef.current = session;
  detailRef.current = detail;

  const toast = useCallback((message: string, tone: Toast['tone'] = 'error') => {
    const id = (toastId.current += 1);
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 6000);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const next = await api.status();
      setStatus(next);
      setSettings(next.settings);
      setAudio(next.settings.preferredAudio);
      setQuality(next.settings.quality);
    } catch (error) {
      toast(`Service unreachable: ${(error as Error).message}`);
    }
  }, [toast]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await api.history()).entries);
    } catch {
      /* history is optional */
    }
  }, []);

  const loadFeed = useCallback(async () => {
    try {
      setFeed(await api.home());
    } catch {
      setFeed(EMPTY_FEED);
    } finally {
      setFeedLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadHistory();
    void loadFeed();
  }, [loadStatus, loadHistory, loadFeed]);

  // Discovery is metadata only; it paints the browse rows and every card
  // carries the title to search a real provider for. It never blocks the home
  // feed, and an empty answer just leaves the rows out.
  useEffect(() => {
    if (status && !status.providers.some((item) => item.id !== 'local')) return;
    let live = true;
    const kinds: (keyof typeof ROW_SUB)[] = ['trending', 'top', 'seasonal'];
    const load = async () => {
      const settled = await Promise.allSettled(
        kinds.map(async (kind) => ({ kind, items: (await api.discover(kind)).items })),
      );
      if (!live) return;
      setDiscover(
        settled
          .flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []))
          .filter((row) => row.items.length > 0)
          .map((row) => ({
            kind: row.kind,
            title: row.kind === 'trending' ? 'Trending now' : row.kind === 'top' ? 'Top rated' : 'This season',
            sub: ROW_SUB[row.kind],
            items: row.items,
          })),
      );
    };
    void load();
    return () => {
      live = false;
    };
  }, [status]);

  // Genre browsing replaces the rows with one filtered row.
  const loadGenre = useCallback(async (genre: string) => {
    setDiscoverGenre(genre);
    try {
      const { items } = await api.discover('genre', genre);
      setDiscover([{ kind: 'genre', title: genre, sub: 'Most popular in this genre', items }]);
    } catch (error) {
      toast((error as Error).message);
    }
  }, [toast]);

  // Suggestions follow the query, debounced, and only while the box has focus.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2 || !suggestOpen) {
      setSuggestions([]);
      return;
    }
    const seq = (suggestSeq.current += 1);
    const timer = window.setTimeout(async () => {
      try {
        const { items } = await api.suggest(term);
        if (seq === suggestSeq.current) setSuggestions(items);
      } catch {
        if (seq === suggestSeq.current) setSuggestions([]);
      }
    }, SUGGEST_DEBOUNCE);
    return () => window.clearTimeout(timer);
  }, [query, suggestOpen]);

  // Session updates are pushed by the service; the player is a mirror.
  useEffect(() => {
    return subscribe((next) => {
      setSession((current) => acceptSession(current, next));
      if (next.state === 'ended' || next.state === 'countdown' || next.state === 'closed') {
        void loadHistory();
      }
    }, (message) => toast(message));
  }, [loadHistory, toast]);

  // Keep the watch view pinned to whatever session is live.
  useEffect(() => {
    if (session) setView('watch');
  }, [session?.sessionId]);

  // Move focus to the new screen for keyboard and screen-reader users, but never
  // while the caret is still in the search box (the view changes as you type).
  useEffect(() => {
    const wasSearch = previousView.current === 'search';
    previousView.current = view;
    if (wasSearch || view === 'watch') return;
    // Typing in the search box flips the view to search; moving focus to main
    // would take the caret out of the box and close the suggestion list.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.rail-search-wrap')) return;
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [view]);

  const runSearch = useCallback(
    async (term?: string) => {
      const trimmed = (term ?? query).trim();
      const key = `${provider}|${trimmed}`;
      lastRun.current = key;
      // Keep the list open here: the debounced live search would otherwise close
      // it 320ms after typing, before anyone could pick. Submitting, Escape, a
      // pick and the clear button each close it themselves.
      const seq = (searchSeq.current += 1);
      setSearching(true);
      setSearchErrors([]);
      setResults([]);
      setView('search');
      try {
        const response = await api.search(trimmed, provider === 'all' ? undefined : provider);
        if (seq !== searchSeq.current) return;
        setResults(response.results);
        setSearchErrors(response.errors ?? []);
      } catch (error) {
        if (seq !== searchSeq.current) return;
        toast((error as Error).message);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [provider, query, toast],
  );

  // Live search: typing debounces, submitting runs immediately.
  useEffect(() => {
    if (view !== 'search') return;
    const trimmed = query.trim();
    const key = `${provider}|${trimmed}`;
    if (key === lastRun.current) return;
    const timer = window.setTimeout(() => void runSearch(trimmed), SEARCH_DEBOUNCE);
    return () => window.clearTimeout(timer);
  }, [query, provider, view, runSearch]);

  const openDetail = useCallback(
    async (providerId: ProviderId, id: string) => {
      const seq = detailSeq.current.next();
      setOrigin(view === 'detail' ? origin : view);
      setDetailLoading(true);
      setDetail(null);
      setView('detail');
      try {
        const { anime } = await api.detail(providerId, id);
        if (!detailSeq.current.isCurrent(seq)) return;
        setDetail(anime);
        setManual(null);
        setAudio((current) => (anime.availableAudio.includes(current) ? current : (anime.availableAudio[0] ?? 'sub')));
      } catch (error) {
        if (!detailSeq.current.isCurrent(seq)) return;
        toast((error as Error).message);
      } finally {
        if (detailSeq.current.isCurrent(seq)) setDetailLoading(false);
      }
    },
    [origin, toast, view],
  );

  const playEpisode = useCallback(
    async (episode: Episode, startAt?: number) => {
      const current = detailRef.current;
      if (!current) return;
      setBusy(true);
      try {
        const response = await api.play({
          provider: current.provider,
          animeId: current.id,
          episodeNumber: episode.number,
          audio,
          startAt,
          quality,
        });
        setSession(response.session);
      } catch (error) {
        toast(error instanceof ApiError ? error.message : (error as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [audio, quality, toast],
  );

  const playFromHistory = useCallback(
    async (entry: HistoryEntry) => {
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
        // Load the series behind the player so the rail and Back work.
        const seq = detailSeq.current.next();
        void api
          .detail(entry.provider, entry.animeId)
          .then(({ anime }) => { if (detailSeq.current.isCurrent(seq)) setDetail(anime); })
          .catch(() => undefined);
      } catch (error) {
        toast((error as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const act = useCallback(
    async (action: string, value?: number) => {
      const current = sessionRef.current;
      if (!current) return;
      try {
        await api.action(current.sessionId, action, value);
      } catch (error) {
        toast((error as Error).message);
      }
    },
    [toast],
  );

  const fallbackToMpv = useCallback(
    async (reason: string) => {
      const current = sessionRef.current;
      if (!current || !status?.mpv.available) {
        toast(reason || 'mpv is not installed', 'info');
        return;
      }
      try {
        const response = await api.play({
          provider: current.provider,
          animeId: current.animeId,
          episodeNumber: current.episodeNumber,
          audio: current.audio,
          startAt: current.position,
          mode: 'external',
        });
        setSession(response.session);
        toast('Opened in mpv', 'info');
      } catch (error) {
        toast(`mpv fallback failed: ${(error as Error).message}`);
      }
    },
    [status?.mpv.available, toast],
  );

  const saveSettings = useCallback(
    async (patch: Partial<Settings>) => {
      try {
        const response = await api.saveSettings(patch);
        setSettings(response.settings);
        setAudio(response.settings.preferredAudio);
      } catch (error) {
        toast((error as Error).message);
      }
    },
    [toast],
  );

  const saveManualSkip = useCallback(
    async (intro: SkipRange | null, outro: SkipRange | null) => {
      const current = sessionRef.current ?? (detail ? { provider: detail.provider, animeId: detail.id } : null);
      if (!current) return;
      const episodeNumber = sessionRef.current?.episodeNumber ?? detail?.episodes[0]?.number ?? 1;
      const key = skipKey(current.provider, current.animeId, episodeNumber, audio);
      try {
        await api.saveManualSkip(key, intro, outro);
        setManual({ intro, outro });
        toast('Skip ranges saved for this episode', 'info');
      } catch (error) {
        toast((error as Error).message);
      }
    },
    [audio, detail, toast],
  );

  const providers = status?.providers ?? [];
  const watched = useMemo(() => {
    const map = new Map<string, HistoryEntry>();
    for (const entry of history) {
      const id = `${entry.provider}:${entry.animeId}`;
      if (!map.has(id)) map.set(id, entry);
    }
    return map;
  }, [history]);

  const progressFor = useCallback(
    (episode: number): HistoryEntry | undefined =>
      history.find(
        (entry) =>
          detail &&
          entry.provider === detail.provider &&
          entry.animeId === detail.id &&
          entry.episodeNumber === episode &&
          entry.audio === audio,
      ),
    [audio, detail, history],
  );

  const resumeTarget = useMemo(() => {
    if (!detail) return null;
    return resumeEpisode(detail, progressFor);
  }, [detail, progressFor]);

  const goSearch = useCallback(
    (term: string) => {
      setQuery(term);
      void runSearch(term);
    },
    [runSearch],
  );

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>

      <aside className="rail">
        <button className="brand" onClick={() => setView('home')} aria-label="AnimeDesk home">
          <span className="brand-mark">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M4 5h16v14H4z" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" />
            </svg>
          </span>
          <span className="brand-text">
            <strong>AnimeDesk</strong>
            <small>{status ? `v${status.version}` : 'connecting'}</small>
          </span>
        </button>

        <div className="rail-search-wrap">
          <form
            className="rail-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              setSuggestOpen(false);
              void runSearch();
            }}
          >
          <button type="button" className="mobile-search-trigger" onClick={() => setView('search')} aria-label="Search catalogue">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" className="search-icon">
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setView('search');
              setSuggestOpen(true);
              setSuggestActive(-1);
            }}
            onFocus={() => {
              if (view !== 'search') setView('search');
              setSuggestOpen(true);
            }}
            onBlur={() => window.setTimeout(() => setSuggestOpen(false), 120)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSuggestOpen(false);
                return;
              }
              if (!suggestions.length) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setSuggestActive((current) => Math.min(suggestions.length - 1, Math.max(-1, current + step)));
              } else if (event.key === 'Enter' && suggestActive >= 0) {
                const pick = suggestions[suggestActive];
                if (pick) {
                  event.preventDefault();
                  setSuggestOpen(false);
                  goSearch(pick.searchTitle);
                }
              }
            }}
            placeholder="Search anime"
            maxLength={120}
            aria-label="Search anime"
            aria-expanded={suggestOpen && suggestions.length > 0}
            aria-autocomplete="list"
            enterKeyHint="search"
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery('');
                setResults([]);
                setSearchErrors([]);
                lastRun.current = `${provider}|`;
              }}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </form>

        {suggestOpen && suggestions.length > 0 && (
          <ul className="suggest" role="listbox" aria-label="Title suggestions">
            {suggestions.map((item, index) => (
              <li key={item.id ?? item.title} role="option" aria-selected={index === suggestActive}>
                <button
                  type="button"
                  className={index === suggestActive ? 'suggest-row active' : 'suggest-row'}
                  onMouseEnter={() => setSuggestActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setSuggestOpen(false);
                    goSearch(item.searchTitle);
                  }}
                >
                  <span className="suggest-art">
                    {item.coverUrl && <img src={item.coverUrl} alt="" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} />}
                  </span>
                  <span className="suggest-text">
                    <strong>{item.title}</strong>
                    <small>{[item.year, item.format].filter(Boolean).join(' \u00b7 ') || 'Anime'}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        </div>

        <nav className="rail-nav" aria-label="Main">
          <RailLink active={view === 'home'} onClick={() => setView('home')} label="Home" icon={<HomeIcon />} />
          <RailLink active={view === 'search'} onClick={() => void runSearch()} label="Catalogue" icon={<GridIcon />} />
          <RailLink
            active={view === 'history'}
            onClick={() => {
              void loadHistory();
              setView('history');
            }}
            label="History"
            icon={<ClockIcon />}
            count={history.length}
          />
          <RailLink active={view === 'settings'} onClick={() => setView('settings')} label="Settings" icon={<GearIcon />} />
        </nav>

        <div className="rail-sources" role="group" aria-label="Sources">
          <span className="rail-label">Sources</span>
          <button
            className={provider === 'all' ? 'pill active' : 'pill'}
            onClick={() => setProvider('all')}
            aria-pressed={provider === 'all'}
          >
            All
          </button>
          {providers.map((item) => (
            <button
              key={item.id}
              className={provider === item.id ? 'pill active' : 'pill'}
              onClick={() => setProvider(item.id)}
              title={item.sourceNote}
              aria-pressed={provider === item.id}
            >
              {item.name}
            </button>
          ))}
        </div>

        <div className="rail-foot">
          <span className={status?.mpv.available ? 'dot ok' : 'dot warn'} aria-hidden="true" />
          <span>{status?.mpv.available ? 'mpv fallback ready' : 'in-app only'}</span>
        </div>
      </aside>

      <main className="main" id="main" ref={mainRef} tabIndex={-1}>
        {view === 'home' && (
          <Home
            feed={feed}
            loading={feedLoading}
            discover={discover}
            genre={discoverGenre}
            onGenre={loadGenre}
            onOpen={openDetail}
            onResume={playFromHistory}
            onBrowse={() => void runSearch('')}
            onSearch={goSearch}
          />
        )}

        {view === 'search' && (
          <section className="page">
            <header className="page-head">
              <div>
                <h1>{query.trim() ? `Results for \u201c${query.trim()}\u201d` : 'Catalogue'}</h1>
                <p className="sub">
                  {provider === 'all' ? 'Searching every source' : `Searching ${provider}`}
                  {!searching && results.length > 0 && ` \u00b7 ${results.length} titles`}
                </p>
              </div>
            </header>

            <form className="mobile-search" role="search" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search anime"
                maxLength={120}
                aria-label="Search anime"
                enterKeyHint="search"
              />
              <button className="btn primary" type="submit">Search</button>
            </form>

            {searchErrors.length > 0 && (
              <div className="notice" role="status">
                {searchErrors.map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </div>
            )}

            <p className="sr-only" aria-live="polite">
              {searching ? 'Searching' : `${results.length} results`}
            </p>

            {searching && <GridSkeleton />}

            {!searching && !results.length && (
              <div className="empty-state">
                <span className="empty-mark" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22">
                    <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </span>
                <h2>{query.trim() ? 'Nothing matched' : 'Search for a title'}</h2>
                <p>
                  {query.trim()
                    ? 'Try a shorter title, or switch to the Internet Archive for public-domain animation that always plays.'
                    : 'Use the search box, or browse your local library with an empty query.'}
                </p>
              </div>
            )}

            {!searching && results.length > 0 && (
              <div className="poster-grid" onKeyDown={gridKeys}>
                {results.map((result) => (
                  <PosterCard
                    key={`${result.provider}:${result.id}`}
                    title={result.title}
                    cover={result.coverUrl}
                    badge={result.badge ?? result.provider}
                    meta={[
                      result.year,
                      result.episodeCount ? `${result.episodeCount} episodes` : '',
                      result.audio.includes('dub') ? 'Dub & Sub' : 'Sub',
                    ]
                      .filter(Boolean)
                      .join(' \u00b7 ')}
                    onClick={() => void openDetail(result.provider, result.id)}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {view === 'detail' && detailLoading && <DetailSkeleton />}

        {view === 'detail' && detail && !detailLoading && (
          <DetailPage
            detail={detail}
            audio={audio}
            setAudio={setAudio}
            busy={busy}
            progressFor={progressFor}
            resumeTarget={resumeTarget}
            currentEpisode={session?.episodeNumber ?? null}
            watched={watched.get(`${detail.provider}:${detail.id}`)}
            onPlay={playEpisode}
            onBack={() => setView(origin)}
            quality={quality}
            setQuality={setQuality}
            manual={manual}
            onSaveManual={saveManualSkip}
          />
        )}

        {view === 'watch' && session && settings && (
          <section className="watch">
            {session.mode === 'embedded' ? (
              <Player
                session={session}
                settings={settings}
                onFallback={(reason) => void fallbackToMpv(reason)}
                onLeave={() => setView('detail')}
                onAction={act}
              />
            ) : (
              <ExternalStage session={session} onLeave={() => setView('detail')} onAction={act} />
            )}

            <EpisodeRail
              detail={detail}
              current={session.episodeNumber}
              audio={session.audio}
              progressFor={progressFor}
              busy={busy}
              onPick={(episode) => void playEpisode(episode)}
            />
          </section>
        )}

        {view === 'history' && (
          <section className="page">
            <header className="page-head row">
              <div>
                <h1>History</h1>
                <p className="sub">Everything you have started, newest first.</p>
              </div>
              {history.length > 0 && (
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      await api.clearHistory();
                      void loadHistory();
                      void loadFeed();
                    } catch (error) { toast(`Could not clear history: ${(error as Error).message}`); }
                  }}
                >
                  Clear all
                </button>
              )}
            </header>
            {!history.length && (
              <div className="empty-state">
                <span className="empty-mark" aria-hidden="true">
                  <ClockIcon />
                </span>
                <h2>Nothing watched yet</h2>
                <p>Start an episode and it will appear here with your position.</p>
              </div>
            )}
            <ul className="rows">
              {history.map((entry) => (
                <li key={entry.key}>
                  <div className="row-thumb">
                    <span className="poster-fallback">{entry.animeTitle.slice(0, 2)}</span>
                    {entry.coverUrl && (
                      <img
                        src={entry.coverUrl}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={(event) => { event.currentTarget.hidden = true; }}
                      />
                    )}
                  </div>
                  <div className="row-main">
                    <strong>
                      {entry.animeTitle} · {entry.episodeLabel}
                    </strong>
                    <small>
                      {entry.audio === 'dub' ? 'Dub' : 'Sub'} ·{' '}
                      {entry.completed ? 'Finished' : `Stopped at ${formatTime(entry.positionSeconds)}`} ·{' '}
                      {new Date(entry.updatedAt).toLocaleString()}
                    </small>
                    <div className="bar">
                      <span
                        style={{
                          width: `${
                            entry.durationSeconds
                              ? Math.min(100, (entry.positionSeconds / entry.durationSeconds) * 100)
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                  <div className="row-actions">
                    <button className="btn small primary" onClick={() => void playFromHistory(entry)}>
                      {entry.completed ? 'Play again' : 'Resume'}
                    </button>
                    <button
                      className="btn small"
                      onClick={async () => {
                        try {
                          await api.removeHistory(entry.key);
                          void loadHistory();
                          void loadFeed();
                        } catch (error) { toast(`Could not remove history: ${(error as Error).message}`); }
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
          <section className="page narrow">
            <header className="page-head">
              <h1>Settings</h1>
              <p className="sub">Stored locally in {status?.dataDir}</p>
            </header>

            <fieldset className="group">
              <legend>Playback</legend>
              <Toggle
                label="Play inside AnimeDesk"
                hint="Off sends every episode to the mpv window instead."
                checked={settings.embeddedPlayer}
                onChange={(value) => void saveSettings({ embeddedPlayer: value })}
              />
              <Toggle
                label="Autoplay next episode"
                hint="Uses the real end of the episode, with a countdown you can cancel."
                checked={settings.autoNext}
                onChange={(value) => void saveSettings({ autoNext: value })}
              />
              <label className="field">
                <span>Autoplay countdown (seconds)</span>
                <input
                  type="number"
                  min={0}
                  max={60}
                  value={settings.autoNextDelaySeconds}
                  onChange={(event) => void saveSettings({ autoNextDelaySeconds: Number(event.target.value) })}
                />
              </label>
              <Toggle
                label="Resume unfinished episodes"
                checked={settings.resumePlayback}
                onChange={(value) => void saveSettings({ resumePlayback: value })}
              />
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
              <label className="field">
                <span>Preferred quality</span>
                <select
                  value={settings.quality}
                  onChange={(event) => void saveSettings({ quality: event.target.value as Settings['quality'] })}
                >
                  <option value="best">Best available</option>
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                  <option value="480">480p</option>
                  <option value="worst">Lowest</option>
                </select>
              </label>
            </fieldset>

            <fieldset className="group">
              <legend>Intro &amp; outro</legend>
              <Toggle
                label="Look up skip times"
                hint="Queries AniSkip with a MyAnimeList id matched from the title."
                checked={settings.aniskipEnabled}
                onChange={(value) => void saveSettings({ aniskipEnabled: value })}
              />
              <Toggle
                label="Automatically skip intros"
                hint="Off by default. The button stays available either way."
                checked={settings.autoSkipIntro}
                onChange={(value) => void saveSettings({ autoSkipIntro: value })}
              />
              <Toggle
                label="Automatically skip outros"
                hint="Jumps to the end of the ending; autoplay still waits for the real end."
                checked={settings.autoSkipOutro}
                onChange={(value) => void saveSettings({ autoSkipOutro: value })}
              />
            </fieldset>

            <fieldset className="group">
              <legend>Library</legend>
              <label className="field">
                <span>Local library folder</span>
                <input
                  defaultValue={settings.localLibraryDir}
                  placeholder="C:\Videos\Anime"
                  onBlur={(event) => void saveSettings({ localLibraryDir: event.target.value })}
                />
              </label>
              <label className="field">
                <span>mpv executable (blank uses the bundled build)</span>
                <input
                  defaultValue={settings.mpvPath}
                  placeholder="tools\mpv\mpv.exe"
                  onBlur={(event) => void saveSettings({ mpvPath: event.target.value })}
                />
              </label>
            </fieldset>

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

      <div className="toasts" aria-live="assertive">
        {toasts.map((item) => (
          <div key={item.id} className={`toast ${item.tone}`} role="alert">
            <span>{item.message}</span>
            <button onClick={() => setToasts((current) => current.filter((t) => t.id !== item.id))} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Arrow-key movement inside a poster grid, so results are reachable without a mouse. */
function gridKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
  const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'];
  if (!keys.includes(event.key)) return;
  const cards = [...event.currentTarget.querySelectorAll<HTMLElement>('.poster-card')];
  const index = cards.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  event.preventDefault();
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? 4 : -4;
  const next = cards[Math.min(cards.length - 1, Math.max(0, index + step))];
  next?.focus();
}

/* ---------- home ---------- */

function Home({
  feed,
  loading,
  discover,
  genre,
  onGenre,
  onOpen,
  onResume,
  onBrowse,
  onSearch,
}: {
  feed: HomeFeed;
  loading: boolean;
  discover: DiscoverRow[];
  genre: string | null;
  onGenre: (genre: string) => Promise<void>;
  onOpen: (provider: ProviderId, id: string) => Promise<void>;
  onResume: (entry: HistoryEntry) => Promise<void>;
  onBrowse: () => void;
  onSearch: (term: string) => void;
}) {
  const hero = feed.featured[0] ?? null;
  const strip = feed.featured.slice(1);
  const art = hero?.bannerUrl ?? hero?.coverUrl;

  if (loading) return <HomeSkeleton />;

  return (
    <section className="home">
      {hero ? (
        <header className="hero">
          {art && <img className="hero-art" src={art} alt="" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} />}
          <div className="hero-shade" />
          <div className="hero-body">
            <span className="eyebrow">Featured today</span>
            <h1>{hero.title}</h1>
            <p className="hero-meta">
              {[hero.year, `${hero.episodeCount ?? hero.episodes.length} episodes`, hero.availableAudio.includes('dub') ? 'Dub & Sub' : 'Sub']
                .filter(Boolean)
                .join(' \u00b7 ')}
            </p>
            {hero.description && <p className="hero-desc">{hero.description}</p>}
            <div className="hero-actions">
              <button className="btn primary large" onClick={() => void onOpen(hero.provider, hero.id)}>
                View episodes
              </button>
            </div>
          </div>
        </header>
      ) : (
        <header className="hero plain">
          <div className="hero-body">
            <span className="eyebrow">AnimeDesk</span>
            <h1>Your desk, your queue.</h1>
            <p className="hero-desc">
              Search a catalogue, pick a dub or a sub, and watch without leaving the app.
            </p>
            <div className="hero-actions">
              <button className="btn primary large" onClick={onBrowse}>
                Browse catalogue
              </button>
            </div>
          </div>
        </header>
      )}

      {discover.length > 0 && (
        <div className="genre-strip" role="group" aria-label="Browse by genre">
          {GENRES.map((name) => (
            <button
              key={name}
              className={genre === name ? 'genre-chip active' : 'genre-chip'}
              aria-pressed={genre === name}
              onClick={() => void onGenre(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {feed.continueWatching.length > 0 && (
        <Row title="Continue watching" sub="Pick up where you stopped">
          {feed.continueWatching.map((entry) => (
            <ContinueCard key={entry.key} entry={entry} onResume={onResume} />
          ))}
        </Row>
      )}

      {feed.recentlyWatched.length > 0 && (
        <Row title="Recently watched" sub="Jump back in">
          {feed.recentlyWatched.map((entry) => (
            <ContinueCard key={entry.key} entry={entry} onResume={onResume} compact />
          ))}
        </Row>
      )}

      {strip.length > 0 && (
        <Row title="Trending now" sub="Popular on the index">
          {strip.map((item) => (
            <PosterCard
              key={item.id}
              title={item.title}
              cover={item.coverUrl}
              meta={[item.year, `${item.episodes.length} episodes`].filter(Boolean).join(' \u00b7 ')}
              onClick={() => void onOpen(item.provider, item.id)}
            />
          ))}
        </Row>
      )}

      {discover.map((row) => (
        <section className="row-block discover-row" key={`${row.kind}:${row.title}`}>
          <header className="row-head">
            <h2>{row.title}</h2>
            <span>{row.sub}</span>
          </header>
          <div className="row-scroll">
            {row.items.map((item) => (
              <PosterCard
                key={item.id ?? item.title}
                title={item.title}
                cover={item.coverUrl}
                meta={[item.year, item.format, item.score ? `${item.score}%` : ''].filter(Boolean).join(' \u00b7 ')}
                onClick={() => onSearch(item.searchTitle)}
              />
            ))}
          </div>
          <p className="row-note">Tap a title to search the catalogue for it.</p>
        </section>
      ))}

      <Row title="Quick search" sub="One tap">
        {QUICK_TERMS.map((term) => (
          <button key={term} className="quick" onClick={() => onSearch(term)}>
            {term}
          </button>
        ))}
      </Row>
    </section>
  );
}

function Row({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="row-block">
      <header className="row-head">
        <h2>{title}</h2>
        {sub && <span>{sub}</span>}
      </header>
      <div className="row-scroll">{children}</div>
    </section>
  );
}

function ContinueCard({
  entry,
  onResume,
  compact,
}: {
  entry: HistoryEntry;
  onResume: (entry: HistoryEntry) => Promise<void>;
  compact?: boolean;
}) {
  const percent = entry.durationSeconds
    ? Math.min(100, (entry.positionSeconds / entry.durationSeconds) * 100)
    : 0;
  const left = entry.durationSeconds ? Math.max(0, entry.durationSeconds - entry.positionSeconds) : 0;
  return (
    <button className={compact ? 'continue compact' : 'continue'} onClick={() => void onResume(entry)}>
      <div className="continue-art">
        <span className="poster-fallback">{entry.animeTitle.slice(0, 2)}</span>
        {entry.coverUrl && <img src={entry.coverUrl} alt="" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} />}
        <span className="continue-play"><PlayIcon /></span>
        <div className="continue-bar"><span style={{ width: `${percent}%` }} /></div>
      </div>
      <strong>{entry.animeTitle}</strong>
      <small>
        {entry.episodeLabel}
        {entry.completed
          ? ' \u00b7 Finished'
          : ` \u00b7 ${formatTime(entry.positionSeconds)} left off${left ? ` \u00b7 ${formatTime(left)} to go` : ''}`}
      </small>
    </button>
  );
}

function PosterCard({
  title,
  cover,
  meta,
  badge,
  onClick,
}: {
  title: string;
  cover?: string;
  meta?: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button className="poster-card" onClick={onClick}>
      <div className="poster">
        <span className="poster-fallback">{title.slice(0, 2)}</span>
        {cover && <img src={cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} />}
        {badge && <span className="poster-badge">{badge}</span>}
        <span className="poster-play" aria-hidden="true"><PlayIcon /></span>
      </div>
      <strong>{title}</strong>
      {meta && <small>{meta}</small>}
    </button>
  );
}

/* ---------- detail ---------- */

function DetailPage({
  detail,
  audio,
  setAudio,
  busy,
  progressFor,
  resumeTarget,
  currentEpisode,
  watched,
  onPlay,
  onBack,
  quality,
  setQuality,
  manual,
  onSaveManual,
}: {
  detail: AnimeDetail;
  audio: AudioMode;
  setAudio: (mode: AudioMode) => void;
  busy: boolean;
  progressFor: (episode: number) => HistoryEntry | undefined;
  resumeTarget: Episode | null;
  currentEpisode: number | null;
  watched?: HistoryEntry;
  onPlay: (episode: Episode, startAt?: number) => Promise<void>;
  onBack: () => void;
  quality: Settings['quality'];
  setQuality: (quality: Settings['quality']) => void;
  manual: { intro: SkipRange | null; outro: SkipRange | null } | null;
  onSaveManual: (intro: SkipRange | null, outro: SkipRange | null) => Promise<void>;
}) {
  const resumeEntry = resumeTarget ? progressFor(resumeTarget.number) : undefined;
  const done = detail.episodes.filter((episode) => progressFor(episode.number)?.completed).length;
  const art = detail.bannerUrl ?? detail.coverUrl;
  const groups = groupEpisodes(detail.episodes);

  return (
    <section className="detail">
      <div className="detail-hero">
        {art && <img className="detail-backdrop" src={art} alt="" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} />}
        <div className="detail-shade" />
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M14.5 5.5L8 12l6.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          Back
        </button>

        <div className="detail-body">
          <div className="detail-poster-wrap">
            <span className="poster-fallback">{detail.title.slice(0, 2)}</span>
            {detail.coverUrl && <img className="detail-poster" src={detail.coverUrl} alt="" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} />}
          </div>
          <div className="detail-text">
            <h1>{detail.title}</h1>
            <div className="chips">
              {detail.year && <span className="chip">{detail.year}</span>}
              <span className="chip">{detail.episodes.length} episodes</span>
              {detail.availableAudio.includes('dub') ? (
                <span className="chip accent">Dub &amp; Sub</span>
              ) : (
                <span className="chip">Sub only</span>
              )}
              <span className="chip muted">{detail.provider}</span>
            </div>
            {detail.description && <p className="detail-desc">{detail.description}</p>}

            <div className="detail-actions">
              {resumeTarget && (
                <button
                  className="btn primary large"
                  disabled={busy}
                  onClick={() => void onPlay(resumeTarget, resumeEntry?.completed ? 0 : undefined)}
                >
                  <PlayIcon />
                  {resumeEntry && !resumeEntry.completed
                    ? `Resume ${resumeTarget.label} \u00b7 ${formatTime(resumeEntry.positionSeconds)}`
                    : `Play ${resumeTarget.label}`}
                </button>
              )}
              <div className="audio-switch" role="group" aria-label="Audio">
                <button className={audio === 'sub' ? 'seg active' : 'seg'} onClick={() => setAudio('sub')} aria-pressed={audio === 'sub'}>
                  Subtitled
                </button>
                <button
                  className={audio === 'dub' ? 'seg active' : 'seg'}
                  onClick={() => setAudio('dub')}
                  disabled={!detail.availableAudio.includes('dub')}
                  aria-pressed={audio === 'dub'}
                  title={detail.availableAudio.includes('dub') ? 'English dub' : 'No dub listed'}
                >
                  English dub
                </button>
              </div>
              <label className="quality-pick">
                <span>Quality</span>
                <select
                  value={quality}
                  onChange={(event) => setQuality(event.target.value as Settings['quality'])}
                  aria-label="Stream quality for the next episode"
                >
                  <option value="best">Best</option>
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                  <option value="480">480p</option>
                  <option value="worst">Lowest</option>
                </select>
              </label>
            </div>

            {!detail.availableAudio.includes('dub') && (
              <p className="hint">No English dub is listed for this series.</p>
            )}
            {watched && !watched.completed && (
              <p className="hint">
                Last watched {watched.episodeLabel} at {formatTime(watched.positionSeconds)}.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="detail-lower">
        <header className="row-head">
          <h2>Episodes</h2>
          <span>
            {done} of {detail.episodes.length} watched
          </span>
        </header>

        {groups.map((group) => (
          <div className="episode-group" key={group.start}>
            {groups.length > 1 && (
              <p className="episode-group-label">
                Episodes {group.start}\u2013{group.end}
              </p>
            )}
            <div className="episode-grid">
              {group.episodes.map((episode) => {
                const entry = progressFor(episode.number);
                const percent = entry?.durationSeconds
                  ? Math.min(100, (entry.positionSeconds / entry.durationSeconds) * 100)
                  : 0;
                return (
                  <button
                    key={episode.number}
                    className={[
                      'episode',
                      entry?.completed ? 'done' : '',
                      currentEpisode === episode.number ? 'current' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    disabled={busy}
                    onClick={() => void onPlay(episode, entry?.completed ? 0 : undefined)}
                    title={episode.label}
                  >
                    <span className="episode-num">{String(episode.number).padStart(2, '0')}</span>
                    <span className="episode-label">{episode.title ?? episode.label}</span>
                    {entry?.completed && <span className="episode-tick">Watched</span>}
                    {percent > 0 && !entry?.completed && (
                      <span className="episode-progress"><span style={{ width: `${percent}%` }} /></span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <details className="manual-skip">
          <summary>Manual skip ranges</summary>
          <p className="hint">
            Used when AniSkip has no data for this episode. Saved per episode and audio track.
          </p>
          <ManualSkipEditor manual={manual} onSave={onSaveManual} />
        </details>
      </div>
    </section>
  );
}

/** Long series get readable blocks of fifty instead of one endless wall. */
function groupEpisodes(episodes: Episode[]): { start: number; end: number; episodes: Episode[] }[] {
  if (episodes.length <= 50) {
    return [{ start: episodes[0]?.number ?? 1, end: episodes[episodes.length - 1]?.number ?? 0, episodes }];
  }
  const groups: { start: number; end: number; episodes: Episode[] }[] = [];
  for (let index = 0; index < episodes.length; index += 50) {
    const slice = episodes.slice(index, index + 50);
    groups.push({ start: slice[0]?.number ?? index + 1, end: slice[slice.length - 1]?.number ?? index + 50, episodes: slice });
  }
  return groups;
}

function ManualSkipEditor({
  manual,
  onSave,
}: {
  manual: { intro: SkipRange | null; outro: SkipRange | null } | null;
  onSave: (intro: SkipRange | null, outro: SkipRange | null) => Promise<void>;
}) {
  const [intro, setIntro] = useState({ start: '', end: '' });
  const [outro, setOutro] = useState({ start: '', end: '' });

  useEffect(() => {
    setIntro({
      start: manual?.intro ? String(manual.intro.start) : '',
      end: manual?.intro ? String(manual.intro.end) : '',
    });
    setOutro({
      start: manual?.outro ? String(manual.outro.start) : '',
      end: manual?.outro ? String(manual.outro.end) : '',
    });
  }, [manual]);

  const parse = (value: { start: string; end: string }): SkipRange | null => {
    if (!value.start.trim() || !value.end.trim()) return null;
    const start = Number(value.start);
    const end = Number(value.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { start, end };
  };

  return (
    <div className="skip-editor">
      <div className="skip-pair">
        <span>Intro</span>
        <input placeholder="start s" value={intro.start} onChange={(e) => setIntro({ ...intro, start: e.target.value })} />
        <input placeholder="end s" value={intro.end} onChange={(e) => setIntro({ ...intro, end: e.target.value })} />
      </div>
      <div className="skip-pair">
        <span>Outro</span>
        <input placeholder="start s" value={outro.start} onChange={(e) => setOutro({ ...outro, start: e.target.value })} />
        <input placeholder="end s" value={outro.end} onChange={(e) => setOutro({ ...outro, end: e.target.value })} />
      </div>
      <div className="row">
        <button className="btn small primary" onClick={() => void onSave(parse(intro), parse(outro))}>
          Save ranges
        </button>
        <button
          className="btn small"
          onClick={() => {
            setIntro({ start: '', end: '' });
            setOutro({ start: '', end: '' });
            void onSave(null, null);
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

/* ---------- watch extras ---------- */

function ExternalStage({
  session,
  onLeave,
  onAction,
}: {
  session: PlaybackSession;
  onLeave: () => void;
  onAction: (action: string, value?: number) => Promise<void>;
}) {
  const percent = session.duration ? Math.min(100, (session.position / session.duration) * 100) : 0;
  const [remaining, setRemaining] = useState(0);
  const counting = session.state === 'countdown' && session.nextAt;

  useEffect(() => {
    if (!counting) return;
    const tick = () => setRemaining(Math.max(0, Math.round((session.nextAt! - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 400);
    return () => window.clearInterval(timer);
  }, [counting, session.nextAt]);

  return (
    <section className="external-stage">
      <div className="external-body">
        <span className="eyebrow">Playing in mpv</span>
        <h2>{session.animeTitle}</h2>
        <p className="sub">
          {session.episodeLabel} · {session.audio === 'dub' ? 'English dub' : 'Subtitled'} · {session.state}
        </p>
        <p className="hint">
          This source is running in the separate mpv window. Use its own controls for volume and
          fullscreen; the bar below mirrors progress and drives the episode hand-off.
        </p>
        <div className="bar big"><span style={{ width: `${percent}%` }} /></div>
        <div className="row">
          <button className="btn" disabled={!session.previousEpisode} onClick={() => void onAction('previous')}>
            Previous
          </button>
          <button className="btn primary" onClick={() => void onAction(session.paused ? 'resume' : 'pause')}>
            {session.paused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn" disabled={!session.nextEpisode} onClick={() => void onAction('next')}>
            Next
          </button>
          <button className="btn ghost" onClick={onLeave}>Back to series</button>
        </div>
        {counting && session.nextEpisode && (
          <div className="notice info">
            Next: {session.nextEpisode.label} in {remaining}s{' '}
            <button className="btn small primary" onClick={() => void onAction('skipCountdown')}>Play now</button>{' '}
            <button className="btn small" onClick={() => void onAction('cancelCountdown')}>Cancel</button>
          </div>
        )}
        {session.error && <div className="notice">{session.error}</div>}
      </div>
    </section>
  );
}

function EpisodeRail({
  detail,
  current,
  audio,
  progressFor,
  busy,
  onPick,
}: {
  detail: AnimeDetail | null;
  current: number;
  audio: AudioMode;
  progressFor: (episode: number) => HistoryEntry | undefined;
  busy: boolean;
  onPick: (episode: Episode) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = ref.current?.querySelector('.episode.current');
    node?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [current]);

  if (!detail) return null;

  return (
    <section className="watch-rail">
      <header className="row-head">
        <h2>{detail.title}</h2>
        <span>
          {detail.episodes.length} episodes · {audio === 'dub' ? 'Dub' : 'Sub'}
        </span>
      </header>
      <div className="episode-grid small" ref={ref}>
        {detail.episodes.map((episode) => {
          const entry = progressFor(episode.number);
          return (
            <button
              key={episode.number}
              className={[
                'episode',
                entry?.completed ? 'done' : '',
                current === episode.number ? 'current' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={busy}
              onClick={() => onPick(episode)}
              aria-current={current === episode.number ? 'true' : undefined}
            >
              <span className="episode-num">{String(episode.number).padStart(2, '0')}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ---------- shared bits ---------- */

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle">
      <span className="toggle-text">
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}

function RailLink({
  active,
  onClick,
  label,
  icon,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: ReactNode;
  count?: number;
}) {
  return (
    <button className={active ? 'rail-link active' : 'rail-link'} onClick={onClick} aria-current={active ? 'page' : undefined}>
      {icon}
      <span>{label}</span>
      {count ? <span className="count">{count}</span> : null}
    </button>
  );
}

function GridSkeleton() {
  return (
    <div className="poster-grid">
      {Array.from({ length: 12 }, (_, index) => (
        <div key={index} className="poster-card skeleton">
          <div className="poster shimmer" />
          <div className="line shimmer" />
          <div className="line short shimmer" />
        </div>
      ))}
    </div>
  );
}

function HomeSkeleton() {
  return (
    <section className="home">
      <div className="hero skeleton"><div className="hero-shade" /></div>
      <div className="row-block">
        <div className="line wide shimmer" />
        <div className="row-scroll">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="poster-card skeleton">
              <div className="poster shimmer" />
              <div className="line shimmer" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DetailSkeleton() {
  return (
    <section className="detail">
      <div className="detail-hero skeleton"><div className="detail-shade" /></div>
      <div className="detail-lower">
        <div className="line wide shimmer" />
        <div className="episode-grid">
          {Array.from({ length: 12 }, (_, index) => (
            <div key={index} className="skeleton-episode shimmer" />
          ))}
        </div>
      </div>
    </section>
  );
}

const iconStroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
    </svg>
  );
}
function HomeIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 11l8-7 8 7v9H4z" {...iconStroke} /></svg>;
}
function GridIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" {...iconStroke} /></svg>;
}
function ClockIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="12" cy="12" r="8" {...iconStroke} /><path d="M12 8v4.5l3 1.5" {...iconStroke} /></svg>;
}
function GearIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="12" cy="12" r="3.2" {...iconStroke} /><path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.9l1.9 1.1M17.2 15l1.9 1.1M4.9 16.1l1.9-1.1M17.2 9l1.9-1.1" {...iconStroke} /></svg>;
}
