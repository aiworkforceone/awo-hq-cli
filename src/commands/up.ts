/**
 * `hq up <team>` wakes a team (a human signal, decision 23); `hq open <editor|--with "cmd"> <team>`
 * wakes it and then starts the editor on the team folder over SSH. The CLI never names an editor it
 * does not launch itself: `--with` takes any command with `{host}` and `{dir}` placeholders.
 */
import type { RemoteOrg } from '@kpa/shared/remote.types';
import { spawn } from 'node:child_process';
import { closeConnection, ConnectRefusedError, openConnection } from '../connect.js';
import { clientFor, type Ctx } from '../context.js';
import { pinHostKey } from '../ssh-config-file.js';
import { readState, writeState } from '../state.js';
import { resolveTeam, type Team } from '../teams.js';

export async function loadTeam(
  ctx: Ctx,
  ref: string,
  org?: string,
): Promise<{ team: Team; client: ReturnType<typeof clientFor> }> {
  const state = readState(ctx.env);
  const client = clientFor(ctx, state);
  const { body: orgs } = await client.request<RemoteOrg[]>('GET', '/api/remote/orgs');
  writeState({ ...state, orgs }, ctx.env);
  return { team: resolveTeam(orgs, ref, org), client };
}

async function wake(ctx: Ctx, team: Team, client: ReturnType<typeof clientFor>): Promise<void> {
  const ready = await openConnection(
    client,
    team,
    { scope: 'ssh', client: 'hq', intent: 'open', wake: true },
    { now: ctx.now, sleep: ctx.sleep, say: ctx.err },
  );
  if (ready.hostKey) await pinHostKey(team.alias, ready.hostKey, ctx.env);
  // `hq up` only needed the machine awake; the row is not a connection.
  await closeConnection(client, team, ready.id);
}

export async function up(ctx: Ctx, opts: { team: string; org?: string }): Promise<number> {
  try {
    const { team, client } = await loadTeam(ctx, opts.team, opts.org);
    await wake(ctx, team, client);
    ctx.out(`Team "${team.workspace.name}" is awake.`);
    return 0;
  } catch (err) {
    ctx.err(err instanceof ConnectRefusedError ? err.message : (err as Error).message);
    return 1;
  }
}

export function teamDir(team: Team): string {
  return `/data/workspaces/${team.workspace.id}`;
}

/** The argv for a known editor, or for a `--with` template. Never goes through a shell. */
export function editorArgv(
  editor: string | undefined,
  withCmd: string | undefined,
  team: Team,
): string[] | null {
  const host = team.alias;
  const dir = teamDir(team);
  if (withCmd) {
    const parts = withCmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    return parts.map((p) =>
      p
        .replace(/^["']|["']$/g, '')
        .replace(/\{host\}/g, host)
        .replace(/\{dir\}/g, dir),
    );
  }
  if (editor === 'cursor') return ['cursor', '--remote', `ssh-remote+${host}`, dir];
  if (editor === 'zed') return ['zed', `ssh://${host}${dir}`];
  return null;
}

export async function open(
  ctx: Ctx,
  opts: { editor?: string; with?: string; team: string; org?: string },
  run: (argv: string[]) => Promise<number> = runDetached,
): Promise<number> {
  try {
    const { team, client } = await loadTeam(ctx, opts.team, opts.org);
    const argv = editorArgv(opts.editor, opts.with, team);
    if (!argv || argv.length === 0) {
      ctx.err('hq: name an editor (cursor or zed), or pass --with "<command {host} {dir}>".');
      return 2;
    }
    await wake(ctx, team, client);
    ctx.out(`Opening ${team.workspace.name} (${team.alias})...`);
    return await run(argv);
  } catch (err) {
    ctx.err(err instanceof ConnectRefusedError ? err.message : (err as Error).message);
    return 1;
  }
}

function runDetached(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'ignore', detached: true });
    child.once('error', () => {
      process.stderr.write(`hq: could not start "${argv[0]}". Is it installed and on your PATH?\n`);
      resolve(1);
    });
    child.once('spawn', () => {
      child.unref();
      resolve(0);
    });
  });
}
