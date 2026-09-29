/**
 * `hq attach <session>` — a bearer client of the SAME terminal path the browser uses
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
import WebSocket from 'ws';
import type { Readable, Writable } from 'node:stream';
import type { HqClient } from '../api.js';
import { clientFor, type Ctx } from '../context.js';
import { readState, writeState } from '../state.js';
import { withTeamAliases, type Team } from '../teams.js';
import { createTerminalQueryFilter } from '@kpa/shared/terminal-queries';
import type { LocalEchoMode } from '@kpa/shared/local-echo-engine';
import { LocalEchoSession } from '../local-echo/engine-adapter.js';
import { WAKE_TIMEOUT_MS, wakeTimeoutMessage } from '../connect.js';
import {
  REMOTE_TERMINAL_WS_PATH,
  upgradeRefusalMessage,
  wsUrl,
  type WsFactory,
} from '../tunnel-client.js';

export const DETACH_BYTE = 0x1d; // Ctrl-]
export const TOKEN_CHECK_MS = 60_000;
/** The browser's presence heartbeat (runner-idle-sleep D13): "still here", once a minute. */
export const PRESENCE_MS = 60_000;
/** The browser's wake re-attach cadence: 2 s, then 4 s. */
export const WAKE_RETRY_MS = 2_000;
export const WAKE_RETRY_MAX_MS = 4_000;
/** The browser's "Still on it..." under a wake that runs past this (WakingPill). Not for a cold restart. */
export const WAKE_STILL_ON_IT_MS = 20_000;
/**
 * How long after a repaint (or a `reset`) a `history_unavailable` notice is a sibling attach's
 * failed read, not a lost screen: the browser's 8 s (DEF-23, the after-repaint grace).
 */
const HISTORY_NOTICE_GRACE_MS = 8_000;
const HISTORY_UNAVAILABLE_NOTICE = 'history_unavailable';
const WORKSPACE_ASLEEP_NOTICE = 'workspace_asleep';
/** Reconnect backoff after a dropped socket: 1 s doubling to 10 s, at most 8 attempts in a row. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 10_000;
export const MAX_RECONNECTS = 8;

/**
 * local-echo RTT (Decision 15): WebSocket PROTOCOL pings, answered by the `ws` library at the other
 * end, so no server change and no JSON frame. One at once, a short burst, then this cadence.
 */
export const RTT_PING_MS = 30_000;
const RTT_BURST_MS = [500, 1_000, 1_500];
/** Printed once when local echo was asked for but the org or the environment does not allow it. */
export const LOCAL_ECHO_UNAVAILABLE = 'hq: local echo is not available on this HQ yet.';

/** The RETRYABLE codes the server sends while a machine starts or wakes (never a failure). */
const WAKE_CODES = new Set([
  'SESSION_STARTING',
  'SESSION_RESUMING',
  'SESSION_RESUME_RETRYING',
  'SESSION_RESUME_COLD_RESTART',
]);

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

/**
 * The wake, held across sockets: a drop mid-wake neither restarts its clock nor repeats its lines.
 * `since` is null while no wake is in flight.
 */
interface WakeState {
  since: number | null;
  /** The server's sentence last printed (printed again only when it changes). */
  said: string | null;
  cold: boolean;
  stillSaid: boolean;
  /** A `workspace_asleep` notice is showing: the next key re-attaches with intent `open`. */
  asleep: boolean;
}

type ServerFrame =
  | { type: 'output' | 'history'; sessionId: string; data: string }
  | { type: 'reset'; sessionId: string }
  | { type: 'status'; sessionId: string; status?: string }
  | { type: 'error'; sessionId: string | null; message: string; code: string }
  | { type: 'notice'; sessionId: string; text: string; code?: string }
  | { type: string; sessionId?: string };

