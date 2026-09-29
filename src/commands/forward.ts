/**
 * `hq forward <port> [--local <port>]` — one connection row for the whole invocation (S1), one
 * tunnel upgrade per accepted local TCP connection, each with its own one-time code and signature.
 * A 30 s heartbeat keeps the row from the stale sweep; Ctrl-C closes it.
 *
 * The heartbeat and a stream's code-then-upgrade run under one lock: a heartbeat poll on a row that
 * has not connected yet re-issues the row's code, which would void a code already in flight.
 */
import net from 'node:net';
import {
  closeConnection,
  ConnectRefusedError,
  connectionsPath,
  openConnection,
} from '../connect.js';
import type { RemoteOrg } from '@kpa/shared/remote.types';
import type { HqClient } from '../api.js';
import { clientFor, type Ctx } from '../context.js';
import { readState, writeState } from '../state.js';
import { withTeamAliases, type Team } from '../teams.js';
import {
  closeTunnel,
  openTunnelSocket,
  pipeTunnel,
  TunnelRefusedError,
  type WsFactory,
} from '../tunnel-client.js';
import { loadTeam } from './up.js';

export const HEARTBEAT_MS = 30_000;

export function parsePort(v: string | undefined, min: number): number | null {
  if (!v || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= 65535 ? n : null;
}

class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface ForwardHandle {
  port: number;
  close: () => Promise<void>;
  done: Promise<number>;
}

export async function startForward(
  ctx: Ctx,
  client: HqClient,
  team: Team,
  remotePort: number,
  localPort: number,
  wsFactory?: WsFactory,
): Promise<ForwardHandle> {
  const conn = await openConnection(
    client,
    team,
    { scope: 'forward', port: remotePort, localPort, client: 'hq', intent: 'open', wake: true },
    { now: ctx.now, sleep: ctx.sleep, say: ctx.err },
  );
  const lock = new Lock();
  const org = team.org.slug;
  let closed = false;

  const server = net.createServer((sock) => {
    // Review 2026-09-27: an 'error' listener BEFORE any await. A browser resetting a keep-alive
    // connection (ECONNRESET) or a write to a destroyed socket otherwise throws as an unhandled
    // 'error' event, and the whole process (every other forwarded stream) dies with it.
    let tunnel: Parameters<typeof closeTunnel>[0] | null = null;
    sock.on('error', () => {
      if (tunnel) closeTunnel(tunnel, 1000);
      sock.destroy();
    });
    sock.pause();
    void lock
      .run(async () => {
        const { body } = await client.request<{ connectCode: string }>(
          'POST',
          `${connectionsPath(team, conn.id)}/codes`,
          {
            org,
            signed: true,
          },
        );
        return openTunnelSocket(client, org, body.connectCode, wsFactory);
      })
      .then(async (ws) => {
        tunnel = ws;
        // Code S-e: the socket is still PAUSED here (`openTunnelSocket`), or paused again by the
        // pipe's backpressure later: `closeTunnel` resumes it, so the close reply is read.
        if (sock.destroyed) {
          closeTunnel(ws, 1000);
          return;
        }
        sock.on('close', () => closeTunnel(ws, 1000));
        sock.resume();
        await pipeTunnel(ws, sock, sock);
        if (!sock.destroyed) sock.end();
      })
      .catch((err: unknown) => {
        ctx.err(
          err instanceof TunnelRefusedError
            ? err.message
            : `hq: stream failed (${(err as Error).message})`,
        );
        sock.destroy();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(localPort, '127.0.0.1', () => resolve());
  });
  const bound = (server.address() as net.AddressInfo).port;

  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));
  const heartbeat = setInterval(() => {
    void lock
      .run(() => client.request('GET', connectionsPath(team, conn.id), { org, signed: true }))
      .catch((err: unknown) => {
        ctx.err(`hq: the forward ended (${(err as Error).message}).`);
        void close(1);
      });
  }, HEARTBEAT_MS);

  const close = async (code = 0) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    await new Promise<void>((r) => server.close(() => r()));
    await closeConnection(client, team, conn.id);
    resolveDone(code);
  };
  return { port: bound, close: () => close(0), done };
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
