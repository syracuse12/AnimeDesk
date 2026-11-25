import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('distribution service exposes local media, persists history and shuts down cleanly', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'animedesk-release-'));
  const library = path.join(scratch, 'library', 'Sample Show');
  fs.mkdirSync(library, { recursive: true });
  fs.copyFileSync(path.resolve('tests/fixtures/media/sample.mp4'), path.join(library, 'Episode 1.mp4'));
  const service = spawn(process.execPath, ['server/main.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, ANIMEDESK_PROFILE: 'distribution', ANIMEDESK_PORT: '0', ANIMEDESK_DATA_DIR: path.join(scratch, 'data') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let port = 0;
  service.stdout.setEncoding('utf8');
  service.stdout.on('data', (chunk: string) => {
    output += chunk;
    const match = output.match(/service ready on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) port = Number(match[1]);
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!port && Date.now() < deadline && service.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(port > 0, 'service did not start');
    const base = `http://127.0.0.1:${port}`;
    const json = async (route: string, init?: RequestInit) => {
      const response = await fetch(base + route, init);
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const status = await json('/api/status');
    // hianime is the shipped catalogue; archive stays development-only.
    assert.deepEqual(status.body.providers.map((provider: { id: string }) => provider.id), ['hianime', 'local']);
    assert.equal(status.body.mpv.available, false);
    // Both used to be gated off in this profile. They are registered now, so the
    // gate itself is gone: a hianime detail lookup and a direct URL must no
    // longer answer 403 (upstream reachability decides the eventual status).
    assert.notEqual((await json('/api/anime/hianime/abc')).status, 403);
    // A direct URL may still fail for upstream reasons (DNS, unreachable host),
    // so assert the *profile gate* is gone rather than the status.
    const direct = await json('/api/direct', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/video.mp4' }) });
    assert.ok(!String(direct.body.error ?? '').includes('distribution profile'), `direct still blocked by the profile gate: ${direct.body.error}`);
    assert.equal((await fetch(base + '/api/status', { headers: { Origin: 'https://example.com' } })).status, 403);
    await json('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localLibraryDir: path.resolve(scratch, 'library') }) });
    const search = await json('/api/search?q=Sample');
    // hianime is searchable here too, so pick the local hit rather than assuming
    // the whole result set is ours.
    const local = search.body.results.filter((item: { provider: string }) => item.provider === 'local');
    assert.equal(local.length, 1);
    const entry = local[0];
    const detail = await json(`/api/anime/local/${entry.id}`);
    assert.equal(detail.body.anime.episodes.length, 1);
    const play = await json('/api/play', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'local', animeId: entry.id, episodeNumber: 1, audio: 'sub' }) });
    assert.equal(play.status, 200);
    const session = play.body.session;
    assert.ok(session.sessionId);
    const media = await fetch(base + session.streamUrl, { headers: { Range: 'bytes=0-15' } });
    assert.equal(media.status, 206);
    assert.equal((await media.arrayBuffer()).byteLength, 16);
    const progress = await json(`/api/sessions/${session.sessionId}/progress?force=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position: 30, duration: 60 }) });
    assert.equal(progress.status, 200);
    let localHistory = 0;
    for (let attempt = 0; attempt < 20 && !localHistory; attempt += 1) {
      const entries = (await json('/api/history')).body.entries as { provider: string; animeId: string }[];
      // A successful /api/direct also records a `local` row under a direct: id,
      // so match the library episode specifically rather than counting rows.
      localHistory = entries.filter((row) => row.provider === 'local' && !row.animeId.startsWith('direct:')).length;
      if (!localHistory) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(localHistory, 1);
    assert.ok(fs.existsSync(path.join(scratch, 'data', 'distribution', 'history.json')));
    await json('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localLibraryDir: '' }) });
    assert.equal((await fetch(base + session.streamUrl)).status, 403);
    service.stdin.write('shutdown\n');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([once(service, 'exit'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('service did not stop')), 5000); })]);
    } finally { if (timer) clearTimeout(timer); }
    assert.equal(service.exitCode, 0);
  } finally {
    if (service.exitCode === null) service.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
