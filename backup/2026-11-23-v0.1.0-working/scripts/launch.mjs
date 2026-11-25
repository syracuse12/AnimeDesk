#!/usr/bin/env node
/**
 * Production launcher: builds if needed, starts the local service, opens the
 * window. Only localhost is used; nothing is installed system-wide.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.ANIMEDESK_PORT ?? 47821);
const url = `http://127.0.0.1:${port}/`;

const mpvExe = path.join(root, 'tools', 'mpv', 'mpv.exe');
if (!fs.existsSync(mpvExe)) {
  console.warn('[animedesk] mpv.exe missing. Run: npm run setup:mpv');
}

if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.log('[animedesk] first run: building the UI...');
  const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const service = spawn(process.execPath, [path.join(root, 'server', 'main.ts')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ANIMEDESK_PORT: String(port) },
});

/** Prefer a dedicated app window; fall back to the default browser. */
function openWindow() {
  const edge = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((candidate) => fs.existsSync(candidate));

  const chrome = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].find((candidate) => fs.existsSync(candidate));

  const browser = edge ?? chrome;
  if (browser) {
    const profile = path.join(root, '.appdata', 'window');
    fs.mkdirSync(profile, { recursive: true });
    const child = spawn(
      browser,
      [
        `--app=${url}`,
        `--user-data-dir=${profile}`,
        '--window-size=1280,860',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return;
  }
  console.log(`[animedesk] open ${url} in a browser (no Edge/Chrome found)`);
}

let opened = false;
async function waitForService() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${url}api/status`);
      if (response.ok) {
        if (!opened) {
          opened = true;
          openWindow();
          console.log(`[animedesk] running at ${url}`);
        }
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.error('[animedesk] service did not become ready');
}

void waitForService();

const shutdown = () => {
  if (service.exitCode === null) service.kill();
};
process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
service.on('exit', (code) => process.exit(code ?? 0));