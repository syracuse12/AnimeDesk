/**
 * mpv fallback QA against an authorised local fixture.
 *
 * Proves the real bundled mpv process launches, loads the file, reports a
 * moving position, honours a seek, exits cleanly on stop, and leaves the
 * browser-side session usable afterwards.
 *
 *   node tests/mpv-fallback.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.ANIMEDESK_TEST_PORT ?? 47895);
const BASE = `http://127.0.0.1:${PORT}`;
const LIBRARY = path.resolve('.tmp/qa/library');

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
    await sleep(250);
  }
}

function mpvProcesses() {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      "(Get-Process mpv -ErrorAction SilentlyContinue | Measure-Object).Count",
    ], { encoding: 'utf8' });
    return Number(out.trim()) || 0;
  } catch { return 0; }
}

fs.rmSync(LIBRARY, { recursive: true, force: true });
execFileSync(process.execPath, ['tests/setup-library.mjs', LIBRARY], { stdio: 'inherit' });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-mpv-'));
const service = spawn(process.execPath, ['server/main.ts'], {
  env: { ...process.env, ANIMEDESK_PORT: String(PORT), ANIMEDESK_DATA_DIR: dataDir },
  stdio: 'ignore',
});

const api = async (route, init) => {
  const response = await fetch(BASE + route, { ...init, headers: { 'content-type': 'application/json' } });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

function cleanup() {
  try { service.kill(); } catch {}
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Process mpv -ErrorAction SilentlyContinue | Stop-Process -Force'], { stdio: 'ignore' });
  } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}

async function main() {
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/status`)).ok; } catch { return false; }
  }, 40_000, 'the service');

  const status = (await api('/api/status')).body;
  record('bundled mpv is detected', status.mpv?.available === true, status.mpv?.path ?? 'none');
  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ localLibraryDir: LIBRARY, autoNext: false, aniskipEnabled: false, volume: 0 }),
  });

  const search = (await api(`/api/search?q=${encodeURIComponent('QA Test Show')}`)).body;
  const show = (search.results ?? []).find((item) => /QA Test Show/.test(item.title ?? ''));
  if (!show) throw new Error('the test series was not found in search');

  const before = mpvProcesses();
  const play = await api('/api/play', {
    method: 'POST',
    body: JSON.stringify({ provider: 'local', animeId: show.id, episodeNumber: 1, audio: 'sub', mode: 'external' }),
  });
  const session = play.body.session;
  record('mpv fallback launches a session', play.status === 200 && session?.mode === 'external', session?.sessionId ?? JSON.stringify(play.body));

  await waitFor(() => mpvProcesses() > before, 20_000, 'the mpv process to appear');
  record('a real mpv process is running', mpvProcesses() > before, `mpv count ${before} -> ${mpvProcesses()}`);

  const loaded = await waitFor(async () => {
    const live = (await api(`/api/sessions/${session.sessionId}`)).body;
    return (live.duration ?? 0) > 5 ? live : null;
  }, 30_000, 'mpv to load the fixture');
  record('mpv loads the video and reports its duration', loaded.duration > 5, `duration=${loaded.duration}`);

  const advanced = await waitFor(async () => {
    const live = (await api(`/api/sessions/${session.sessionId}`)).body;
    return (live.position ?? 0) > 0.5 ? live : null;
  }, 30_000, 'mpv playback time to advance');
  record('mpv playback time advances on its own', advanced.position > 0.5, `position=${advanced.position}`);

  const seek = await api(`/api/sessions/${session.sessionId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'seek', value: 4.2 }),
  });
  const seeked = await waitFor(async () => {
    const live = (await api(`/api/sessions/${session.sessionId}`)).body;
    return (live.position ?? 0) > 3.5 ? live : null;
  }, 20_000, 'the seek to apply').catch(() => null);
  record('seeking moves mpv to the new offset', seek.status === 200 && Boolean(seeked), `position=${seeked?.position ?? 'none'}`);

  const stop = await api(`/api/sessions/${session.sessionId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'stop' }),
  });
  record('stop is accepted', stop.status === 200, String(stop.status));
  await sleep(2500);
  record('the mpv process exits cleanly', mpvProcesses() <= before, `mpv count ${mpvProcesses()}`);
  record('no session is left live', ((await api('/api/sessions')).body.sessions ?? []).length === 0);

  /* The browser-side session must still work after an external run. */
  const embedded = await api('/api/play', {
    method: 'POST',
    body: JSON.stringify({ provider: 'local', animeId: show.id, episodeNumber: 1, audio: 'sub', mode: 'embedded' }),
  });
  record('the in-app player still starts after mpv', embedded.status === 200 && embedded.body.session?.mode === 'embedded', embedded.body.session?.sessionId ?? '');
  const streamOk = await fetch(BASE + (embedded.body.session?.streamUrl ?? '/api/status'));
  record('the embedded stream is still served', streamOk.ok, `${streamOk.status}`);
  await api(`/api/sessions/${embedded.body.session.sessionId}/action`, { method: 'POST', body: JSON.stringify({ action: 'stop' }) });
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
await sleep(600);
process.exit(failed ? 1 : 0);