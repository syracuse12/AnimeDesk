/**
 * Real browser check of subtitle Off/On against the real provider.
 *
 * The reported failure was a dub with subtitles set to Off still showing Arabic
 * text. That is only true or false in a real media element, so this drives
 * headless Edge over CDP, reads `video.textTracks` modes, and clicks the menu
 * the way a viewer would.
 *
 *   node tests/subs-ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.ANIMEDESK_TEST_PORT ?? 47899);
const CDP_PORT = Number(process.env.ANIMEDESK_CDP_PORT ?? 9334);
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = process.env.ANIMEDESK_BROWSER ?? [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((candidate) => fs.existsSync(candidate));

if (!EDGE) { console.error('No Edge or Chrome found.'); process.exit(1); }

const stages = [];
const record = (name, ok, detail = '') => {
  stages.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(300);
  }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-subs-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-subs-profile-'));
const service = spawn(process.execPath, ['server/main.ts'], {
  env: { ...process.env, ANIMEDESK_PORT: String(PORT), ANIMEDESK_DATA_DIR: dataDir }, stdio: 'ignore',
});

const api = async (route, init) => {
  const response = await fetch(BASE + route, { ...init, headers: { 'content-type': 'application/json' } });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

let browser, ws, nextId = 1;
const pending = new Map();
const errors = [];
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
const click = (selector) => evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true; })()`);
const clickText = (scope, text) => evaluate(`(() => {
  const node = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
  if (!node) return false; node.click(); return true;
})()`);

/** Modes of every text track, plus what hls.js itself thinks. */
const subtitleState = () => evaluate(`(() => {
  const video = document.querySelector('.stage video');
  if (!video) return null;
  return {
    tracks: [...video.textTracks].map((t) => ({ mode: t.mode, label: t.label, lang: t.language })),
    menu: [...document.querySelectorAll('.menu button')].map((b) => b.textContent.trim()),
    active: [...document.querySelectorAll('.menu button.active')].map((b) => b.textContent.trim()),
  };
})()`);
const showingCount = (state) => (state?.tracks ?? []).filter((t) => t.mode === 'showing').length;

