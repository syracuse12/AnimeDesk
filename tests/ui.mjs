/**
 * Real browser UI regression run for v0.2.1.
 *
 * Drives headless Edge over the Chrome DevTools Protocol against the built app
 * and exercises the four reported failures end to end: cover artwork, Next /
 * Previous, Skip Intro, and autoplay-next. Every stage is a real DOM
 * interaction with the real service and the real provider, not a stub.
 *
 *   node tests/ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.ANIMEDESK_TEST_PORT ?? 47898);
const CDP_PORT = Number(process.env.ANIMEDESK_CDP_PORT ?? 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE =
  process.env.ANIMEDESK_BROWSER ??
  ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(
    (candidate) => fs.existsSync(candidate),
  );

const stages = [];
function record(name, ok, detail = '') {
  stages.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(250);
  }
}

if (!EDGE) {
  console.error('No Edge or Chrome found.');
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-ui-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-profile-'));

const service = spawn(process.execPath, ['server/main.ts'], {
  env: { ...process.env, ANIMEDESK_PORT: String(PORT), ANIMEDESK_DATA_DIR: dataDir },
  stdio: 'ignore',
});

const api = async (route, init) => {
  const response = await fetch(BASE + route, {
    ...init,
    headers: { 'content-type': 'application/json' },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

let browser;
let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
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

function cleanup() {
  try { ws?.close(); } catch {}
  try { browser?.kill(); } catch {}
  try { service.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

async function main() {
  // --- service ---
  await waitFor(async () => {
    try {
      return (await fetch(`${BASE}/api/status`)).ok;
    } catch {
      return false;
    }
  }, 40_000, 'the service');
  record('service starts on the built app', true);

  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ autoNext: true, autoNextDelaySeconds: 1, aniskipEnabled: true, embeddedPlayer: true }),
  });

  // --- browser ---
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

  // --- BUG 3: artwork on search results ---
  await evaluate(`(() => {
    const input = document.querySelector('.rail-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'classroom of the elite');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);

  await waitFor(
    () => evaluate('document.querySelectorAll(".poster-card:not(.skeleton)").length > 0'),
    60_000,
    'search results',
  );

  const cards = await evaluate(`(() => {
    const list = [...document.querySelectorAll('.poster-card:not(.skeleton)')];
    return list.slice(0, 8).map((card) => {
      const img = card.querySelector('img');
      return {
        title: card.querySelector('strong')?.textContent?.trim() ?? '',
        hasImg: Boolean(img),
        src: img?.getAttribute('src') ?? '',
        loaded: Boolean(img && img.naturalWidth > 0),
      };
    });
  })()`);
  // Images decode asynchronously; give them a moment before judging.
  if (cards.some((card) => card.hasImg && !card.loaded)) {
    await sleep(2500);
  }
  const withArt = await evaluate(`(() => {
    const list = [...document.querySelectorAll('.poster-card:not(.skeleton)')].slice(0, 8);
    return list.filter((card) => {
      const img = card.querySelector('img');
      return Boolean(img && img.naturalWidth > 0);
    }).length;
  })()`);
  record(
    'search results show real artwork',
    withArt > 0,
    `${withArt}/${cards.length} posters decoded; first="${cards[0]?.src ?? ''}"`,
  );

  // --- BUG 3: artwork on the detail page ---
  const target2 = await waitFor(
    () =>
      evaluate(`(() => {
        const card = [...document.querySelectorAll('.poster-card:not(.skeleton)')].find((node) =>
          /classroom of the elite/i.test(node.querySelector('strong')?.textContent ?? ''),
        );
        if (!card) return null;
        card.click();
        return card.querySelector('strong')?.textContent?.trim() ?? '';
      })()`),
    30_000,
    'a Classroom of the Elite result',
  );
  record('Classroom of the Elite opens from the catalogue', true, target2);

  await waitFor(() => evaluate('Boolean(document.querySelector(".detail"))'), 45_000, 'the detail page');
  const detailArt = await waitFor(
    async () => {
      const art = await evaluate(`(() => {
        const poster = document.querySelector('.detail-poster');
        if (!poster) return null;
        return { src: poster.getAttribute('src'), loaded: poster.complete && poster.naturalWidth > 0 };
      })()`);
      // Only settle once the poster has actually decoded, not merely appeared.
      return art?.loaded ? art : null;
    },
    30_000,
    'detail artwork to decode',
  );
  record('detail page shows real artwork', Boolean(detailArt?.loaded), detailArt?.src ?? 'missing');

  // --- BUG 1: start an episode, then Next / Previous ---
  await evaluate(`(() => {
    const button = document.querySelector('.detail-actions .btn.primary');
    button.click();
    return true;
  })()`);
  await waitFor(() => evaluate('Boolean(document.querySelector(".stage video"))'), 45_000, 'the player');
  record('episode 1 starts in the in-app player', true);

  const heading = () => evaluate('document.querySelector(".stage-heading span")?.textContent?.trim() ?? ""');
  await waitFor(async () => /Episode 1\b/.test(await heading()), 20_000, 'episode 1 heading');

  await waitFor(() => evaluate('Boolean(document.querySelectorAll(".control-row .icon-btn")[2])'), 10_000, 'the Next button');
  await click('.control-row .icon-btn:nth-of-type(3)');
  const afterNext = await waitFor(
    async () => {
      const text = await heading();
      return /Episode 2\b/.test(text) ? text : null;
    },
    60_000,
    'episode 2 after Next',
  );
  record('Next moves to episode 2', true, afterNext);

  await waitFor(() => evaluate('Boolean(document.querySelector(".control-row .icon-btn"))'), 10_000, 'the Previous button');
  await click('.control-row .icon-btn');
  const afterPrev = await waitFor(
    async () => {
      const text = await heading();
      return /Episode 1\b/.test(text) ? text : null;
    },
    60_000,
    'episode 1 after Previous',
  );
  record('Previous returns to episode 1', true, afterPrev);

  // The player must have actually re-attached the new source and decoded it,
  // not just relabelled the heading. A fresh `src` alone proves nothing.
  const remounted = await evaluate(`(() => {
    const video = document.querySelector('.stage video');
    return Boolean(video && video.currentSrc);
  })()`);
  record('the player re-attached a stream after the hand-off', remounted);

  const healthy = await waitFor(
    async () => {
      const state = await evaluate(`(() => {
        const video = document.querySelector('.stage video');
        if (!video) return null;
        return {
          readyState: video.readyState,
          width: video.videoWidth,
          decoded: video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
          time: video.currentTime,
        };
      })()`);
      // Ready to play, real pixels decoded, and the playhead actually moving.
      return state && state.readyState >= 2 && state.width > 0 && state.time > 0.2 ? state : null;
    },
    60_000,
    'the re-attached stream to decode and advance',
  );
  record('the re-attached stream decodes and advances', true, JSON.stringify(healthy));

  // --- Skip data for the show that was actually broken ---
  // AniSkip files Classroom of the Elite episode 1 with the opening and ending
  // swapped: `op` 1168s and `ed` 4s in a 1450s episode. Each window fits the
  // duration on its own, so only the plausibility guard catches it.
  const coteSkips = await waitFor(
    async () =>
      evaluate(`(async () => {
        const live = await (await fetch('/api/sessions')).json();
        const session = live.sessions[0];
        if (!session || !session.duration || !session.skips) return null;
        if (session.skips.reason !== 'ok') return { reason: session.skips.reason, malId: session.skips.malId };
        return { id: session.sessionId, duration: session.duration, skips: session.skips };
      })()`),
    90_000,
    'skip data for Classroom of the Elite episode 1',
  );
  record(
    'Classroom of the Elite resolves skip data',
    Boolean(coteSkips?.skips?.malId),
    `malId=${coteSkips?.skips?.malId} reason=${coteSkips?.skips?.reason}`,
  );

  const coteIntro = coteSkips?.skips?.intro;
  const coteOutro = coteSkips?.skips?.outro;
  const coteDuration = coteSkips?.duration ?? 0;
  record(
    'the swapped opening and ending land on the right side of the episode',
    Boolean(
      coteIntro &&
        coteOutro &&
        coteDuration > 0 &&
        coteIntro.start < coteDuration / 2 &&
        coteOutro.start > coteDuration / 2 &&
        coteIntro.start < coteOutro.start,
    ),
    `intro=${JSON.stringify(coteIntro)} outro=${JSON.stringify(coteOutro)} duration=${coteDuration}`,
  );

  await evaluate(`(() => {
    const video = document.querySelector('.stage video');
    video.currentTime = ${(coteOutro?.start ?? 0) + 2};
    return true;
  })()`);
  const outroButton = await waitFor(
    () => evaluate(`document.querySelector('.skip-btn')?.textContent?.trim() ?? ''`),
    30_000,
    'the Skip Outro button',
  );
  record('the ending offers Skip outro, not Skip intro', /Skip outro/i.test(outroButton), outroButton);

  // --- BUG 2: Skip Intro with real AniSkip data ---
  // Naruto episode 1 has a clean published 1-102s opening and drives the seek
  // stage; Classroom of the Elite is covered above, where its record is swapped.
  await evaluate(`(() => {
    const back = document.querySelector('.stage-top .icon-btn');
    back?.click();
    return true;
  })()`);
  await sleep(500);

  await evaluate(`(() => {
    const input = document.querySelector('.rail-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'naruto');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);

  const naruto = await waitFor(
    async () =>
      evaluate(`(() => {
        const card = [...document.querySelectorAll('.poster-card')].find((node) =>
          /^Naruto$/i.test(node.querySelector('strong')?.textContent?.trim() ?? ''),
        );
        if (!card) return null;
        card.click();
        return true;
      })()`),
    60_000,
    'the Naruto result',
  );
  record('Naruto opens for the skip stage', Boolean(naruto));

  await waitFor(() => evaluate('Boolean(document.querySelector(".detail-actions .btn.primary"))'), 45_000, 'the Naruto play button');
  await evaluate(`document.querySelector('.detail-actions .btn.primary').click()`);
  await waitFor(() => evaluate('Boolean(document.querySelector(".stage video"))'), 45_000, 'the Naruto player');

  // Wait for the skip data to arrive from the service, then seek inside the intro.
  const skipData = await waitFor(
    async () =>
      evaluate(`(async () => {
        const live = await (await fetch('/api/sessions')).json();
        const session = live.sessions[0];
        if (!session) return null;
        if (!session.duration) return null;
        if (!session.skips) return null;
        return { id: session.sessionId, duration: session.duration, skips: session.skips };
      })()`),
    90_000,
    'skip data for Naruto episode 1',
  );
  record(
    'skip data resolved from AniSkip',
    Boolean(skipData.skips?.intro),
    `malId=${skipData.skips?.malId} source=${skipData.skips?.source} reason=${skipData.skips?.reason} intro=${JSON.stringify(skipData.skips?.intro)}`,
  );

  await evaluate(`(() => {
    const video = document.querySelector('.stage video');
    video.currentTime = ${Math.max(2, (skipData.skips?.intro?.start ?? 1) + 6)};
    return true;
  })()`);

  const skipButton = await waitFor(
    () => evaluate(`document.querySelector('.skip-btn')?.textContent?.trim() ?? ''`),
    30_000,
    'the Skip Intro button',
  );
  record('Skip Intro button appears inside the opening', /Skip intro/i.test(skipButton), skipButton);

  const beforeSkip = await evaluate('document.querySelector(".stage video").currentTime');
  await click('.skip-btn');
  const afterSkip = await waitFor(
    async () => {
      const time = await evaluate('document.querySelector(".stage video").currentTime');
      return time > beforeSkip + 40 ? time : null;
    },
    20_000,
    'the intro seek',
  );
  record('Skip Intro seeks past the opening', true, `${beforeSkip.toFixed(1)}s -> ${afterSkip.toFixed(1)}s`);

  // --- BUG 4: autoplay after the real end ---
  const autoplay = await evaluate(`(async () => {
    const live = await (await fetch('/api/sessions')).json();
    const session = live.sessions[0];
    if (!session) return null;
    await fetch('/api/sessions/' + session.sessionId + '/end', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ duration: session.duration }),
    });
    return session.sessionId;
  })()`);
  record('a real end signal is delivered', Boolean(autoplay));

  const countdown = await waitFor(
    () => evaluate('document.querySelector(".stage-countdown")?.textContent ?? ""'),
    20_000,
    'the autoplay countdown',
  );
  record('the countdown appears', /Up next/i.test(countdown), countdown.replace(/\s+/g, ' ').slice(0, 90));

  const advanced = await waitFor(
    async () => {
      const text = await heading();
      return /Episode 2\b/.test(text) ? text : null;
    },
    60_000,
    'autoplay to episode 2',
  );
  record('autoplay launches the next episode', true, advanced);

  // --- player still healthy ---
  const health = await waitFor(
    async () => {
      const state = await evaluate(`(() => {
        const video = document.querySelector('.stage video');
        if (!video) return null;
        return {
          readyState: video.readyState,
          width: video.videoWidth,
          src: Boolean(video.currentSrc),
          episode: document.querySelector('.stage-heading span')?.textContent?.trim() ?? '',
        };
      })()`);
      return state && state.src && state.readyState >= 2 && state.width > 0 ? state : null;
    },
    60_000,
    'the autoplayed episode to decode',
  );
  record('the player is still usable after the hand-off', true, JSON.stringify(health));

  record('no uncaught console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
  record('run completed without throwing', false, (error).message);
}

const passed = stages.filter((stage) => stage.ok).length;
console.log(`\n${passed}/${stages.length} stages passed`);
if (failure) console.error(failure.stack);
cleanup();
await sleep(500);
process.exit(passed === stages.length ? 0 : 1);