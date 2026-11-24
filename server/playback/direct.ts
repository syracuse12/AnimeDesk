import { store } from '../store.ts';
import type { DirectPlayRequest, PlaybackMode, PlaybackSession } from '../../shared/types.ts';
import type { SessionManager } from './sessions.ts';

/**
 * Fallback path for a raw URL with no provider behind it. Kept separate so the
 * provider interface never needs a "fake provider" just for ad-hoc streams.
 */
export async function directStart(
  manager: SessionManager,
  request: DirectPlayRequest,
  mode?: PlaybackMode,
): Promise<PlaybackSession> {
  const settings = store.getSettings();
  const resolved = mode ?? (settings.embeddedPlayer ? 'embedded' : 'external');
  const session = await manager.startDirect({
    provider: 'local',
    animeId: `direct:${request.url}`,
    animeTitle: request.title,
    episodeNumber: request.episodeNumber ?? 1,
    episodeCount: 1,
    episodeLabel: `Direct stream ${request.episodeNumber ?? 1}`,
    audio: request.audio,
    url: request.url,
    subtitleUrl: request.subtitleUrl,
    subtitleLang: request.subtitleLang,
    volume: settings.volume,
    mode: resolved,
  });
  return session;
}