/** `hq ssh --config` — write `~/.ssh/hq_config` for every team this device can reach over SSH. */
import type { RemoteOrg } from '@kpa/shared/remote.types';
import os from 'node:os';
import { clientFor, type Ctx } from '../context.js';
import { ensureDeviceKey } from '../device-key.js';
import { resolveLauncher, tildify, writeSshConfig } from '../ssh-config-file.js';
import { readState, writeState } from '../state.js';
import { partitionTeams } from '../teams.js';

export async function sshConfig(ctx: Ctx): Promise<number> {
  const state = readState(ctx.env);
  const client = clientFor(ctx, state);
  const { body: orgs } = await client.request<RemoteOrg[]>('GET', '/api/remote/orgs');
  writeState({ ...state, orgs }, ctx.env);
  ensureDeviceKey(ctx.env);
  const { teams: all, skipped } = partitionTeams(orgs);
  const teams = all.filter((t) => t.org.remoteAccess.allowed && t.workspace.rights.ssh);
  const launcher = resolveLauncher(ctx.env, ctx.platform);
  for (const warning of launcher.warnings ?? []) ctx.err(warning);
  const written = writeSshConfig(teams, launcher, ctx.env);
  // Review C4: a team whose id or org slug is not in HQ's shape is never written into ssh config
  // (its ProxyCommand would run through /bin/sh). A real HQ never sends one.
  if (skipped.length > 0) {
    ctx.err(
      `hq: skipped ${skipped.length} ${skipped.length === 1 ? 'team' : 'teams'} whose id or org name is not in the expected form. Check that ${state.host} is your HQ address.`,
    );
  }
  const home = os.homedir();
  ctx.out(
    `Wrote ${tildify(written.hqConfigPath, home)} (Included from ${tildify(written.sshConfigPath, home)}), ${teams.length} ${teams.length === 1 ? 'team' : 'teams'}:`,
  );
  for (const t of teams) {
    const note = t.workspace.supported ? '' : '   (machine update pending)';
    ctx.out(`  ${t.alias.padEnd(12)}  ${t.org.name} / ${t.workspace.name}${note}`);
  }
  const off = orgs.filter((o) => !o.remoteAccess.allowed);
  for (const o of off) ctx.out(`  ${o.name}: remote access is off for this org.`);
  if (teams.length === 0) {
    ctx.out(
      'No team is reachable over SSH yet. An org owner turns it on in HQ: Settings → Security → Remote access.',
    );
    return 0;
  }
  ctx.out(
    `Connect:  ssh ${teams[0]!.alias}   or pick the host in a Remote-SSH-compatible editor (Cursor, JetBrains Gateway, Zed).`,
  );
  ctx.out(
    'Editors that ignore ConnectTimeout: set their SSH connect timeout to 180 s and the remote platform to "linux".',
  );
  ctx.out(
    'Jobs started in a plain ssh shell get SIGHUP when the connection closes (hourly at the latest); use an HQ session or a schedule for long runs.',
  );
  return 0;
}
