/**
 * Genuine autoplay QA: a real <video> element is allowed to reach its real end.
 *
 * No HTTP POST stands in for EOF and no synthetic `ended` is dispatched. The
 * media element plays a 5.759s local file to completion; the only end signal is
 * the element's own `ended` event, which the player turns into an API call.
 *
 *   node tests/autoplay.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.ANIMEDESK_TEST_PORT ?? 47897);
const CDP_PORT = Number(process.env.ANIMEDESK_CDP_PORT ?? 9334);
const BASE = `http://127.0.0.1:${PORT}`;
const LIBRARY = path.resolve('.tmp/qa/library');
const SHOTS = path.resolve('.tmp/qa/shots');
const EDGE =
  process.env.ANIMEDESK_BROWSER ??
  [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].find((candidate) => fs.existsSync(candidate));

const results = [];
function record(name, verdict, detail = '') {
  const normalized = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict;
  results.push({ name, verdict: normalized, detail });
  console.log(`${normalized}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

if (!EDGE) {
  console.error('No Edge or Chrome found.');
  process.exit(1);
}

fs.rmSync(LIBRARY, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
const { execFileSync } = await import('node:child_process');
execFileSync(process.execPath, ['tests/setup-library.mjs', LIBRARY], { stdio: 'inherit' });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-auto-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-autoprof-'));
const service = spawn(process.execPath, ['server/main.ts'], {
  env: { ...process.env, ANIMEDESK_PORT: String(PORT), ANIMEDESK_DATA_DIR: dataDir },
  stdio: 'ignore',
});

const api = async (route, init) => {
  const response = await fetch(BASE + route, { ...init, headers: { 'content-type': 'application/json' } });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

let browser;
let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function click(selector) {
  const ok = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.click();
    return true;
  })()`);
  if (!ok) throw new Error(`nothing to click for ${selector}`);
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

function cleanup() {
  try { ws?.close(); } catch {}
  try { browser?.kill(); } catch {}
  try { service.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

const heading = () => evaluate('document.querySelector(".stage-heading span")?.textContent?.trim() ?? ""');
const sessionState = async () => (await api('/api/sessions')).body.sessions?.[0]?.state ?? 'none';

/** Arm the media element so a real `ended` is observed, not inferred. */
async function armEndProbe() {
  return evaluate(`(() => {
    const video = document.querySelector('.stage video');
    if (!video) return false;
    window.__qa = { ended: 0, at: null, duration: null, frames: 0, samples: [] };
    video.addEventListener('ended', () => {
      window.__qa.ended += 1;
      window.__qa.at = video.currentTime;
      window.__qa.duration = video.duration;
    });
    window.__qaTimer = setInterval(() => {
      window.__qa.frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      window.__qa.samples.push(Number(video.currentTime.toFixed(2)));
    }, 250);
    return true;
  })()`);
}

const probe = () => evaluate('window.__qa ? JSON.parse(JSON.stringify(window.__qa)) : null');

