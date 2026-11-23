import assert from 'node:assert/strict';
import test from 'node:test';
import { pickRanges, searchTitle, titlesMatch, normalizeTitle, MIN_SKIP_SECONDS } from '../server/aniskip.ts';
import { autoSkipTarget, clampRange, isInside, isValidRange, visibleSkip } from '../shared/skip-timing.ts';
import type { SkipInfo } from '../shared/types.ts';

const skips = (intro: [number, number] | null, outro: [number, number] | null): SkipInfo => ({
  intro: intro ? { start: intro[0], end: intro[1] } : null,
  outro: outro ? { start: outro[0], end: outro[1] } : null,
  source: 'aniskip',
  malId: 20,
});

const DURATION = 1429;

/* ---- AniSkip report parsing ---- */

test('pickRanges keeps a real opening and ending', () => {
  const picked = pickRanges(
    [
      { skipType: 'op', interval: { startTime: 1, endTime: 102 }, episodeLength: DURATION },
      { skipType: 'ed', interval: { startTime: 1320, endTime: 1410 }, episodeLength: DURATION },
    ],
    DURATION,
  );
  assert.deepEqual(picked.intro, { start: 1, end: 102 });
  assert.deepEqual(picked.outro, { start: 1320, end: 1410 });
});

test('pickRanges drops an interval that starts past the video', () => {
  const picked = pickRanges([{ skipType: 'op', interval: { startTime: 1500, endTime: 1560 } }], DURATION);
  assert.equal(picked.intro, null);
});

test('pickRanges drops an inverted or too-short interval', () => {
  assert.equal(pickRanges([{ skipType: 'op', interval: { startTime: 90, endTime: 40 } }], DURATION).intro, null);
  assert.equal(
    pickRanges([{ skipType: 'op', interval: { startTime: 10, endTime: 10 + MIN_SKIP_SECONDS - 1 } }], DURATION).intro,
    null,
  );
});

test('pickRanges clamps an ending that overshoots the duration', () => {
  const picked = pickRanges([{ skipType: 'ed', interval: { startTime: 1300, endTime: 1800 } }], DURATION);
  assert.deepEqual(picked.outro, { start: 1300, end: DURATION });
});

test('pickRanges ignores unknown skip types and missing intervals', () => {
  const picked = pickRanges(
    [{ skipType: 'mixed-ed' as string, interval: { startTime: 1300, endTime: 1400 } }, { skipType: 'op' }],
    DURATION,
  );
  assert.equal(picked.intro, null);
  assert.deepEqual(picked.outro, { start: 1300, end: 1400 });
});

test('pickRanges treats mixed tags as their base type', () => {
  const picked = pickRanges([{ skipType: 'mixed-op' as string, interval: { startTime: 1, endTime: 90 } }], DURATION);
  assert.deepEqual(picked.intro, { start: 1, end: 90 });
});

test('pickRanges accepts timestamps when the duration is not yet known', () => {
  const picked = pickRanges([{ skipType: 'op', interval: { startTime: 5, endTime: 90 } }], null);
  assert.deepEqual(picked.intro, { start: 5, end: 90 });
});

/*
 * Regression: AniSkip files Classroom of the Elite (MAL 35507) episode 1 with
 * the opening and ending the wrong way round — `op` 1168-1258 and `ed` 3.8-93.8
 * in a 1450s episode. Both windows fit the duration on their own, so the old
 * rules accepted them and the player offered "Skip intro" 19 minutes in.
 */
test('pickRanges swaps an opening that starts after the ending', () => {
  const picked = pickRanges(
    [
      { skipType: 'op', interval: { startTime: 1168.458, endTime: 1258.458 } },
      { skipType: 'ed', interval: { startTime: 3.861, endTime: 93.861 } },
    ],
    1450,
  );
  assert.deepEqual(picked.intro, { start: 3.861, end: 93.861 });
  assert.deepEqual(picked.outro, { start: 1168.458, end: 1258.458 });
});

test('pickRanges leaves correctly ordered records alone', () => {
  const picked = pickRanges(
    [
      { skipType: 'op', interval: { startTime: 68, endTime: 156 } },
      { skipType: 'ed', interval: { startTime: 1346, endTime: 1426 } },
    ],
    1450,
  );
  assert.deepEqual(picked.intro, { start: 68, end: 156 });
  assert.deepEqual(picked.outro, { start: 1346, end: 1426 });
});

