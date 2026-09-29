/**
 * `hq` — connect this computer to your HQ team machines. Entry point of the bundled `dist/hq.cjs`.
 */
import { NotLoggedInError, HqApiError } from './api.js';
import { flagString, parseArgs, type ParsedArgs } from './args.js';
import { attach } from './commands/attach.js';
import { forward } from './commands/forward.js';
import { login } from './commands/login.js';
import { logout } from './commands/logout.js';
import { sshConfig } from './commands/ssh-config.js';
import { sshProxy } from './commands/ssh-proxy.js';
import { status } from './commands/status.js';
import { open, up } from './commands/up.js';
import { defaultCtx, type Ctx } from './context.js';
import { resolveLocalEchoMode } from './local-echo/mode.js';
import { TeamNotFoundError } from './teams.js';
import { HQ_VERSION } from './version.js';

export const USAGE = `hq ${HQ_VERSION}: connect this computer to your HQ team machines

Usage:
  hq login [--host <url>]            sign this computer in (approve it in your browser)
  hq ssh --config                    write ~/.ssh/hq_config for your teams
  hq status                          who you are and the teams you can reach
  hq up <team>                       wake a team machine
  hq open cursor|zed <team>          wake a team, then open it in that editor
  hq open --with "<cmd {host} {dir}>" <team>
  hq attach <session> [--team <t>]   join an HQ session in this terminal (Ctrl-] to detach)
      [--local-echo[=auto|always|off]] show what you type instantly (or set HQ_LOCAL_ECHO)
  hq forward <port> [--local <port>] [--team <t>]
  hq logout                          sign out and revoke this computer's access

<team> is the hq-… name from hq status, or the team's name. --org <slug> narrows either.`;

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
      case 'ssh':
        if (args.flags.has('config')) return await sshConfig(ctx);
        ctx.err('hq: to connect, run hq ssh --config once, then ssh <hq-name>.');
        return 2;
      case 'ssh-proxy': {
        const workspace = flagString(args, 'workspace');
        if (!workspace || !org) {
          ctx.err(
            'hq: ssh-proxy needs --workspace <id> and --org <slug> (it is written by hq ssh --config).',
          );
          return 255;
        }
        return await sshProxy(
          ctx,
          { workspace, org, wake: args.flags.has('wake') },
          { stdin: process.stdin, stdout: process.stdout },
        );
      }
      case 'up':
        if (!rest[0]) break;
        return await up(ctx, { team: rest[0], ...(org ? { org } : {}) });
      case 'open': {
        const withCmd = flagString(args, 'with');
        const team = withCmd ? rest[0] : rest[1];
        const editor = withCmd ? undefined : rest[0];
        if (!team) break;
        return await open(ctx, {
          team,
          ...(editor ? { editor } : {}),
          ...(withCmd ? { with: withCmd } : {}),
          ...(org ? { org } : {}),
        });
      }
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
    // Flush stdout first (a pipe is asynchronous on macOS: ssh must get the last bytes), then exit
    // so a paused stdin or an idle keep-alive cannot hold the process open.
    process.stdout.write('', () => process.exit(code));
  });
}
