import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../server/playback/sessions.ts';
import { registerProvider } from '../server/providers/index.ts';
import { Store } from '../server/store.ts';
import type { AnimeDetail, AudioMode, ProviderId, SearchResult, StreamSource } from '../shared/types.ts';
import type { Provider } from '../server/providers/types.ts';

const EPISODES = 3;

function detail(id: string, audio: AudioMode[] = ['sub', 'dub']): AnimeDetail {
  return {
    provider: 'hianime',
    id,
    title: 'Test Show',
    audio,
    availableAudio: audio,
    episodeCount: EPISODES,
    episodes: Array.from({ length: EPISODES }, (_, index) => ({
      number: index + 1,
      label: `Episode ${index + 1}`,
      audio,
    })),
  };
}

let lastAudio: AudioMode | null = null;
let lastEpisode = 0;

const fake: Provider = {
  info: {
    id: 'hianime',
    name: 'fake',
    description: '',
    searchable: true,
    sourceNote: '',
  },
  async search(): Promise<SearchResult[]> {
    return [];
  },
  async detail(id: string) {
    return detail(id);
  },
  async resolve(_id: string, episode: number, audio: AudioMode): Promise<StreamSource> {
    lastAudio = audio;
    lastEpisode = episode;
    return { url: `https://cdn.test/${episode}.m3u8`, referer: 'https://embed.test/' };
  },
  async ready() {
    return true;
  },
};

registerProvider('hianime' as ProviderId, fake);

async function manager(): Promise<SessionManager> {
  const store = new Store();
  await store.load();
  await store.clearHistory();
  const created = new SessionManager(null);
  return created;
}

test('embedded session is created without mpv and exposes a proxied stream', async () => {
  const sessions = await manager();
  const session = await sessions.start({
    provider: 'hianime',
    animeId: 'show-1',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
  });
  assert.equal(session.mode, 'embedded');
  assert.match(session.streamUrl ?? '', /^\/api\/stream\/[a-f0-9]{20}$/);
  assert.equal(session.episodeCount, EPISODES);
  assert.deepEqual(session.nextEpisode, { number: 2, label: 'Episode 2' });
  assert.equal(session.previousEpisode, null);
  await sessions.stopAll();
});

test('external mode needs mpv and reports why when it is missing', async () => {
  const sessions = await manager();
  await assert.rejects(
    () =>
      sessions.start({
        provider: 'hianime',
        animeId: 'show-1',
        episodeNumber: 1,
        audio: 'sub',
        mode: 'external',
      }),
    /mpv/,
  );
});

test('dub preference is kept when advancing episodes', async () => {
  const sessions = await manager();
  await sessions.start({
    provider: 'hianime',
    animeId: 'show-1',
    episodeNumber: 1,
    audio: 'dub',
    mode: 'embedded',
  });
  const advanced: string[] = [];
  sessions.on('advanced', (payload: { from: string; to: string }) => advanced.push(payload.to));

  const session = sessions.list()[0];
  assert.ok(session);
  await sessions.action(session.sessionId, 'next');

  const live = sessions.list()[0];
  assert.equal(live?.episodeNumber, 2);
  assert.equal(live?.audio, 'dub');
  assert.equal(lastAudio, 'dub');
  assert.equal(advanced.length, 1);
  await sessions.stopAll();
});

test('a hand-off names the session it superseded', async () => {
  const sessions = await manager();
  const first = await sessions.start({
    provider: 'hianime',
    animeId: 'show-10',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
  });
  assert.equal(first.supersedes, null);
  sessions.reportById(first.sessionId, 30, 1440);

  // Next is pressed while the old episode is still playing, not ended.
  await sessions.action(first.sessionId, 'next');

  const live = sessions.list();
  assert.equal(live.length, 1);
  assert.equal(live[0]?.episodeNumber, 2);
  assert.equal(live[0]?.supersedes, first.sessionId);
  await sessions.stopAll();
});

test('previous names the superseded session too', async () => {
  const sessions = await manager();
  const first = await sessions.start({
    provider: 'hianime',
    animeId: 'show-11',
    episodeNumber: 2,
    audio: 'sub',
    mode: 'embedded',
  });
  await sessions.action(first.sessionId, 'previous');
  const live = sessions.list();
  assert.equal(live[0]?.episodeNumber, 1);
  assert.equal(live[0]?.supersedes, first.sessionId);
  await sessions.stopAll();
});

test('a dub is downgraded when the provider does not list one', async () => {
  registerProvider('archive' as ProviderId, {
    ...fake,
    info: { ...fake.info, id: 'archive' },
    async detail(id: string) {
      return { ...detail(id, ['sub']), provider: 'archive' };
    },
  });
  const sessions = await manager();
  const session = await sessions.start({
    provider: 'archive',
    animeId: 'show-1',
    episodeNumber: 1,
    audio: 'dub',
    mode: 'embedded',
  });
  assert.equal(session.audio, 'sub');
  await sessions.stopAll();
});

