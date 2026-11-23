/**
 * Skip-window decisions, shared by the player and the tests.
 *
 * Rules that matter:
 *  - a range is only usable when it fits inside the real duration;
 *  - a button appears only while the playhead is inside its window;
 *  - automatic skipping fires once per entry, never in a loop;
 *  - skipping an outro seeks to the end of the window, not past it, so
 *    completion is still decided by the real `ended` event.
 */
import type { SkipInfo, SkipRange } from './types.ts';

export const MIN_SKIP_SECONDS = 3;
export const MIN_REMAINING_SECONDS = 2;

/**
 * Where an intro may start and an outro may start, as a fraction of the
 * episode. An opening half way through the file is not an opening.
 */
export const MAX_INTRO_START_FRACTION = 0.5;
export const MIN_OUTRO_START_FRACTION = 0.5;

/** A range is valid when ordered, long enough and inside the video. */
export function isValidRange(
  range: SkipRange | null | undefined,
  duration: number | null,
  kind?: SkipKind,
): boolean {
  if (!range) return false;
  const { start, end } = range;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start < 0 || end <= start) return false;
  if (end - start < MIN_SKIP_SECONDS) return false;
  if (duration && Number.isFinite(duration) && duration > 0) {
    // AniSkip timestamps routinely run a second or two past the duration the
    // browser reports, so an overshooting end is clamped rather than rejected.
    // Only a window that starts at the very end is useless.
    if (start >= duration - MIN_REMAINING_SECONDS) return false;
    // AniSkip sometimes files the opening and the ending under the wrong type,
    // so a window on the wrong side of the episode is not what it claims to be.
    const fraction = start / duration;
    if (kind === 'intro' && fraction >= MAX_INTRO_START_FRACTION) return false;
    if (kind === 'outro' && fraction < MIN_OUTRO_START_FRACTION) return false;
  }
  return true;
}

/** Clamp a range into the duration so a seek can never overshoot. */
export function clampRange(range: SkipRange, duration: number | null): SkipRange {
  const end = duration && duration > 0 ? Math.min(range.end, duration) : range.end;
  return { start: Math.max(0, Math.min(range.start, end)), end };
}

export type SkipKind = 'intro' | 'outro';

function rangeFor(skips: SkipInfo | null, kind: SkipKind): SkipRange | null {
  if (!skips) return null;
  return kind === 'intro' ? skips.intro : skips.outro;
}

/** True while the playhead sits inside a usable window. */
export function isInside(
  skips: SkipInfo | null,
  kind: SkipKind,
  position: number,
  duration: number | null,
): boolean {
  const range = rangeFor(skips, kind);
  if (!isValidRange(range, duration, kind)) return false;
  const clamped = clampRange(range as SkipRange, duration);
  return position >= clamped.start && position < clamped.end;
}

/**
 * Which button (if any) the UI should show right now. The outro is only
 * offered while there is still something left to skip.
 */
export function visibleSkip(
  skips: SkipInfo | null,
  position: number,
  duration: number | null,
): SkipKind | null {
  if (isInside(skips, 'intro', position, duration)) return 'intro';
  if (isInside(skips, 'outro', position, duration)) return 'outro';
  return null;
}

/**
 * The seek target when automatic skipping is on, or null. `handled` is the
 * window already auto-skipped, so seeking into the same window does not bounce.
 */
export function autoSkipTarget(
  skips: SkipInfo | null,
  position: number,
  duration: number | null,
  options: { intro: boolean; outro: boolean; handled: SkipKind | null },
): { kind: SkipKind; target: number } | null {
  const consider = (kind: SkipKind): { kind: SkipKind; target: number } | null => {
    if (kind === 'intro' ? !options.intro : !options.outro) return null;
    if (options.handled === kind) return null;
    if (!isInside(skips, kind, position, duration)) return null;
    const range = rangeFor(skips, kind) as SkipRange;
    const clamped = clampRange(range, duration);
    // Never jump to the exact end of the file; that is the ended event's job.
    const target = Math.max(clamped.start, clamped.end - 0.25);
    return { kind, target };
  };
  return consider('intro') ?? consider('outro');
}