/**
 * Layout and contrast audit across the eight app screens.
 *
 * There is no image-vision model in this environment, so appearance is measured
 * from the live DOM rather than judged by eye: horizontal overflow, clipped
 * text, sibling overlap, undersized targets, off-screen content and text
 * contrast against its real background, at desktop and narrow widths.
 *
 *   node tests/layout.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.ANIMEDESK_TEST_PORT ?? 47892);
const CDP = Number(process.env.ANIMEDESK_CDP_PORT ?? 9338);
const BASE = `http://127.0.0.1:${PORT}`;
const LIBRARY = path.resolve('.tmp/qa/library');
const OUT = path.resolve('.tmp/qa/layout-audit.json');
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
fs.mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync(process.execPath, ['tests/setup-library.mjs', LIBRARY], { stdio: 'inherit' });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-layout-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-layoutprof-'));
const service = spawn(process.execPath, ['server/main.ts'], {
  env: { ...process.env, ANIMEDESK_PORT: String(PORT), ANIMEDESK_DATA_DIR: dataDir },
  stdio: 'ignore',
});

const api = async (route, init) => {
  const response = await fetch(BASE + route, { ...init, headers: { 'content-type': 'application/json' } });
  return response.json().catch(() => ({}));
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

/**
 * The measurement. Runs inside the page and returns counts plus examples, so
 * the caller can assert on numbers rather than on prose.
 */
const AUDIT = `(() => {
  const out = { overflowX: 0, clipped: [], overlaps: [], tiny: [], lowContrast: [], offscreen: [] };
  const de = document.documentElement;
  out.overflowX = Math.max(0, de.scrollWidth - de.clientWidth);

  const rgb = (value) => { const m = value.match(/[\\d.]+/g); return m ? m.slice(0, 3).map(Number) : null; };
  const lum = (channel) => {
    const s = channel.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
  };
  const ratio = (a, b) => {
    const l1 = lum(a); const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const background = (el) => {
    let node = el;
    while (node && node !== de) {
      const bg = getComputedStyle(node).backgroundColor;
      const parts = bg.match(/[\\d.]+/g);
      if (parts && !(parts.length === 4 && Number(parts[3]) === 0)) {
        if (parts.length < 4 || Number(parts[3]) > 0.5) return parts.slice(0, 3).map(Number);
      }
      node = node.parentElement;
    }
    return [8, 8, 10];
  };
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  };
  /** True when an ancestor scrolls horizontally, so being outside the viewport is by design. */
  const inScroller = (el) => {
    for (let node = el.parentElement; node && node !== de; node = node.parentElement) {
      const ox = getComputedStyle(node).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
    }
    return false;
  };

  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const box = el.getBoundingClientRect();
    if ((box.right > de.clientWidth + 1 || box.left < -1) && !inScroller(el)) {
      out.offscreen.push(String(el.className || el.tagName));
    }

    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText) {
      const style = getComputedStyle(el);
      // A line-clamped paragraph is meant to cut off; that is not a defect.
      const clamped = style.webkitLineClamp && style.webkitLineClamp !== 'none';
      // Visually-hidden live regions are clipped by design.
      const hidden = el.classList.contains('sr-only') || el.closest('.sr-only');
      const cutX = el.scrollWidth > el.clientWidth + 1 && style.overflowX !== 'visible' && style.textOverflow !== 'ellipsis';
      const cutY = el.scrollHeight > el.clientHeight + 1 && style.overflowY !== 'visible';
      if ((cutX || cutY) && !clamped && !hidden) {
        out.clipped.push(String(el.className || el.tagName) + ' :: ' + el.textContent.trim().slice(0, 40));
      }
      const size = parseFloat(style.fontSize);
      if (size < 10) out.tiny.push(String(el.className || el.tagName) + ' ' + size + 'px');
      const value = ratio(rgb(style.color) ?? [255, 255, 255], background(el));
      const large = size >= 18 || (size >= 14 && Number(style.fontWeight) >= 700);
      const floor = large ? 3 : 4.5;
      if (value < floor) {
        out.lowContrast.push(String(el.className || el.tagName) + ' ' + value.toFixed(2) + ':1 "' + el.textContent.trim().slice(0, 30) + '"');
      }
    }

    if (el.matches('button, a, input, select, [role="button"]') && (box.width < 24 || box.height < 24)) {
      out.tiny.push('target ' + String(el.className || el.tagName) + ' ' + Math.round(box.width) + 'x' + Math.round(box.height));
    }
  }

  for (const parent of document.querySelectorAll('.episode-grid, .poster-grid, .row-track, .rail-nav')) {
    const kids = [...parent.children].filter(visible).map((k) => k.getBoundingClientRect());
    for (let i = 0; i < kids.length; i += 1) {
      for (let j = i + 1; j < kids.length; j += 1) {
        const a = kids[i];
        const b = kids[j];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 2 && overlapY > 2) {
          out.overlaps.push(String(parent.className) + ' ' + i + '/' + j + ' ' + overlapX.toFixed(0) + 'x' + overlapY.toFixed(0));
        }
      }
    }
  }

  return out;
})()`;

const seen = [];

function assess(name, audit) {
  seen.push({ name, ...audit });
  record(`${name}: no horizontal overflow`, audit.overflowX === 0, `overflow=${audit.overflowX}px`);
  record(`${name}: no clipped text`, audit.clipped.length === 0, audit.clipped.slice(0, 3).join(' | '));
  record(`${name}: no overlapping siblings`, audit.overlaps.length === 0, audit.overlaps.slice(0, 3).join(' | '));
  record(`${name}: nothing outside the viewport`, audit.offscreen.length === 0, audit.offscreen.slice(0, 3).join(' | '));
  record(`${name}: text clears AA contrast`, audit.lowContrast.length === 0, audit.lowContrast.slice(0, 4).join(' | '));
  record(`${name}: no undersized text or targets`, audit.tiny.length === 0, audit.tiny.slice(0, 4).join(' | '));
}