test('the previous episode link is present from episode two', async () => {
  const sessions = await manager();
  const session = await sessions.start({
    provider: 'hianime',
    animeId: 'show-2',
    episodeNumber: 2,
    audio: 'sub',
    mode: 'embedded',
  });
  assert.deepEqual(session.previousEpisode, { number: 1, label: 'Episode 1' });
  assert.deepEqual(session.nextEpisode, { number: 3, label: 'Episode 3' });
  await sessions.stopAll();
});

/* ---- playback event handling ---- */

test('progress reports move the position and set the duration', async () => {
  const sessions = await manager();
  const session = await sessions.start({
    provider: 'hianime',
    animeId: 'show-3',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
  });
  sessions.reportById(session.sessionId, 42.5, 1440);
  const live = sessions.get(session.sessionId);
  assert.equal(live?.position, 42.5);
  assert.equal(live?.duration, 1440);
  assert.equal(live?.state, 'playing');
  await sessions.stopAll();
});

test('a real end writes completed history and starts the countdown', async () => {
  const sessions = await manager();
  const session = await sessions.start({
    provider: 'hianime',
    animeId: 'show-4',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
  });
  sessions.reportById(session.sessionId, 1439, 1440);
  await sessions.endFromClient(session.sessionId, 1440);

  const live = sessions.get(session.sessionId);
  assert.equal(live?.completed, true);
  assert.equal(live?.state, 'countdown');
  assert.ok((live?.nextAt ?? 0) > Date.now() - 1000);

  const entry = new Store();
  await entry.load();
  const saved = entry.getHistory().find((item) => item.animeId === 'show-4');
  assert.equal(saved?.completed, true);
  await sessions.stopAll();
});

test('a duplicate end report does not double-fire', async () => {
  const sessions = await manager();
  const session = await sessions.start({
    provider: 'hianime',
    animeId: 'show-5',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
  });
  await sessions.endFromClient(session.sessionId, 1440);
  const first = sessions.get(session.sessionId)?.nextAt;
  await sessions.endFromClient(session.sessionId, 1440);
  assert.equal(sessions.get(session.sessionId)?.nextAt, first);
  await sessions.stopAll();
});

test('cancelling the countdown leaves the episode ended, not advanced', async () => {
  const sessions = await manager();
  const session = await sessions.start({
    provider: 'hianime',
    animeId: 'show-6',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
  });
  await sessions.endFromClient(session.sessionId, 1440);
  await sessions.action(session.sessionId, 'cancelCountdown');
  const live = sessions.get(session.sessionId);
  assert.equal(live?.state, 'ended');
  assert.equal(live?.nextAt, null);
  assert.equal(live?.completed, true);
  await sessions.stopAll();
});

test('seeking is clamped to the known duration', async () => {
  const sessions = await manager();
  const session = await sessions.start({
    provider: 'hianime',
    animeId: 'show-7',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
  });
  sessions.reportById(session.sessionId, 10, 100);
  await sessions.action(session.sessionId, 'seek', 5000);
  assert.equal(sessions.get(session.sessionId)?.position, 100);
  await sessions.action(session.sessionId, 'seek', -20);
  assert.equal(sessions.get(session.sessionId)?.position, 0);
  await sessions.stopAll();
});

test('pause and resume flip the state', async () => {
  const sessions = await manager();
  const session = await sessions.start({
    provider: 'hianime',
    animeId: 'show-8',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
  });
  sessions.reportById(session.sessionId, 5, 100);
  await sessions.action(session.sessionId, 'pause');
  assert.equal(sessions.get(session.sessionId)?.state, 'paused');
  await sessions.action(session.sessionId, 'resume');
  assert.equal(sessions.get(session.sessionId)?.state, 'playing');
  await sessions.stopAll();
});

test('resume playback starts from saved history', async () => {
  const sessions = await manager();
  const first = await sessions.start({
    provider: 'hianime',
    animeId: 'show-9',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
  });
  sessions.reportById(first.sessionId, 300, 1440);
  await sessions.stopAll();

  // Force a history write, then reopen the same episode.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const store = new Store();
  await store.load();
  await store.upsertHistory({
    key: 'hianime:show-9:1:sub',
    provider: 'hianime',
    animeId: 'show-9',
    animeTitle: 'Test Show',
    episodeLabel: 'Episode 1',
    audio: 'sub',
    episodeNumber: 1,
    positionSeconds: 300,
    durationSeconds: 1440,
    completed: false,
    updatedAt: Date.now(),
  });

  const again = await sessions.start({
    provider: 'hianime',
    animeId: 'show-9',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
  });
  assert.equal(again.position, 300);
  await sessions.stopAll();
});

test('an explicit startAt overrides saved progress', async () => {
  const sessions = await manager();
  const session = await sessions.start({
    provider: 'hianime',
    animeId: 'show-9',
    episodeNumber: 1,
    audio: 'sub',
    mode: 'embedded',
    startAt: 0,
  });
  assert.equal(session.position, 0);
  await sessions.stopAll();
});