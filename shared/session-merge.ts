/**
 * Which pushed session the UI should adopt.
 *
 * The service pushes every session change to every client, so a late frame from
 * the episode the viewer just left arrives after the new episode has already
 * started. Only two things may replace the held session: a frame for the same
 * session, or a session that explicitly names the held one as the session it
 * superseded. Everything else is stale and is dropped, otherwise Next, Previous
 * and autoplay leave the player stuck on the old episode.
 *
 * Pure so the rule is testable without a browser.
 */
import type { PlaybackSession } from './types.ts';

export function acceptSession(
  current: PlaybackSession | null,
  next: PlaybackSession,
): PlaybackSession {
  if (!current) return next;
  if (current.sessionId === next.sessionId) return next;
  if (next.supersedes === current.sessionId) return next;
  // A session that has already finished cannot be the one being replaced.
  return current.state === 'countdown' || current.state === 'ended' || current.state === 'closed'
    ? next
    : current;
}