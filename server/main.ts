import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, VERSION, DEFAULT_SETTINGS, paths } from './config.ts';
import { ensureDir, isDirectory } from './paths.ts';
import { store } from './store.ts';
import { distributionProfile, getProvider, providerInfos } from './providers/index.ts';
import { ProviderError } from './providers/types.ts';
import { FetchError, assertHttpUrl } from './http.ts';
import { SessionManager } from './playback/sessions.ts';
import { mpvVersion, resolveMpvPath } from './player/mpv.ts';
import { setLibraryDir } from './providers/local.ts';
import { skips } from './aniskip.ts';
import { serveStream } from './proxy.ts';
import { artworkUrl, serveArtwork } from './artwork.ts';
import { discover, isGenre, suggest } from './discover.ts';
import type {
  AnimeDetail,
  AudioMode,
  DirectPlayRequest,
  DiscoverKind,
  HomeFeed,
  PlayRequest,
  PlaybackMode,
  SearchResult,
  HistoryEntry,
  Settings,
} from '../shared/types.ts';

const PORT = Number(process.env.ANIMEDESK_PORT ?? 47821);
const HOST = '127.0.0.1';
const DIST = path.resolve(process.cwd(), 'dist');
const ALLOWED_HOSTS = new Set(distributionProfile ? [`127.0.0.1:${PORT}`] : [`127.0.0.1:${PORT}`, '127.0.0.1:5173']);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((host) => `http://${host}`));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
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

function modeOf(value: unknown): PlaybackMode | undefined {
  return value === 'external' || value === 'embedded' ? value : undefined;
}

function qualityOf(value: unknown): Settings['quality'] | undefined {
  return value === 'best' || value === '1080' || value === '720' || value === '480' || value === 'worst'
    ? value
    : undefined;
}

function episodeOf(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > LIMITS.maxEpisodeNumber) {
    throw new ProviderError(400, 'episodeNumber must be a positive integer');
  }
  return number;
}

function safeArt<T extends { coverUrl?: string; bannerUrl?: string }>(item: T): T {
  return { ...item, coverUrl: artworkUrl(item.coverUrl), bannerUrl: artworkUrl(item.bannerUrl) };
}

async function historyArt(entry: HistoryEntry): Promise<HistoryEntry> {
  if (entry.provider !== 'local') return safeArt(entry);
  try {
    // File tokens live only for this process, so re-mint local sidecar artwork
    // when a persisted Continue Watching entry is shown after a restart.
    const detail = await getProvider('local').detail(entry.animeId);
    return safeArt({ ...entry, coverUrl: detail.coverUrl });
  } catch {
    return safeArt({ ...entry, coverUrl: undefined });
  }
}

/** Home rows: history is instant, the featured strip is best-effort and cached. */
const FEATURED_TITLES = ['one piece', 'attack on titan', 'demon slayer', 'jujutsu kaisen', 'naruto'];
let featuredCache: { at: number; items: AnimeDetail[] } = { at: 0, items: [] };

