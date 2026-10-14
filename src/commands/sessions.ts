/**
 * cli-session-lifecycle: `hq sessions`, `hq start`, `hq stop` and `hq restart`.
 *
 * The calls are the shared client's (`hq-client`: `listSessions`, `startSession`, `stopSession`,
 * `restartSession`), the bearer twins of the web's session lifecycle routes, so the session limit,
 * the pause and update checks and the audit rows are HQ's own. A session is named by an id prefix or
 * its exact name, resolved exactly as `hq attach` resolves it (`findSession`).
 *
 *   - Before a Stop or a Restart of a session whose agent is mid-answer (`midTurn`), the person is
 *     asked at the terminal; with no terminal the command refuses and names `--yes`.
 *   - A member HQ says may not operate the session (`canOperate === false`) is refused here with the
 *     web's sentence and nothing is sent; the route refuses on its own anyway.
 *   - "Already running" (start, restart) and "already stopped" (stop) are exit 0: nothing to do.
 *     A session the listing shows still starting says "already starting", never running (train 98).
 *   - `--json` prints ONE JSON document on stdout on success; refusals stay plain text on stderr.
 *     `name` is the cleaned display name; `rawName` is HQ's exact value (train 96 e2e), printed
 *     through `scriptSafeJson` so the line itself never carries a control character.
 */
import type {
  RemoteOrg,
  RemoteSessionAction,
  RemoteSessionActionResponse,
  RemoteSessionSummary,
} from '@kpa/shared/remote.types';
import {
  describeSessionRefusal,
  SESSION_NOT_OPERATOR_MESSAGE,
} from '@hq/client/session-actions.js';
import { clientFor, type Ctx } from '../context.js';
import { readState, writeState } from '../state.js';
import { withTeamAliases, type Team } from '../teams.js';
import { findSession } from './attach.js';
import { cleanSessionSummary, oneLine, scriptSafeJson } from '../safe-text.js';
import { copy } from '@kpa/shared/active-dev-brand';

export interface SessionsOptions {
  org?: string;
  team?: string;
  json?: boolean;
}

export interface SessionActionOptions extends SessionsOptions {
  session: string;
  yes?: boolean;
}

function teamJson(team: Team): { id: string; alias: string; name: string; org: string } {
  return {
    id: team.workspace.id,
    alias: team.alias,
    name: team.workspace.name,
    org: team.org.slug,
  };
}

function ownerLabel(s: RemoteSessionSummary): string {
  return s.ownerIsMe === true ? 'you' : s.ownerName;
}

function mayLabel(s: RemoteSessionSummary): string {
  if (s.canOperate === true) return 'can operate';
  if (s.canOperate === false) return 'view only';
  return '';
}

/**
 * train 98 e2e: the state `hq` shows. HQ lists a session it is still starting as `running` (what
 * every older client expects) with `starting: true` beside it; that session may yet fail to come
 * up, so `hq` says starting.
 */
function shownState(s: RemoteSessionSummary): RemoteSessionSummary['status'] | 'starting' {
  return s.starting === true ? 'starting' : s.status;
}

function agentName(s: RemoteSessionSummary): string {
  return s.engine === 'codex' ? 'Codex' : 'Claude';
}

async function loadOrgs(
  ctx: Ctx,
): Promise<{ orgs: RemoteOrg[]; client: ReturnType<typeof clientFor> }> {
  const state = readState(ctx.env);
  const client = clientFor(ctx, state);
  const { body: orgs } = await client.request<RemoteOrg[]>('GET', '/api/remote/orgs');
  writeState({ ...state, orgs }, ctx.env);
  return { orgs, client };
}

/** `hq sessions [--team <t>] [--org <slug>] [--json]`. */
export async function sessions(ctx: Ctx, opts: SessionsOptions = {}): Promise<number> {
  const { orgs, client } = await loadOrgs(ctx);
  const needle = opts.team?.trim().toLowerCase();
  const teams = withTeamAliases(orgs).filter(
    (t) =>
      t.org.remoteAccess.allowed &&
      t.workspace.rights.attach &&
      (!opts.org || t.org.slug === opts.org) &&
      (!needle || t.alias === needle || t.workspace.name.toLowerCase() === needle),
  );
  const rows: Array<{ team: Team; session: RemoteSessionSummary; rawName: string }> = [];
  let listedTeams = 0;
  for (const team of teams) {
    let list: RemoteSessionSummary[];
    try {
      list = await client.listSessions(team);
    } catch {
      ctx.err(copy`hq: could not list the sessions of team "${team.workspace.name}".`);
      continue;
    }
    listedTeams += 1;
    // Security L1: every server string on one clean line before anything prints it. The raw name
    // is kept beside it for `--json` `rawName` only.
    for (const raw of list) {
      rows.push({ team, session: cleanSessionSummary(raw), rawName: String(raw.name ?? '') });
    }
  }
  if (opts.json) {
    ctx.out(
      scriptSafeJson(
        rows.map(({ team, session, rawName }) => ({
          id: session.id,
          name: session.name,
          rawName,
          team: teamJson(team),
          state: shownState(session),
          owner: session.ownerName,
          ownerIsMe: session.ownerIsMe === true,
          canOperate: session.canOperate ?? null,
          canType: session.canType,
          midTurn: session.midTurn === true,
          engine: session.engine ?? 'claude',
        })),
      ),
    );
    return 0;
  }
  if (rows.length === 0) {
    ctx.out(copy`No sessions in your teams yet. Sessions are created in HQ.`);
    return 0;
  }
  ctx.out(
    `${rows.length} ${rows.length === 1 ? 'session' : 'sessions'} in ${listedTeams} ${listedTeams === 1 ? 'team' : 'teams'}`,
  );
  for (const { team, session } of rows) {
    ctx.out(
      `  ${session.id.slice(0, 8)}  ${session.name.padEnd(18)}  ${team.workspace.name.padEnd(18)}  ${shownState(session).padEnd(8)}  ${ownerLabel(session).padEnd(14)}  ${mayLabel(session)}`.trimEnd(),
    );
  }
  return 0;
}

