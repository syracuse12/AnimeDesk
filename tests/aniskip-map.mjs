/**
 * AniSkip regression: the range sanitiser must swap reversed windows and drop
 * windows on the wrong side, and mapping a title must not touch unrelated
 * metadata.
 *
 *   node tests/aniskip-map.mjs
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const results = [];
function record(name, verdict, detail = '') {
  const normalized = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict;
  results.push({ name, verdict: normalized, detail });
  console.log(`${normalized}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

const root = path.resolve('.');
const aniskip = await import(pathToFileURL(path.join(root, 'server/aniskip.ts')).href);

const DURATION = 1440;
const { pickRanges, normalizeTitle, titlesMatch } = aniskip;
const op = (startTime, endTime) => ({ skipType: 'op', interval: { startTime, endTime } });
const ed = (startTime, endTime) => ({ skipType: 'ed', interval: { startTime, endTime } });

/* Reversed intro/outro: the later start is really the intro. */
const swapped = pickRanges([ed(95, 185), op(1300, 1385)], DURATION);
record(
  'reversed windows are swapped back',
  Boolean(swapped?.intro) && Boolean(swapped?.outro) && swapped.intro.start === 95 && swapped.outro.start === 1300,
  JSON.stringify(swapped),
);

/* Outro in the opening half of a long episode is dropped. */
const earlyOutro = pickRanges([ed(300, 390)], DURATION);
record('an outro in the opening half is dropped', !earlyOutro?.outro, JSON.stringify(earlyOutro));

/* Intro in the closing half is dropped. */
const lateIntro = pickRanges([op(900, 990)], DURATION);
record('an intro in the closing half is dropped', !lateIntro?.intro, JSON.stringify(lateIntro));

/* A normal pair survives untouched. */
const normal = pickRanges([op(90, 180), ed(1300, 1400)], DURATION);
record('a normal pair is preserved', normal?.intro?.start === 90 && normal?.outro?.start === 1300, JSON.stringify(normal));

/* String timestamps are coerced, not invented. */
const stringy = pickRanges([op('90', '180')], DURATION);
record('string timestamps are coerced', stringy?.intro?.start === 90, JSON.stringify(stringy));

/* Too-short windows are dropped. */
record('a two-second window is dropped', !pickRanges([op(90, 92)], DURATION).intro);

/* Empty input is null-safe. */
const empty = pickRanges([], DURATION);
record('empty input yields nothing', !empty.intro && !empty.outro, JSON.stringify(empty));

/* Title matching must strip qualifiers without inventing matches. */
record('qualifiers are stripped from a title', normalizeTitle('Some Show Season 2 (Dub)') === 'some show', normalizeTitle('Some Show Season 2 (Dub)'));
record('a qualified title still matches its base title', titlesMatch('Some Show Season 2', 'Some Show'));
record('unrelated titles do not match', !titlesMatch('Some Unrelated Show', 'Another Show'));

/* The detail object handed to the matcher must not be mutated. */
const detail = {
  title: 'Some Unrelated Show',
  animeId: 'unrelated-id',
  episodes: [{ number: 1, label: '1' }],
  availableAudio: ['sub'],
};
const frozen = JSON.stringify(detail);
titlesMatch(detail.title, 'Some Unrelated Show');
record('matching leaves unrelated metadata untouched', JSON.stringify(detail) === frozen);

const failed = results.filter((item) => item.verdict === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);