/**
 * Visual QA: capture every required screen at desktop and narrow widths so the
 * layout can actually be inspected. Screenshots land in .tmp/qa/shots.
 *
 *   node tests/screens.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.ANIMEDESK_TEST_PORT ?? 47894);
const CDP_PORT = Number(process.env.ANIMEDESK_CDP_PORT ?? 9336);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Click a poster card atomically. The search view swaps the previous card list
 * out asynchronously, so finding and clicking in one evaluate avoids a race
 * where the card disappears between the two calls.
 */
async function clickCard(title) {
  const re = new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  await waitFor(
    () => evaluate(`Boolean([...document.querySelectorAll('.poster-card')].find((n) => ${re}.test(n.textContent ?? '')))`),
    30_000,
    `the ${title} card`,
  );
  await waitFor(
    () =>
      evaluate(`(() => {
        const node = [...document.querySelectorAll('.poster-card')].find((n) => ${re}.test(n.textContent ?? ''));
        if (!node) return false;
        node.click();
        return true;
      })()`),
    20_000,
    `a click on ${title}`,
  );
}

const results = [];
function record(name, verdict, detail = '') {
  results.push({ name, verdict, detail });
  console.log(`${verdict}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

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
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
execFileSync(process.execPath, ['tests/setup-library.mjs', LIBRARY], { stdio: 'inherit' });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-shots-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-shotprof-'));
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

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`shot  ${name}`);
}

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
}

function cleanup() {
  try { ws?.close(); } catch {}
  try { browser?.kill(); } catch {}
  try { service.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

async function main() {
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/status`)).ok; } catch { return false; }
  }, 40_000, 'the service');

  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ localLibraryDir: LIBRARY, aniskipEnabled: false, embeddedPlayer: true, volume: 0, autoNext: false }),
  });

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
  await setViewport(1440, 960);
  await waitFor(() => evaluate('Boolean(document.querySelector(".rail"))'), 30_000, 'the app shell');
  await sleep(1200);
  await shot('01-homepage');

  /* search */
  await evaluate(`(() => {
    const input = document.querySelector('.rail-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'QA Test Show');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);
  await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('.poster-card')].find((n) => /QA Test Show/.test(n.textContent ?? '')))`), 30_000, 'search results');
  await sleep(700);
  await shot('02-search-results');

  /* detail */
  await clickCard('QA Test Show');
  await waitFor(() => evaluate('document.querySelectorAll(".episode-grid .episode").length >= 2'), 30_000, 'the detail page');
  await sleep(900);
  await shot('03-detail');

  /* playback */
  await evaluate('document.querySelectorAll(".episode-grid .episode")[0].click()');
  await waitFor(() => evaluate(`(() => { const v = document.querySelector('.stage video'); return Boolean(v) && v.readyState >= 2; })()`), 30_000, 'playback');
  await sleep(900);
  await evaluate('document.querySelector(".stage").dispatchEvent(new MouseEvent("mousemove", { bubbles: true }))');
  await sleep(400);
  await shot('04-playback');

  /* settings */
  await evaluate('[...document.querySelectorAll(".rail-link")].find((n) => /Settings/.test(n.textContent ?? ""))?.click()');
  await waitFor(
    () => evaluate('document.querySelector(".page.narrow h1")?.textContent?.trim() === "Settings"'),
    20_000,
    'the settings view',
  );
  await sleep(800);
  await shot('05-settings');

  /* error handling: a corrupt local file, played through the real UI */
  await evaluate('document.querySelectorAll(".rail-nav .rail-link")[0].click()');
  await sleep(600);
  await evaluate(`(() => {
    const input = document.querySelector('.rail-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Broken Show');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);
  await waitFor(
    () => evaluate(`Boolean([...document.querySelectorAll('.poster-card')].find((n) => /Broken Show/.test(n.textContent ?? '')))`),
    30_000,
    'the broken series card',
  );
  await clickCard('Broken Show');
  await waitFor(() => evaluate('document.querySelectorAll(".episode-grid .episode").length >= 1'), 30_000, 'the broken episode');
  await evaluate('document.querySelectorAll(".episode-grid .episode")[0].click()');
  await waitFor(() => evaluate('Boolean(document.querySelector(".stage video"))'), 30_000, 'the broken player');
  const errorShown = await waitFor(
    () => evaluate('Boolean(document.querySelector(".stage-error"))'),
    30_000,
    'the in-player error panel',
  ).then(() => true).catch(() => false);
  record(`error panel appears for a corrupt file: ${errorShown}`, errorShown ? 'PASS' : 'FAIL');
  await sleep(600);
  await shot('06-error');

  /* narrow layout */
  await setViewport(560, 900);
  await evaluate('document.querySelectorAll(".rail-nav .rail-link")[0].click()');
  await sleep(900);
  await shot('07-narrow');
  await setViewport(1440, 960);

  /* fullscreen-style controls on a live stage */
  await evaluate('document.querySelectorAll(".rail-nav .rail-link")[0].click()');
  await sleep(400);
  await evaluate(`(() => {
    const input = document.querySelector('.rail-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'QA Test Show');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);
  await clickCard('QA Test Show');
  await waitFor(() => evaluate('document.querySelectorAll(".episode-grid .episode").length >= 2'), 30_000, 'detail again');
  await evaluate('document.querySelectorAll(".episode-grid .episode")[0].click()');
  await waitFor(() => evaluate('Boolean(document.querySelector(".stage video"))'), 30_000, 'stage again');
  await evaluate('document.querySelector(".stage").requestFullscreen()');
  await sleep(1200);
  await shot('08-fullscreen');
  await evaluate('document.exitFullscreen()');
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
  console.error(`FAIL ${error.message}`);
}

cleanup();
await sleep(500);
console.log(`\nshots in ${SHOTS}`);
const failed = results.filter((item) => item.verdict === 'FAIL').length;
process.exit(failure || failed ? 1 : 0);
