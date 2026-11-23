import type {
  AnimeDetail,
  AppStatus,
  AudioMode,
  HistoryEntry,
  HomeFeed,
  PlaybackMode,
  PlaybackSession,
  SearchResult,
  Settings,
  SkipRange,
} from '../shared/types.ts';

const BASE = '/api';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; detail?: string };
      message = body.detail ? `${body.error}: ${body.detail}` : (body.error ?? message);
    } catch {
      /* keep the status text */
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  status: () => request<AppStatus>('/status'),
  home: () => request<HomeFeed>('/home'),
  search: (query: string, provider?: string) =>
    request<{ results: SearchResult[]; errors?: string[] }>(
      `/search?q=${encodeURIComponent(query)}${provider ? `&provider=${provider}` : ''}`,
    ),
  detail: (provider: string, id: string) =>
    request<{ anime: AnimeDetail }>(`/anime/${provider}/${encodeURIComponent(id)}`),
  play: (body: {
    provider: string;
    animeId: string;
    episodeNumber: number;
    audio: AudioMode;
    startAt?: number;
    mode?: PlaybackMode;
  }) => request<{ session: PlaybackSession }>('/play', { method: 'POST', body: JSON.stringify(body) }),
  direct: (body: { title: string; url: string; audio: AudioMode; subtitleUrl?: string; mode?: PlaybackMode }) =>
    request<{ session: PlaybackSession }>('/direct', { method: 'POST', body: JSON.stringify(body) }),
  session: (id: string) => request<PlaybackSession>(`/sessions/${id}`),
  action: (id: string, action: string, value?: number) =>
    request<{ session?: PlaybackSession }>(`/sessions/${id}/action`, {
      method: 'POST',
      body: JSON.stringify({ action, value }),
    }),
  progress: (id: string, position: number, duration?: number | null, options?: { keepalive?: boolean; force?: boolean }) =>
    request<{ ok: boolean }>(`/sessions/${id}/progress${options?.force ? '?force=1' : ''}`, {
      method: 'POST',
      body: JSON.stringify({ position, duration: duration ?? null }),
      keepalive: options?.keepalive,
    }),
  end: (id: string, duration?: number | null) =>
    request<{ session?: PlaybackSession }>(`/sessions/${id}/end`, {
      method: 'POST',
      body: JSON.stringify({ duration: duration ?? null }),
    }),
  history: () => request<{ entries: HistoryEntry[] }>('/history'),
  clearHistory: () => request<{ ok: boolean }>('/history', { method: 'DELETE' }),
  removeHistory: (key: string) =>
    request<{ ok: boolean }>(`/history/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  settings: () => request<{ settings: Settings }>('/settings'),
  saveSettings: (patch: Partial<Settings>) =>
    request<{ settings: Settings }>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  getManualSkip: (key: string) =>
    request<{ manual: { intro: SkipRange | null; outro: SkipRange | null } | null }>(
      `/skips?key=${encodeURIComponent(key)}`,
    ),
  saveManualSkip: (key: string, intro: SkipRange | null, outro: SkipRange | null) =>
    request<{ manual: unknown }>('/skips', {
      method: 'PUT',
      body: JSON.stringify({ key, intro, outro }),
    }),
};

/** Subscribe to pushed session updates; returns an unsubscribe function. */
export function subscribe(onSession: (session: PlaybackSession) => void, onHistoryError?: (message: string) => void): () => void {
  const source = new EventSource(`${BASE}/events`);
  source.addEventListener('session', (event) => {
    try {
      onSession(JSON.parse((event as MessageEvent<string>).data) as PlaybackSession);
    } catch {
      /* ignore malformed frames */
    }
  });
  source.addEventListener('history-error', (event) => {
    try { onHistoryError?.(JSON.parse((event as MessageEvent<string>).data) as string); }
    catch { onHistoryError?.('Watch history could not be saved.'); }
  });
  return () => source.close();
}

export function formatTime(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours ? String(minutes).padStart(2, '0') : String(minutes);
  return hours ? `${hours}:${mm}:${String(secs).padStart(2, '0')}` : `${mm}:${String(secs).padStart(2, '0')}`;
}

export function skipKey(provider: string, animeId: string, episode: number, audio: AudioMode): string {
  return `${provider}:${animeId}:${episode}:${audio}`;
}
