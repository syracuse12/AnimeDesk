/**
 * Progress durability at the service boundary.
 *
 * The embedded player reports position every second, but the periodic write is
 * only a backstop. Every real exit point (pause, seek, episode hand-off,
 * shutdown) has to reach disk on its own, otherwise closing the app mid-episode
 * loses the last few seconds and Resume points at the wrong place.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

// paths.ts resolves the data folder at import time, so the override has to be
// in place before anything is imported.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-durability-'));
process.env.ANIMEDESK_DATA_DIR = dataDir;

const { SessionManager } = await import('../server/playback/sessions.ts');
const { registerProvider } = await import('../server/providers/index.ts');
const { store } = await import('../server/store.ts');
const { DEFAULT_SETTINGS } = await import('../server/config.ts');
const type = await import('../shared/types.ts');
void type;

const EPISODES = 3;

registerProvider('hianime', {
  info: { id: 'hianime', name: 'fake', description: '', searchable: true, sourceNote: '' },
  async search() {
    return [];
  },
  async detail(id: string) {
    return {
      provider: 'hianime',
      id,
      title: 'Durable Show',
      coverUrl: 'https://img.test/durable.jpg',
      audio: ['sub'],
      availableAudio: ['sub'],
      episodeCount: EPISODES,
      episodes: Array.from({ length: EPISODES }, (_, index) => ({
        number: index + 1,
        label: `Episode ${index + 1}`,
        audio: ['sub'],
      })),
    };
  },
  async resolve(_id: string, episode: number) {
    return { url: `https://cdn.test/${episode}.m3u8`, referer: 'https://embed.test/' };
  },
  async ready() {
    return true;
  },
});

await store.load();

async function fresh(): Promise<{ manager: InstanceType<typeof SessionManager>; sessionId: string }> {
  await store.clearHistory();
  const manager = new SessionManager(null);
  const session = await manager.start({
    provider: 'hianime',
    animeId: 'durable-1',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
  });
  return { manager, sessionId: session.sessionId };
}

const saved = (key: string) => store.getHistoryEntry(key);
const KEY = 'hianime:durable-1:1:sub';

/** Give the async store write a turn to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test('failed history writes emit a user-visible error instead of disappearing', async () => {
  const { manager, sessionId } = await fresh();
  const write = mock.method(store, 'upsertHistory', async () => { throw new Error('disk unavailable'); });
  const log = mock.method(console, 'error', () => undefined);
  const errors: string[] = [];
  manager.on('history-error', (message: string) => errors.push(message));
  try {
    manager.reportById(sessionId, 25, 100, true);
    await settle();
    assert.match(errors[0] ?? '', /history could not be saved/i);
    assert.equal(saved(KEY), undefined);
  } finally {
    write.mock.restore();
    log.mock.restore();
    await manager.stopAll();
  }
});

test('the history entry carries the series artwork', async () => {
  const { manager, sessionId } = await fresh();
  manager.reportById(sessionId, 12, 1440, true);
  await settle();
  assert.equal(saved(KEY)?.coverUrl, 'https://img.test/durable.jpg');
  await manager.stopAll();
});

test('a pause writes the position without waiting for the tick', async () => {
  const { manager, sessionId } = await fresh();
  manager.reportById(sessionId, 40, 1440, true);
  await settle();
  await manager.action(sessionId, 'pause');
  await settle();
  assert.equal(saved(KEY)?.positionSeconds, 40);
  await manager.stopAll();
});

test('a seek writes the target position immediately', async () => {
  const { manager, sessionId } = await fresh();
  manager.reportById(sessionId, 10, 1440, true);
  await settle();
  await manager.action(sessionId, 'seek', 500);
  await settle();
  assert.equal(saved(KEY)?.positionSeconds, 500);
  await manager.stopAll();
});

test('an episode hand-off saves the position it left behind', async () => {
  const { manager, sessionId } = await fresh();
  manager.reportById(sessionId, 75, 1440, true);
  await settle();
  await manager.action(sessionId, 'next');
  await settle();
  assert.equal(saved(KEY)?.positionSeconds, 75);
  await manager.stopAll();
});

test('shutdown saves progress that the periodic tick had not reached', async () => {
  const { manager, sessionId } = await fresh();
  // No forced report at all: only the throttled path has run.
  manager.reportById(sessionId, 88, 1440);
  await manager.stopAll();
  await settle();
  assert.equal(saved(KEY)?.positionSeconds, 88);
});

test('a forced report bypasses the throttle, an ordinary one does not', async () => {
  const { manager, sessionId } = await fresh();
  manager.reportById(sessionId, 5, 1440, true);
  await settle();
  assert.equal(saved(KEY)?.positionSeconds, 5);

  // Inside the 5s window and not forced: the disk copy stays put.
  manager.reportById(sessionId, 6, 1440);
  await settle();
  assert.equal(saved(KEY)?.positionSeconds, 5);

  manager.reportById(sessionId, 7, 1440, true);
  await settle();
  assert.equal(saved(KEY)?.positionSeconds, 7);
  await manager.stopAll();
});

test('progress written before a restart is readable from disk', async () => {
  const { manager, sessionId } = await fresh();
  manager.reportById(sessionId, 33, 1440, true);
  await settle();
  await manager.stopAll();
  await settle();

  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'history.json'), 'utf8')) as {
    entries: { key: string; positionSeconds: number }[];
  };
  const entry = onDisk.entries.find((item) => item.key === KEY);
  assert.equal(entry?.positionSeconds, 33);

  // A cold manager reloads that entry and resumes from it.
  const reloaded = new SessionManager(null);
  const again = await reloaded.start({
    provider: 'hianime',
    animeId: 'durable-1',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
  });
  assert.equal(again.position, 33);
  assert.equal(store.getSettings().resumePlayback, DEFAULT_SETTINGS.resumePlayback);
  await reloaded.stopAll();
});

test('a completed episode keeps its completion flag through shutdown', async () => {
  const { manager, sessionId } = await fresh();
  manager.reportById(sessionId, 1440, 1440, true);
  await manager.endFromClient(sessionId, 1440);
  await manager.stopAll();
  await settle();
  assert.equal(saved(KEY)?.completed, true);
});