async function attach() {
  const target = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
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
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor(() => evaluate('Boolean(document.querySelector(".rail"))'), 30_000, 'the app shell');
}

function launch(width, height) {
  browser = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    `--window-size=${width},${height}`,
    `${BASE}/`,
  ], { stdio: 'ignore' });
}

async function detach() {
  try { ws?.close(); } catch {}
  try { browser?.kill(); } catch {}
  ws = null;
  browser = null;
  await sleep(800);
}

async function search(term, cardRe) {
  await evaluate(`(() => {
    const input = document.querySelector('.rail-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(term)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);
  await waitFor(
    () => evaluate(`Boolean([...document.querySelectorAll('.poster-card')].find((n) => ${cardRe}.test(n.textContent ?? '')))`),
    30_000,
    `${term} results`,
  );
}

async function openEpisode(re) {
  await evaluate(`[...document.querySelectorAll('.poster-card')].find((n) => ${re}.test(n.textContent ?? '')).click()`);
  await waitFor(() => evaluate('document.querySelectorAll(".episode-grid .episode").length > 0'), 30_000, 'the episode list');
  await evaluate('document.querySelectorAll(".episode-grid .episode")[0].click()');
}

async function desktopPass() {
  launch(1440, 960);
  await attach();
  await waitFor(() => evaluate('document.querySelectorAll(".poster-card").length > 0'), 30_000, 'the home feed');
  assess('homepage', await evaluate(AUDIT));

  await search('QA', '/QA Test Show/');
  assess('search results', await evaluate(AUDIT));

  await openEpisode('/QA Test Show/');
  await waitFor(() => evaluate('document.querySelectorAll(".episode-grid .episode").length > 0'), 30_000, 'detail');
  assess('detail', await evaluate(AUDIT));

  await evaluate('document.querySelectorAll(".episode-grid .episode")[0].click()');
  await waitFor(() => evaluate('(() => { const v = document.querySelector(".stage video"); return Boolean(v) && v.readyState >= 2; })()'), 30_000, 'playback');
  await sleep(1200);
  assess('playback', await evaluate(AUDIT));
  const spaceHijacked = await evaluate(`(() => {
    const button = document.querySelector('.stage .icon-btn.play');
    button.focus();
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  record('Space on a focused player button stays available', !spaceHijacked);

  await evaluate('[...document.querySelectorAll(".rail-link")].find((n) => /Settings/.test(n.textContent ?? ""))?.click()');
  await waitFor(() => evaluate('Boolean(document.querySelector("form"))'), 20_000, 'settings');
  await sleep(600);
  assess('settings', await evaluate(AUDIT));

  await evaluate('document.querySelectorAll(".rail-nav .rail-link")[0].click()');
  await waitFor(() => evaluate('document.querySelectorAll(".poster-card").length > 0'), 20_000, 'home');
  await search('Broken', '/Broken Show/');
  await openEpisode('/Broken Show/');
  await waitFor(() => evaluate('Boolean(document.querySelector(".stage-error, .stage"))'), 30_000, 'the error panel');
  await sleep(1500);
  assess('error state', await evaluate(AUDIT));
  await detach();
}

async function narrowPass() {
  launch(560, 900);
  await attach();
  await waitFor(() => evaluate('document.querySelectorAll(".poster-card").length > 0'), 30_000, 'the narrow feed');
  assess('narrow viewport', await evaluate(AUDIT));
  await evaluate('document.querySelector(".mobile-search-trigger").click()');
  await waitFor(() => evaluate('Boolean(document.querySelector(".mobile-search input"))'), 20_000, 'compact search');
  const usable = await evaluate(`(() => {
    const input = document.querySelector('.mobile-search input');
    const visible = input && input.getBoundingClientRect().width > 100;
    if (!visible) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'QA');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);
  await waitFor(() => evaluate('Boolean([...document.querySelectorAll(".poster-card")].find((n) => /QA Test Show/.test(n.textContent ?? "")))'), 30_000, 'compact search result');
  record('narrow search accepts a title', usable);
  assess('narrow search results', await evaluate(AUDIT));
  await detach();
}

async function fullscreenPass() {
  launch(1440, 960);
  await attach();
  await waitFor(() => evaluate('document.querySelectorAll(".poster-card").length > 0'), 30_000, 'the home feed');
  await search('QA', '/QA Test Show/');
  await openEpisode('/QA Test Show/');
  await waitFor(() => evaluate('(() => { const v = document.querySelector(".stage video"); return Boolean(v) && v.readyState >= 2; })()'), 30_000, 'playback');
  await evaluate('document.querySelector(".stage")?.requestFullscreen?.()');
  await sleep(1500);
  assess('fullscreen', await evaluate(AUDIT));
  await detach();
}

let failure = null;
try {
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/status`)).ok; } catch { return false; }
  }, 40_000, 'the service');
  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ localLibraryDir: LIBRARY, autoNext: false, aniskipEnabled: false, embeddedPlayer: true, volume: 0 }),
  });
  await desktopPass();
  await narrowPass();
  await fullscreenPass();
} catch (error) {
  failure = error;
  record('run completed without throwing', false, error.message);
} finally {
  fs.writeFileSync(OUT, JSON.stringify(seen, null, 1));
  try { ws?.close(); } catch {}
  try { browser?.kill(); } catch {}
  try { service.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((item) => item.verdict === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failure) console.error(failure.stack);
await sleep(400);
process.exit(failed || failure ? 1 : 0);
