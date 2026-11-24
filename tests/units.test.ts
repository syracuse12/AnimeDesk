import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { deobfuscate, titleFromPage, coverFromPage } from '../server/providers/hianime.ts';
import { assertHttpUrl, cleanText, absoluteUrl, originOf } from '../server/http.ts';
import { GENRES, isGenre, toItem, toKitsuItem } from '../server/discover.ts';
import { normalizeLocalPath } from '../server/paths.ts';
import { Store } from '../server/store.ts';
import { DEFAULT_SETTINGS, LIMITS } from '../server/config.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures');
const blob = fs.readFileSync(path.join(fixtures, 'embed-blob.txt'), 'utf8').trim();
const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'embed-expected.json'), 'utf8')) as Record<
  string,
  unknown
>;

/**
 * Decode a real blob captured from the live embed page. This is the exact
 * payload shape the provider must handle, including the digits printf would
 * read as octal.
 */
test('deobfuscate decodes a real captured embed blob', () => {
  const json = JSON.parse(deobfuscate(blob)) as Record<string, unknown>;
  assert.deepEqual(json, expected);
  assert.match(String(json.src), /\.m3u8/);
});

test('deobfuscate recovers the subtitle track from the real blob', () => {
  const json = JSON.parse(deobfuscate(blob)) as { subtitles: { src: string; default: boolean }[] };
  assert.equal(json.subtitles.length, 1);
  assert.equal(json.subtitles[0]?.default, true);
  assert.match(json.subtitles[0]?.src ?? '', /\.vtt$/);
});

test('deobfuscate is stable across repeated runs', () => {
  assert.equal(deobfuscate(blob), deobfuscate(blob));
});

test('deobfuscate tolerates an empty blob', () => {
  assert.equal(deobfuscate(''), '');
});

test('titleFromPage reads the romaji heading from a real detail page shape', () => {
  const page = '<div class="anisc-detail"><h2 class="film-name dynamic-name" data-jname="Naruto">\n  Naruto\n</h2></div>';
  assert.equal(titleFromPage(page), 'Naruto');
});

test('titleFromPage prefers the romaji attribute over the shown title', () => {
  const page = '<h2 class="film-name dynamic-name" data-jname="Sousou no Frieren">Frieren: Beyond Journey&#039;s End</h2>';
  assert.equal(titleFromPage(page), 'Sousou no Frieren');
});

test('titleFromPage falls back to the heading text, then to null', () => {
  assert.equal(titleFromPage('<h2 class="film-name">One Piece</h2>'), 'One Piece');
  assert.equal(titleFromPage('<div>nothing</div>'), null);
});

/*
 * Regression: the real detail markup puts `src` before `class`, and the old
 * class-first regex could therefore never match. Every poster was missing and
 * the home feed filtered those series out entirely.
 */
test('coverFromPage reads a poster whose src precedes the class attribute', () => {
  const page = `
    <div class="film-poster">
      <img src="https://hianime.fm/storage/media/2026/08/classroom-of-the-elite.webp" class="film-poster-img" alt="Poster">
    </div>`;
  assert.equal(coverFromPage(page), 'https://hianime.fm/storage/media/2026/08/classroom-of-the-elite.webp');
});

test('coverFromPage still reads the older class-first shape', () => {
  const page = '<img class="film-poster-img" src="https://hianime.fm/a.webp" alt="">';
  assert.equal(coverFromPage(page), 'https://hianime.fm/a.webp');
});

test('coverFromPage returns null when the page has no poster', () => {
  assert.equal(coverFromPage('<div class="anisc-detail">no poster</div>'), null);
});

test('assertHttpUrl rejects non-http schemes', () => {
  assert.equal(assertHttpUrl('https://a.test/x').host, 'a.test');
  assert.throws(() => assertHttpUrl('file:///C:/x.mp4'), /Unsupported protocol/);
  assert.throws(() => assertHttpUrl('not a url'), /Not a valid URL/);
});

test('absoluteUrl resolves relative links and drops odd schemes', () => {
  assert.equal(
    absoluteUrl('800/index.m3u8', 'https://cdn.test/a/'),
    'https://cdn.test/a/800/index.m3u8',
  );
  assert.equal(absoluteUrl('javascript:;', 'https://cdn.test/'), null);
  assert.equal(originOf('https://zoko.test/stream/x'), 'https://zoko.test/');
});