/** Open the test series and start episode 1 from a clean state. */
async function startEpisodeOne() {
  await evaluate(`(() => {
    const back = document.querySelector('.stage-top .icon-btn');
    back?.click();
    return true;
  })()`);
  await sleep(400);
  await evaluate(`(() => {
    const input = document.querySelector('.rail-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'QA Test Show');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);
  await waitFor(
    () => evaluate(`Boolean([...document.querySelectorAll('.poster-card')].find((n) => /QA Test Show/.test(n.textContent ?? '')))`),
    30_000,
    'the test series card',
  );
  await evaluate(`[...document.querySelectorAll('.poster-card')].find((n) => /QA Test Show/.test(n.textContent ?? '')).click()`);
  // The primary button resumes at the first unwatched episode, so once episode 1
  // is complete it would open episode 2. Click the episode 1 tile directly.
  await waitFor(
    () => evaluate('document.querySelectorAll(".episode-grid .episode").length >= 2'),
    30_000,
    'the episode list',
  );
  await evaluate('document.querySelectorAll(".episode-grid .episode")[0].click()');
  await waitFor(() => evaluate('Boolean(document.querySelector(".stage video"))'), 30_000, 'the player');
  await waitFor(async () => /01 - First Contact/.test(await heading()), 20_000, 'episode 1 heading');
}

async function main() {
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/status`)).ok; } catch { return false; }
  }, 40_000, 'the service');

  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      localLibraryDir: LIBRARY,
      autoNext: true,
      autoNextDelaySeconds: 4,
      aniskipEnabled: false,
      embeddedPlayer: true,
      volume: 0,
    }),
  });
  record('service starts with a two-episode local library', true, LIBRARY);

  browser = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1440,960',
    `${BASE}/`,
  ], { stdio: 'ignore' });

  const target = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      return list.find((item) => item.type === 'page' && item.url.startsWith(BASE));
    } catch { return null; }
  }, 40_000, 'a browser page');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails.exception?.description ?? 'exception');
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor(() => evaluate('Boolean(document.querySelector(".rail"))'), 30_000, 'the app shell');

  /* ---------------- 1. genuine end to next episode ---------------- */
  await startEpisodeOne();
  await waitFor(() => evaluate(`(() => { const v = document.querySelector('.stage video'); return Boolean(v) && v.readyState >= 2 && v.currentTime > 0.15; })()`), 30_000, 'episode 1 to actually play');
  record('episode 1 decodes and the playhead moves', true, JSON.stringify(await evaluate(`(() => { const v = document.querySelector('.stage video'); return { readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, frames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, t: v.currentTime, dur: v.duration }; })()`)));
  await shot('03-active-playback');

  await armEndProbe();
  const beforeEnd = await probe();
  record('end probe armed on the live element', true, `frames=${beforeEnd.frames} t=${beforeEnd.samples.at(-1)}`);

  const endedAt = await waitFor(async () => {
    const state = await probe();
    return state && state.ended > 0 ? state : null;
  }, 40_000, 'the real ended event');
  record(
    'the real HTMLMediaElement ended event fired',
    true,
    `ended x${endedAt.ended} at t=${endedAt.at} duration=${endedAt.duration}`,
  );
  record(
    'the element genuinely reached the end of the file',
    Number(endedAt.at) > 5.4 && Math.abs(Number(endedAt.duration) - 5.759) < 0.2,
    `t=${endedAt.at} dur=${endedAt.duration}`,
  );
  record('decoded frames accumulated while playing', endedAt.frames > 0, `frames=${endedAt.frames}`);
  record('playhead advanced in real steps', new Set(endedAt.samples).size > 5, `samples=${endedAt.samples.length} distinct=${new Set(endedAt.samples).size}`);

  const history = await api('/api/history');
  const completed = (history.body.entries ?? []).find((entry) => entry.episodeNumber === 1);
  record('history records completion', Boolean(completed?.completed), JSON.stringify(completed ?? null));

  const countdown = await waitFor(() => evaluate('document.querySelector(".stage-countdown")?.textContent ?? ""'), 15_000, 'the countdown');
  record('the next-episode countdown appears', /Up next/i.test(countdown), countdown.replace(/\s+/g, ' ').slice(0, 90));
  await shot('04-countdown');

  const nextHeading = await waitFor(async () => {
    const text = await heading();
    return /02 - Second Contact/.test(text) ? text : null;
  }, 30_000, 'the next episode to load automatically');
  record('the next episode loads automatically', true, nextHeading);

  const nextHealth = await waitFor(async () => {
    const state = await evaluate(`(() => {
      const v = document.querySelector('.stage video');
      if (!v) return null;
      return { readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, frames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, t: v.currentTime };
    })()`);
    return state && state.readyState >= 2 && state.w > 0 && state.t > 0.2 ? state : null;
  }, 40_000, 'the next episode to decode and advance');
  record('readyState >= 2 on the next episode', nextHealth.readyState >= 2, `readyState=${nextHealth.readyState}`);
  record('real frames decode on the next episode', nextHealth.frames > 0 && nextHealth.w > 0, `${nextHealth.w}x${nextHealth.h} frames=${nextHealth.frames}`);
  record('the playhead advances on the next episode', nextHealth.t > 0.2, `t=${nextHealth.t}`);

  /* ---------------- 2. fullscreen controls ---------------- */
  await evaluate(`document.querySelector('.stage').requestFullscreen()`);
  await sleep(700);
  const fsState = await evaluate(`(() => ({ full: Boolean(document.fullscreenElement), controls: document.querySelectorAll('.control-row .icon-btn').length, seek: Boolean(document.querySelector('.scrub input')) }))()`);
  record('fullscreen engages with controls visible', fsState.full && fsState.controls >= 4 && fsState.seek, JSON.stringify(fsState));
  await shot('05-fullscreen-controls');
  await evaluate('document.exitFullscreen()');
  await sleep(400);

  /* ---------------- 3. countdown cancellation ---------------- */
  await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ autoNextDelaySeconds: 8 }) });
  await startEpisodeOne();
  await waitFor(() => evaluate(`(() => { const v = document.querySelector('.stage video'); return Boolean(v) && v.readyState >= 2; })()`), 30_000, 'episode 1 again');
  await armEndProbe();
  await waitFor(async () => { const s = await probe(); return s && s.ended > 0; }, 40_000, 'the second real ended event');
  record('a second real ended event fires on replay', true);
  await waitFor(() => evaluate('Boolean(document.querySelector(".stage-countdown"))'), 15_000, 'the countdown again');
  await click('.stage-countdown .btn:not(.primary)');
  await sleep(600);
  const cancelledState = await sessionState();
  const countdownGone = await evaluate('!document.querySelector(".stage-countdown")');
  record('cancelling the countdown stops the advance', cancelledState === 'ended' && countdownGone, `state=${cancelledState} countdownGone=${countdownGone}`);
  await sleep(9000);
  record('the episode stays put well past the delay', (await heading()).includes('01 - First Contact'), await heading());

  /* ---------------- 4. autoplay disabled ---------------- */
  await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ autoNext: false }) });
  await startEpisodeOne();
  await waitFor(() => evaluate(`(() => { const v = document.querySelector('.stage video'); return Boolean(v) && v.readyState >= 2; })()`), 30_000, 'episode 1 for the disabled run');
  await armEndProbe();
  await waitFor(async () => { const s = await probe(); return s && s.ended > 0; }, 40_000, 'the real ended event with autoplay off');
  await sleep(1200);
  const disabledState = await sessionState();
  const disabledCountdown = await evaluate('Boolean(document.querySelector(".stage-countdown"))');
  record('autoplay disabled leaves the episode ended', disabledState === 'ended', `state=${disabledState}`);
  record('autoplay disabled shows no countdown', !disabledCountdown, `countdown=${disabledCountdown}`);
  await sleep(4000);
  record('autoplay disabled does not advance', (await heading()).includes('01 - First Contact'), await heading());

  record('no uncaught console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
  record('run completed without throwing', 'FAIL', error.message);
}

const failed = results.filter((item) => item.verdict === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failure) console.error(failure.stack);
cleanup();
await sleep(400);
process.exit(failed ? 1 : 0);