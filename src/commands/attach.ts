/**
 * `hq attach <session>` — a bearer client of the SAME terminal path the browser uses. The attach
 * itself (everything below) is the shared `hq-client` `AttachSession` (hq-vscode decision 4); this
 * command finds the session, owns the person's terminal (raw mode, Ctrl-]) and prints the ending.
 *
 * (`WS /ws/remote/terminal`, decision 5): owner-only typing, masking and geometry are the server's
 * rules. View-only attaches never send input. Ctrl-] detaches. The 15-minute access token is rotated
 * over the open socket with a `remote-token` frame before it expires.
 *
 * The browser's client rules, applied here too (review 2026-09-27, D7/D9/D13):
 *   - terminal QUERIES in `history`/`output` are never written to the laptop terminal
 *     (`@kpa/shared/terminal-queries`, shared with the in-container shim), so the laptop never answers one into the agent as keystrokes;
 *   - a `presence` frame every 60 s while attached, so a view-only watcher keeps the machine awake;
 *   - the wake codes are progress (print the server's sentence, re-attach with intent `reconnect`),
 *     with "Still on it..." past 20 s and a bounded wait (`WAKE_TIMEOUT_MS`, the other doors' budget);
 *   - a `history_unavailable` notice is not printed during a wake (DEF-140: a FROZEN screen was not
 *     lost), nor right after a repaint or a reset (a sibling attach's read, not a lost screen);
 *   - after "Press any key to continue." (`workspace_asleep`, DEF-110) the next key re-attaches with
 *     intent `open` first, the one gesture that wakes the machine, for a view-only watcher too;
 *   - a dropped socket (1006, or 1001 from a draining replica / the hourly LB cut) reconnects with
 *     backoff and a freshly signed upgrade, re-attaching with intent `reconnect`.
 *
 * FAIL 4 (nonprod 2026-09-28): ONCE A WAKE IS OVER, THE PERSON'S ATTACH IS SAID AGAIN, AS `open`.
 * A machine that idle-slept drops the api tier's relay socket, and every session it served is left
 * `reconnecting` there; only an attach by someone who may write re-attaches one (DEF-147's
 * `reattachNow`, under the attaching person's principal). Since DEF-212 kr-api lets a writer's
 * `reconnect` poll do that too, so the first poll after the resume already brings live output. The
 * `open` below stays as the backstop (a server without DEF-212, or a round that backed off): the
 * machine is awake by then, so it wakes nothing and names nobody in a wake row; it only restates
 * who is watching, and costs one repaint.
 *
 * INSTANT LOCAL ECHO (feature `local-echo`, Decisions 12-19): with `--local-echo` / `HQ_LOCAL_ECHO`,
 * AND the org and environment allowing it (`session.localEchoAvailable`), AND a person who may type
 * at a real terminal (raw stdin, TTY stdout), keystrokes are predicted by the SAME engine the browser
 * runs and drawn with ANSI bytes (`../local-echo/`). Output then goes through that session's ordered
 * queue instead of straight to stdout. Everything else — and every attach without the flag — is
 * byte-for-byte what it was.
 *
 * ⛔ "BACK" IS ONE SIGNAL ONLY: an `attached` whose answer carried NO wake code and NO asleep notice
 *    (review 2026-09-28). Bytes are not it: a SUSPENDING machine still has its relay socket, so it
 *    answers the wake code AND a readable screen, and ending the wake on those bytes re-sent `open`
 *    at network speed for the whole suspend. An answer that says "asleep, nobody waking it" (the
 *    wake was refused or failed) ends the wake QUIETLY: no `open` (that would wake the machine with
 *    no key pressed, DEF-110, and loop forever against a paused team); the next KEY sends it.
 */
import type { RemoteOrg, RemoteSessionSummary } from '@kpa/shared/remote.types';
import type { Readable, Writable } from 'node:stream';
import {
  createAttachSession,
  MAX_RECONNECTS,
  PRESENCE_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RTT_PING_MS,
  TOKEN_CHECK_MS,
  WAKE_RETRY_MAX_MS,
  WAKE_RETRY_MS,
  WAKE_STILL_ON_IT_MS,
} from '@hq/client/attach-session.js';
import type { LocalEchoMode } from '@kpa/shared/local-echo-engine';
import type { HqClient } from '../api.js';
import { clientFor, type Ctx } from '../context.js';
import { readState, writeState } from '../state.js';
import { withTeamAliases, type Team } from '../teams.js';
import { LocalEchoSession } from '../local-echo/engine-adapter.js';
import { upgradeRefusalMessage, type WsFactory } from '../tunnel-client.js';

export {
  MAX_RECONNECTS,
  PRESENCE_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RTT_PING_MS,
  TOKEN_CHECK_MS,
  WAKE_RETRY_MAX_MS,
  WAKE_RETRY_MS,
  WAKE_STILL_ON_IT_MS,
};

export const DETACH_BYTE = 0x1d; // Ctrl-]
/** Printed once when local echo was asked for but the org or the environment does not allow it. */
export const LOCAL_ECHO_UNAVAILABLE = 'hq: local echo is not available on this HQ yet.';

export interface Found {
  team: Team;
  session: RemoteSessionSummary;
}

