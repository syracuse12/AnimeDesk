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
  /** Resolve one episode. `audio` may be downgraded by the caller when absent. */
  resolve(id: string, episodeNumber: number, audio: AudioMode): Promise<StreamSource>;
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