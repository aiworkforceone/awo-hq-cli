/**
 * `hq` — connect this computer to your HQ team machines. Entry point of the bundled `dist/hq.cjs`.
 */
import { SSH_REMOVED_MESSAGE } from '@kpa/shared/remote.types';
import { NotLoggedInError, HqApiError } from './api.js';
import { flagString, parseArgs, type ParsedArgs } from './args.js';
import { attach } from './commands/attach.js';
import { renderUsage } from './command-manifest.js';
import { forward } from './commands/forward.js';
import { login } from './commands/login.js';
import { logout } from './commands/logout.js';
import { status } from './commands/status.js';
import { up } from './commands/up.js';
import { defaultCtx, type Ctx } from './context.js';
import { resolveLocalEchoMode } from './local-echo/mode.js';
import { TeamNotFoundError } from './teams.js';
import { HQ_VERSION } from './version.js';

/** `hq --help`, rendered from the command manifest (the same source as /docs/cli/reference). */
export const USAGE = renderUsage(HQ_VERSION);

export async function run(argv: string[], ctx: Ctx = defaultCtx()): Promise<number> {
  const args: ParsedArgs = parseArgs(argv);
  const [cmd, ...rest] = args.positionals;
  const org = flagString(args, 'org');
  if (args.flags.has('version') || cmd === 'version') {
    ctx.out(HQ_VERSION);
    return 0;
  }
  if (!cmd || args.flags.has('help') || cmd === 'help') {
    ctx.out(USAGE);
    return cmd || args.flags.has('help') ? 0 : 2;
  }
  try {
    switch (cmd) {
      case 'login': {
        const host = flagString(args, 'host');
        return await login(ctx, host ? { host } : {});
      }
      case 'logout':
        return await logout(ctx);
      case 'status':
        return await status(ctx);
      // SSH to team machines was removed on 2026-10-01. The SSH commands stay only to say so, so a
      // script or an old ~/.ssh/hq_config entry gets the reason instead of "unknown command".
      case 'ssh':
      case 'open':
        ctx.err(`hq: ${SSH_REMOVED_MESSAGE}`);
        return 1;
      case 'ssh-proxy':
        // What ssh runs from an old `Host hq-…` entry: 255 is ssh's own "could not connect".
        ctx.err(`hq: ${SSH_REMOVED_MESSAGE}`);
        return 255;
      case 'up':
        if (!rest[0]) break;
        return await up(ctx, { team: rest[0], ...(org ? { org } : {}) });
      case 'attach': {
        if (!rest[0]) break;
        const team = flagString(args, 'team');
        // feature `local-echo` (Decision 16): the flag wins over HQ_LOCAL_ECHO; neither = off.
        const echo = resolveLocalEchoMode(args.flags.get('local-echo'), ctx.env.HQ_LOCAL_ECHO);
        if ('error' in echo) {
          ctx.err(echo.error);
          return 2;
        }
        return await attach(
          ctx,
          {
            session: rest[0],
            ...(org ? { org } : {}),
            ...(team ? { team } : {}),
            ...(echo.mode !== 'off' ? { localEcho: echo.mode } : {}),
          },
          { stdin: process.stdin, stdout: process.stdout },
        );
      }
      case 'forward': {
        if (!rest[0]) break;
        const local = flagString(args, 'local');
        const team = flagString(args, 'team');
        return await forward(ctx, {
          port: rest[0],
          ...(local ? { local } : {}),
          ...(team ? { team } : {}),
          ...(org ? { org } : {}),
        });
      }
      default:
        ctx.err(`hq: unknown command "${cmd}". Run hq --help.`);
        return 2;
    }
  } catch (err) {
    if (err instanceof NotLoggedInError || err instanceof TeamNotFoundError) ctx.err(err.message);
    else if (err instanceof HqApiError) ctx.err(`hq: ${err.message}`);
    else ctx.err(`hq: ${(err as Error).message}`);
    return 1;
  }
  ctx.err(`hq: missing arguments for "${cmd}". Run hq --help.`);
  return 2;
}

// Run when executed (the bundle, or `node --import tsx cli/src/main.ts`), not when imported by tests.
const isMain =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
if (isMain) {
  void run(process.argv.slice(2)).then((code) => {
    // Flush stdout first (a pipe is asynchronous on macOS: a reader must get the last bytes), then exit
    // so a paused stdin or an idle keep-alive cannot hold the process open.
    process.stdout.write('', () => process.exit(code));
  });
}