test('cleanText strips tags and entities and clamps length', () => {
  assert.equal(cleanText('<b>Hello</b> &#039;world&#039; &amp; co', 40), "Hello 'world' & co");
  assert.equal(cleanText('x'.repeat(50), 10).length, 10);
});

test('normalizeLocalPath resolves a folder without env expansion', () => {
  assert.ok(normalizeLocalPath('C:\\Videos\\Anime').endsWith('Anime'));
});

test('settings are sanitised, not trusted', async () => {
  const store = new Store();
  await store.load();
  const next = await store.updateSettings({
    autoNext: 'yes',
    autoNextDelaySeconds: 999,
    preferredAudio: 'dub',
    quality: 'nonsense',
    volume: 500,
  });
  assert.equal(next.autoNext, true);
  assert.equal(next.autoNextDelaySeconds, 60);
  assert.equal(next.preferredAudio, 'dub');
  assert.equal(next.quality, DEFAULT_SETTINGS.quality);
  assert.equal(next.volume, 130);
});

test('history upsert replaces the same key and orders newest first', async () => {
  const store = new Store();
  await store.load();
  await store.clearHistory();
  const base = {
    provider: 'hianime' as const,
    animeTitle: 'Show',
    episodeLabel: 'Episode 1',
    audio: 'sub' as const,
    durationSeconds: 1400,
    completed: false,
  };
  await store.upsertHistory({ ...base, key: 'a', animeId: 'a', episodeNumber: 1, positionSeconds: 10, updatedAt: 1 });
  await store.upsertHistory({ ...base, key: 'b', animeId: 'b', episodeNumber: 1, positionSeconds: 20, updatedAt: 2 });
  await store.upsertHistory({ ...base, key: 'a', animeId: 'a', episodeNumber: 1, positionSeconds: 99, updatedAt: 3 });

  const history = store.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0]?.key, 'a');
  assert.equal(history[0]?.positionSeconds, 99);
});

test('history entries survive a reload from disk', async () => {
  const store = new Store();
  await store.load();
  await store.clearHistory();
  await store.upsertHistory({
    key: 'hianime:x:1:sub',
    provider: 'hianime',
    animeId: 'x',
    animeTitle: 'Persisted',
    episodeLabel: 'Episode 1',
    audio: 'sub',
    episodeNumber: 1,
    positionSeconds: 42,
    durationSeconds: 1440,
    completed: false,
    updatedAt: Date.now(),
  });

  const reloaded = new Store();
  await reloaded.load();
  assert.equal(reloaded.getHistory().some((entry) => entry.animeTitle === 'Persisted'), true);
});

test('removing a history key reports whether it existed', async () => {
  const store = new Store();
  await store.load();
  await store.clearHistory();
  assert.equal(await store.removeHistory('missing'), false);
  await store.upsertHistory({
    key: 'k',
    provider: 'local',
    animeId: 'a',
    animeTitle: 'T',
    episodeLabel: 'Episode 1',
    audio: 'sub',
    episodeNumber: 1,
    positionSeconds: 1,
    durationSeconds: null,
    completed: false,
    updatedAt: 1,
  });
  assert.equal(await store.removeHistory('k'), true);
});

/* ---------- discovery ---------- */

test('toItem prefers the English title and searches with the romaji one', () => {
  const item = toItem({
    id: 21,
    title: { romaji: 'One Piece', english: 'One Piece' },
    episodes: 1100,
    seasonYear: 1999,
    averageScore: 88,
    genres: ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy'],
    status: 'RELEASING',
    format: 'TV',
  });
  assert.equal(item?.title, 'One Piece');
  assert.equal(item?.searchTitle, 'One Piece');
  assert.equal(item?.id, '21');
  assert.equal(item?.episodes, 1100);
  assert.equal(item?.year, '1999');
  assert.equal(item?.score, 88);
  // AniList statuses and formats arrive SCREAMING_SNAKE; the UI wants prose.
  assert.equal(item?.status, 'releasing');
  assert.equal(item?.format, 'TV');
  assert.equal(item?.genres?.length, 4);
});

