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
    assert.deepEqual(status.body.providers.map((provider: { id: string }) => provider.id), ['local']);
    assert.equal(status.body.mpv.available, false);
    assert.equal((await json('/api/anime/hianime/abc')).status, 403);
    assert.equal((await json('/api/direct', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/video.mp4' }) })).status, 403);
    assert.equal((await fetch(base + '/api/status', { headers: { Origin: 'https://example.com' } })).status, 403);
    await json('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localLibraryDir: path.resolve(scratch, 'library') }) });
    const search = await json('/api/search?q=Sample');
    assert.equal(search.body.results.length, 1);
    const entry = search.body.results[0];
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
    let historyCount = 0;
    for (let attempt = 0; attempt < 20 && !historyCount; attempt += 1) {
      historyCount = (await json('/api/history')).body.entries.length;
      if (!historyCount) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(historyCount, 1);
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