/** How one socket ended. `dropped` is a transport loss worth a reconnect. */
type SocketEnd = { kind: 'dropped' } | { kind: 'ended'; exitCode: number; message: string | null };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  const make: WsFactory = io.wsFactory ?? ((url, h) => new WebSocket(url, { headers: h }));
  const raw = io.stdin.isTTY === true && typeof io.stdin.setRawMode === 'function';
  const reconnectBase = io.reconnectBaseMs ?? RECONNECT_BASE_MS;
  let rawOn = false;
  let announced = false;
  let intent: 'open' | 'reconnect' = 'open';
  let reconnects = 0;
  const wake: WakeState = { since: null, said: null, cold: false, stillSaid: false, asleep: false };
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

  try {
    for (;;) {
      // A FRESH signed upgrade every time: a nonce is single-use and the token may have rotated.
      const headers = await client.upgradeHeaders(REMOTE_TERMINAL_WS_PATH, team.org.slug);
      const ws = make(wsUrl(client.host, REMOTE_TERMINAL_WS_PATH), headers);
      const opened = await new Promise<number | null>((resolve) => {
        ws.once('open', () => resolve(null));
        ws.once('unexpected-response', (_req, res) => {
          const status = res.statusCode ?? 0;
          res.resume();
          ws.terminate();
          resolve(status);
        });
        ws.once('error', () => resolve(0));
      });
      if (opened !== null) {
        // A reconnect that meets a restarting HQ (or no network yet) keeps trying, bounded.
        if (
          intent === 'reconnect' &&
          (opened === 0 || opened === 503) &&
          reconnects < MAX_RECONNECTS
        ) {
          await sleep(Math.min(RECONNECT_MAX_MS, reconnectBase * 2 ** reconnects));
          reconnects += 1;
          continue;
        }
        ctx.err(opened === 0 ? 'hq: could not reach HQ.' : upgradeRefusalMessage(opened));
        return 1;
      }
      if (!announced) {
        announced = true;
        ctx.err(
          `Attached to "${session.name}" (${session.ownerName}) · ${session.canType ? 'you can type' : 'view only'} · Ctrl-] to detach`,
        );
        if (raw) {
          io.stdin.setRawMode!(true);
          rawOn = true;
        }
      }
      const end = await runSocket(
        ctx,
        client,
        io,
        ws,
        {
          team,
          session,
          wake,
          echo,
          // Review N5: the budget is MAX_RECONNECTS drops IN A ROW. An admitted attach ends the row,
          // so a day of hourly LB cuts never adds up to a give-up.
          onAdmitted: () => {
            reconnects = 0;
          },
        },
        intent,
        headers,
      );
      if (end.kind === 'dropped' && reconnects < MAX_RECONNECTS) {
        ctx.err('\r\nhq: connection lost, reconnecting...');
        await sleep(Math.min(RECONNECT_MAX_MS, reconnectBase * 2 ** reconnects));
        reconnects += 1;
        intent = 'reconnect';
        continue;
      }
      if (end.kind === 'dropped') {
        ctx.err('\r\nhq: the connection to HQ was lost.');
        return 1;
      }
      if (end.message) ctx.err(end.message);
      return end.exitCode;
    }
  } finally {
    // local-echo: whatever is drawn comes off and SGR is reset before the terminal is handed back.
    echo?.close();
    io.stdin.pause();
    if (rawOn) io.stdin.setRawMode!(false);
  }
}

