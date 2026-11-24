import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_FRAG_RECOVERIES,
  classifyFatal,
  emptyRecovery,
  nextRecovery,
  noteProgress,
} from '../shared/player-recovery.ts';

/* ---- the reported failure ---- */

test('a fatal fragment load error is retried in place', () => {
  const decision = nextRecovery('frag', emptyRecovery(), 1000);
  assert.equal(decision.action, 'retry');
  assert.equal(decision.state.attempts, 1);
});

test('fragment retries are capped so a dead CDN cannot loop', () => {
  let state = emptyRecovery();
  for (let i = 0; i < MAX_FRAG_RECOVERIES; i += 1) {
    const decision = nextRecovery('frag', state, i * 10_000);
    assert.equal(decision.action, 'retry');
    state = decision.state;
  }
  assert.equal(nextRecovery('frag', state, 999_999).action, 'give-up');
});

test('the retry budget is small enough to stay bounded', () => {
  assert.ok(MAX_FRAG_RECOVERIES <= 3);
});

test('the cooldown widens with each attempt', () => {
  const first = nextRecovery('frag', emptyRecovery(), 0);
  const second = nextRecovery('frag', first.state, 0);
  assert.ok(second.delayMs > first.delayMs);
});

test('a successful fragment restores the budget', () => {
  const used = nextRecovery('frag', emptyRecovery(), 0).state;
  assert.equal(noteProgress(used).attempts, 0);
});

test('progress with a full budget does not churn state', () => {
  const clean = emptyRecovery();
  assert.equal(noteProgress(clean), clean);
});

/* ---- media errors are separate and rarer ---- */

test('a media error asks for a media recovery', () => {
  assert.equal(nextRecovery('media', emptyRecovery(), 0).action, 'recoverMedia');
});

test('only one media recovery is allowed', () => {
  const once = nextRecovery('media', emptyRecovery(), 0).state;
  assert.equal(nextRecovery('media', once, 5000).action, 'give-up');
});

/* ---- things that will not fix themselves ---- */

test('an unrecognised fatal error falls back immediately', () => {
  assert.equal(nextRecovery('other', emptyRecovery(), 0).action, 'give-up');
});

/* ---- classification ---- */

test('fragment details classify as fragment failures', () => {
  assert.equal(classifyFatal('fragLoadError'), 'frag');
  assert.equal(classifyFatal('fragParsingError'), 'frag');
  assert.equal(classifyFatal('bufferStalledError'), 'frag');
});

test('network details classify as network failures', () => {
  assert.equal(classifyFatal('levelLoadError'), 'network');
  assert.equal(classifyFatal('levelEmptyError'), 'network');
});

test('media details classify as media failures', () => {
  assert.equal(classifyFatal('mediaError'), 'media');
});

test('a manifest failure is not retried', () => {
  assert.equal(classifyFatal('manifestLoadError'), 'other');
  assert.equal(classifyFatal(undefined), 'other');
});