function cleanup() {
  try { ws?.close(); } catch {}
  try { browser?.kill(); } catch {}
  try { service.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

async function startEpisode(searchTerm, audio) {
  await evaluate(`(() => {
    const input = document.querySelector('.rail-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(searchTerm)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);
  const card = await waitFor(
    () => evaluate(`(() => {
      const node = document.querySelector('.poster-card:not(.skeleton)');
      if (!node) return null;
      const title = node.querySelector('strong')?.textContent?.trim() ?? '';
      node.click();
      return title;
    })()`),
    60_000, 'a search result',
  );
  console.log('  opened:', card);
  await waitFor(() => evaluate('Boolean(document.querySelector(".detail"))'), 45_000, 'the detail page');

  if (audio === 'dub') {
    const switched = await waitFor(
      () => evaluate(`(() => {
        const btn = [...document.querySelectorAll('.detail button')].find((b) => /dub/i.test(b.textContent));
        if (!btn) return false;
        btn.click();
        return true;
      })()`),
      20_000, 'a dub option',
    ).catch(() => false);
    record('dub audio can be chosen', switched);
    await sleep(1200);
  }

  await evaluate(`document.querySelector('.detail-actions .btn.primary').click(); true`);
  await waitFor(() => evaluate('Boolean(document.querySelector(".stage video"))'), 45_000, 'the player');
  await waitFor(
    () => evaluate('(() => { const v = document.querySelector(".stage video"); return Boolean(v && v.readyState >= 2); })()'),
    60_000, 'video metadata',
  );
  await sleep(2500);
}

async function openMenu() {
  await evaluate(`(() => { const b = document.querySelector('button[title="Subtitles"]'); if (b) b.click(); return true; })()`);
  await sleep(300);
}

async function main() {
  await waitFor(async () => { try { return (await fetch(`${BASE}/api/status`)).ok; } catch { return false; } }, 40_000, 'the service');
  await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ embeddedPlayer: true, autoNext: false, preferredAudio: 'dub' }) });

  browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--mute-audio', '--window-size=1440,960', `${BASE}/`,
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
      errors.push(message.params.exceptionDetails.exception?.description ?? 'exception');
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor(() => evaluate('Boolean(document.querySelector(".rail"))'), 30_000, 'the app shell');

  /* ---- the reported case: English dub, subtitles off ---- */
  console.log('-- dub episode --');
  await startEpisode('irregular at magic high school', 'dub');

  const initial = await evaluate(`(() => {
    const video = document.querySelector('.stage video');
    return { tracks: [...video.textTracks].map((t) => ({ mode: t.mode, label: t.label, lang: t.language })) };
  })()`);
  record(
    'a dub starts with no subtitle track showing',
    showingCount(initial) === 0,
    JSON.stringify(initial.tracks),
  );

  await openMenu();
  let state = await subtitleState();
  record('the menu offers Off and the side track', state.menu.includes('Off') && state.menu.length >= 2, JSON.stringify(state.menu));
  record('Off is the active entry on a dub', state.active.includes('Off'), JSON.stringify(state.active));
  record('the side track is labelled from its language tag', state.menu.includes('English'), JSON.stringify(state.menu));

  // Turn the side track on.
  const sideLabel = state.menu.find((m) => m !== 'Off');
  await clickText('.menu-wrap .menu', sideLabel);
  await sleep(1200);
  state = await subtitleState();
  record('choosing a language shows exactly one track', showingCount(state) === 1, JSON.stringify(state.tracks));
  record('the shown track is the side-loaded one', state.tracks.filter((t) => t.mode === 'showing').every((t) => t.label !== ''), JSON.stringify(state.tracks));

  // And off again.
  await openMenu();
  await clickText('.menu-wrap .menu', 'Off');
  await sleep(1200);
  state = await subtitleState();
  record('Off disables the side track again', showingCount(state) === 0, JSON.stringify(state.tracks));

  // Survives a seek, which is when a stale track usually reappears.
  await evaluate(`(() => { const v = document.querySelector('.stage video'); v.currentTime = Math.min(v.duration || 60, 45); return true; })()`);
  await sleep(3000);
  state = await subtitleState();
  record('Off survives a seek', showingCount(state) === 0, JSON.stringify(state.tracks));

  /* ---- subtitled audio keeps its track ---- */
  console.log('-- sub episode --');
  await evaluate(`(() => { const b = [...document.querySelectorAll('.stage-top ~ * button, button')].find((n) => /back to the series/i.test(n.title ?? '')); if (b) b.click(); return true; })()`);
  await sleep(1500);
  await evaluate(`(() => { const b = [...document.querySelectorAll('.detail button')].find((n) => /sub/i.test(n.textContent)); if (b) b.click(); return true; })()`);
  await sleep(1200);
  await evaluate(`document.querySelector('.detail-actions .btn.primary').click(); true`);
  await waitFor(() => evaluate('(() => { const v = document.querySelector(".stage video"); return Boolean(v && v.readyState >= 2); })()'), 60_000, 'the sub video');
  await sleep(2500);
  const subState = await evaluate(`(() => { const v = document.querySelector('.stage video'); return { tracks: [...v.textTracks].map((t) => ({ mode: t.mode, label: t.label })) }; })()`);
  record('subtitled audio shows its track without being asked', showingCount(subState) === 1, JSON.stringify(subState.tracks));

  record('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
}

main()
  .catch((error) => record('run completed', false, error.message))
  .finally(async () => {
    cleanup();
    const failed = stages.filter((s) => !s.ok);
    console.log(`\n${stages.length - failed.length}/${stages.length} passed`);
    await sleep(500);
    process.exit(failed.length ? 1 : 0);
  });