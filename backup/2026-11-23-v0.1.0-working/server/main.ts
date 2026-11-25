import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, VERSION, paths } from './config.ts';
import { ensureDir, isDirectory } from './paths.ts';
import { store } from './store.ts';
import { getProvider, providerInfos } from './providers/index.ts';
import { ProviderError } from './providers/types.ts';
import { FetchError, assertHttpUrl } from './http.ts';
import { SessionManager } from './playback/sessions.ts';
import { mpvVersion, resolveMpvPath } from './player/mpv.ts';
import { setLibraryDir } from './providers/local.ts';
import type { AudioMode, DirectPlayRequest, PlayRequest } from '../shared/types.ts';

const PORT = Number(process.env.ANIMEDESK_PORT ?? 47821);
const HOST = '127.0.0.1';
const DIST = path.resolve(process.cwd(), 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

let mpvPath: string | null = null;
let manager: SessionManager;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function fail(res: http.ServerResponse, status: number, error: string, detail?: string): void {
  json(res, status, detail ? { error, detail } : { error });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        reject(new ProviderError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ProviderError(400, 'Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function audioOf(value: unknown): AudioMode {
  return value === 'dub' ? 'dub' : 'sub';
}

function episodeOf(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > LIMITS.maxEpisodeNumber) {
    throw new ProviderError(400, 'episodeNumber must be a positive integer');
  }
  return number;
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  const method = req.method ?? 'GET';

  if (route === '/api/status' && method === 'GET') {
    const settings = store.getSettings();
    json(res, 200, {
      version: VERSION,
      mpv: {
        available: Boolean(mpvPath),
        path: mpvPath,
        version: mpvPath ? await mpvVersion(mpvPath) : null,
      },
      dataDir: paths.dataDir,
      providers: providerInfos(),
      settings,
      platform: process.platform,
      shell: 'browser',
    });
    return true;
  }

  if (route === '/api/providers' && method === 'GET') {
    json(res, 200, { providers: providerInfos() });
    return true;
  }

  if (route === '/api/search' && method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, LIMITS.maxSearchLength);
    const only = url.searchParams.get('provider');
    const providers = only ? [getProvider(only)] : providerInfos().map((info) => getProvider(info.id));
    // An empty query is a browse request: only the local library can answer it.
    const active = query ? providers : providers.filter((provider) => provider.info.id === 'local');
    if (!active.length) return json(res, 200, { results: [] }), true;

    const settled = await Promise.allSettled(
      active.filter((provider) => provider.info.searchable).map((provider) => provider.search(query)),
    );
    const results = settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []));
    const errors = settled
      .map((outcome, index) => (outcome.status === 'rejected' ? String((outcome.reason as Error).message) : ''))
      .filter(Boolean);
    json(res, 200, { results, errors });
    return true;
  }

  const detailMatch = route.match(/^\/api\/anime\/([a-z]+)\/([^/]+)$/);
  if (detailMatch && method === 'GET') {
    const provider = getProvider(detailMatch[1] as string);
    const detail = await provider.detail(decodeURIComponent(detailMatch[2] as string));
    json(res, 200, { anime: detail });
    return true;
  }

  if (route === '/api/play' && method === 'POST') {
    const body = asRecord(await readBody(req));
    const request: PlayRequest = {
      provider: String(body.provider ?? '') as PlayRequest['provider'],
      animeId: String(body.animeId ?? ''),
      episodeNumber: episodeOf(body.episodeNumber),
      audio: audioOf(body.audio),
      startAt: typeof body.startAt === 'number' && Number.isFinite(body.startAt) ? Math.max(0, body.startAt) : undefined,
    };
    if (!request.animeId) throw new ProviderError(400, 'animeId is required');
    const session = await manager.start(request);
    json(res, 200, { session });
    return true;
  }

  if (route === '/api/direct' && method === 'POST') {
    const body = asRecord(await readBody(req));
    const raw = String(body.url ?? '').trim();
    assertHttpUrl(raw);
    const request: DirectPlayRequest = {
      title: String(body.title ?? 'Direct stream').slice(0, 200),
      url: raw,
      audio: audioOf(body.audio),
      episodeNumber: Number(body.episodeNumber) || 1,
      subtitleUrl: body.subtitleUrl ? String(body.subtitleUrl) : undefined,
    };
    if (!mpvPath) throw new ProviderError(500, 'mpv was not found');
    const session = await manager.start({
      provider: 'local',
      animeId: `direct:${request.url}`,
      episodeNumber: request.episodeNumber ?? 1,
      audio: request.audio,
    }).catch(async () => {
      // Direct URLs bypass provider detail/resolve entirely.
      const { directStart } = await import('./playback/direct.ts');
      return directStart(manager, request);
    });
    json(res, 200, { session });
    return true;
  }

  if (route === '/api/sessions' && method === 'GET') {
    json(res, 200, { sessions: manager.list() });
    return true;
  }

  const sessionMatch = route.match(/^\/api\/sessions\/([0-9a-f-]{36})$/);
  if (sessionMatch && method === 'GET') {
    const session = manager.get(sessionMatch[1] as string);
    return json(res, session ? 200 : 404, session ?? { error: 'No such session' }), true;
  }

  const actionMatch = route.match(/^\/api\/sessions\/([0-9a-f-]{36})\/action$/);
  if (actionMatch && method === 'POST') {
    const body = asRecord(await readBody(req));
    const result = await manager.action(
      actionMatch[1] as string,
      String(body.action ?? ''),
      typeof body.value === 'number' ? body.value : undefined,
    );
    if (!result) return json(res, 200, { ok: true }), true;
    json(res, 200, { session: result });
    return true;
  }

  if (route === '/api/history' && method === 'GET') {
    json(res, 200, { entries: store.getHistory() });
    return true;
  }

  if (route === '/api/history' && method === 'DELETE') {
    await store.clearHistory();
    json(res, 200, { ok: true });
    return true;
  }

  const historyMatch = route.match(/^\/api\/history\/(.+)$/);
  if (historyMatch && method === 'DELETE') {
    const removed = await store.removeHistory(decodeURIComponent(historyMatch[1] as string));
    json(res, removed ? 200 : 404, { ok: removed });
    return true;
  }

  if (route === '/api/settings' && method === 'GET') {
    json(res, 200, { settings: store.getSettings() });
    return true;
  }

  if (route === '/api/settings' && method === 'PATCH') {
    const settings = await store.updateSettings(asRecord(await readBody(req)));
    if (settings.localLibraryDir) setLibraryDir(settings.localLibraryDir);
    manager.setVolume(settings.volume);
    json(res, 200, { settings });
    return true;
  }

  if (route === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const onSession = (session: unknown): void => {
      res.write(`event: session\ndata: ${JSON.stringify(session)}\n\n`);
    };
    manager.on('session', onSession);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      manager.off('session', onSession);
    });
    return true;
  }

  return false;
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const target = path.join(DIST, relative);
  if (!target.startsWith(DIST)) return fail(res, 403, 'Forbidden');

  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': stat.size,
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    // SPA fallback, but never for /api.
    if (url.pathname.startsWith('/api')) return fail(res, 404, 'Not found');
    const index = path.join(DIST, 'index.html');
    if (!fs.existsSync(index)) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('AnimeDesk service is running. Build the UI with `npm run build`, or use `npm run dev`.');
      return;
    }
    res.writeHead(200, { 'content-type': MIME['.html'] as string });
    fs.createReadStream(index).pipe(res);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  void (async () => {
    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, url);
        if (!handled) fail(res, 404, 'Unknown endpoint');
        return;
      }
      await serveStatic(req, res, url);
    } catch (error) {
      if (error instanceof ProviderError || error instanceof FetchError) {
        return fail(res, error.status, error.message);
      }
      fail(res, 500, (error as Error).message || 'Internal error');
    }
  })();
});

async function boot(): Promise<void> {
  ensureDir(paths.dataDir);
  ensureDir(paths.tempDir);
  await store.load();

  const settings = store.getSettings();
  mpvPath = resolveMpvPath(settings.mpvPath);
  if (!mpvPath) {
    console.warn('[animedesk] mpv.exe not found; run `npm run setup:mpv`.');
  }
  if (settings.localLibraryDir && isDirectory(settings.localLibraryDir)) {
    setLibraryDir(settings.localLibraryDir);
  }

  manager = new SessionManager(mpvPath);

  server.listen(PORT, HOST, () => {
    console.log(`[animedesk] service ready on http://${HOST}:${PORT}`);
    console.log(`[animedesk] data: ${paths.dataDir}`);
    console.log(`[animedesk] mpv: ${mpvPath ?? 'not found'}`);
  });

  const shutdown = async (): Promise<void> => {
    await manager.stopAll().catch(() => undefined);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void boot();