const DONE: Record<RemoteSessionAction, 'started' | 'stopped' | 'restarted'> = {
  start: 'started',
  stop: 'stopped',
  restart: 'restarted',
};

/** `hq start|stop|restart <session> [--team <t>] [--org <slug>] [--yes] [--json]`. */
export async function sessionAction(
  ctx: Ctx,
  action: RemoteSessionAction,
  opts: SessionActionOptions,
): Promise<number> {
  const { orgs, client } = await loadOrgs(ctx);
  const hits = await findSession(client, orgs, opts.session, opts.org, opts.team);
  if (hits.length === 0) {
    ctx.err(copy`hq: no session "${opts.session}" you can see. Run hq sessions to list them.`);
    return 1;
  }
  if (hits.length > 1) {
    ctx.err(copy`hq: "${opts.session}" matches ${hits.length} sessions. Use more of the id:`);
    for (const h of hits)
      ctx.err(`  ${h.session.id.slice(0, 8)}  ${h.team.workspace.name} / ${h.session.name}`);
    return 1;
  }
  const { team, session, rawName } = hits[0]!;
  if (session.canOperate === false) {
    ctx.err(copy`hq: ${SESSION_NOT_OPERATOR_MESSAGE}`);
    return 1;
  }
  if (action !== 'start' && session.midTurn === true && opts.yes !== true) {
    const verb = action === 'stop' ? 'stop' : 'restart';
    const busy = `${agentName(session)} is answering in "${session.name}" right now.`;
    if (!ctx.ask) {
      ctx.err(copy`hq: ${busy} Run the command again with --yes to ${verb} it anyway.`);
      return 1;
    }
    const verbCap = verb === 'stop' ? 'Stop' : 'Restart';
    const reply = await ctx.ask(`${busy} ${verbCap} it anyway? [y/N] `);
    if (!/^\s*y(es)?\s*$/i.test(reply)) {
      ctx.err(copy`hq: not ${action === 'stop' ? 'stopped' : 'restarted'}.`);
      return 1;
    }
  }
  // `asleep` and `stopped` are different machines (`hq status` says sleeping / off): a start wakes
  // the first and starts the second, exactly as pressing Start in HQ does. `starting` needs no word.
  if (action === 'start' && team.workspace.state === 'asleep') {
    ctx.err(copy`hq: team "${team.workspace.name}" is sleeping. Starting the session wakes it.`);
  } else if (action === 'start' && team.workspace.state === 'stopped') {
    ctx.err(
      copy`hq: team "${team.workspace.name}" has no running Cloud Computer. Starting the session starts it.`,
    );
  }

  let answer: RemoteSessionActionResponse;
  try {
    answer =
      action === 'start'
        ? await client.startSession(team, session.id)
        : action === 'stop'
          ? await client.stopSession(team, session.id)
          : await client.restartSession(team, session.id);
  } catch (err) {
    const refusal = describeSessionRefusal(err, action, {
      session: session.name,
      team: team.workspace.name,
    });
    // Security L1: an `other` refusal is HQ's own sentence: cleaned like any server string.
    refusal.message = oneLine(refusal.message);
    if (refusal.kind === 'already') {
      // train 98 e2e: HQ answers ALREADY_RUNNING for a session that is still STARTING too (its slot
      // is held in both states). Saying "running" then is a claim nobody has checked: the start may
      // still fail. Starting when the listing we just read says so, or still said stopped (a start
      // from elsewhere landed in between); running only when it listed the session running.
      const stillStarting =
        action !== 'stop' && (session.starting === true || session.status === 'stopped');
      const short = session.id.slice(0, 8);
      if (opts.json) {
        ctx.out(
          scriptSafeJson({
            id: session.id,
            name: session.name,
            rawName,
            team: teamJson(team),
            action,
            result:
              action === 'stop'
                ? 'already_stopped'
                : stillStarting
                  ? 'already_starting'
                  : 'already_running',
            status: action === 'stop' ? 'stopped' : stillStarting ? 'starting' : 'running',
          }),
        );
      } else if (stillStarting) {
        ctx.out(
          copy`Session "${session.name}" is already starting. Follow it with hq attach ${short}.`,
        );
      } else ctx.out(refusal.message);
      return 0;
    }
    ctx.err(copy`hq: ${refusal.message}`);
    return 1;
  }

  if (opts.json) {
    ctx.out(
      scriptSafeJson({
        id: session.id,
        name: session.name,
        rawName,
        team: teamJson(team),
        action,
        result: DONE[action],
        status: answer.status,
      }),
    );
    return 0;
  }
  const short = session.id.slice(0, 8);
  if (action === 'start') {
    ctx.out(
      copy`Starting session "${session.name}" on team "${team.workspace.name}". Follow it with hq attach ${short}.`,
    );
  } else if (action === 'stop') {
    ctx.out(`Stopped session "${session.name}".`);
  } else {
    ctx.out(copy`Restarting session "${session.name}". Follow it with hq attach ${short}.`);
  }
  return 0;
}
