/** `hq status` — who you are and the teams you can reach. */
import type { RemoteAccessDeniedReason, RemoteOrg } from '@kpa/shared/remote.types';
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
    // Ticket (v): the label follows what the server said. A refusal names its reason, and a team
    // with no running machine is never "ready" (a connect cannot start one; a session in HQ does).
    const note = !t.org.remoteAccess.allowed
      ? `remote access off: ${deniedReasonText(t.org.remoteAccess.reason)}`
      : !t.workspace.supported
        ? 'machine update pending'
        : !t.workspace.rights.forward && !t.workspace.rights.attach
          ? 'no access'
          : t.workspace.state === 'stopped'
            ? 'no running machine, start a session in HQ first'
            : t.workspace.rights.forward
              ? 'remote access ready'
              : 'attach only';
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

/** The closed wire vocabulary, in plain words. Unknown (a newer server) reads as the generic one. */
function deniedReasonText(reason: RemoteAccessDeniedReason | undefined): string {
  switch (reason) {
    case 'two_factor_required':
      return 'two-step verification needed (run hq login again)';
    case 'plan_inactive':
      return 'the plan is not active';
    case 'feature_not_in_plan':
      return 'not included in this plan';
    case 'staged_rollout':
      return 'not available to this org yet';
    case 'advanced_terminal_off':
      return 'the advanced terminal is off for this org';
    default:
      return 'turned off for this org';
  }
}
