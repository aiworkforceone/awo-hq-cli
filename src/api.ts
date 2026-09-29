/**
 * The HQ API as the CLI sees it: bearer auth, the server nonce, device signatures, transparent
 * token refresh, and the house error envelope mapped to plain sentences.
 *
 *  - Every request carries `Authorization: Bearer hqa_…` and `X-HQ-CLI-Version`.
 *  - Every STATE-CHANGING request (and both WebSocket upgrades) is signed with the device key over
 *    `nonce\nMETHOD\n/path\nsha256(body)`; the nonce is single-use, taken from the last response's
 *    `X-HQ-Nonce` or fetched with `GET /api/remote/nonce`.
 *  - The access token lives 15 minutes. `ensureFresh` rotates it (device-signed) when less than two
 *    minutes remain. A reused refresh token is fatal on the server side (the grant is revoked), and
 *    an editor starts several `hq ssh-proxy` processes at once, so rotation is serialized ACROSS
 *    PROCESSES by a lock file in ~/.hq (review C3): the process that waited re-reads the keychain
 *    and adopts the pair the winner stored instead of presenting the used refresh token.
 *
 * ⛔ No token, nonce, code or signature is ever printed. Errors print the server's `error` sentence.
 */
import { createHash, randomBytes, type KeyObject } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import {
  HQ_HEADER_CLI_VERSION,
  HQ_HEADER_DEVICE_SIG,
  HQ_HEADER_NONCE,
  HQ_HEADER_ORG,
  type TokenPair,
} from '@kpa/shared/remote.types';
import { signRequest } from './device-key.js';
import { loadTokens, saveTokens, type StoredTokens } from './keychain.js';
import { hqPaths } from './paths.js';
import { HQ_VERSION } from './version.js';

export class HqApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = 'HqApiError';
  }
}

export class NotLoggedInError extends Error {
  constructor() {
    super('hq: you are not logged in on this computer. Run hq login.');
    this.name = 'NotLoggedInError';
  }
}

export type FetchLike = typeof globalThis.fetch;

export interface HqClientOptions {
  host: string;
  key: KeyObject;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  now?: () => number;
  /** Override token storage (tests). */
  store?: {
    load(host: string): StoredTokens | null;
    save(host: string, tokens: StoredTokens): void;
  };
  /** Where the cross-process refresh lock lives. Default: `~/.hq` (`HQ_HOME`). */
  lockDir?: string;
}

