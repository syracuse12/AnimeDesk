import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUBTITLES_OFF,
  defaultSubtitleSelection,
  hlsSubtitleState,
  resolveSubtitleSelection,
  sideTrackLabel,
  subtitleModes,
} from '../shared/subtitles.ts';

/* ---- the reported failure: a dub with subtitles off ---- */

test('a dub starts with subtitles off even when tracks are offered', () => {
  assert.equal(defaultSubtitleSelection('dub', 2), SUBTITLES_OFF);
});

test('off means every track is disabled', () => {
  assert.deepEqual(subtitleModes(3, SUBTITLES_OFF), ['disabled', 'disabled', 'disabled']);
});

test('off is mirrored to hls.js as a disabled display', () => {
  assert.deepEqual(hlsSubtitleState(SUBTITLES_OFF), { subtitleTrack: -1, subtitleDisplay: false });
});

/* ---- selecting a language ---- */

test('selecting a track shows exactly that track', () => {
  assert.deepEqual(subtitleModes(3, 1), ['disabled', 'showing', 'disabled']);
});

test('the last track can be selected', () => {
  assert.deepEqual(subtitleModes(2, 1), ['disabled', 'showing']);
});

test('a selection is mirrored to hls.js and enables display', () => {
  assert.deepEqual(hlsSubtitleState(2), { subtitleTrack: 2, subtitleDisplay: true });
});

test('no tracks at all means off', () => {
  assert.deepEqual(subtitleModes(0, 0), []);
  assert.equal(defaultSubtitleSelection('sub', 0), SUBTITLES_OFF);
});

/* ---- initial defaults ---- */

test('subtitled audio starts with the first track showing', () => {
  assert.equal(defaultSubtitleSelection('sub', 2), 0);
});

test('an unset choice falls back to the default for the audio mode', () => {
  assert.equal(resolveSubtitleSelection(null, 'dub', 2), SUBTITLES_OFF);
  assert.equal(resolveSubtitleSelection(null, 'sub', 2), 0);
});

/* ---- hand-offs and stream switches ---- */

test('an explicit off survives a hand-off that offers tracks', () => {
  assert.equal(resolveSubtitleSelection(SUBTITLES_OFF, 'sub', 3), SUBTITLES_OFF);
});

test('a chosen language survives a hand-off with the same track count', () => {
  assert.equal(resolveSubtitleSelection(1, 'dub', 2), 1);
});

test('an index past the new track list falls back instead of pointing at nothing', () => {
  assert.equal(resolveSubtitleSelection(4, 'dub', 2), SUBTITLES_OFF);
  assert.equal(resolveSubtitleSelection(4, 'sub', 2), 0);
});

test('a hand-off that publishes no tracks resolves to off', () => {
  assert.equal(resolveSubtitleSelection(1, 'dub', 0), SUBTITLES_OFF);
});

test('a negative index other than off is treated as unset', () => {
  assert.equal(resolveSubtitleSelection(-7, 'dub', 2), SUBTITLES_OFF);
});

/* ---- labels ---- */

test('a language tag becomes a readable label', () => {
  assert.equal(sideTrackLabel('ar'), 'Arabic');
  assert.equal(sideTrackLabel('en-GB'), 'British English');
});

test('a missing language still gets a usable label', () => {
  assert.equal(sideTrackLabel(null), 'Subtitles');
});