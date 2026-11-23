/**
 * History persistence across a full application restart.
 *
 * Phase 1 drives the real app, plays and advances a position, then stops.
 * The server is shut down. Phase 2 restarts through the normal launch path
 * (scripts/launch.mjs) on the same controlled data directory and proves the
 * progress survived and that resuming starts at the saved position.
 *
 *   node tests/persistence.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.ANIMEDESK_TEST_PORT ?? 47896);
const CDP_PORT = Number(process.env.ANIMEDESK_CDP_PORT ?? 9335);
const BASE = `http://127.0.0.1:${PORT}`;
const LIBRARY = path.resolve('.tmp/qa/library');
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-persist-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-persistprof-'));
fs.rmSync(LIBRARY, { recursive: true, force: true });
execFileSync(process.execPath, ['tests/setup-library.mjs', LIBRARY], { stdio: 'inherit' });

const api = async (route, init) => {
  const response = await fetch(BASE + route, { ...init, headers: { 'content-type': 'application/json' } });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

let service = null;
let browser = null;
let ws = null;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function connectBrowser() {
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
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor(() => evaluate('Boolean(document.querySelector(".rail"))'), 30_000, 'the app shell');
}

async function disconnectBrowser() {
  try { ws?.close(); } catch {}
  try { browser?.kill(); } catch {}
  ws = null;
  browser = null;
  await sleep(800);
}

function killStrayWindow() {
  try {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--app=${BASE}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore' });
  } catch { /* nothing stray */ }
}

async function waitForService() {
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/status`)).ok; } catch { return false; }
  }, 60_000, 'the service');
}

async function main() {
  /* ---------------- phase 1: play, advance, stop ---------------- */
  service = spawn(process.execPath, ['server/main.ts'], {
    env: { ...process.env, ANIMEDESK_PORT: String(PORT), ANIMEDESK_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  await waitForService();
  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ localLibraryDir: LIBRARY, autoNext: false, aniskipEnabled: false, embeddedPlayer: true, volume: 0, resumePlayback: true }),
  });
  record('fresh service starts on a controlled data directory', true, dataDir);

  await connectBrowser();
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
    'the long test series',
  );
  await evaluate(`[...document.querySelectorAll('.poster-card')].find((n) => /Long Show/.test(n.textContent ?? '')).click()`);
  await waitFor(() => evaluate('document.querySelectorAll(".episode-grid .episode").length >= 2'), 30_000, 'the episode list');
  await evaluate('document.querySelectorAll(".episode-grid .episode")[0].click()');
  await waitFor(() => evaluate(`(() => { const v = document.querySelector('.stage video'); return Boolean(v) && v.readyState >= 2; })()`), 30_000, 'episode 1 to load');
  record('episode 1 plays in the in-app player', true);

  // Play for real past both gates, then pause so the end is not reached: the
  // Continue Watching gate is 20s and the resume threshold is 30s, and the
  // fixture is 34.5s, so both are genuinely crossed by playing rather than by
  // writing history by hand.
  await waitFor(
    () => evaluate(`(() => { const v = document.querySelector('.stage video'); return v.currentTime > 31 ? v.currentTime : null; })()`),
    60_000,
    'playback past the 20s and 30s gates',
  );
  await evaluate(`(() => { const v = document.querySelector('.stage video'); v.pause(); return true; })()`);
  await waitFor(() => evaluate('document.querySelector(".stage video").paused === true'), 10_000, 'the pause');

  const live = (await api('/api/sessions')).body.sessions?.[0];
  const sessionId = live?.sessionId;
  record('a live session reports the advanced position', (live?.position ?? 0) > 30, `position=${live?.position}`);

  await api(`/api/sessions/${sessionId}/action`, { method: 'POST', body: JSON.stringify({ action: 'stop' }) });
  const saved = (await api('/api/history')).body.entries?.[0];
  record('stopping playback writes the position to history', Boolean(saved) && saved.positionSeconds > 30, JSON.stringify(saved ?? null));
  const savedPosition = saved?.positionSeconds ?? 0;

  await disconnectBrowser();
  killStrayWindow();
  service.kill();
  await sleep(2500);
  const downOk = await fetch(`${BASE}/api/status`).then(() => false).catch(() => true);
  record('the application and its server shut down', downOk);
  service = null;

  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'history.json'), 'utf8'));
  record('history is on disk after shutdown', onDisk.entries?.[0]?.positionSeconds > 30, JSON.stringify(onDisk.entries?.[0] ?? null));

  /* ---------------- phase 2: restart through the normal launcher ---------------- */
  service = spawn(process.execPath, ['scripts/launch.mjs'], {
    env: { ...process.env, ANIMEDESK_PORT: String(PORT), ANIMEDESK_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  await waitForService();
  record('restart through scripts/launch.mjs succeeds', true, `port ${PORT}`);

  const restored = (await api('/api/history')).body.entries?.[0];
  record(
    'the previous progress survives the restart',
    Boolean(restored) && restored.positionSeconds === savedPosition,
    `restored=${restored?.positionSeconds} saved=${savedPosition}`,
  );
  const feed = (await api('/api/home')).body;
  const inFeed = (feed.continueWatching ?? []).some((entry) => entry.animeId === restored?.animeId);
  record(
    'the series shows in Continue watching',
    inFeed,
    `${(feed.continueWatching ?? []).length} rows; position ${restored?.positionSeconds}s vs 20s gate`,
  );
  const cardArt = (feed.continueWatching ?? []).find((entry) => entry.animeId === restored?.animeId)?.coverUrl;
  const artResponse = cardArt ? await fetch(BASE + cardArt) : null;
  record('Continue Watching artwork survives service restart', artResponse?.ok === true && artResponse.headers.get('content-type')?.startsWith('image/') === true, cardArt ?? 'missing');
  await artResponse?.arrayBuffer();

  await connectBrowser();
  await evaluate('[...document.querySelectorAll(".rail-link")].find((n) => /History/.test(n.textContent ?? ""))?.click()');
  await waitFor(() => evaluate('Boolean(document.querySelector(".rows .btn.primary"))'), 30_000, 'the Resume button');
  await evaluate('document.querySelector(".rows .btn.primary").click()');
  await waitFor(() => evaluate('Boolean(document.querySelector(".stage video"))'), 30_000, 'the player');
  const resumedAt = await waitFor(async () => {
    const state = await evaluate(`(() => { const v = document.querySelector('.stage video'); if (!v) return null; return { t: v.currentTime, readyState: v.readyState, dur: v.duration }; })()`);
    return state && state.readyState >= 2 && state.t > 1.2 ? state : null;
  }, 30_000, 'playback to resume at the saved position');
  record(
    'resume starts at the saved position',
    Math.abs(resumedAt.t - savedPosition) < 1.5,
    `resumed=${resumedAt.t.toFixed(2)} saved=${savedPosition} duration=${resumedAt.dur}`,
  );
  record('the resumed stream decodes', resumedAt.readyState >= 2, `readyState=${resumedAt.readyState}`);

  const sessionStart = (await api('/api/sessions')).body.sessions?.[0];
  record('the session itself starts at the saved offset', Math.abs((sessionStart?.position ?? 0) - savedPosition) < 1.5, `position=${sessionStart?.position}`);
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
await disconnectBrowser();
killStrayWindow();
try { service?.kill(); } catch {}
await sleep(1500);
killStrayWindow();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
