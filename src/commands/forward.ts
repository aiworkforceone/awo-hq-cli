/**
 * `hq forward <port> [--local <port>]` — one connection row for the whole invocation (S1), one
 * tunnel upgrade per accepted local TCP connection, each with its own one-time code and signature.
 * A 30 s heartbeat keeps the row from the stale sweep; Ctrl-C closes it. The forward itself is the
 * shared `hq-client` one (hq-vscode decision 4); this file is the command around it.
 */
import type { RemoteOrg } from '@kpa/shared/remote.types';
import {
  parsePort,
  startForward as startSharedForward,
  type ForwardHandle,
} from '@hq/client/forward.js';
import { ConnectRefusedError } from '../connect.js';
import type { HqClient } from '../api.js';
import { clientFor, type Ctx } from '../context.js';
import { readState, writeState } from '../state.js';
import { withTeamAliases, type Team } from '../teams.js';
import type { WsFactory } from '../tunnel-client.js';
import { loadTeam } from './up.js';

export { HEARTBEAT_MS, parsePort, type ForwardHandle } from '@hq/client/forward.js';

/** The CLI's call shape: the shared forward with the CLI's own messages, `client: 'hq'`. */
export function startForward(
  ctx: Ctx,
  client: HqClient,
  team: Team,
  remotePort: number,
  localPort: number,
  wsFactory?: WsFactory,
): Promise<ForwardHandle> {
  return startSharedForward(
    { now: ctx.now, sleep: ctx.sleep, say: ctx.err },
    client,
    team,
    remotePort,
    localPort,
    { clientKind: 'hq', ...(wsFactory ? { wsFactory } : {}) },
  );
}

export async function forward(
  ctx: Ctx,
  opts: { port: string; local?: string; team?: string; org?: string },
): Promise<number> {
  const remotePort = parsePort(opts.port, 1024);
  if (remotePort === null) {
    ctx.err('hq: the team port must be a number from 1024 to 65535.');
    return 2;
  }
  const localPort = opts.local === undefined ? remotePort : parsePort(opts.local, 1);
  if (localPort === null) {
    ctx.err('hq: --local must be a port number.');
    return 2;
  }
  try {
    const teamRef = opts.team ?? '';
    const { team, client } = await loadTeamForForward(ctx, teamRef, opts.org);
    const handle = await startForward(ctx, client, team, remotePort, localPort);
    ctx.out(
      `Forwarding http://localhost:${handle.port} -> ${team.workspace.name} :${remotePort}   (Ctrl-C to stop)`,
    );
    process.once('SIGINT', () => void handle.close());
    process.once('SIGTERM', () => void handle.close());
    return await handle.done;
  } catch (err) {
    ctx.err(err instanceof ConnectRefusedError ? err.message : (err as Error).message);
    return 1;
  }
}

/** `--team` is optional when exactly one team allows forwarding. */
async function loadTeamForForward(
  ctx: Ctx,
  ref: string,
  org?: string,
): Promise<{ team: Team; client: HqClient }> {
  if (ref) return loadTeam(ctx, ref, org);
  const state = readState(ctx.env);
  const client = clientFor(ctx, state);
  const { body: orgs } = await client.request<RemoteOrg[]>('GET', '/api/remote/orgs');
  writeState({ ...state, orgs }, ctx.env);
  const candidates = withTeamAliases(orgs).filter(
    (t) => t.org.remoteAccess.allowed && t.workspace.rights.forward && (!org || t.org.slug === org),
  );
  if (candidates.length === 1) return { team: candidates[0]!, client };
  throw new Error(
    candidates.length === 0
      ? 'hq: no team lets you forward ports. Run hq status to see your teams.'
      : 'hq: more than one team can forward ports. Name one with --team <hq-name>.',
  );
}
