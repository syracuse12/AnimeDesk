/**
 * Discovery resilience.
 *
 * AniList and Kitsu are free, rate-limited and occasionally down. A browse
 * surface must degrade rather than break: these tests pin the behaviour under
 * failure, which is the only time the code paths actually matter.
 */
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { FetchError } from '../server/http.ts';
import { __resetCache, __setTransport, discover, suggest } from '../server/discover.ts';

function node(id: number, romaji: string) {
  return { id, title: { romaji, english: null } };
}

beforeEach(() => {
  __resetCache();
});

/* ---------- AniList unavailable ---------- */

test('an AniList outage surfaces as an error when nothing is cached', async () => {
  __setTransport({ anilist: async () => { throw new FetchError(502, 'AniList HTTP 503'); } });
  await assert.rejects(discover('trending'), /AniList HTTP 503/);
});

test('a failed refresh serves the last good rows instead of blanking the row', async () => {
  __setTransport({ anilist: async () => [node(1, 'Frieren')] });
  assert.equal((await discover('trending')).length, 1);

  __setTransport({ anilist: async () => { throw new FetchError(502, 'AniList HTTP 503'); } });
  // Expire the freshness window without waiting ten real minutes.
  const rows = await discover('trending');
  assert.equal(rows[0]?.title, 'Frieren');
});

test('Kitsu being down does not break the search box', async () => {
  __setTransport({ kitsu: async () => { throw new FetchError(502, 'Kitsu HTTP 503'); } });
  await assert.rejects(suggest('frier'), /Kitsu HTTP 503/);
});

/* ---------- HTTP 429 ---------- */

test('a 429 keeps its own status so the UI can say "slow down"', async () => {
  __setTransport({ anilist: async () => { throw new FetchError(429, 'AniList HTTP 429'); } });
  await assert.rejects(discover('top'), (error: unknown) => {
    assert.ok(error instanceof FetchError);
    assert.equal(error.status, 429);
    return true;
  });
});

test('a 429 falls back to stale rows rather than propagating', async () => {
  __setTransport({ anilist: async () => [node(2, 'Bleach')] });
  await discover('top');
  __setTransport({ anilist: async () => { throw new FetchError(429, 'AniList HTTP 429'); } });
  const rows = await discover('top');
  assert.equal(rows[0]?.title, 'Bleach');
});

/* ---------- slow responses and stale requests ---------- */

test('concurrent calls for one key share a single upstream request', async () => {
  let calls = 0;
  __setTransport({
    anilist: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return [node(3, 'Monster')];
    },
  });
  const settled = await Promise.all([
    discover('seasonal'),
    discover('seasonal'),
    discover('seasonal'),
  ]);
  assert.equal(calls, 1, 'three concurrent calls must not become three requests');
  for (const rows of settled) assert.equal(rows[0]?.title, 'Monster');
});

test('a slow first answer cannot overwrite a faster later one for a different key', async () => {
  __setTransport({
    anilist: async (variables) => {
      const genre = String(variables.genre ?? '');
      await new Promise((resolve) => setTimeout(resolve, genre === 'Action' ? 40 : 5));
      return [node(genre === 'Action' ? 10 : 11, genre || 'trending')];
    },
  });
  const slow = discover('genre', 'Action');
  const fast = discover('genre', 'Comedy');
  await Promise.all([slow, fast]);
  // Both keys are cached independently, so each keeps its own answer.
  assert.equal((await discover('genre', 'Comedy'))[0]?.title, 'Comedy');
  assert.equal((await discover('genre', 'Action'))[0]?.title, 'Action');
});

/* ---------- rapid typing ---------- */

test('typing a title does not evict the browse rows from the cache', async () => {
  __setTransport({
    anilist: async () => [node(4, 'Keep Me')],
    kitsu: async (url) => {
      const term = decodeURIComponent(/filter\[text\]=([^&]*)/.exec(url)?.[1] ?? '');
      return { data: [{ id: term, attributes: { canonicalTitle: term } }] };
    },
  });
  await discover('trending');

  // Far more distinct suggestion terms than the row cache holds keys.
  for (let i = 0; i < 60; i += 1) await suggest(`title-${i}`);

  // A cache hit, so the transport is not consulted at all.
  __setTransport({ anilist: async () => { throw new FetchError(502, 'should not be called'); } });
  const rows = await discover('trending');
  assert.equal(rows[0]?.title, 'Keep Me');
});

