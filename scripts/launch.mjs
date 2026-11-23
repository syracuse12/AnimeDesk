#!/usr/bin/env node
/**
 * Production launcher: builds if needed, starts the local service, opens the
 * window. Only localhost is used; nothing is installed system-wide.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A fresh loopback port avoids opening somebody else's service on a collision.
const requestedPort = Number(process.env.ANIMEDESK_PORT ?? 0);
let url = '';

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
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  env: { ...process.env, ANIMEDESK_PORT: String(requestedPort) },
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
    const profile = path.join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? os.homedir(), 'AnimeDesk', 'window');
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
      { stdio: 'ignore' },
    );
    child.on('exit', () => {
      // Closing the dedicated window also stops the local API and player.
      if (service.exitCode === null) service.kill();
    });
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
  service.kill();
}

service.on('message', (message) => {
  if (!message || message.type !== 'ready' || !Number.isInteger(message.port) || message.port < 1) return;
  url = `http://127.0.0.1:${message.port}/`;
  void waitForService();
});
service.on('error', (error) => console.error('[animedesk] service failed:', error));

const shutdown = () => {
  if (service.exitCode === null) service.kill();
};
process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
service.on('exit', (code) => process.exit(code ?? 0));
