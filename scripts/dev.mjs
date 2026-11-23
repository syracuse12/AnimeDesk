#!/usr/bin/env node
/**
 * Development launcher: Vite HMR for the UI plus the local service, opened as
 * an app window. Keeps the same API port the Vite proxy expects.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.ANIMEDESK_PORT ?? 47821);
const appUrl = 'http://127.0.0.1:5173/';

const children = [];
function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  return child;
}

const mpvExe = path.join(root, 'tools', 'mpv', 'mpv.exe');
if (!fs.existsSync(mpvExe)) {
  console.warn('[animedesk] mpv.exe missing. Run: npm run setup:mpv');
}

run(process.execPath, [path.join(root, 'server', 'main.ts')], { ANIMEDESK_PORT: String(port) });
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['exec', '--', 'vite', '--', '--host', '127.0.0.1'], {
  ANIMEDESK_PORT: String(port),
});

function openWindow() {
  const browser = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].find((candidate) => fs.existsSync(candidate));
  if (!browser) return console.log(`[animedesk] open ${appUrl}`);
  const profile = path.join(root, '.appdata', 'window-dev');
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(
    browser,
    [`--app=${appUrl}`, `--user-data-dir=${profile}`, '--window-size=1280,860', '--no-first-run'],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

async function wait() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(appUrl);
      if (response.ok) {
        openWindow();
        console.log(`[animedesk] dev server ready at ${appUrl}`);
        return;
      }
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
void wait();

const stop = () => {
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);