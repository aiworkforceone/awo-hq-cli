/**
 * `hq ssh-proxy --workspace <uuid> --org <slug> [--wake]` — the ProxyCommand. stdout is SSH bytes
 * and nothing else; every message goes to stderr. Exit 0 on a normal close, 255 on any refusal (what
 * ssh itself uses, so editors report "could not connect" rather than a remote exit status).
 */
import type { RemoteOrg } from '@kpa/shared/remote.types';
import { workspaceAlias } from '@kpa/shared/remote.types';
import type { Readable, Writable } from 'node:stream';
import { ConnectRefusedError, openConnection } from '../connect.js';
import { clientFor, type Ctx } from '../context.js';
import { pinHostKey } from '../ssh-config-file.js';
import { readState } from '../state.js';
import { withTeamAliases, type Team } from '../teams.js';
import {
  closeMessage,
  openTunnelSocket,
  pipeTunnel,
  TunnelRefusedError,
  type WsFactory,
} from '../tunnel-client.js';
import { NotLoggedInError } from '../api.js';

export const EXIT_REFUSED = 255;

export interface ProxyIo {
  stdin: Readable;
  stdout: Writable;
  wsFactory?: WsFactory;
}

/** The team from the cache (for its name and alias), or a minimal stand-in built from the args. */
function teamFor(orgs: RemoteOrg[] | undefined, workspaceId: string, org: string): Team {
  const hit = withTeamAliases(orgs ?? []).find(
    (t) => t.workspace.id === workspaceId && t.org.slug === org,
  );
  if (hit) return hit;
  const alias = workspaceAlias(workspaceId);
  return {
    alias,
    org: {
      id: '',
      slug: org,
      name: org,
      role: 'member',
      remoteAccess: { allowed: true },
      workspaces: [],
    },
    workspace: {
      id: workspaceId,
      alias,
      name: alias,
      state: 'stopped',
      rights: { ssh: true, forward: false, attach: false },
      supported: true,
    },
  };
}

export async function sshProxy(
  ctx: Ctx,
  opts: { workspace: string; org: string; wake: boolean },
  io: ProxyIo,
): Promise<number> {
  const say = ctx.err;
  const state = readState(ctx.env);
  const team = teamFor(state.orgs, opts.workspace, opts.org);
  const client = clientFor(ctx, state);
  try {
    // Refresh BEFORE dialing: a ProxyCommand may start with a token minutes from expiry.
    await client.ensureFresh();
    const ready = await openConnection(
      client,
      team,
      { scope: 'ssh', client: 'ssh', intent: 'open', ...(opts.wake ? { wake: true } : {}) },
      { now: ctx.now, sleep: ctx.sleep, say },
    );
    if (ready.hostKey) await pinHostKey(team.alias, ready.hostKey, ctx.env);
    const ws = await openTunnelSocket(client, team.org.slug, ready.connectCode, io.wsFactory);
    say('hq: connected');
    const code = await pipeTunnel(ws, io.stdin, io.stdout);
    const msg = closeMessage(code);
    if (msg) {
      say(msg);
      return EXIT_REFUSED;
    }
    return 0;
  } catch (err) {
    if (
      err instanceof ConnectRefusedError ||
      err instanceof TunnelRefusedError ||
      err instanceof NotLoggedInError
    ) {
      say(err.message);
    } else {
      say(`hq: ${(err as Error).message}`);
    }
    return EXIT_REFUSED;
  }
}
