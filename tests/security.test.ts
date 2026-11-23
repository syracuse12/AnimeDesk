import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import dns from 'node:dns/promises';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { assertHttpUrl, isPublicAddress, requestPublic } from '../server/http.ts';

test('private, loopback and non-global addresses cannot be fetched', async () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  await assert.rejects(requestPublic('http://127.0.0.1:12345/secret'), /not a public Internet address/);
  assert.throws(() => assertHttpUrl('http://user:pass@example.com/'), /credentials/);
});

test('a redirect to loopback is validated before any second request', async () => {
  const lookup = mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  let requests = 0;
  const get = mock.method(http, 'get', (_url: unknown, _options: unknown, callback: (response: http.IncomingMessage) => void) => {
    requests += 1;
    const req = new EventEmitter() as http.ClientRequest;
    const response = Readable.from([]) as http.IncomingMessage;
    response.statusCode = 302;
    response.headers = { location: 'http://127.0.0.1/private' };
    queueMicrotask(() => {
      req.emit('response', response);
      callback(response);
    });
    return req;
  });
  try {
    await assert.rejects(requestPublic('http://public.example/start'), /not a public Internet address/);
    assert.equal(requests, 1);
  } finally {
    get.mock.restore();
    lookup.mock.restore();
  }
});

test('the validated DNS answer is pinned for single and list lookups', async () => {
  const lookup = mock.method(dns, 'lookup', async () => [{ address: '8.8.4.4', family: 4 }]);
  const get = mock.method(http, 'get', (_url: unknown, options: { lookup: (host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void }, callback: (response: http.IncomingMessage) => void) => {
    options.lookup('public.example', {}, (_error, address, family) => {
      assert.equal(address, '8.8.4.4');
      assert.equal(family, 4);
    });
    options.lookup('public.example', { all: true }, (_error, addresses) => {
      assert.deepEqual(addresses, [{ address: '8.8.4.4', family: 4 }]);
    });
    const req = new EventEmitter() as http.ClientRequest;
    const response = Readable.from([]) as http.IncomingMessage;
    response.statusCode = 200;
    response.headers = {};
    queueMicrotask(() => {
      req.emit('response', response);
      callback(response);
    });
    return req;
  });
  try {
    const result = await requestPublic('http://public.example/video');
    assert.equal(result.finalUrl, 'http://public.example/video');
    result.response.resume();
  } finally {
    get.mock.restore();
    lookup.mock.restore();
  }
});

test('local API rejects hostile Host, Origin and browser fetch metadata', async () => {
  const port = await new Promise<number>((resolve) => {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      listener.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
  const tempRoot = path.resolve('.tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'security-'));
  const child = spawn(process.execPath, ['server/main.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, ANIMEDESK_PORT: String(port), ANIMEDESK_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  const call = (route: string, method = 'GET', headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        ready = (await call('/api/status')) === 200;
        if (ready) break;
      } catch { /* service is starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'service started');
    assert.equal(await call('/api/status', 'GET', { host: 'evil.example' }), 403);
    assert.equal(await call('/api/status', 'GET', { origin: 'https://evil.example' }), 403);
    assert.equal(await call('/api/status', 'GET', { 'sec-fetch-site': 'cross-site' }), 403);
    assert.equal(await call('/api/settings', 'PATCH', { origin: 'https://evil.example' }), 403);
    assert.equal(await call('/api/artwork?url=http%3A%2F%2F127.0.0.1%2Fsecret'), 404);
    assert.equal(await call('/api/artwork/invalid'), 404);
    // A sibling named "dist-leak" shares the old string prefix of DIST.
    assert.equal(await call('/..%2Fdist-leak%2Fsecret'), 403);
  } finally {
    child.kill();
    assert.equal(dataDir.startsWith(tempRoot + path.sep), true);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an ephemeral local port accepts only its assigned Host', async () => {
  const tempRoot = path.resolve('.tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'ephemeral-'));
  const child = spawn(process.execPath, ['server/main.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, ANIMEDESK_PORT: '0', ANIMEDESK_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('service ready timeout')), 10_000);
      child.once('message', (message: unknown) => {
        clearTimeout(timer);
        resolve((message as { port: number }).port);
      });
      child.once('exit', () => reject(new Error('service exited before ready')));
    });
    assert.ok(port > 0);
    const status = async (host: string) => new Promise<number>((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/api/status', headers: { host } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      });
      req.on('error', reject);
    });
    assert.equal(await status(`127.0.0.1:${port}`), 200);
    assert.equal(await status('evil.example'), 403);
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
