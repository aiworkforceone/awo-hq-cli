/**
 * `hq up <team>` wakes a team (a human signal, decision 23) through the wake route (hq-vscode D13).
 * SSH was removed on 2026-10-01, so the route is the only way: there is no SSH-door fallback.
 */
import type { RemoteOrg, RemoteWakeResponse, RemoteWorkspace } from '@kpa/shared/remote.types';
import {
  ConnectRefusedError,
  refusalMessage,
  WAKE_POLL_MS,
  WAKE_TIMEOUT_MS,
  wakeTimeoutMessage,
} from '../connect.js';
import { clientFor, type Ctx } from '../context.js';
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

/**
 * `hq up` (hq-vscode D13): wake through `POST …/workspaces/:ws/wake`, which is open to viewers, then
 * wait until the team reads `running`. Every refusal (a 404 included) is the plain sentence.
 */
async function wake(ctx: Ctx, team: Team, client: ReturnType<typeof clientFor>): Promise<void> {
  const base = `/api/remote/orgs/${encodeURIComponent(team.org.slug)}/workspaces/${team.workspace.id}`;
  let answer: { status: number; body: RemoteWakeResponse };
  try {
    answer = await client.request<RemoteWakeResponse>('POST', `${base}/wake`, {
      org: team.org.slug,
      signed: true,
    });
  } catch (err) {
    throw new ConnectRefusedError(refusalMessage(team, err));
  }
  if (answer.body.state === 'running') return;
  ctx.err(`hq: waking team "${team.workspace.name}" (about 15 s)...`);
  const deadline = ctx.now() + WAKE_TIMEOUT_MS;
  while (ctx.now() < deadline) {
    await ctx.sleep(WAKE_POLL_MS);
    let ws: RemoteWorkspace;
    try {
      ws = (await client.request<RemoteWorkspace>('GET', base, { org: team.org.slug })).body;
    } catch (err) {
      throw new ConnectRefusedError(refusalMessage(team, err));
    }
    if (ws.state === 'running') return;
  }
  throw new ConnectRefusedError(wakeTimeoutMessage(team));
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
