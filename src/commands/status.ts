/** `hq status` — who you are and the teams you can reach. */
import type { RemoteOrg } from '@kpa/shared/remote.types';
import { clientFor, type Ctx } from '../context.js';
import { readState, writeState } from '../state.js';
import { withTeamAliases } from '../teams.js';

export async function status(ctx: Ctx): Promise<number> {
  const state = readState(ctx.env);
  const client = clientFor(ctx, state);
  const { body: orgs } = await client.request<RemoteOrg[]>('GET', '/api/remote/orgs');
  writeState({ ...state, orgs }, ctx.env);
  ctx.out(
    `${state.user?.email ?? 'signed in'} · ${orgs.length} ${orgs.length === 1 ? 'org' : 'orgs'}`,
  );
  for (const t of withTeamAliases(orgs)) {
    const note = !t.org.remoteAccess.allowed
      ? 'remote access off'
      : !t.workspace.supported
        ? 'machine update pending'
        : t.workspace.rights.ssh
          ? 'remote access ready'
          : t.workspace.rights.attach
            ? 'attach only'
            : 'no access';
    // `off` (never started, or stopped) is not `asleep`: `hq up` wakes a sleeping machine, and only
    // a session start in HQ brings one that is off (FAIL 6).
    const state =
      t.workspace.state === 'running'
        ? 'awake'
        : t.workspace.state === 'starting'
          ? 'starting'
          : t.workspace.state === 'asleep'
            ? 'asleep'
            : 'off';
    ctx.out(
      `  ${t.alias.padEnd(12)}  ${t.org.slug}/${t.workspace.name.padEnd(18)}  ${state.padEnd(8)}  ${note}`,
    );
  }
  return 0;
}