/** Find a session by id prefix or exact name across every team the device may attach to. */
export async function findSession(
  client: HqClient,
  orgs: RemoteOrg[],
  ref: string,
  org?: string,
  teamRef?: string,
): Promise<Found[]> {
  const needle = ref.trim().toLowerCase();
  const teams = withTeamAliases(orgs).filter(
    (t) =>
      t.org.remoteAccess.allowed &&
      t.workspace.rights.attach &&
      (!org || t.org.slug === org) &&
      (!teamRef || t.alias === teamRef || t.workspace.name.toLowerCase() === teamRef.toLowerCase()),
  );
  const hits: Found[] = [];
  for (const team of teams) {
    let sessions: RemoteSessionSummary[] = [];
    try {
      sessions = (
        await client.request<RemoteSessionSummary[]>(
          'GET',
          `/api/remote/orgs/${encodeURIComponent(team.org.slug)}/workspaces/${team.workspace.id}/sessions`,
          { org: team.org.slug },
        )
      ).body;
    } catch {
      continue; // a team whose machine cannot answer is skipped, not fatal
    }
    for (const s of sessions) {
      if (s.id.toLowerCase().startsWith(needle) || s.name.toLowerCase() === needle)
        hits.push({ team, session: s });
    }
  }
  return hits;
}

export interface AttachIo {
  stdin: Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };
  stdout: Writable & {
    columns?: number;
    rows?: number;
    /** Local echo draws only into a real terminal: a pipe or a file never sees an escape it did not before. */
    isTTY?: boolean;
    on(event: 'resize', fn: () => void): unknown;
    off?(event: 'resize', fn: () => void): unknown;
  };
  wsFactory?: WsFactory;
  /** Test seams (production uses the constants above). */
  presenceIntervalMs?: number;
  wakeRetryMs?: number;
  wakeStillMs?: number;
  wakeTimeoutMs?: number;
  reconnectBaseMs?: number;
}

export async function attach(
  ctx: Ctx,
  opts: { session: string; org?: string; team?: string; localEcho?: LocalEchoMode },
  io: AttachIo,
): Promise<number> {
  const state = readState(ctx.env);
  const client = clientFor(ctx, state);
  const { body: orgs } = await client.request<RemoteOrg[]>('GET', '/api/remote/orgs');
  writeState({ ...state, orgs }, ctx.env);
  const hits = await findSession(client, orgs, opts.session, opts.org, opts.team);
  if (hits.length === 0) {
    ctx.err(
      `hq: no session "${opts.session}" you can open. Sessions are listed in HQ on the team page.`,
    );
    return 1;
  }
  if (hits.length > 1) {
    ctx.err(`hq: "${opts.session}" matches ${hits.length} sessions. Use more of the id:`);
    for (const h of hits)
      ctx.err(`  ${h.session.id.slice(0, 8)}  ${h.team.workspace.name} / ${h.session.name}`);
    return 1;
  }
  const { team, session } = hits[0]!;
  const raw = io.stdin.isTTY === true && typeof io.stdin.setRawMode === 'function';
  let rawOn = false;
  // local-echo: asked for, AND allowed by the org and the environment (Decision 18: an older HQ
  // omits the field, which reads as not allowed), AND someone who may type at a real terminal.
  let echo: LocalEchoSession | null = null;
  if ((opts.localEcho ?? 'off') !== 'off') {
    if (session.localEchoAvailable !== true) ctx.err(LOCAL_ECHO_UNAVAILABLE);
    else if (session.canType && raw && io.stdout.isTTY === true) {
      echo = await LocalEchoSession.create({
        mode: opts.localEcho!,
        write: (bytes) => io.stdout.write(bytes),
        cols: io.stdout.columns ?? 80,
        rows: io.stdout.rows ?? 24,
      });
    }
  }

  const attachSession = createAttachSession(
    client,
    { team, session },
    {
      write: (bytes) => {
        io.stdout.write(bytes);
      },
      say: (line) => ctx.err(line),
      size: () => ({ cols: io.stdout.columns ?? 80, rows: io.stdout.rows ?? 24 }),
      onInput: (fn) => {
        io.stdin.on('data', fn);
        io.stdin.resume();
        return () => {
          io.stdin.off('data', fn);
          io.stdin.pause();
        };
      },
      onResize: (fn) => {
        io.stdout.on('resize', fn);
        return () => {
          io.stdout.off?.('resize', fn);
        };
      },
    },
    {
      echo,
      detachByte: DETACH_BYTE,
      onFirstOpen: () => {
        ctx.err(
          `Attached to "${session.name}" (${session.ownerName}) · ${session.canType ? 'you can type' : 'view only'} · Ctrl-] to detach`,
        );
        if (raw) {
          io.stdin.setRawMode!(true);
          rawOn = true;
        }
      },
      ...(io.wsFactory ? { wsFactory: io.wsFactory } : {}),
      ...(io.presenceIntervalMs !== undefined ? { presenceIntervalMs: io.presenceIntervalMs } : {}),
      ...(io.wakeRetryMs !== undefined ? { wakeRetryMs: io.wakeRetryMs } : {}),
      ...(io.wakeStillMs !== undefined ? { wakeStillMs: io.wakeStillMs } : {}),
      ...(io.wakeTimeoutMs !== undefined ? { wakeTimeoutMs: io.wakeTimeoutMs } : {}),
      ...(io.reconnectBaseMs !== undefined ? { reconnectBaseMs: io.reconnectBaseMs } : {}),
    },
  );

  try {
    const end = await attachSession.run();
    if (end.kind === 'refused') {
      ctx.err(end.status === 0 ? 'hq: could not reach HQ.' : upgradeRefusalMessage(end.status));
      return 1;
    }
    if (end.kind === 'lost') {
      ctx.err('\r\nhq: the connection to HQ was lost.');
      return 1;
    }
    if (end.message) ctx.err(end.message);
    return end.exitCode;
  } finally {
    // local-echo: whatever is drawn comes off and SGR is reset before the terminal is handed back.
    echo?.close();
    io.stdin.pause();
    if (rawOn) io.stdin.setRawMode!(false);
  }
}