/** One socket's life: attach, pipe, heartbeat, until it closes. */
function runSocket(
  ctx: Ctx,
  client: HqClient,
  io: AttachIo,
  ws: WebSocket,
  target: {
    team: Team;
    session: RemoteSessionSummary;
    wake: WakeState;
    /** local-echo, when on for this attach (it outlives a reconnect, like `wake`). */
    echo: LocalEchoSession | null;
    onAdmitted: () => void;
  },
  intent: 'open' | 'reconnect',
  headers: Record<string, string>,
): Promise<SocketEnd> {
  const { team, session, wake, echo, onAdmitted } = target;
  // A reconnect / re-attach is a lifecycle reset (Decision 19): nothing predicted survives it.
  echo?.lifecycleReset();
  /** stderr shares the person's terminal: take any drawn prediction off it first. */
  const say = (line: string): void => {
    echo?.undrawNow();
    ctx.err(line);
  };
  let lastToken = (headers.Authorization ?? '').slice('Bearer '.length);
  const send = (frame: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const size = () => ({ cols: io.stdout.columns ?? 80, rows: io.stdout.rows ?? 24 });
  // What the answer to the attach we sent said, read when its `attached` (always last) lands: a wake
  // code (still waking), the asleep notice (nobody waking it), or neither (the machine is back).
  //
  // ⛔ ONE ATTACH OUTSTANDING, so those flags always belong to the answer being read (review W1). The
  //    next wake poll is armed from the `attached`, never from the wake code that precedes it: a
  //    slow screen read (a relay socket that died unseen, the probe plus the serialize) held that
  //    `attached` past the 2 s poll, the poll reset the flags, and the OLD answer then read as "back",
  //    re-sending `open`, reprinting "Waking" and restarting the budget. The server folds an attach
  //    that arrives mid-run anyway, so a second one bought nothing.
  let answerWaking = false;
  let answerAsleep = false;
  let attachOutstanding = false;
  const attachFrame = (i: 'open' | 'reconnect') => {
    answerWaking = false;
    answerAsleep = false;
    attachOutstanding = true;
    send({ type: 'attach', sessionId: session.id, ...size(), intent: i });
  };
  attachFrame(intent);
  const filter = createTerminalQueryFilter();

  return new Promise<SocketEnd>((resolve) => {
    let exitCode = 0;
    let errorMessage: string | null = null;
    let userDetached = false;
    let wakeTimer: NodeJS.Timeout | null = null;
    let wakeAttempts = 0;
    let stillTimer: NodeJS.Timeout | null = null;
    let giveUpTimer: NodeJS.Timeout | null = null;
    // When the screen was last repainted (a `history`) or wiped (a `reset`), for the notice grace.
    let repaintedAt = 0;

    // The wake cadence: 2 s, then 4 s (the browser's), one poll pending at most.
    const schedulePoll = () => {
      if (wakeTimer !== null) return;
      const base = io.wakeRetryMs ?? WAKE_RETRY_MS;
      const delay =
        wakeAttempts === 0 ? base : Math.max(base, Math.min(WAKE_RETRY_MAX_MS, base * 2));
      wakeAttempts += 1;
      wakeTimer = setTimeout(() => {
        wakeTimer = null;
        attachFrame('reconnect');
      }, delay);
    };
    const clearWakeTimers = () => {
      if (wakeTimer) clearTimeout(wakeTimer);
      if (stillTimer) clearTimeout(stillTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      wakeTimer = stillTimer = giveUpTimer = null;
    };
    // The wake's two clocks, measured from when it BEGAN (`wake.since`), so a socket that dropped
    // mid-wake resumes them rather than starting over.
    const armWakeClocks = (since: number) => {
      const now = Date.now();
      if (stillTimer === null && !wake.stillSaid) {
        stillTimer = setTimeout(
          () => {
            // A cold restart has already said the real answer; "Still on it..." would be vaguer.
            if (wake.since === null || wake.cold || wake.stillSaid) return;
            wake.stillSaid = true;
            say('\r\nhq: Still on it...');
          },
          Math.max(0, since + (io.wakeStillMs ?? WAKE_STILL_ON_IT_MS) - now),
        );
      }
      if (giveUpTimer === null) {
        giveUpTimer = setTimeout(
          () => {
            // Said NOW, then the socket is cut: a clean close could wait out the 30 s handshake
            // timeout on a replica that stopped answering (review N3).
            say(`\r\n${wakeTimeoutMessage(team)}`);
            errorMessage = '';
            exitCode = 1;
            ws.terminate();
          },
          Math.max(0, since + (io.wakeTimeoutMs ?? WAKE_TIMEOUT_MS) - now),
        );
      }
    };
    /** Forget the wake. `asleep` is left as it is: the caller decides whether a key is awaited. */
    const clearWake = () => {
      wake.since = null;
      wake.said = null;
      wake.cold = false;
      wake.stillSaid = false;
      wakeAttempts = 0;
      clearWakeTimers();
    };
    // The machine is back: the wake is over. Say the person's attach once more, as `open`, so a
    // session the wake left behind is re-attached (see the header, FAIL 4).
    const endWake = () => {
      if (wake.since === null) return;
      clearWake();
      wake.asleep = false;
      attachFrame('open');
    };
    // Review N4: a socket that replaced one dropped mid-wake keeps the wake's clocks from the start,
    // so a replica that never answers still meets the ORIGINAL bound.
    if (wake.since !== null) armWakeClocks(wake.since);

    const tokenTimer = setInterval(() => {
      void client
        .accessToken()
        .then((t) => {
          if (t !== lastToken) {
            lastToken = t;
            send({ type: 'remote-token', token: t });
          }
        })
        .catch(() => undefined);
    }, TOKEN_CHECK_MS);
    // D13: the browser's "still here" while its tab is visible. A terminal that is attached IS
    // visible to the person running `hq attach`, so it says it for as long as it stays attached.
    const presenceTimer = setInterval(
      () => send({ type: 'presence', sessionId: session.id }),
      io.presenceIntervalMs ?? PRESENCE_MS,
    );
    presenceTimer.unref?.();
    tokenTimer.unref?.();

    // local-echo RTT: protocol pings, stamped with the send time (Decision 15).
    const rttTimers: NodeJS.Timeout[] = [];
    if (echo) {
      const ping = (): void => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.ping(String(Date.now()));
        } catch {
          // A socket closing under us: no sample this round.
        }
      };
      ws.on('pong', (payload: Buffer) => {
        const sentAt = Number(payload.toString('utf8'));
        if (Number.isFinite(sentAt)) echo.rttSample(Date.now() - sentAt);
      });
      ping();
      for (const ms of RTT_BURST_MS) rttTimers.push(setTimeout(ping, ms));
      rttTimers.push(setInterval(ping, RTT_PING_MS));
      for (const tm of rttTimers) tm.unref?.();
    }

    const onResize = () => {
      echo?.resize(size().cols, size().rows);
      send({ type: 'resize', sessionId: session.id, ...size() });
    };
    const onData = (chunk: Buffer) => {
      const i = chunk.indexOf(DETACH_BYTE);
      const before = i >= 0 ? chunk.subarray(0, i) : chunk;
      // DEF-110: a key on a machine the server said is asleep is the person asking for it. The
      // browser re-attaches `open` first; so do we, typing rights or not (a viewer's key wakes too).
      if (before.length > 0 && wake.asleep) {
        wake.asleep = false;
        attachFrame('open');
      }
      if (session.canType && before.length > 0) {
        const data = before.toString('utf8');
        echo?.key(data); // judged in order with the output; the bytes go out right now regardless
        send({ type: 'input', sessionId: session.id, data });
      }
      if (i >= 0) {
        // local-echo: nothing dim or underlined is left on screen once the socket is gone (C11).
        echo?.close();
        userDetached = true;
        send({ type: 'detach', sessionId: session.id });
        ws.close(1000);
      }
    };
    io.stdout.on('resize', onResize);
    io.stdin.on('data', onData);
    io.stdin.resume();

    ws.on('message', (data: Buffer) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data.toString('utf8')) as ServerFrame;
      } catch {
        return;
      }
      if (
        frame.sessionId !== undefined &&
        frame.sessionId !== null &&
        frame.sessionId !== session.id
      )
        return;
      if ((frame.type === 'output' || frame.type === 'history') && 'data' in frame) {
        if (frame.type === 'history') repaintedAt = Date.now();
        wake.asleep = false;
        const clean = filter.push(frame.data);
        if (clean.length > 0) {
          if (!echo) io.stdout.write(clean);
          else if (frame.type === 'history') echo.repaint(clean);
          else echo.output(clean);
        }
        // NOT the end of a wake: a suspending machine repaints its screen with the wake code.
      } else if (frame.type === 'reset') {
        repaintedAt = Date.now();
        if (echo) echo.repaint('\x1b[H\x1b[2J\x1b[3J');
        else io.stdout.write('\x1b[H\x1b[2J\x1b[3J');
      } else if (frame.type === 'attached') {
        attachOutstanding = false;
        onAdmitted();
        if (answerWaking) {
          schedulePoll(); // still waking: ask again, now that nothing is outstanding
          return;
        }
        if (answerAsleep) {
          // Asleep and nobody waking it (a refused or failed wake): stop waiting, send nothing.
          // "Press any key to continue." is on screen, and the key is what sends `open`.
          if (wake.since !== null) clearWake();
          return;
        }
        endWake(); // admitted with no wake code and no asleep notice: the machine is back
      } else if (frame.type === 'error' && 'message' in frame) {
        const code = 'code' in frame ? frame.code : '';
        if (WAKE_CODES.has(code)) {
          // Progress, not failure: say the server's sentence once per change, re-attach shortly.
          answerWaking = true;
          wake.asleep = false;
          wake.cold = code === 'SESSION_RESUME_COLD_RESTART';
          if (wake.since === null) wake.since = Date.now();
          armWakeClocks(wake.since);
          if (wake.said !== frame.message) {
            wake.said = frame.message;
            say(`\r\nhq: ${frame.message}`);
          }
          // A keystroke's wake code arrives with no attach outstanding: nothing else will arm the
          // cadence, so it starts here. An attach's own code waits for its `attached` (above).
          if (!attachOutstanding) schedulePoll();
          return;
        }
        errorMessage = `\r\nhq: ${frame.message}`;
        exitCode = 1;
        ws.close(1000);
      } else if (frame.type === 'notice' && 'text' in frame) {
        const code = 'code' in frame ? frame.code : undefined;
        // DEF-140: a screen that is FROZEN (a wake, or a machine asleep) was not lost; and one
        // just repainted or wiped was read by a sibling attach. Neither is news.
        if (
          code === HISTORY_UNAVAILABLE_NOTICE &&
          (wake.since !== null || wake.asleep || Date.now() - repaintedAt < HISTORY_NOTICE_GRACE_MS)
        )
          return;
        if (code === WORKSPACE_ASLEEP_NOTICE) {
          wake.asleep = true;
          answerAsleep = true;
        }
        say(`\r\nhq: ${frame.text}`);
      }
    });
    ws.on('error', () => undefined);
    ws.on('close', (code) => {
      for (const tm of rttTimers) clearTimeout(tm);
      clearInterval(tokenTimer);
      clearInterval(presenceTimer);
      clearWakeTimers();
      io.stdin.off('data', onData);
      io.stdout.off?.('resize', onResize);
      io.stdin.pause();
      const held = filter.flush();
      if (held.length > 0 && !userDetached) {
        if (echo) echo.output(held);
        else io.stdout.write(held);
      }
      // local-echo: whatever is still queued reaches the terminal before anything is said about the
      // socket, and nothing predicted is left drawn across a reconnect.
      echo?.undrawNow();
      if (!userDetached && exitCode === 0 && (code === 1006 || code === 1001)) {
        resolve({ kind: 'dropped' });
        return;
      }
      if (code === 4401) {
        resolve({
          kind: 'ended',
          exitCode: 1,
          message: '\r\nhq: your access to this session ended.',
        });
        return;
      }
      if (errorMessage !== null) {
        if (errorMessage.length > 0) say(errorMessage);
        resolve({ kind: 'ended', exitCode, message: null });
        return;
      }
      resolve({ kind: 'ended', exitCode, message: '\r\nhq: detached.' });
    });
  });
}
