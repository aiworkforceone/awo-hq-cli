/**
 * Everything a command touches in the outside world, injectable so every command is testable
 * without a network, a browser, a terminal or a real home directory.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
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
  /** Is stdout a terminal? Not one (a pipe, CI, a script) means nobody is at a browser to approve. */
  stdoutIsTTY: boolean;
  hostname: () => string;
  platform: NodeJS.Platform;
  arch: string;
  /**
   * cli-session-lifecycle: ask the person a question at the terminal and resolve with the line they
   * typed. ABSENT when nobody is there to answer (stdin or stderr is not a terminal: a pipe, CI, a
   * script), so a command that would ask refuses instead and names its `--yes`.
   */
  ask?: (question: string) => Promise<string>;
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
    stdoutIsTTY: process.stdout.isTTY === true,
    hostname: () => os.hostname().split('.')[0] ?? 'computer',
    platform: process.platform,
    arch: process.arch,
    // The question goes to stderr, so `--json` output on stdout stays one clean document.
    ...(process.stdin.isTTY === true && process.stderr.isTTY === true
      ? {
          ask: async (question: string) => {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            try {
              return await rl.question(terminalSafe(question));
            } finally {
              rl.close();
            }
          },
        }
      : {}),
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
