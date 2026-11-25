import { store } from '../store.ts';
import type { DirectPlayRequest, PlaybackSession } from '../../shared/types.ts';
import type { SessionManager } from './sessions.ts';

/**
 * Fallback path for a raw URL with no provider behind it. Kept separate so the
 * provider interface never needs a "fake provider" just for ad-hoc streams.
 */
export async function directStart(
  manager: SessionManager,
  request: DirectPlayRequest,
): Promise<PlaybackSession> {
  const settings = store.getSettings();
  const session = await manager.startDirect({
    provider: 'local',
    animeId: `direct:${request.url}`,
    animeTitle: request.title,
    episodeNumber: request.episodeNumber ?? 1,
    episodeLabel: `Direct stream ${request.episodeNumber ?? 1}`,
    audio: request.audio,
    url: request.url,
    subtitleUrl: request.subtitleUrl,
    volume: settings.volume,
  });
  return session;
}