import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptSession } from '../shared/session-merge.ts';
import type { PlaybackSession } from '../shared/types.ts';

function session(patch: Partial<PlaybackSession> = {}): PlaybackSession {
  return {
    sessionId: 'id-1',
    supersedes: null,
    provider: 'hianime',
    animeId: 'show',
    animeTitle: 'Show',
    episodeNumber: 1,
    episodeCount: 12,
    episodeLabel: 'Episode 1',
    audio: 'sub',
    state: 'playing',
    position: 10,
    duration: 1440,
    paused: false,
    completed: false,
    nextEpisode: { number: 2, label: 'Episode 2' },
    previousEpisode: null,
    nextAt: null,
    mode: 'embedded',
    streamUrl: '/api/stream/token',
    hls: true,
    subtitleUrl: null,
    skips: null,
    startedAt: 1,
    ...patch,
  };
}

/*
 * Regression: pressing Next while episode 1 was still `playing` published the
 * new session, the reducer refused it because the old state was not `ended`,
 * and the player stayed on episode 1 forever.
 */
test('a hand-off is accepted while the old episode is still playing', () => {
  const current = session({ sessionId: 'old' });
  const next = session({ sessionId: 'new', supersedes: 'old', episodeNumber: 2 });
  assert.equal(acceptSession(current, next).sessionId, 'new');
});

test('autoplay hand-off after the end signal is accepted', () => {
  const current = session({ sessionId: 'old', state: 'countdown' });
  const next = session({ sessionId: 'new', supersedes: 'old', episodeNumber: 2 });
  assert.equal(acceptSession(current, next).sessionId, 'new');
});

test('a stale frame from the episode we left cannot win', () => {
  const current = session({ sessionId: 'new', episodeNumber: 2 });
  const stale = session({ sessionId: 'old', episodeNumber: 1, position: 1400 });
  assert.equal(acceptSession(current, stale).sessionId, 'new');
});

test('frames for the held session are applied', () => {
  const current = session({ sessionId: 'same', position: 10 });
  const next = session({ sessionId: 'same', position: 55 });
  assert.equal(acceptSession(current, next).position, 55);
});

test('the first session is always adopted', () => {
  assert.equal(acceptSession(null, session()).sessionId, 'id-1');
});

test('a closed session may be replaced by a fresh one', () => {
  const current = session({ sessionId: 'old', state: 'closed' });
  const next = session({ sessionId: 'new' });
  assert.equal(acceptSession(current, next).sessionId, 'new');
});