async function featured(): Promise<AnimeDetail[]> {
  if (distributionProfile) return [];
  if (Date.now() - featuredCache.at < 15 * 60_000 && featuredCache.items.length) {
    return featuredCache.items;
  }
  const settled = await Promise.allSettled(
    FEATURED_TITLES.map(async (title) => {
      const [hit] = await getProvider('hianime').search(title);
      if (!hit) return null;
      return getProvider('hianime').detail(hit.id);
    }),
  );
  const items = settled
    .flatMap((outcome) => (outcome.status === 'fulfilled' && outcome.value ? [outcome.value] : []))
    .filter((item) => item.coverUrl && item.episodes.length)
    .slice(0, 5);
  if (items.length) featuredCache = { at: Date.now(), items };
  return items;
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
      embedded: true,
    });
    return true;
  }

  if (route === '/api/providers' && method === 'GET') {
    json(res, 200, { providers: providerInfos() });
    return true;
  }

  if (route === '/api/home' && method === 'GET') {
    const history = store.getHistory();
    // One row per series, newest first; unfinished work is "continue".
    const seen = new Set<string>();
    const unique = history.filter((entry) => {
      const id = `${entry.provider}:${entry.animeId}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const feed: HomeFeed = {
      continueWatching: await Promise.all(unique.filter((entry) => !entry.completed && entry.positionSeconds > 20).slice(0, 12).map(historyArt)),
      recentlyWatched: await Promise.all(unique.slice(0, 12).map(historyArt)),
      featured: (await featured().catch(() => [])).map((entry) => safeArt<AnimeDetail>(entry)),
    };
    json(res, 200, feed);
    return true;
  }

  if (route === '/api/search' && method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, LIMITS.maxSearchLength);
    const only = url.searchParams.get('provider');
    const providers = !only || only === 'all'
      ? providerInfos().map((info) => getProvider(info.id))
      : [getProvider(only)];
    // An empty query is a browse request: only the local library can answer it.
    const active = query ? providers : providers.filter((provider) => provider.info.id === 'local');
    if (!active.length) return json(res, 200, { results: [] }), true;

    const settled = await Promise.allSettled(
      active.filter((provider) => provider.info.searchable).map((provider) => provider.search(query)),
    );
    const results = settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []));
    const errors = settled
      .map((outcome) => (outcome.status === 'rejected' ? String((outcome.reason as Error).message) : ''))
      .filter(Boolean);
    json(res, 200, { results: results.map((item) => safeArt<SearchResult>(item)), errors });
    return true;
  }

  // Discovery is AniList metadata, so it is only reachable while the remote
  // providers are: the distribution profile is offline by design.
  if (route === '/api/discover' && method === 'GET') {
    if (distributionProfile) return json(res, 200, { items: [] }), true;
    const kind = (url.searchParams.get('kind') ?? 'trending') as DiscoverKind;
    const genreParam = url.searchParams.get('genre') ?? undefined;
    const genre = genreParam && isGenre(genreParam) ? genreParam : undefined;
    const items = await discover(kind, genre);
    json(res, 200, { items: items.map((item) => safeArt(item)) });
    return true;
  }

  if (route === '/api/suggest' && method === 'GET') {
    if (distributionProfile) return json(res, 200, { items: [] }), true;
    const term = (url.searchParams.get('q') ?? '').trim().slice(0, LIMITS.maxSearchLength);
    const items = term ? await suggest(term) : [];
    json(res, 200, { items: items.map((item) => safeArt(item)) });
    return true;
  }

  const detailMatch = route.match(/^\/api\/anime\/([a-z]+)\/([^/]+)$/);
  if (detailMatch && method === 'GET') {
    const provider = getProvider(detailMatch[1] as string);
    const detail = await provider.detail(decodeURIComponent(detailMatch[2] as string));
    json(res, 200, { anime: safeArt<AnimeDetail>(detail) });
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
      mode: modeOf(body.mode),
      quality: qualityOf(body.quality),
    };
    if (!request.animeId) throw new ProviderError(400, 'animeId is required');
    const session = await manager.start(request);
    json(res, 200, { session });
    return true;
  }

  if (route === '/api/direct' && method === 'POST') {
    if (distributionProfile) throw new ProviderError(403, 'Direct remote streams are unavailable in the distribution profile');
    const body = asRecord(await readBody(req));
    const raw = String(body.url ?? '').trim();
    assertHttpUrl(raw);
    const request: DirectPlayRequest = {
      title: String(body.title ?? 'Direct stream').slice(0, 200),
      url: raw,
      audio: audioOf(body.audio),
      episodeNumber: Number(body.episodeNumber) || 1,
      subtitleUrl: body.subtitleUrl ? String(body.subtitleUrl) : undefined,
      subtitleLang: body.subtitleLang ? String(body.subtitleLang) : undefined,
    };
    // Direct URLs bypass provider detail/resolve entirely.
    const { directStart } = await import('./playback/direct.ts');
    const session = await directStart(manager, request, modeOf(body.mode));
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

  // The embedded player owns the clock, so it reports position and the real end.
  const progressMatch = route.match(/^\/api\/sessions\/([0-9a-f-]{36})\/progress$/);
  if (progressMatch && method === 'POST') {
    const body = asRecord(await readBody(req));
    const item = manager.get(progressMatch[1] as string);
    if (!item) return json(res, 404, { error: 'No such session' }), true;
    manager.reportById(
      progressMatch[1] as string,
      Number(body.position),
      body.duration as number | null,
      url.searchParams.get('force') === '1',
    );
    json(res, 200, { ok: true });
    return true;
  }

  const endMatch = route.match(/^\/api\/sessions\/([0-9a-f-]{36})\/end$/);
  if (endMatch && method === 'POST') {
    const body = asRecord(await readBody(req));
    const session = await manager.endFromClient(
      endMatch[1] as string,
      typeof body.duration === 'number' ? body.duration : null,
    );
    json(res, session ? 200 : 404, session ? { session } : { error: 'No such session' });
    return true;
  }

  if (route === '/api/skips' && method === 'GET') {
    const key = url.searchParams.get('key') ?? '';
    if (!key) throw new ProviderError(400, 'key is required');
    json(res, 200, { manual: skips.getManual(key) });
    return true;
  }

  if (route === '/api/skips' && method === 'PUT') {
    const body = asRecord(await readBody(req));
    const key = String(body.key ?? '');
    const range = (value: unknown): { start: number; end: number } | null => {
      const record = asRecord(value);
      if (record.start === undefined || record.end === undefined) return null;
      return { start: Number(record.start), end: Number(record.end) };
    };
    const saved = await skips.setManual(key, range(body.intro), range(body.outro));
    json(res, 200, { manual: saved });
    return true;
  }

  if (route.startsWith('/api/stream/') && method === 'GET') {
    const token = route.slice('/api/stream/'.length);
    await serveStream(token, req, res);
    return true;
  }

  if (route.startsWith('/api/artwork/') && method === 'GET') {
    await serveArtwork(route.slice('/api/artwork/'.length), res);
    return true;
  }

  if (route === '/api/history' && method === 'GET') {
    json(res, 200, { entries: store.getHistory().map((entry) => safeArt<HistoryEntry>(entry)) });
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
    setLibraryDir(settings.localLibraryDir);
    manager.setVolume(settings.volume);
    manager.setRate(settings.playbackRate);
    json(res, 200, { settings });
    return true;
  }

  // Reset to defaults. The UI calls this, so the route has to exist or the
  // button fails against a live service.
  if (route === '/api/settings' && method === 'DELETE') {
    const settings = await store.updateSettings({ ...DEFAULT_SETTINGS });
    setLibraryDir(settings.localLibraryDir);
    manager.setVolume(settings.volume);
    manager.setRate(settings.playbackRate);
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
    const onHistoryError = (message: string): void => {
      res.write(`event: history-error\ndata: ${JSON.stringify(message)}\n\n`);
    };
    manager.on('session', onSession);
    manager.on('history-error', onHistoryError);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      manager.off('session', onSession);
      manager.off('history-error', onHistoryError);
    });
    return true;
  }

  return false;
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const target = path.resolve(DIST, `.${relative}`);
  const withinDist = (file: string): boolean => {
    const rel = path.relative(DIST, file);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  if (!withinDist(target)) return fail(res, 403, 'Forbidden');

  try {
    if (!withinDist(await fsp.realpath(target))) return fail(res, 403, 'Forbidden');
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
  // A browser can reach loopback from an untrusted page. Host blocks DNS
  // rebinding; Origin and Fetch Metadata block cross-site reads and writes.
  if (!req.headers.host || !ALLOWED_HOSTS.has(req.headers.host.toLowerCase())) {
    fail(res, 403, 'Invalid request host');
    return;
  }
  if ((req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) ||
      (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) {
    fail(res, 403, 'Cross-origin request denied');
    return;
  }
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
  await skips.load();

  const settings = store.getSettings();
  mpvPath = distributionProfile ? null : resolveMpvPath(settings.mpvPath);
  if (!mpvPath) {
    console.warn('[animedesk] mpv.exe not found; in-app playback still works, external fallback will not.');
  }
  if (settings.localLibraryDir && isDirectory(settings.localLibraryDir)) {
    setLibraryDir(settings.localLibraryDir);
  }

  manager = new SessionManager(mpvPath);
  manager.setRate(settings.playbackRate);

  server.listen(PORT, HOST, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : PORT;
    ALLOWED_HOSTS.add(`127.0.0.1:${boundPort}`);
    ALLOWED_ORIGINS.add(`http://127.0.0.1:${boundPort}`);
    manager.setProxyPort(boundPort);
    if (process.send) process.send({ type: 'ready', port: boundPort });
    console.log(`[animedesk] service ready on http://${HOST}:${boundPort}`);
    console.log(`[animedesk] data: ${paths.dataDir}`);
    console.log(`[animedesk] mpv fallback: ${mpvPath ?? 'not found'}`);
  });
  server.on('error', (error) => {
    console.error('[animedesk] could not bind local service:', error.message);
    process.exitCode = 1;
  });

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await manager.stopAll().catch(() => undefined);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  if (distributionProfile) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      if (chunk.trim() === 'shutdown') void shutdown();
    });
    process.stdin.resume();
  }
}

void boot();