/** Refresh when fewer than this many ms remain on the access token. */
export const REFRESH_MARGIN_MS = 2 * 60 * 1000;
/** A refresh lock older than this belongs to a process that died holding it; it is broken. */
export const REFRESH_LOCK_STALE_MS = 30_000;
/** The longest a process waits for another one's refresh before breaking the lock itself. */
export const REFRESH_LOCK_WAIT_MS = 20_000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HqClient {
  readonly host: string;
  private readonly key: KeyObject;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly store: NonNullable<HqClientOptions['store']>;
  private nonce: string | null = null;
  private refreshing: Promise<StoredTokens> | null = null;
  private readonly lockDir: string;

  constructor(opts: HqClientOptions) {
    this.host = opts.host.replace(/\/+$/, '');
    this.key = opts.key;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    const env = opts.env ?? process.env;
    this.store = opts.store ?? {
      load: (h) => loadTokens(h, env),
      save: (h, t) => saveTokens(h, t, env),
    };
    this.lockDir = opts.lockDir ?? hqPaths(env).home;
  }

  /** The lock file's name for THIS host (one login per host, so one lock per host). */
  refreshLockName(): string {
    return `refresh-${createHash('sha256').update(this.host).digest('hex').slice(0, 12)}.lock`;
  }

  private isFresh(t: StoredTokens): boolean {
    return Date.parse(t.accessExpiresAt) - this.now() > REFRESH_MARGIN_MS;
  }

  private tokens(): StoredTokens {
    const t = this.store.load(this.host);
    if (!t) throw new NotLoggedInError();
    return t;
  }

  /** A live access token, rotated first when it is about to expire. */
  async accessToken(): Promise<string> {
    return (await this.ensureFresh()).accessToken;
  }

  async ensureFresh(): Promise<StoredTokens> {
    const t = this.tokens();
    if (this.isFresh(t)) return t;
    // In-process: one refresh at a time. Across processes: the lock file (below).
    this.refreshing ??= this.refreshAcrossProcesses().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Rotate under the cross-process lock. After taking it, re-read the store: when another process
   * rotated while we waited, its pair is fresh and we adopt it without touching the server. If the
   * server still answers `REFRESH_RACE` (a process that raced us WITHOUT the lock, e.g. an older
   * hq), the pair it stored is adopted the same way.
   */
  private async refreshAcrossProcesses(): Promise<StoredTokens> {
    const release = await this.acquireRefreshLock();
    try {
      const current = this.tokens();
      if (this.isFresh(current)) return current;
      try {
        return await this.refresh(current);
      } catch (err) {
        if (err instanceof HqApiError && err.code === 'REFRESH_RACE') {
          const after = this.tokens();
          if (after.refreshToken !== current.refreshToken) return after;
        }
        throw err;
      }
    } finally {
      release();
    }
  }

  /**
   * `~/.hq/refresh-<host>.lock`, created with O_EXCL (atomic on every local filesystem). A lock whose
   * mtime is older than `REFRESH_LOCK_STALE_MS` belongs to a process that died holding it and is
   * broken; after `REFRESH_LOCK_WAIT_MS` of waiting we break it ourselves rather than hang an editor.
   * The release removes the file only while it still carries OUR token, so a lock broken and
   * re-taken by another process is never deleted from under it. Real time, not `now()`: file
   * mtimes are wall-clock.
   */
  private async acquireRefreshLock(): Promise<() => void> {
    mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.lockDir, this.refreshLockName());
    const mine = `${process.pid}:${randomBytes(8).toString('hex')}`;
    const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
    let delay = 25;
    for (;;) {
      try {
        const fd = openSync(file, 'wx', 0o600);
        try {
          writeSync(fd, mine);
        } finally {
          closeSync(fd);
        }
        return () => {
          try {
            if (readFileSync(file, 'utf8') === mine) rmSync(file, { force: true });
          } catch {
            /* already gone */
          }
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      let age = 0;
      try {
        age = Date.now() - statSync(file).mtimeMs;
      } catch {
        continue; // released between our open and our stat: try again at once
      }
      if (age > REFRESH_LOCK_STALE_MS || Date.now() > deadline) {
        rmSync(file, { force: true });
        continue;
      }
      await realSleep(delay);
      delay = Math.min(delay * 2, 500);
    }
  }

  /** Rotate the pair. Device-signed; the nonce is fetched with the REFRESH token as the bearer. */
  private async refresh(t: StoredTokens): Promise<StoredTokens> {
    const nonceRes = await this.fetchFn(`${this.host}/api/remote/nonce`, {
      headers: { Authorization: `Bearer ${t.refreshToken}`, [HQ_HEADER_CLI_VERSION]: HQ_VERSION },
    });
    if (!nonceRes.ok) throw await this.toError(nonceRes);
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    const path = '/api/remote/token/refresh';
    const body = JSON.stringify({ refreshToken: t.refreshToken });
    const res = await this.fetchFn(`${this.host}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [HQ_HEADER_CLI_VERSION]: HQ_VERSION,
        [HQ_HEADER_NONCE]: nonce,
        [HQ_HEADER_DEVICE_SIG]: signRequest(this.key, nonce, 'POST', path, body),
      },
      body,
    });
    if (!res.ok) throw await this.toError(res);
    const pair = (await res.json()) as TokenPair;
    const next: StoredTokens = {
      accessToken: pair.accessToken,
      accessExpiresAt: pair.accessExpiresAt,
      refreshToken: pair.refreshToken,
    };
    this.store.save(this.host, next);
    return next;
  }

  /** A fresh single-use nonce (the last response's, or a new one). */
  async takeNonce(): Promise<string> {
    if (this.nonce) {
      const n = this.nonce;
      this.nonce = null;
      return n;
    }
    const res = await this.fetchFn(`${this.host}/api/remote/nonce`, {
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        [HQ_HEADER_CLI_VERSION]: HQ_VERSION,
      },
    });
    if (!res.ok) throw await this.toError(res);
    return ((await res.json()) as { nonce: string }).nonce;
  }

  /** Headers for a signed WebSocket upgrade (`GET <path>`, empty body). */
  async upgradeHeaders(
    path: string,
    org: string,
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const token = await this.accessToken();
    const nonce = await this.takeNonce();
    return {
      Authorization: `Bearer ${token}`,
      [HQ_HEADER_ORG]: org,
      [HQ_HEADER_NONCE]: nonce,
      [HQ_HEADER_DEVICE_SIG]: signRequest(this.key, nonce, 'GET', path, ''),
      [HQ_HEADER_CLI_VERSION]: HQ_VERSION,
      ...extra,
    };
  }

  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { body?: unknown; org?: string; signed?: boolean } = {},
  ): Promise<{ status: number; body: T }> {
    const token = await this.accessToken();
    const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      [HQ_HEADER_CLI_VERSION]: HQ_VERSION,
    };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.org) headers[HQ_HEADER_ORG] = opts.org;
    if (opts.signed) {
      const nonce = await this.takeNonce();
      headers[HQ_HEADER_NONCE] = nonce;
      headers[HQ_HEADER_DEVICE_SIG] = signRequest(this.key, nonce, method, path, body);
    }
    const res = await this.fetchFn(`${this.host}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body } : {}),
    });
    const next = res.headers.get(HQ_HEADER_NONCE);
    if (next) this.nonce = next;
    if (!res.ok) throw await this.toError(res);
    if (res.status === 204) return { status: 204, body: undefined as T };
    return { status: res.status, body: (await res.json()) as T };
  }

  async toError(res: Response): Promise<HqApiError> {
    let body: { error?: unknown; code?: unknown; details?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* not JSON */
    }
    const message = typeof body.error === 'string' ? body.error : `HQ answered ${res.status}`;
    return new HqApiError(
      res.status,
      typeof body.code === 'string' ? body.code : undefined,
      message,
      typeof body.details === 'object' && body.details !== null
        ? (body.details as Record<string, unknown>)
        : undefined,
    );
  }
}

/** Unauthenticated JSON POST (device start / poll). */
export async function postJson<T>(
  fetchFn: FetchLike,
  url: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [HQ_HEADER_CLI_VERSION]: HQ_VERSION },
    body: JSON.stringify(body),
  });
  let parsed: unknown = undefined;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed as T };
}
