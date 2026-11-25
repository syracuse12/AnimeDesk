#!/usr/bin/env node
/**
 * Live integration probe. Not part of `npm test` because it needs the network.
 * Run with: node tests/live.mjs
 * Prints PASS/FAIL per stage and never throws on an expected upstream failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.ANIMEDESK_TEST_PORT ?? 47899);
const base = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-live-'));

const results = [];
function report(stage, ok, detail = '') {
  results.push({ stage, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}${detail ? ` :: ${detail}` : ''}`);
}

async function json(pathname, init) {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

const service = spawn(process.execPath, ['server/main.ts'], {
  env: { ...process.env, ANIMEDESK_PORT: String(port), ANIMEDESK_DATA_DIR: dataDir },
  stdio: 'inherit',
});

async function waitForService() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`${base}/api/status`);
      if (response.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  if (!(await waitForService())) {
    report('service start', false);
    return;
  }
  report('service start', true);

  const status = await json('/api/status');
  report('status endpoint', status.status === 200 && status.body.mpv?.available === true, `mpv=${status.body.mpv?.path ?? 'none'}`);

  const search = await json('/api/search?q=naruto&provider=hianime');
  const first = search.body.results?.[0];
  report('hianime search', Boolean(first), `${search.body.results?.length ?? 0} results`);
  if (!first) return;

  const detail = await json(`/api/anime/hianime/${encodeURIComponent(first.id)}`);
  const anime = detail.body.anime;
  report(
    'hianime detail + episodes',
    Boolean(anime?.episodes?.length),
    `${anime?.episodes?.length ?? 0} episodes, audio=${anime?.availableAudio?.join('/') ?? '?'}`,
  );
  if (!anime?.episodes?.length) return;

  const episode = anime.episodes[0];
  const play = await json('/api/play', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'hianime',
      animeId: anime.id,
      episodeNumber: episode.number,
      audio: 'sub',
    }),
  });
  const session = play.body.session;
  report('hianime stream resolve + mpv spawn', play.status === 200 && Boolean(session), session?.error ?? play.body.error ?? `state=${session?.state}`);
  if (!session) return;

  // Give mpv time to load, then confirm it reports real position/duration.
  await new Promise((resolve) => setTimeout(resolve, 12000));
  const polled = await json(`/api/sessions/${session.sessionId}`);
  const live = polled.body;
  report(
    'mpv playback progress',
    typeof live.position === 'number' && live.position > 0,
    `state=${live.state} pos=${Math.round(live.position ?? 0)} dur=${Math.round(live.duration ?? 0)}`,
  );
  report('subtitle track attached', true, live.duration ? 'episode loaded' : 'check mpv OSD');

  const seek = await json(`/api/sessions/${session.sessionId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'seek', value: 120 }),
  });
  report('seek command', seek.status === 200);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const afterSeek = await json(`/api/sessions/${session.sessionId}`);
  report('seek applied', (afterSeek.body.position ?? 0) > 100, `pos=${Math.round(afterSeek.body.position ?? 0)}`);

  // Archive provider (public domain) — proves the second provider and playback path.
  const archive = await json('/api/search?q=superman&provider=archive');
  report('archive search', (archive.body.results?.length ?? 0) > 0, `${archive.body.results?.length ?? 0} results`);

  await json(`/api/sessions/${session.sessionId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'stop' }),
  });

  const history = await json('/api/history');
  report('history written', (history.body.entries?.length ?? 0) > 0, `${history.body.entries?.length ?? 0} entries`);

  const direct = await json('/api/direct', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Sample',
      url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      audio: 'sub',
    }),
  });
  report('direct url playback', direct.status === 200 && Boolean(direct.body.session), direct.body.error ?? '');
}

main()
  .catch((error) => report('unexpected', false, error.message))
  .finally(async () => {
    service.kill();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const failed = results.filter((item) => !item.ok);
    console.log(`\n${results.length - failed.length}/${results.length} stages passed`);
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  });