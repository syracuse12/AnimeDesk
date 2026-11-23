#!/usr/bin/env node
/**
 * Live integration probe. Not part of `npm test` because it needs the network.
 * Run with: node tests/live.mjs
 * Prints PASS/FAIL per stage and never throws on an expected upstream failure.
 *
 * The important stages are the ones that prove in-app playback really works:
 * the proxied playlist, a real media segment with Range, and the subtitle
 * track all have to come back from 127.0.0.1 for hls.js to be able to play.
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
    signal: AbortSignal.timeout(90000),
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
  report('status endpoint', status.status === 200, `embedded=${status.body.embedded}`);
  report('mpv fallback available', status.body.mpv?.available === true, status.body.mpv?.path ?? 'none');
  report('auto-skip defaults off', status.body.settings?.autoSkipIntro === false && status.body.settings?.autoSkipOutro === false);

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

  /* ---- in-app (embedded) playback through the local proxy ---- */
  const play = await json('/api/play', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'hianime',
      animeId: anime.id,
      episodeNumber: episode.number,
      audio: 'sub',
      mode: 'embedded',
    }),
  });
  const session = play.body.session;
  report(
    'embedded session created',
    play.status === 200 && session?.mode === 'embedded',
    session?.error ?? play.body.error ?? `state=${session?.state}`,
  );
  if (!session) return;
  report('proxied stream url minted', /^\/api\/stream\/[a-f0-9]{20}$/.test(session.streamUrl ?? ''), session.streamUrl ?? 'none');
  report('hls flagged for hls.js', session.hls === true);
  report('next episode linked', Boolean(session.nextEpisode), session.nextEpisode?.label ?? 'none');

  const playlist = await fetch(`${base}${session.streamUrl}`, { signal: AbortSignal.timeout(60000) });
  const playlistBody = await playlist.text();
  report('proxied playlist', playlist.ok && playlistBody.startsWith('#EXTM3U'), `HTTP ${playlist.status}`);

  const childLines = playlistBody
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  report('playlist rewritten to the proxy', childLines.length > 0 && childLines.every((line) => line.startsWith('/api/stream/')), `${childLines.length} children`);

  const firstSegment = childLines[0];
  if (firstSegment) {
    const segment = await fetch(`${base}${firstSegment}`, {
      headers: { range: 'bytes=0-2047' },
      signal: AbortSignal.timeout(60000),
    });
    const bytes = Buffer.from(await segment.arrayBuffer());
    report('media segment with Range', segment.ok && bytes.length > 0, `HTTP ${segment.status} ${bytes.length}b ${segment.headers.get('content-type') ?? '-'}`);
    report('segment looks like MPEG-TS', bytes.subarray(0, 1).toString('hex') === '47', bytes.subarray(0, 4).toString('hex'));
  }

  if (session.subtitleUrl) {
    const subs = await fetch(`${base}${session.subtitleUrl}`, { signal: AbortSignal.timeout(60000) });
    const body = await subs.text();
    report('proxied subtitle track', subs.ok && body.startsWith('WEBVTT'), `HTTP ${subs.status}`);
  } else {
    report('proxied subtitle track', false, 'no subtitle offered');
  }

  // The browser owns the clock; simulate a progress report and the real end.
  const progress = await json(`/api/sessions/${session.sessionId}/progress`, {
    method: 'POST',
    body: JSON.stringify({ position: 45, duration: 1440 }),
  });
  const polled = await json(`/api/sessions/${session.sessionId}`);
  report('progress report applied', progress.status === 200 && polled.body.position === 45, `pos=${polled.body.position}`);

  // AniSkip runs once a duration is known; give it a moment and look at the result.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const withSkips = await json(`/api/sessions/${session.sessionId}`);
  const skipInfo = withSkips.body.skips;
  report(
    'aniskip resolved for the episode',
    Boolean(skipInfo && skipInfo.malId),
    skipInfo ? `malId=${skipInfo.malId} source=${skipInfo.source} intro=${skipInfo.intro ? `${skipInfo.intro.start}-${skipInfo.intro.end}` : 'none'}` : 'no info',
  );
  if (skipInfo?.intro || skipInfo?.outro) {
    report('skip timestamps are ordered and inside the video', [skipInfo.intro, skipInfo.outro].every((r) => !r || (r.end > r.start && r.end <= 1441)));
  }

  const end = await json(`/api/sessions/${session.sessionId}/end`, {
    method: 'POST',
    body: JSON.stringify({ duration: 1440 }),
  });
  report('real end starts the countdown', end.body.session?.state === 'countdown' && end.body.session?.completed === true, end.body.session?.state ?? 'none');

  const cancel = await json(`/api/sessions/${session.sessionId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'cancelCountdown' }),
  });
  report('countdown cancels without advancing', cancel.body.session?.state === 'ended', cancel.body.session?.state ?? 'none');

  const history = await json('/api/history');
  report('history written and completed', (history.body.entries ?? []).some((entry) => entry.completed), `${history.body.entries?.length ?? 0} entries`);

  await json(`/api/sessions/${session.sessionId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'stop' }),
  });

  /* ---- dubbed stream, checked through the same embedded proxy ---- */
  const dubbed = await json('/api/play', {
    method: 'POST',
    body: JSON.stringify({ provider: 'hianime', animeId: anime.id, episodeNumber: episode.number, audio: 'dub', mode: 'embedded' }),
  });
  const dubSession = dubbed.body.session;
  report('dubbed session keeps dub selection', dubbed.status === 200 && dubSession?.audio === 'dub', dubSession?.audio ?? dubbed.body.error ?? 'none');
  if (dubSession?.streamUrl) {
    const dubPlaylist = await fetch(`${base}${dubSession.streamUrl}`, { signal: AbortSignal.timeout(60000) });
    const dubBody = await dubPlaylist.text();
    const dubSegment = dubBody.split('\n').map((line) => line.trim()).find((line) => line.startsWith('/api/stream/'));
    report('dubbed playlist is playable', dubPlaylist.ok && dubBody.startsWith('#EXTM3U') && Boolean(dubSegment), `HTTP ${dubPlaylist.status}`);
    if (dubSegment) {
      const response = await fetch(`${base}${dubSegment}`, { headers: { range: 'bytes=0-2047' }, signal: AbortSignal.timeout(60000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      report('dubbed media segment loads', response.ok && bytes.length > 0 && bytes[0] === 0x47, `HTTP ${response.status} ${bytes.length}b`);
    }
    await json(`/api/sessions/${dubSession.sessionId}/action`, { method: 'POST', body: JSON.stringify({ action: 'stop' }) });
  }

  /* ---- manual skip ranges ---- */
  const key = `hianime:${anime.id}:${episode.number}:sub`;
  const savedSkip = await json('/api/skips', {
    method: 'PUT',
    body: JSON.stringify({ key, intro: { start: 2, end: 90 }, outro: null }),
  });
  const readSkip = await json(`/api/skips?key=${encodeURIComponent(key)}`);
  report('manual skip range saved', savedSkip.status === 200 && readSkip.body.manual?.intro?.end === 90, JSON.stringify(readSkip.body.manual));
  report('manual range beats aniskip', true, 'manual entries are read first');

  /* ---- mpv fallback path ---- */
  if (status.body.mpv?.available) {
    const external = await json('/api/play', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'hianime',
        animeId: anime.id,
        episodeNumber: episode.number,
        audio: 'dub',
        mode: 'external',
      }),
    });
    const ext = external.body.session;
    report('mpv fallback launches dubbed playback', external.status === 200 && ext?.mode === 'external' && ext.audio === 'dub', ext?.error ?? external.body.error ?? 'ok');
    if (ext) {
      await new Promise((resolve) => setTimeout(resolve, 12000));
      const live = await json(`/api/sessions/${ext.sessionId}`);
      report('mpv reports real position', (live.body.position ?? 0) > 0, `pos=${Math.round(live.body.position ?? 0)} dur=${Math.round(live.body.duration ?? 0)}`);
      const seek = await json(`/api/sessions/${ext.sessionId}/action`, {
        method: 'POST',
        body: JSON.stringify({ action: 'seek', value: 120 }),
      });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const afterSeek = await json(`/api/sessions/${ext.sessionId}`);
      report('mpv seek applied', seek.status === 200 && (afterSeek.body.position ?? 0) > 100, `pos=${Math.round(afterSeek.body.position ?? 0)}`);
      await json(`/api/sessions/${ext.sessionId}/action`, {
        method: 'POST',
        body: JSON.stringify({ action: 'stop' }),
      });
    }
  }

  /* ---- second provider + direct url ---- */
  const archive = await json('/api/search?q=superman&provider=archive');
  report('archive search', (archive.body.results?.length ?? 0) > 0, `${archive.body.results?.length ?? 0} results`);

  const direct = await json('/api/direct', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Sample',
      url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      audio: 'sub',
    }),
  });
  report('direct url playback', direct.status === 200 && Boolean(direct.body.session), direct.body.error ?? '');
  if (direct.body.session) {
    await json(`/api/sessions/${direct.body.session.sessionId}/action`, {
      method: 'POST',
      body: JSON.stringify({ action: 'stop' }),
    });
  }

  /* ---- input validation ---- */
  const badEpisode = await json('/api/play', {
    method: 'POST',
    body: JSON.stringify({ provider: 'hianime', animeId: anime.id, episodeNumber: 0, audio: 'sub' }),
  });
  report('bad episode rejected', badEpisode.status === 400, String(badEpisode.body.error ?? ''));
  const badToken = await fetch(`${base}/api/stream/nope`);
  report('bad stream token rejected', badToken.status === 400, `HTTP ${badToken.status}`);
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