test('toItem falls back to the romaji title when no English title exists', () => {
  const item = toItem({ title: { romaji: 'Sousou no Frieren', english: null } });
  assert.equal(item?.title, 'Sousou no Frieren');
  assert.equal(item?.searchTitle, 'Sousou no Frieren');
});

test('toItem strips release qualifiers from the provider search title', () => {
  const item = toItem({ title: { romaji: 'Bleach (TV)', english: 'Bleach' } });
  assert.equal(item?.title, 'Bleach');
  assert.equal(item?.searchTitle, 'Bleach');
});

test('toItem rejects a node with no usable title', () => {
  assert.equal(toItem({}), null);
  assert.equal(toItem({ title: { romaji: '   ', english: '' } }), null);
  assert.equal(toItem({ title: { romaji: 'x'.repeat(201) } }), null);
});

test('toItem keeps only https artwork', () => {
  const item = toItem({
    title: { romaji: 'A' },
    coverImage: { extraLarge: 'http://insecure/x.jpg', large: 'https://secure/l.jpg' },
    bannerImage: 'https://secure/b.jpg',
  });
  assert.equal(item?.coverUrl, 'https://secure/l.jpg');
  assert.equal(item?.bannerUrl, 'https://secure/b.jpg');
});

test('toItem flattens markup and caps the synopsis', () => {
  const item = toItem({
    title: { romaji: 'A' },
    description: `line one<br>line two<br />line three ${'word '.repeat(400)}`,
  });
  assert.ok(item?.description?.startsWith('line one line two line three'));
  assert.ok((item?.description?.length ?? 0) <= LIMITS.maxDescriptionLength);
});

test('toItem ignores impossible numbers and non-string genres', () => {
  const item = toItem({
    title: { romaji: 'A' },
    episodes: 0,
    seasonYear: 12,
    averageScore: 0,
    genres: ['Action', null, 7 as unknown as string],
  });
  assert.equal(item?.episodes, undefined);
  assert.equal(item?.year, undefined);
  assert.equal(item?.score, undefined);
  assert.deepEqual(item?.genres, ['Action']);
});

test('the genre whitelist is exact and case sensitive', () => {
  assert.equal(GENRES.includes('Sci-Fi'), true);
  assert.equal(isGenre('Sci-Fi'), true);
  assert.equal(isGenre('science fiction'), false);
  assert.equal(isGenre(''), false);
});

test('toKitsuItem reads the JSON:API shape and searches with the romaji title', () => {
  const item = toKitsuItem({
    id: '46474',
    attributes: {
      canonicalTitle: 'Sousou no Frieren',
      titles: { en: 'Frieren: Beyond Journey’s End', en_jp: 'Sousou no Frieren' },
      episodeCount: 28,
      averageRating: '86.4',
      startDate: '2023-09-29',
      subtype: 'TV',
      status: 'finished',
      posterImage: { large: 'https://media.kitsu.io/a.jpg' },
    },
  });
  assert.equal(item?.title, 'Frieren: Beyond Journey’s End');
  assert.equal(item?.searchTitle, 'Sousou no Frieren');
  assert.equal(item?.episodes, 28);
  assert.equal(item?.score, 86);
  assert.equal(item?.year, '2023');
  assert.equal(item?.format, 'TV');
  assert.equal(item?.coverUrl, 'https://media.kitsu.io/a.jpg');
});

test('toKitsuItem falls back through canonical and romaji titles', () => {
  const item = toKitsuItem({ attributes: { canonicalTitle: 'Bleach', titles: {} } });
  assert.equal(item?.title, 'Bleach');
  assert.equal(item?.searchTitle, 'Bleach');
});

test('toKitsuItem rejects a null node, an empty title and bad artwork', () => {
  assert.equal(toKitsuItem(null), null);
  assert.equal(toKitsuItem({ attributes: {} }), null);
  assert.equal(toKitsuItem({ attributes: { canonicalTitle: '   ' } }), null);
  const item = toKitsuItem({
    attributes: { canonicalTitle: 'A', posterImage: { large: 'http://insecure/a.jpg' } },
  });
  assert.equal(item?.coverUrl, undefined);
});