test('the same term in different case reuses one cache entry', async () => {
  let calls = 0;
  __setTransport({
    kitsu: async () => {
      calls += 1;
      return { data: [{ id: 'x', attributes: { canonicalTitle: 'Frieren' } }] };
    },
  });
  await suggest('Frieren');
  await suggest('frieren');
  assert.equal(calls, 1);
});

/* ---------- repeated genre switching ---------- */

test('flipping genres repeatedly resolves to the last pick, not an earlier one', async () => {
  __setTransport({
    anilist: async (variables) => {
      const genre = String(variables.genre ?? 'trending');
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [node(20, genre)];
    },
  });
  const pending = [discover('genre', 'Action'), discover('genre', 'Horror'), discover('genre', 'Sports')];
  await Promise.all(pending);
  assert.equal((await discover('genre', 'Sports'))[0]?.title, 'Sports');
});

test('an unknown genre degrades to trending instead of an empty query', async () => {
  let seen: Record<string, unknown> = {};
  __setTransport({
    anilist: async (variables) => {
      seen = variables;
      return [node(21, 'Anything')];
    },
  });
  const rows = await discover('genre', 'Not A Genre');
  assert.deepEqual(seen.sort, ['TRENDING_DESC']);
  assert.equal(rows.length, 1);
});

test('genre with no genre at all is treated as trending', async () => {
  let seen: Record<string, unknown> = {};
  __setTransport({ anilist: async (variables) => { seen = variables; return [node(22, 'A')]; } });
  await discover('genre');
  assert.deepEqual(seen.sort, ['TRENDING_DESC']);
});

/* ---------- empty and invalid metadata ---------- */

test('an empty result is not cached, so the next call retries', async () => {
  let calls = 0;
  __setTransport({
    anilist: async () => {
      calls += 1;
      return calls === 1 ? [] : [node(30, 'Later')];
    },
  });
  assert.equal((await discover('trending')).length, 0);
  assert.equal((await discover('trending'))[0]?.title, 'Later');
  assert.equal(calls, 2);
});

test('invalid nodes are dropped without taking the row down', async () => {
  __setTransport({
    anilist: async () => [
      node(40, 'Good'),
      {} as never,
      { title: { romaji: '   ' } },
      { id: 41, title: { romaji: 'x'.repeat(300) } },
      { id: 42, title: { romaji: 'Also Good' }, episodes: 0, averageScore: 0, seasonYear: 12 },
    ],
  });
  const rows = await discover('trending');
  assert.deepEqual(rows.map((item) => item.title), ['Good', 'Also Good']);
  assert.equal(rows[1]?.episodes, undefined);
});

test('a Kitsu payload with junk still yields usable suggestions', async () => {
  __setTransport({
    kitsu: async () => ({
      data: [
        { id: '1', attributes: { canonicalTitle: 'Real One' } },
        null,
        { id: '2', attributes: {} },
        { id: '3', attributes: { canonicalTitle: 'Real Two', posterImage: { large: 'http://insecure/x.jpg' } } },
      ],
    }),
  });
  const items = await suggest('real');
  assert.deepEqual(items.map((item) => item.title), ['Real One', 'Real Two']);
  assert.equal(items[1]?.coverUrl, undefined);
});

/* ---------- offline / shape ---------- */

test('a term shorter than two characters never reaches the network', async () => {
  let calls = 0;
  __setTransport({ kitsu: async () => { calls += 1; return { data: [] }; } });
  assert.deepEqual(await suggest(' a '), []);
  assert.equal(calls, 0);
});

test('suggestions are capped so a busy payload cannot flood the list', async () => {
  __setTransport({
    kitsu: async () => ({
      data: Array.from({ length: 40 }, (_, i) => ({ id: String(i), attributes: { canonicalTitle: `Show ${i}` } })),
    }),
  });
  assert.equal((await suggest('show')).length, 6);
});