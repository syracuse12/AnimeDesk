/**
 * Continue Watching, end to end, with real playback.
 *
 * Uses the 34.5s fixture so the 20s eligibility gate can actually be crossed
 * by playing, not by writing history by hand. Everything here is a real DOM
 * interaction against the real service: a real <video> element is allowed to
 * play past the gate, the page is reloaded, and Resume is clicked.
 *
 *   node tests/continue-watching.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.ANIMEDESK_TEST_PORT ?? 47893);
const CDP_PORT = Number(process.env.ANIMEDESK_CDP_PORT ?? 9337);
const BASE = `http://127.0.0.1:${PORT}`;
const LIBRARY = path.resolve('.tmp/qa/library');
const SHOTS = path.resolve('.tmp/qa/shots');
const GATE = 20;
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
execFileSync(process.execPath, ['tests/setup-library.mjs', LIBRARY], { stdio: 'inherit' });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-cw-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-cwprof-'));
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

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}

async function attach() {
  const target = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      return list.find((item) => item.type === 'page' && item.url.startsWith(BASE));
    } catch {
      return null;
    }
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
}

function launchBrowser() {
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
}

async function detach() {
  try { ws?.close(); } catch {}
  try { browser?.kill(); } catch {}
  ws = null;
  browser = null;
  await sleep(900);
}

function cleanup() {
  try { ws?.close(); } catch {}
  try { browser?.kill(); } catch {}
  try { service.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

const cardState = () => evaluate(`(() => {
  const card = document.querySelector('.row-block .continue');
  if (!card) return null;
  const img = card.querySelector('.continue-art img');
  const fill = card.querySelector('.continue-bar span');
  const art = card.querySelector('.continue-art');
  return {
    title: card.querySelector('strong')?.textContent?.trim() ?? '',
    sub: card.querySelector('small')?.textContent?.trim() ?? '',
    hasImg: Boolean(img),
    imgSrc: img?.getAttribute('src') ?? '',
    imgLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
    imgBox: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
    artBox: art ? art.getBoundingClientRect().toJSON() : null,
    barWidth: fill ? fill.getBoundingClientRect().width : 0,
    trackWidth: card.querySelector('.continue-bar')?.getBoundingClientRect().width ?? 0,
    heading: [...document.querySelectorAll('.row-block h2')].map((n) => n.textContent?.trim()),
  };
})()`);

async function main() {
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/status`)).ok; } catch { return false; }
  }, 40_000, 'the service');

  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ localLibraryDir: LIBRARY, autoNext: false, aniskipEnabled: false, embeddedPlayer: true, volume: 0, resumePlayback: true }),
  });

  const duration = await (async () => {
    const detail = (await api('/api/search?q=Long%20Show')).body.results?.[0];
    return detail;
  })();
  record('the long fixture series is visible to the provider', Boolean(duration?.title), duration?.title ?? 'missing');

  launchBrowser();
  await attach();

  /* --- play episode 1 for real, past the gate --- */
  await evaluate(`(() => {
    const input = document.querySelector('.rail-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Long Show');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);
  await waitFor(
    () => evaluate(`Boolean([...document.querySelectorAll('.poster-card')].find((n) => /Long Show/.test(n.textContent ?? '')))`),
    30_000,
    'the long series card',
  );
  await evaluate(`[...document.querySelectorAll('.poster-card')].find((n) => /Long Show/.test(n.textContent ?? '')).click()`);
  await waitFor(() => evaluate('document.querySelectorAll(".episode-grid .episode").length >= 2'), 30_000, 'the episode list');
  await evaluate('document.querySelectorAll(".episode-grid .episode")[0].click()');
  await waitFor(
    () => evaluate(`(() => { const v = document.querySelector('.stage video'); return Boolean(v) && v.readyState >= 2 && v.duration > ${GATE + 5}; })()`),
    30_000,
    'the long episode to load',
  );
  const media = await evaluate(`(() => { const v = document.querySelector('.stage video'); return { dur: v.duration, w: v.videoWidth, h: v.videoHeight, readyState: v.readyState }; })()`);
  record('the fixture is genuinely longer than the gate', media.dur > GATE, `duration=${media.dur}s gate=${GATE}s`);

  // Play for real until the playhead is past the gate.
  const passed = await waitFor(
    () => evaluate(`(() => { const v = document.querySelector('.stage video'); return v.currentTime > ${GATE + 3} ? v.currentTime : null; })()`),
    60_000,
    `playback past ${GATE}s`,
  );
  record('playback passes the 20s eligibility threshold', passed > GATE, `currentTime=${Number(passed).toFixed(2)}s`);
  record('real frames decode on the long fixture', media.w > 0 && media.h > 0, `${media.w}x${media.h}`);

  const liveSession = (await api('/api/sessions')).body.sessions?.[0];
  record('the live session reports the played position', (liveSession?.position ?? 0) > GATE, `position=${liveSession?.position}`);

  /* --- pause, then reload: the card must survive a restart --- */
  await evaluate(`(() => { document.querySelector('.stage video').pause(); return true; })()`);
  await waitFor(() => evaluate('document.querySelector(".stage video").paused === true'), 10_000, 'the pause');
  const savedBefore = (await api('/api/history')).body.entries?.[0];
  record('pausing persists the position without a timer', (savedBefore?.positionSeconds ?? 0) > GATE, `saved=${savedBefore?.positionSeconds}`);
  await shot('10-continue-playing');

  await detach();
  launchBrowser();
  await attach();
  await waitFor(() => evaluate('document.querySelectorAll(".row-block").length > 0'), 30_000, 'the home feed');

  /* --- the card --- */
  const card = await waitFor(cardState, 30_000, 'the Continue Watching card');
  record('a Continue Watching card appears', Boolean(card), card?.title ?? 'none');
  record('it sits under the Continue watching heading', (card?.heading ?? []).includes('Continue watching'), JSON.stringify(card?.heading));
  record('the card names the right series', card?.title === 'Long Show', card?.title ?? '');
  record('the card names the right episode', /01 - Long One/.test(card?.sub ?? ''), card?.sub ?? '');
  record('the card shows series artwork', Boolean(card?.hasImg && card.imgLoaded), `src=${card?.imgSrc} ${card?.imgBox?.w}x${card?.imgBox?.h}`);
  record('the artwork actually decodes at a real size', (card?.imgBox?.w ?? 0) > 100, JSON.stringify(card?.imgBox));

  const saved = (await api('/api/history')).body.entries?.[0];
  const shownPercent = card && card.trackWidth ? (card.barWidth / card.trackWidth) * 100 : 0;
  const truePercent = saved?.durationSeconds ? (saved.positionSeconds / saved.durationSeconds) * 100 : 0;
  record('the progress bar matches the saved position', Math.abs(shownPercent - truePercent) < 2, `bar=${shownPercent.toFixed(1)}% actual=${truePercent.toFixed(1)}%`);
  record('the card states the time it left off', /\b0:(2[0-9]|3[0-9])\b/.test(card?.sub ?? ''), card?.sub ?? '');
  await shot('11-continue-card');

  /* --- restart preserves the card --- */
  await detach();
  launchBrowser();
  await attach();
  await waitFor(() => evaluate('document.querySelectorAll(".row-block").length > 0'), 30_000, 'the home feed after a second restart');
  const again = await waitFor(cardState, 30_000, 'the card after a second restart');
  record('the card survives a second restart', Boolean(again), again?.title ?? 'none');
  record('the saved position is unchanged across restarts', (await api('/api/history')).body.entries?.[0]?.positionSeconds === saved?.positionSeconds, `${(await api('/api/history')).body.entries?.[0]?.positionSeconds} vs ${saved?.positionSeconds}`);

  /* --- resume --- */
  const target = saved?.positionSeconds ?? 0;
  await evaluate('document.querySelector(".row-block .continue").click()');
  await waitFor(() => evaluate('Boolean(document.querySelector(".stage video"))'), 30_000, 'the player from the card');
  const resumed = await waitFor(
    async () => {
      const state = await evaluate(`(() => { const v = document.querySelector('.stage video'); if (!v) return null; return { t: v.currentTime, rs: v.readyState, dur: v.duration }; })()`);
      return state && state.rs >= 2 && state.t > GATE ? state : null;
    },
    40_000,
    'playback to resume past the gate',
  );
  record('Resume starts at the saved position, not zero', Math.abs(resumed.t - target) < 2.5, `resumed=${resumed.t.toFixed(2)} saved=${target}`);
  record('the resumed stream decodes', resumed.rs >= 2, `readyState=${resumed.rs} duration=${resumed.dur}`);
  const resumedSession = (await api('/api/sessions')).body.sessions?.[0];
  record('the session itself opens at the saved offset', Math.abs((resumedSession?.position ?? 0) - target) < 2.5, `position=${resumedSession?.position}`);
  await shot('12-continue-resumed');

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
await sleep(500);
process.exit(failed || failure ? 1 : 0);