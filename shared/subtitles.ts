/**
 * Subtitle selection rules.
 *
 * The player has two independent subtitle namespaces and both have to obey the
 * same choice: tracks hls.js owns (EXT-X-MEDIA renditions inside the playlist)
 * and the single side-loaded <track> the provider hands over as a VTT file.
 * Getting one of them wrong is what made subtitles appear with the menu set to
 * Off, so the rules live here where they can be tested without a browser.
 *
 * Off is a real value, not the absence of one: -1 means "no track showing",
 * which is different from "nothing chosen yet".
 */

export const SUBTITLES_OFF = -1;

export type SubtitleMode = 'showing' | 'disabled';

/**
 * The starting state. A dub is meant to be watched without subtitles; subtitled
 * audio is meaningless without them, so that case starts on the first track.
 */
export function defaultSubtitleSelection(audio: 'sub' | 'dub', trackCount: number): number {
  if (trackCount <= 0) return SUBTITLES_OFF;
  return audio === 'sub' ? 0 : SUBTITLES_OFF;
}

/**
 * Turn a remembered choice into a valid index for the tracks that exist now.
 * A hand-off can publish a different track list (or none at all), so an index
 * from the previous episode is clamped rather than trusted.
 */
export function resolveSubtitleSelection(
  choice: number | null,
  audio: 'sub' | 'dub',
  trackCount: number,
): number {
  if (choice === null) return defaultSubtitleSelection(audio, trackCount);
  if (choice === SUBTITLES_OFF) return SUBTITLES_OFF;
  return choice >= 0 && choice < trackCount ? choice : defaultSubtitleSelection(audio, trackCount);
}

/** Exactly one track showing, every other track explicitly disabled. */
export function subtitleModes(trackCount: number, selected: number): SubtitleMode[] {
  return Array.from({ length: Math.max(0, trackCount) }, (_, index) =>
    index === selected ? 'showing' : 'disabled',
  );
}

/**
 * The hls.js side of the same choice. hls.js keeps its own display flag, so
 * setting only `subtitleTrack` leaves `subtitleDisplay` true and the track still
 * renders on some builds.
 *
 * The side-loaded VTT is not an hls.js rendition at all, so an index at or past
 * `hlsTrackCount` means "keep hls.js quiet, let the native track show".
 */
export function hlsSubtitleState(
  selected: number,
  hlsTrackCount: number = Number.POSITIVE_INFINITY,
): { subtitleTrack: number; subtitleDisplay: boolean } {
  if (selected === SUBTITLES_OFF) return { subtitleTrack: SUBTITLES_OFF, subtitleDisplay: false };
  if (selected >= hlsTrackCount) return { subtitleTrack: SUBTITLES_OFF, subtitleDisplay: true };
  return { subtitleTrack: selected, subtitleDisplay: true };
}

/** A stable, human label for the side-loaded track. */
export function sideTrackLabel(lang: string | null | undefined): string {
  if (!lang) return 'Subtitles';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang);
    if (name) return name;
  } catch {
    /* older engines: fall through to the raw tag */
  }
  return lang.toUpperCase();
}