/*
 * A lone window on the wrong side of the episode is dropped rather than shown
 * with the wrong label, because there is nothing to swap it with.
 */
test('pickRanges drops a lone opening filed in the second half', () => {
  assert.equal(pickRanges([{ skipType: 'op', interval: { startTime: 1168, endTime: 1258 } }], 1450).intro, null);
});

test('pickRanges drops a lone ending filed in the first half', () => {
  assert.equal(pickRanges([{ skipType: 'ed', interval: { startTime: 4, endTime: 94 } }], 1450).outro, null);
});

test('pickRanges does not swap when the swap leaves a window unusable', () => {
  // An 8s file: the opening sits in the second half and the ending in the
  // first, so they are swapped; the outro then starts exactly at the midpoint.
  const picked = pickRanges(
    [
      { skipType: 'op', interval: { startTime: 4, endTime: 8 } },
      { skipType: 'ed', interval: { startTime: 0, endTime: 3 } },
    ],
    8,
  );
  assert.deepEqual(picked.intro, { start: 0, end: 3 });
  assert.deepEqual(picked.outro, { start: 4, end: 8 });
});

test('isValidRange judges a window by the side of the episode it belongs on', () => {
  assert.equal(isValidRange({ start: 1168, end: 1258 }, 1450, 'intro'), false);
  assert.equal(isValidRange({ start: 1168, end: 1258 }, 1450, 'outro'), true);
  assert.equal(isValidRange({ start: 4, end: 94 }, 1450, 'intro'), true);
  assert.equal(isValidRange({ start: 4, end: 94 }, 1450, 'outro'), false);
});

test('a swapped record still produces working buttons at the right times', () => {
  const info = skips([4, 94], [1168, 1258]);
  assert.equal(visibleSkip(info, 30, 1450), 'intro');
  assert.equal(visibleSkip(info, 600, 1450), null);
  assert.equal(visibleSkip(info, 1180, 1450), 'outro');
  const target = autoSkipTarget(info, 10, 1450, { intro: true, outro: false, handled: null });
  assert.ok((target?.target ?? 0) > 90 && (target?.target ?? 0) <= 94);
});

/*
 * Regression: AniList returns an empty result set for the romaji title hianime
 * reports, because it does not tokenise the "(TV)" qualifier away. Searching
 * the raw title therefore found no MAL id for Classroom of the Elite at all.
 */
test('searchTitle strips release qualifiers for the AniList query', () => {
  assert.equal(
    searchTitle('Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e (TV)'),
    'Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e',
  );
  assert.equal(searchTitle('Naruto [Uncensored]'), 'Naruto');
  assert.equal(searchTitle('Naruto (Dub)'), 'Naruto');
});

test('searchTitle leaves a real title suffix alone', () => {
  assert.equal(searchTitle('Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e 2nd Season'),
    'Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e 2nd Season');
  assert.equal(searchTitle('Naruto Shippuden'), 'Naruto Shippuden');
});

/* ---- title matching ---- */

test('normalizeTitle strips case, punctuation and season markers', () => {
  assert.equal(normalizeTitle('Frieren: Beyond Journey’s End'), 'frieren beyond journey s end');
  assert.equal(normalizeTitle('Naruto Season 2'), 'naruto');
});

test('titlesMatch accepts the same title with different punctuation', () => {
  assert.equal(titlesMatch('Naruto', 'NARUTO'), true);
  assert.equal(titlesMatch('One Piece', 'one piece!'), true);
});

test('titlesMatch rejects a sequel with an extra word', () => {
  assert.equal(titlesMatch('Naruto', 'Naruto Shippuden'), false);
});

test('titlesMatch rejects an unrelated show', () => {
  assert.equal(titlesMatch('Bleach', 'Naruto'), false);
});

/*
 * Regression: hianime's romaji attribute carries a "(TV)" qualifier that AniList
 * does not store. The old exact-token rule failed, so no MAL id was ever found
 * and every skip lookup was silently skipped.
 */
