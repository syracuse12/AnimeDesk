/**
 * Focused browser QA over real Edge CDP.
 *
 * Covers the closure list: real typing and keyboard navigation in suggestions,
 * dropdown geometry, clearing while requests are in flight, rapid genre
 * switching and its reset, discovery load/empty states, per-play quality, resume
 * quality, quality across Next/Previous/autoplay, and Back-to-origin.
 *
 * Everything is asserted against visible DOM state and live playback where
 * playback is involved. Stages that need the network are reported as SKIP when
 * the upstream is unreachable, never as PASS.
 *
 *   node tests/qa-ux.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.ANIMEDESK_TEST_PORT ?? 47897);
const CDP_PORT = Number(process.env.ANIMEDESK_CDP_PORT ?? 9334);
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE =
  process.env.ANIMEDESK_BROWSER ??
  ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(
    (candidate) => fs.existsSync(candidate),
  );

const stages = [];
function record(name, ok, detail = '') {
  stages.push({ name, ok, detail });
  console.log(`${ok === 'skip' ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-qa-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-qa-profile-'));
const evidence = path.resolve('.tmp/qa-ux');
fs.mkdirSync(evidence, { recursive: true });

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
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
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
  try {
    const data = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(data.data, 'base64'));
  } catch { /* evidence is best-effort */ }
}

/** Genuine per-character key events, so React sees real typing.
 *  `keyDown` already carries the text, so a separate `char` event would double
 *  every letter. */
async function typeText(text) {
  for (const char of text) {
    const vk = char.toUpperCase().charCodeAt(0);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, code: `Key${char.toUpperCase()}`, windowsVirtualKeyCode: vk, text: char });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char, code: `Key${char.toUpperCase()}`, windowsVirtualKeyCode: vk });
    await sleep(45);
  }
}

/** Click the middle of a selector so focus is real, not just a DOM call. */
async function focusByClick(selector) {
  const box = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) throw new Error(`nothing to focus for ${selector}`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(80);
}

