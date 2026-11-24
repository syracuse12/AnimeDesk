/**
 * Variant selection. An explicit preference must never be silently upgraded:
 * asking for 480p on a 1080p-only manifest used to return 1080p, which is the
 * exact failure the quality picker exists to prevent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVariants, pickVariant, type Variant } from '../server/quality.ts';

const variant = (height: number): Variant => ({ height, url: `https://cdn.test/${height}/index.m3u8` });
const MASTER = 'https://cdn.test/master.m3u8';

/* ---------- exact matches ---------- */

test('an offered height is chosen exactly', () => {
  const pick = pickVariant([variant(1080), variant(720), variant(480)], '480', MASTER);
  assert.equal(pick.url, 'https://cdn.test/480/index.m3u8');
  assert.equal(pick.height, 480);
  assert.equal(pick.fellBack, false);
  assert.equal(pick.note, null);
});

test('best and worst ignore the request', () => {
  const list = [variant(1080), variant(720), variant(360)];
  assert.equal(pickVariant(list, 'best', MASTER).height, 1080);
  assert.equal(pickVariant(list, 'worst', MASTER).height, 360);
  assert.equal(pickVariant(list, 'best', MASTER).note, null);
});

/* ---------- the reported bug: no exact match ---------- */

test('a missing 480p on a 1080p/720p manifest chooses 720p, not 1080p', () => {
  const pick = pickVariant([variant(1080), variant(720)], '480', MASTER);
  assert.equal(pick.height, 720);
  assert.equal(pick.fellBack, true);
  assert.match(pick.note ?? '', /480p is not offered/);
  assert.match(pick.note ?? '', /720p/);
});

test('the highest rendition at or below the request wins over a closer larger one', () => {
  const pick = pickVariant([variant(1080), variant(540), variant(360)], '480', MASTER);
  assert.equal(pick.height, 360);
  assert.equal(pick.fellBack, true);
});

test('when only larger renditions exist, the lowest is used and the fallback is stated', () => {
  const pick = pickVariant([variant(1080), variant(720)], '480', MASTER);
  assert.equal(pick.height, 720);
  assert.match(pick.note ?? '', /lowest available/);
});

test('an unsorted manifest still resolves deterministically', () => {
  const pick = pickVariant([variant(360), variant(1080), variant(720)], '480', MASTER);
  assert.equal(pick.height, 360);
  assert.equal(pickVariant([variant(360), variant(1080)], 'best', MASTER).height, 1080);
  assert.equal(pickVariant([variant(360), variant(1080)], 'worst', MASTER).height, 360);
});

/* ---------- degenerate manifests ---------- */

test('a manifest with no variants keeps the master URL', () => {
  const pick = pickVariant([], '480', MASTER);
  assert.equal(pick.url, MASTER);
  assert.equal(pick.height, null);
  assert.equal(pick.fellBack, false);
});

test('a single rendition is used whatever the request, and says so', () => {
  const pick = pickVariant([variant(720)], '480', MASTER);
  assert.equal(pick.height, 720);
  assert.equal(pick.fellBack, true);
});

test('variants without a RESOLUTION attribute never beat a known height', () => {
  const pick = pickVariant([{ height: 0, url: 'https://cdn.test/unknown.m3u8' }, variant(360)], '480', MASTER);
  assert.equal(pick.height, 360);
  assert.equal(pickVariant([{ height: 0, url: 'https://cdn.test/unknown.m3u8' }], 'best', MASTER).height, null);
});

test('an unparseable preference behaves like best', () => {
  assert.equal(pickVariant([variant(1080), variant(720)], 'garbage', MASTER).height, 1080);
  assert.equal(pickVariant([variant(1080), variant(720)], '0', MASTER).height, 1080);
});

/* ---------- parsing ---------- */

test('parseVariants reads heights and resolves relative URIs', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
    '1080/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480',
    '/absolute/480/index.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:RESOLUTION=1920x1080,URI="iframe.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'https://other.test/360.m3u8',
  ].join('\n');
  const parsed = parseVariants(playlist, 'https://cdn.test/hls/master.m3u8', (value, base) => new URL(value, base).toString());
  assert.deepEqual(parsed.map((item) => item.height), [1080, 480, 360]);
  assert.equal(parsed[0]?.url, 'https://cdn.test/hls/1080/index.m3u8');
  assert.equal(parsed[1]?.url, 'https://cdn.test/absolute/480/index.m3u8');
  assert.equal(parsed[2]?.url, 'https://other.test/360.m3u8');
});

test('parseVariants skips a stream line with no URI', () => {
  const parsed = parseVariants('#EXT-X-STREAM-INF:RESOLUTION=1280x720\n#comment\n', 'https://cdn.test/m.m3u8', (value) => value);
  assert.deepEqual(parsed, []);
});