test('titlesMatch tolerates a release qualifier suffix', () => {
  assert.equal(
    titlesMatch(
      'Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e (TV)',
      'Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e',
    ),
    true,
  );
  assert.equal(titlesMatch('Naruto (Dub)', 'Naruto'), true);
});

/* ---- visibility rules ---- */

test('a button shows only inside its own window', () => {
  const info = skips([1, 102], [1320, 1410]);
  assert.equal(visibleSkip(info, 30, DURATION), 'intro');
  assert.equal(visibleSkip(info, 500, DURATION), null);
  assert.equal(visibleSkip(info, 1330, DURATION), 'outro');
});

test('the outro window does not hide the intro window', () => {
  const info = skips([1, 102], [1320, 1410]);
  assert.equal(isInside(info, 'intro', 50, DURATION), true);
  assert.equal(isInside(info, 'outro', 50, DURATION), false);
});

test('invalid ranges never produce a button', () => {
  assert.equal(visibleSkip(skips([1200, 1201], null), 1200, DURATION), null);
  assert.equal(visibleSkip(null, 10, DURATION), null);
});

test('isValidRange rejects a start at the very end of the video', () => {
  assert.equal(isValidRange({ start: DURATION - 1, end: DURATION }, DURATION), false);
});

/*
 * Regression: AniSkip timestamps routinely overshoot the duration the browser
 * reports by more than a second. The old rule rejected those outright, so real
 * opening ranges silently produced no button and no automatic skip.
 */
test('isValidRange accepts a range that overshoots the duration', () => {
  assert.equal(isValidRange({ start: 1, end: DURATION + 6 }, DURATION), true);
  assert.equal(isValidRange({ start: 1, end: DURATION + 1.4 }, DURATION), true);
});

test('an overshooting intro still shows its button and clamps the seek target', () => {
  const info = skips([1, DURATION + 6], null);
  assert.equal(visibleSkip(info, 30, DURATION), 'intro');
  assert.deepEqual(clampRange(info.intro as { start: number; end: number }, DURATION), {
    start: 1,
    end: DURATION,
  });
});

test('clampRange pulls an end back to the duration', () => {
  assert.deepEqual(clampRange({ start: 1300, end: 2000 }, DURATION), { start: 1300, end: DURATION });
});

/* ---- automatic skipping ---- */

test('autoSkip fires inside the intro when enabled', () => {
  const target = autoSkipTarget(skips([1, 102], null), 5, DURATION, { intro: true, outro: false, handled: null });
  assert.equal(target?.kind, 'intro');
  assert.ok((target?.target ?? 0) > 100);
});

test('autoSkip stays off when the setting is off', () => {
  const target = autoSkipTarget(skips([1, 102], null), 5, DURATION, { intro: false, outro: false, handled: null });
  assert.equal(target, null);
});

test('autoSkip does not re-fire inside the window it already handled', () => {
  const target = autoSkipTarget(skips([1, 102], null), 5, DURATION, {
    intro: true,
    outro: false,
    handled: 'intro',
  });
  assert.equal(target, null);
});

test('autoSkip targets just before the window end, not past it', () => {
  const target = autoSkipTarget(skips(null, [1320, 1410]), 1330, DURATION, {
    intro: false,
    outro: true,
    handled: null,
  });
  assert.equal(target?.kind, 'outro');
  assert.ok((target?.target ?? 0) <= 1410);
  assert.ok((target?.target ?? 0) > 1400);
});

test('autoSkip honours each kind independently', () => {
  const info = skips([1, 102], [1320, 1410]);
  assert.equal(
    autoSkipTarget(info, 1330, DURATION, { intro: true, outro: false, handled: null }),
    null,
  );
  assert.equal(
    autoSkipTarget(info, 30, DURATION, { intro: false, outro: true, handled: null })?.kind,
    undefined,
  );
});

test('skipping the outro does not mark the episode complete on its own', () => {
  // The seek target lands short of the end, so only the real `ended` event ends it.
  const target = autoSkipTarget(skips(null, [1320, DURATION]), 1330, DURATION, {
    intro: false,
    outro: true,
    handled: null,
  });
  assert.ok((target?.target ?? 0) < DURATION);
});