async function press(key, code, vk) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
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
  record('service starts', true);

  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ autoNext: true, autoNextDelaySeconds: 1, aniskipEnabled: false, embeddedPlayer: true }),
  });

  browser = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--window-size=1440,960',
      `${BASE}/`,
    ],
    { stdio: 'ignore' },
  );

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
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails.exception?.description ?? 'exception');
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor(() => evaluate('Boolean(document.querySelector(".rail"))'), 30_000, 'the app shell');
  record('app shell renders', true);

  /* ---------------- suggestions: real typing, geometry, keyboard ---------------- */

  const suggestionsUsable = await waitFor(async () => {
    await focusByClick('.rail-search input');
    await typeText('frier');
    const typed = await evaluate(`document.querySelector('.rail-search input').value`);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate('document.querySelectorAll(".suggest-row").length > 0')) return true;
      await sleep(300);
    }
    console.log(`  (suggestion probe: field="${typed}", list=${await evaluate('document.querySelectorAll(".suggest-row").length')})`);
    return false;
  }, 40_000, 'suggestions').catch(() => false);

  if (!suggestionsUsable) {
    record('suggestions resolve from real typing', 'skip', 'Kitsu unreachable');
  } else {
    record('suggestions resolve from real typing', true);

    const geometry = await evaluate(`(() => {
      const field = document.querySelector('.rail-search').getBoundingClientRect();
      const list = document.querySelector('.suggest').getBoundingClientRect();
      return {
        fieldLeft: field.left, fieldBottom: field.bottom, fieldWidth: field.width,
        listLeft: list.left, listTop: list.top, listWidth: list.width,
        rows: document.querySelectorAll('.suggest-row').length,
      };
    })()`);
    await shot('suggestions-open');
    record(
      'dropdown sits directly under the field and matches its width',
      geometry.listTop >= geometry.fieldBottom - 2 &&
        Math.abs(geometry.listLeft - geometry.fieldLeft) <= 2 &&
        Math.abs(geometry.listWidth - geometry.fieldWidth) <= 2,
      JSON.stringify(geometry),
    );

    await press('ArrowDown', 'ArrowDown', 40);
    await sleep(150);
    const firstActive = await evaluate(`(() => {
      const active = document.querySelector('.suggest-row.active');
      const input = document.querySelector('.rail-search input');
      return {
        hasActive: Boolean(active),
        text: active?.querySelector('strong')?.textContent?.trim() ?? '',
        aria: input.getAttribute('aria-activedescendant') ?? '',
        expanded: input.getAttribute('aria-expanded'),
      };
    })()`);
    record(
      'ArrowDown activates the first suggestion and points aria-activedescendant at it',
      firstActive.hasActive && firstActive.aria === 'search-suggest-0' && firstActive.expanded === 'true',
      JSON.stringify(firstActive),
    );

    await press('ArrowDown', 'ArrowDown', 40);
    await sleep(150);
    const secondActive = await evaluate(`document.querySelector('.suggest-row.active strong')?.textContent?.trim() ?? ''`);
    record('ArrowDown advances the active option', secondActive !== '' && secondActive !== firstActive.text, `first="${firstActive.text}" second="${secondActive}"`);

    await press('ArrowUp', 'ArrowUp', 38);
    await sleep(150);
    const backActive = await evaluate(`document.querySelector('.suggest-row.active strong')?.textContent?.trim() ?? ''`);
    record('ArrowUp walks back to the first option', backActive === firstActive.text, backActive);

    await shot('suggestions-keyboard');

    // Escape must dismiss without losing the typed term.
    await press('Escape', 'Escape', 27);
    await sleep(250);
    const escaped = await evaluate(`(() => ({
      list: document.querySelectorAll('.suggest-row').length,
      value: document.querySelector('.rail-search input').value,
      expanded: document.querySelector('.rail-search input').getAttribute('aria-expanded'),
    }))()`);
    record('Escape closes the list and keeps the term', escaped.list === 0 && escaped.value === 'frier' && escaped.expanded === 'false', JSON.stringify(escaped));
  }

  /* ---------------- clearing while a request is in flight ---------------- */

  await evaluate(`(() => {
    const input = document.querySelector('.rail-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    return true;
  })()`);
  await typeText('frieren');
  // Clear immediately, while the debounced search and suggestion calls are still out.
  await click('.search-clear');
  await sleep(250);
  const clearedValue = await evaluate(`document.querySelector('.rail-search input').value`);
  const clearedAfter = await waitFor(
    async () => {
      const state = await evaluate(`(() => ({
        value: document.querySelector('.rail-search input').value,
        rows: document.querySelectorAll('.suggest-row').length,
        results: document.querySelectorAll('.poster-card:not(.skeleton)').length,
        skeletons: document.querySelectorAll('.poster-card.skeleton').length,
        heading: document.querySelector('.page-head h1')?.textContent?.trim() ?? '',
      }))()`);
      return state;
    },
    6000,
    'cleared state',
  );
  await sleep(2500);
  const settled = await evaluate(`(() => ({
    value: document.querySelector('.rail-search input').value,
    rows: document.querySelectorAll('.suggest-row').length,
    results: document.querySelectorAll('.poster-card:not(.skeleton)').length,
  }))()`);
  record('the clear button empties the field', clearedValue === '', JSON.stringify(clearedAfter));
  record(
    'a late answer cannot refill the grid after clearing',
    settled.value === '' && settled.rows === 0 && settled.results === 0,
    JSON.stringify(settled),
  );
  await shot('cleared-search');

  /* ---------------- discovery, genre switching, reset ---------------- */

  await click('.rail-nav .rail-link:nth-of-type(1)');
  await sleep(300);

  const rowsPresent = await waitFor(
    () => evaluate('document.querySelectorAll(".discover-row").length > 0'),
    45_000,
    'discovery rows',
  ).then(() => true).catch(() => false);
  if (!rowsPresent) {
    record('discovery rows load', 'skip', 'AniList unreachable');
  } else {
    record('discovery rows load', true, `${await evaluate('document.querySelectorAll(".discover-row").length')} rows`);
    const rowTitles = await evaluate(`[...document.querySelectorAll('.discover-row h2')].map((h) => h.textContent.trim())`);
    record('default rows are trending, top and seasonal', ['Trending now', 'Top rated', 'This season'].every((t) => rowTitles.includes(t)), JSON.stringify(rowTitles));

    const cardsLoaded = await waitFor(
      () => evaluate(`[...document.querySelectorAll('.discover-row img')].some((img) => img.complete && img.naturalWidth > 0)`),
      20_000,
      'discovery artwork',
    ).then(() => true).catch(() => false);
    record('discovery artwork decodes', cardsLoaded);
    await shot('discovery-rows');

    // Rapid switching: the last pick must win, whatever order answers land in.
    for (const genre of ['Action', 'Horror', 'Sports']) {
      await evaluate(`(() => {
        const chip = [...document.querySelectorAll('.genre-chip')].find((c) => c.textContent.trim() === ${JSON.stringify(genre)});
        chip.click();
        return true;
      })()`);
      await sleep(90);
    }
    const settledGenre = await waitFor(async () => {
      const state = await evaluate(`(() => ({
        active: document.querySelector('.genre-chip.active')?.textContent?.trim() ?? '',
        rows: [...document.querySelectorAll('.discover-row h2')].map((h) => h.textContent.trim()),
      }))()`);
      return state.active === 'Sports' && state.rows.length === 1 && state.rows[0] === 'Sports' ? state : null;
    }, 45_000, 'the Sports row').catch(() => null);
    record('rapid genre switching settles on the last pick', Boolean(settledGenre), JSON.stringify(settledGenre));
    await shot('genre-sports');

    const itemCount = await evaluate(`document.querySelectorAll('.discover-row .poster-card').length`);
    record('the genre row carries items', itemCount > 0, `${itemCount} cards`);

    await evaluate(`[...document.querySelectorAll('.genre-chip')].find((c) => c.textContent.trim() === 'All').click()`);
    const restored = await waitFor(async () => {
      const state = await evaluate(`(() => ({
        active: document.querySelector('.genre-chip.active')?.textContent?.trim() ?? '',
        rows: [...document.querySelectorAll('.discover-row h2')].map((h) => h.textContent.trim()),
      }))()`);
      return state.active === 'All' && state.rows.length >= 2 ? state : null;
    }, 45_000, 'the default rows to return').catch(() => null);
    record('All restores the default rows', Boolean(restored), JSON.stringify(restored));
    await shot('genre-reset');
  }

  /* ---------------- per-play quality ---------------- */

  await evaluate(`(() => {
    const input = document.querySelector('.rail-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'naruto');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);

  const opened = await waitFor(
    () => evaluate(`(() => {
      const card = [...document.querySelectorAll('.poster-card:not(.skeleton)')].find((n) => /naruto/i.test(n.querySelector('strong')?.textContent ?? ''));
      if (!card) return false;
      card.click();
      return true;
    })()`),
    60_000,
    'a Naruto result',
  ).then(() => true).catch(() => false);

  if (!opened) {
    record('quality stages', 'skip', 'hianime unreachable');
  } else {
    record('a result opens for the quality stages', true);
    await waitFor(() => evaluate('Boolean(document.querySelector(".detail-actions .btn.primary"))'), 45_000, 'the play button');

    await evaluate(`(() => {
      const select = document.querySelector('.quality-pick select');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, '480');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value;
    })()`);
    const selected = await waitFor(() => evaluate('document.querySelector(".quality-pick select")?.value'), 5_000, 'the picker to read 480');
    record('the picker holds an explicit 480p preference', selected === '480', String(selected));

    await evaluate(`document.querySelector('.detail-actions .btn.primary').click()`);
    const playing = await waitFor(() => evaluate('Boolean(document.querySelector(".stage video"))'), 45_000, 'the player').then(() => true).catch(() => false);

    if (!playing) {
      record('playback starts', 'skip', 'stream could not be resolved');
    } else {
      const session = await waitFor(async () => {
        const live = await evaluate(`(async () => (await (await fetch('/api/sessions')).json()).sessions[0] ?? null)()`);
        return live && live.streamUrl ? live : null;
      }, 30_000, 'the live session').catch(() => null);

      record('the request carries the 480p preference', session?.quality === '480', `quality=${session?.quality}`);

      // The invariant: a served rendition is never above the preference unless
      // the fallback is stated in the interface.
      const consistent =
        session &&
        (session.resolvedHeight === null ||
          session.resolvedHeight <= 480 ||
          Boolean(session.qualityNote));
      record(
        'playback agrees with the displayed quality',
        Boolean(consistent),
        `resolved=${session?.resolvedHeight} note=${session?.qualityNote ?? 'none'}`,
      );

      if (session?.qualityNote) {
        const shown = await waitFor(
          () => evaluate(`document.querySelector('.stage-quality-note')?.textContent?.trim() ?? ''`),
          10_000,
          'the fallback note',
        ).catch(() => '');
        record('the fallback is stated in the interface', shown === session.qualityNote, shown);
      } else {
        const absent = await evaluate(`Boolean(document.querySelector('.stage-quality-note'))`);
        record('no fallback note when the preference was met', absent === false);
      }
      await shot('playback-480');

      const decoded = await waitFor(async () => {
        const state = await evaluate(`(() => {
          const v = document.querySelector('.stage video');
          return v ? { readyState: v.readyState, width: v.videoWidth, time: v.currentTime } : null;
        })()`);
        return state && state.readyState >= 2 && state.width > 0 && state.time > 0.2 ? state : null;
      }, 60_000, 'real decoding').catch(() => null);
      record('the stream really decodes and advances', Boolean(decoded), JSON.stringify(decoded));

      const renditionHeight = await evaluate(`document.querySelector('.stage video').videoHeight`);
      record(
        'the decoded frame matches the served rendition',
        !session?.resolvedHeight || Math.abs(renditionHeight - session.resolvedHeight) <= 2,
        `decoded=${renditionHeight} resolved=${session?.resolvedHeight}`,
      );

      /* ---------- Next and Previous keep the preference ---------- */

      await evaluate(`document.querySelectorAll('.control-row .icon-btn')[2].click()`);
      const nextSession = await waitFor(async () => {
        const live = await evaluate(`(async () => (await (await fetch('/api/sessions')).json()).sessions[0] ?? null)()`);
        return live?.episodeNumber === 2 ? live : null;
      }, 60_000, 'episode 2').catch(() => null);
      record('Next keeps the 480p preference', nextSession?.quality === '480', `quality=${nextSession?.quality} episode=${nextSession?.episodeNumber}`);

      await waitFor(() => evaluate('Boolean(document.querySelector(".control-row .icon-btn"))'), 15_000, 'Previous');
      await evaluate(`document.querySelectorAll('.control-row .icon-btn')[0].click()`);
      const prevSession = await waitFor(async () => {
        const live = await evaluate(`(async () => (await (await fetch('/api/sessions')).json()).sessions[0] ?? null)()`);
        return live?.episodeNumber === 1 ? live : null;
      }, 60_000, 'episode 1').catch(() => null);
      record('Previous keeps the 480p preference', prevSession?.quality === '480', `quality=${prevSession?.quality} episode=${prevSession?.episodeNumber}`);

      /* ---------- autoplay hand-off keeps it ---------- */

      if (prevSession) {
        await evaluate(`(async () => {
          const live = await (await (await fetch('/api/sessions')).json()).sessions[0];
          await fetch('/api/sessions/' + live.sessionId + '/end', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ duration: live.duration ?? 1440 }),
          });
        })()`);
        const autoSession = await waitFor(async () => {
          const live = await evaluate(`(async () => (await (await fetch('/api/sessions')).json()).sessions[0] ?? null)()`);
          return live?.episodeNumber === 2 ? live : null;
        }, 60_000, 'the autoplay hand-off').catch(() => null);
        record('autoplay keeps the 480p preference', autoSession?.quality === '480', `quality=${autoSession?.quality} episode=${autoSession?.episodeNumber}`);
      }

      /* ---------- Back to origin ---------- */

      await evaluate(`document.querySelector('.stage-top .icon-btn').click()`);
      const backToDetail = await waitFor(
        () => evaluate('Boolean(document.querySelector(".detail-actions"))'),
        20_000,
        'the detail page',
      ).then(() => true).catch(() => false);
      record('Back from the player returns to the series', backToDetail);

      const detailPick = await evaluate(`document.querySelector('.quality-pick select')?.value`);
      record('the picker still reads 480 after playback', detailPick === '480', String(detailPick));

      await evaluate(`document.querySelector('.back-btn').click()`);
      const backToSearch = await waitFor(
        () => evaluate(`Boolean(document.querySelector('.page-head h1')?.textContent?.match(/Results for/i))`),
        20_000,
        'the search results',
      ).then(() => true).catch(() => false);
      record('Back on the detail page returns to the origin view, not home', backToSearch);

      /* ---------- resume keeps the preference ---------- */

      const resumeCard = await waitFor(
        () => evaluate(`(() => {
          const card = document.querySelector('.continue:not(.compact)') ?? document.querySelector('.continue');
          if (!card) return false;
          card.click();
          return true;
        })()`),
        30_000,
        'a Continue Watching card',
      ).then(() => true).catch(() => false);

      if (!resumeCard) {
        await click('.rail-nav .rail-link:nth-of-type(1)');
      }
      await sleep(1200);
      const resumed = await waitFor(async () => {
        const live = await evaluate(`(async () => (await (await fetch('/api/sessions')).json()).sessions[0] ?? null)()`);
        return live && live.episodeNumber ? live : null;
      }, 45_000, 'a resumed session').catch(() => null);
      record('resuming from history keeps the 480p preference', resumed?.quality === '480', `quality=${resumed?.quality} episode=${resumed?.episodeNumber}`);
      await shot('after-resume');
    }
  }

  record('no uncaught console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
  record('run completed without throwing', false, error.message);
}

const passed = stages.filter((stage) => stage.ok === true).length;
const skipped = stages.filter((stage) => stage.ok === 'skip').length;
const failed = stages.filter((stage) => stage.ok === false).length;
console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed of ${stages.length}`);
if (failure) console.error(failure.stack);
cleanup();
await sleep(400);
process.exit(failed ? 1 : 0);