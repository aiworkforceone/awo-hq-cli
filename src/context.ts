/**
 * Everything a command touches in the outside world, injectable so every command is testable
 * without a network, a browser, a terminal or a real home directory.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { ensureDeviceKey, loadDeviceKey, type DeviceKey } from './device-key.js';
import { HqClient, type FetchLike } from './api.js';
import { readState, type HqState } from './state.js';
import { terminalSafe } from './safe-text.js';

export interface Ctx {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  openUrl: (url: string) => void;
  hostname: () => string;
  platform: NodeJS.Platform;
  arch: string;
}

export function defaultCtx(): Ctx {
  return {
    env: process.env,
    // Review C4: every line the CLI prints may carry a server string (a team name, an error
    // sentence). Control characters are neutralized here, once, so no escape sequence can start.
    out: (line) => process.stdout.write(`${terminalSafe(line)}\n`),
    err: (line) => process.stderr.write(`${terminalSafe(line)}\n`),
    fetch: globalThis.fetch,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    openUrl: (url) => {
      // Windows: `rundll32 url.dll,FileProtocolHandler`, never `cmd /c start` (cmd would parse `&`
      // and friends inside a URL the server supplied). The caller only opens URLs on the HQ host.
      const [cmd, args] =
        process.platform === 'darwin'
          ? ['open', [url]]
          : process.platform === 'win32'
            ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
            : ['xdg-open', [url]];
      try {
        spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
      } catch {
        /* the URL is printed anyway */
      }
    },
    hostname: () => os.hostname().split('.')[0] ?? 'computer',
    platform: process.platform,
    arch: process.arch,
  };
}

export function clientFor(ctx: Ctx, state: HqState = readState(ctx.env)): HqClient {
  let key: DeviceKey;
  try {
    key = loadDeviceKey(ctx.env);
  } catch {
    key = ensureDeviceKey(ctx.env);
  }
  return new HqClient({
    host: state.host,
    key: key.privateKey,
    env: ctx.env,
    fetch: ctx.fetch,
    now: ctx.now,
  });
}
