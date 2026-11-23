import type { AnimeDetail, Episode, HistoryEntry } from './types.ts';

/** Request generations keep a late detail response from replacing a newer pick. */
export class LatestRequest {
  private generation = 0;
  next(): number { return ++this.generation; }
  isCurrent(generation: number): boolean { return generation === this.generation; }
}

/** Resume the unfinished episode that was actually watched most recently. */
export function resumeEpisode(
  detail: AnimeDetail,
  progressFor: (episode: number) => HistoryEntry | undefined,
): Episode | null {
  const started = detail.episodes
    .map((episode) => ({ episode, entry: progressFor(episode.number) }))
    .filter((item) => item.entry && !item.entry.completed)
    .sort((a, b) => (b.entry?.updatedAt ?? 0) - (a.entry?.updatedAt ?? 0));
  if (started[0]) return started[0].episode;
  return detail.episodes.find((episode) => !progressFor(episode.number)?.completed) ?? detail.episodes[0] ?? null;
}
