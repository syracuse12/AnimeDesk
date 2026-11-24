/**
 * Bounded recovery for fatal hls.js errors.
 *
 * A fragLoadError 20 minutes into an episode is usually transient: one segment
 * request hits a CDN hiccup and hls.js gives up on the whole session. Failing
 * straight to mpv throws away the viewer's position, so a couple of cheap
 * in-place retries are tried first — but a broken manifest must not spin
 * forever, hence the cap and the widening cooldown.
 *
 * Pure, so the policy is testable without a browser or a network.
 */

export type FatalKind = 'frag' | 'network' | 'media' | 'other';
export type RecoveryAction = 'retry' | 'recoverMedia' | 'give-up';

export interface RecoveryState {
  attempts: number;
  /** When the last attempt was made, epoch ms. */
  lastAt: number;
  /** Media-element recoveries are more invasive, so they get their own budget. */
  media: number;
}

export const MAX_FRAG_RECOVERIES = 2;
export const MAX_MEDIA_RECOVERIES = 1;
const COOLDOWN_MS = 1500;
const COOLDOWN_MAX_MS = 8000;

export function emptyRecovery(): RecoveryState {
  return { attempts: 0, lastAt: 0, media: 0 };
}

/**
 * Sort a fatal hls.js detail into the recovery that fits it. Anything we do not
 * recognise is not retried: a 404 manifest will not fix itself.
 */
export function classifyFatal(details: string | undefined): FatalKind {
  const value = (details ?? '').toLowerCase();
  if (value.includes('fragload') || value.includes('fragparsing')) return 'frag';
  if (value.includes('bufferstalled') || value.includes('bufferappend')) return 'frag';
  if (value.includes('levelempty') || value.includes('levelload') || value.includes('audiotrackload')) return 'network';
  if (value.includes('mediaerror')) return 'media';
  return 'other';
}

export interface RecoveryDecision {
  action: RecoveryAction;
  /** How long to wait before acting, so a hot loop cannot form. */
  delayMs: number;
  state: RecoveryState;
}

export function nextRecovery(
  kind: FatalKind,
  state: RecoveryState,
  now: number = Date.now(),
): RecoveryDecision {
  const delayMs = Math.min(COOLDOWN_MAX_MS, COOLDOWN_MS * (state.attempts + 1));

  if (kind === 'other') return { action: 'give-up', delayMs: 0, state };

  if (kind === 'media') {
    if (state.media >= MAX_MEDIA_RECOVERIES) return { action: 'give-up', delayMs: 0, state };
    return { action: 'recoverMedia', delayMs, state: { ...state, media: state.media + 1, lastAt: now } };
  }

  if (state.attempts >= MAX_FRAG_RECOVERIES) return { action: 'give-up', delayMs: 0, state };
  return { action: 'retry', delayMs, state: { ...state, attempts: state.attempts + 1, lastAt: now } };
}

/** A fragment finally arrived: the budget starts over. */
export function noteProgress(state: RecoveryState): RecoveryState {
  if (state.attempts === 0 && state.media === 0) return state;
  return { ...state, attempts: 0, media: 0 };
}