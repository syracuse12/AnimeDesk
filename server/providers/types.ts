import type { AnimeDetail, AudioMode, ProviderInfo, SearchResult, StreamSource } from '../../shared/types.ts';

/**
 * A provider is split into three independent concerns so a broken CDN never
 * takes discovery down with it:
 *   search/detail  -> metadata
 *   resolve        -> a playable stream
 *   (playback)     -> owned by the session manager, not the provider
 */
export interface Provider {
  info: ProviderInfo;
  search(query: string): Promise<SearchResult[]>;
  detail(id: string): Promise<AnimeDetail>;
  /**
   * Resolve one episode. `audio` may be downgraded by the caller when absent,
   * and `quality` is the viewer's preference ('best', '1080', 'worst', ...).
   * Providers that only serve one rendition may ignore it.
   */
  resolve(
    id: string,
    episodeNumber: number,
    audio: AudioMode,
    quality?: 'best' | '1080' | '720' | '480' | 'worst',
  ): Promise<StreamSource>;
  /** Cheap readiness probe used by /api/status. */
  ready(): Promise<boolean>;
}

export class ProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}