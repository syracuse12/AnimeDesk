import { spawn, execFile, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { USER_AGENT } from '../http.ts';

export interface MpvLaunch {
  url: string;
  referer?: string;
  subtitleUrl?: string;
  title: string;
  startAt: number;
  volume: number;
}

export type MpvEvent = 'loaded' | 'end' | 'exit' | 'failed';

/**
 * Thin mpv JSON-IPC client. Only this module knows how mpv is spoken to, so a
 * future embedded renderer can replace it without touching sessions or routes.
 */
export class MpvPlayer extends EventEmitter {
  private readonly exePath: string;
  private child: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private pipeName = '';
  private buffer = '';
  private requestId = 0;
  private closed = false;
  private stderrTail = '';

  constructor(exePath: string) {
    super();
    this.exePath = exePath;
  }

  get alive(): boolean {
    return this.child !== null && !this.closed;
  }

  async open(launch: MpvLaunch): Promise<void> {
    if (this.child) throw new Error('mpv already running for this player');
    this.pipeName = `\\\\.\\pipe\\animedesk-mpv-${randomUUID()}`;

    const args = [
      '--no-config',
      '--terminal=no',
      '--idle=no',
      '--keep-open=no',
      '--force-window=yes',
      '--autofit=1280x720',
      '--osc=yes',
      '--osd-duration=2000',
      '--user-agent=' + USER_AGENT,
      `--volume=${Math.round(launch.volume)}`,
      `--force-media-title=${launch.title}`,
      `--input-ipc-server=${this.pipeName}`,
    ];
    if (launch.referer) args.push(`--referrer=${launch.referer}`);
    if (launch.subtitleUrl) args.push(`--sub-file=${launch.subtitleUrl}`);
    if (launch.startAt > 5) args.push(`--start=${launch.startAt.toFixed(2)}`);
    args.push('--', launch.url);

    const child = spawn(this.exePath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;

    // Keep the tail of mpv's own diagnostics: without it a failed launch is opaque.
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000);
    });

    child.on('error', (error) => {
      this.closed = true;
      this.emit('failed', error.message);
    });
    child.on('exit', (code) => {
      this.closed = true;
      this.socket?.destroy();
      this.socket = null;
      this.emit('exit', code ?? 0);
    });

    await this.connect();
    await this.observe();
  }

  private connect(): Promise<void> {
    const deadline = Date.now() + 15_000;
    return new Promise((resolve, reject) => {
      const attempt = (): void => {
        if (this.closed) {
          const tail = this.stderrTail.trim().split('\n').slice(-4).join(' | ');
          return reject(new Error(`mpv exited before its control pipe appeared${tail ? `: ${tail}` : ''}`));
        }
        const socket = net.connect(this.pipeName);
        socket.setEncoding('utf8');
        socket.once('connect', () => {
          this.socket = socket;
          socket.on('data', (chunk: string) => this.consume(chunk));
          socket.on('error', () => undefined);
          resolve();
        });
        socket.once('error', () => {
          socket.destroy();
          if (Date.now() > deadline) {
            reject(new Error('Timed out waiting for the mpv control pipe'));
          } else {
            setTimeout(attempt, 120);
          }
        });
      };
      attempt();
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handle(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private handle(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.event === 'file-loaded') {
      void this.getProperty('duration').then((duration) => this.emit('loaded', duration));
      return;
    }
    if (message.event === 'end-file') {
      this.emit('end', String(message.reason ?? ''));
      return;
    }
    if (message.event === 'property-change' && typeof message.name === 'string') {
      this.emit('property', message.name, message.data);
    }
  }

  private async observe(): Promise<void> {
    for (const [id, name] of [
      [1, 'time-pos'],
      [2, 'duration'],
      [3, 'pause'],
      [4, 'eof-reached'],
      [5, 'fullscreen'],
    ] as const) {
      await this.command(['observe_property', id, name]).catch(() => undefined);
    }
  }

  send(command: unknown[]): void {
    if (!this.socket || this.closed) return;
    this.socket.write(`${JSON.stringify({ command })}\n`);
  }

  command(command: unknown[]): Promise<unknown> {
    return new Promise((resolve) => {
      if (!this.socket || this.closed) return resolve(null);
      const requestId = (this.requestId += 1);
      const onLine = (chunk: string): void => {
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            if (message.request_id === requestId) {
              this.socket?.off('data', onLine);
              resolve(message.data ?? null);
              return;
            }
          } catch {
            /* not ours */
          }
        }
      };
      this.socket.on('data', onLine);
      this.socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
      setTimeout(() => {
        this.socket?.off('data', onLine);
        resolve(null);
      }, 4000);
    });
  }

  async getProperty(name: string): Promise<unknown> {
    return this.command(['get_property', name]);
  }

  setProperty(name: string, value: unknown): void {
    this.send(['set_property', name, value]);
  }

  seek(seconds: number): void {
    this.send(['seek', Math.max(0, seconds), 'absolute']);
  }

  setPaused(paused: boolean): void {
    this.setProperty('pause', paused);
  }

  setVolume(volume: number): void {
    this.setProperty('volume', Math.round(volume));
  }

  setRate(rate: number): void {
    this.setProperty('speed', rate);
  }

  setFullscreen(on: boolean): void {
    this.setProperty('fullscreen', on);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.send(['quit']);
    const child = this.child;
    setTimeout(() => {
      if (child && child.exitCode === null) child.kill();
    }, 1500);
    this.socket?.end();
  }
}

/** Bundled mpv wins, then the user setting, then PATH. */
export function resolveMpvPath(configured: string): string | null {
  const candidates: string[] = [];
  if (configured.trim()) candidates.push(configured.trim());
  candidates.push(path.resolve(process.cwd(), 'tools', 'mpv', 'mpv.exe'));
  candidates.push(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', 'tools', 'mpv', 'mpv.exe'));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function mpvVersion(exePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(exePath, ['--version'], { timeout: 8000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(stdout.split('\n')[0]?.trim() ?? null);
    });
  });
}
