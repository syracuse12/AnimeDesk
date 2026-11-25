import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { deobfuscate } from '../server/providers/hianime.ts';
import { assertHttpUrl, cleanText, absoluteUrl, originOf } from '../server/http.ts';
import { normalizeLocalPath } from '../server/paths.ts';
import { Store } from '../server/store.ts';
import { DEFAULT_SETTINGS } from '../server/config.ts';

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