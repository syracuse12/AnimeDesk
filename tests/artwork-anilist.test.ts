import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import dns from 'node:dns/promises';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { artworkUrl, serveArtwork } from '../server/artwork.ts';
import { lookupMedia, lookupMalId } from '../server/anilist.ts';

function fakeResponse(status: number, body: Buffer | string, headers: Record<string, string> = {}) {
  const response = Readable.from([body]) as IncomingMessage;
  response.statusCode = status;
  response.headers = headers;
  return response;
}

function fakeServerResponse() {
  const output: { status?: number; headers?: Record<string, string>; body?: Buffer } = {};
  return { output, response: {
    writeHead(status: number, headers: Record<string, string>) { output.status = status; output.headers = headers; },
    end(body: Buffer) { output.body = body; },
  } as unknown as import('node:http').ServerResponse };
}

test('artwork tokens cannot be minted for local or non-HTTPS destinations', () => {
  for (const source of ['http://public.example/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://169.254.169.254/a.png', 'https://user:secret@public.example/a.png']) {
    assert.equal(artworkUrl(source), undefined, source);
  }
  assert.match(artworkUrl('https://public.example/poster.png') ?? '', /^\/api\/artwork\/[A-Za-z0-9_-]{32}$/);
});

test('artwork rejects DNS rebinding to local services before connecting', async () => {
  const lookup = mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
  const get = mock.method(https, 'get', () => { throw new Error('must not connect'); });
  try {
    const token = artworkUrl('https://rebinding.example/poster.jpg')!.split('/').pop()!;
    await assert.rejects(serveArtwork(token, fakeServerResponse().response), /not a public Internet address/);
    assert.equal(get.mock.callCount(), 0);
  } finally { lookup.mock.restore(); get.mock.restore(); }
});

test('artwork rechecks redirects and rejects HTML disguised as an image', async () => {
  const lookup = mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  let status = 302;
  const get = mock.method(https, 'get', (_url: unknown, _options: unknown, callback: (response: IncomingMessage) => void) => {
    const req = new EventEmitter() as ClientRequest;
    const response = status === 302
      ? fakeResponse(302, '', { location: 'https://127.0.0.1/private' })
      : fakeResponse(200, '<html>not an image</html>', { 'content-type': 'image/jpeg' });
    queueMicrotask(() => { req.emit('response', response); callback(response); });
    return req;
  });
  try {
    const token = artworkUrl('https://redirect.example/poster.jpg')!.split('/').pop()!;
    await assert.rejects(serveArtwork(token, fakeServerResponse().response), /not a public Internet address/);
    assert.equal(get.mock.callCount(), 1);
    status = 200;
    await assert.rejects(serveArtwork(token, fakeServerResponse().response), /Unsupported artwork content/);
  } finally { lookup.mock.restore(); get.mock.restore(); }
});

test('artwork accepts a real PNG and sets a sniffed image type', async () => {
  const lookup = mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const get = mock.method(https, 'get', (_url: unknown, _options: unknown, callback: (response: IncomingMessage) => void) => {
    const req = new EventEmitter() as ClientRequest;
    const response = fakeResponse(200, png, { 'content-type': 'text/html' });
    queueMicrotask(() => { req.emit('response', response); callback(response); });
    return req;
  });
  try {
    const token = artworkUrl('https://good.example/poster.png')!.split('/').pop()!;
    const { response, output } = fakeServerResponse();
    await serveArtwork(token, response);
    assert.equal(output.status, 200);
    assert.equal(output.headers?.['content-type'], 'image/png');
    assert.deepEqual(output.body, png);
  } finally { lookup.mock.restore(); get.mock.restore(); }
});

test('artwork refuses oversized upstream bodies', async () => {
  const lookup = mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const get = mock.method(https, 'get', (_url: unknown, _options: unknown, callback: (response: IncomingMessage) => void) => {
    const req = new EventEmitter() as ClientRequest;
    const response = fakeResponse(200, Buffer.from([0xff, 0xd8, 0xff]), { 'content-length': String(9 * 1024 * 1024) });
    queueMicrotask(() => { req.emit('response', response); callback(response); });
    return req;
  });
  try {
    const token = artworkUrl('https://oversized.example/poster.jpg')!.split('/').pop()!;
    await assert.rejects(serveArtwork(token, fakeServerResponse().response), /size limit/);
  } finally { lookup.mock.restore(); get.mock.restore(); }
});

test('AniList uses guarded POST, validates shape, and preserves MAL matching', async () => {
  const lookup = mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  let payload = JSON.stringify({ data: { Page: { media: [{ idMal: 52991, title: { romaji: 'Sousou no Frieren', english: 'Frieren: Beyond Journey’s End' } }] } } });
  const request = mock.method(https, 'request', (url: URL, options: { method: string; lookup: Function }, callback: (response: IncomingMessage) => void) => {
    assert.equal(url.href, 'https://graphql.anilist.co/');
    assert.equal(options.method, 'POST');
    const req = new EventEmitter() as ClientRequest;
    req.end = () => { const response = fakeResponse(200, payload); queueMicrotask(() => { req.emit('response', response); callback(response); }); return req; };
    return req;
  });
  try {
    assert.equal(await lookupMalId('Sousou no Frieren'), 52991);
    payload = '<html>broken';
    assert.equal(await lookupMedia('Never Valid Anime 941'), null);
    payload = JSON.stringify({ data: { Page: { media: 'wrong' } } });
    assert.equal(await lookupMedia('Never Valid Anime 942'), null);
    assert.equal(request.mock.callCount(), 3);
  } finally { lookup.mock.restore(); request.mock.restore(); }
});

test('AniList rejects redirects without sending a second POST', async () => {
  const lookup = mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const request = mock.method(https, 'request', (_url: unknown, _options: unknown, callback: (response: IncomingMessage) => void) => {
    const req = new EventEmitter() as ClientRequest;
    req.end = () => {
      const response = fakeResponse(307, '', { location: 'https://127.0.0.1/private' });
      queueMicrotask(() => { req.emit('response', response); callback(response); });
      return req;
    };
    return req;
  });
  try {
    assert.equal(await lookupMedia('Uncached Redirected Anime 8721'), null);
    assert.equal(request.mock.callCount(), 1);
  } finally { lookup.mock.restore(); request.mock.restore(); }
});
