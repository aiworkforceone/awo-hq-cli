/**
 * `~/.hq/state.json` — what the CLI remembers between runs. NEVER a secret: tokens live in the
 * keychain (keychain.ts); this file holds the host, who is signed in, the grant id (for `hq logout`)
 * and a cache of the teams (for alias resolution without a round trip).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { RemoteOrg } from '@kpa/shared/remote.types';
import { hqPaths } from './paths.js';

export interface HqState {
  host: string;
  user?: { id: string; email: string; name: string };
  grantId?: string;
  orgs?: RemoteOrg[];
}

export const DEFAULT_HOST = 'https://hq.aiworkforceone.com';

/** Loopback hosts may use plain http (a local HQ during development, the CLI's own tests). */
const LOOPBACK_HOST = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * An HQ address: `https://host[:port]`, nothing else. Plain `http` is refused for any non-loopback
 * host, because every call carries a bearer token, the refresh token and a device signature, and the
 * tunnels carry SSH traffic (review suggestion: CLI transport hardening).
 */
export function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '');
  if (LOOPBACK_HOST.test(trimmed)) return trimmed;
  if (/^http:\/\//i.test(trimmed)) {
    throw new Error(`hq: "${host}" must use https:// (only localhost may use http).`);
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(trimmed)) {
    throw new Error(`hq: "${host}" is not an HQ address like https://hq.aiworkforceone.com`);
  }
  return trimmed;
}

export function readState(env: NodeJS.ProcessEnv = process.env): HqState {
  const p = hqPaths(env).state;
  const fallbackHost = env.HQ_HOST ? normalizeHost(env.HQ_HOST) : DEFAULT_HOST;
  if (!existsSync(p)) return { host: fallbackHost };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as HqState;
    return { ...parsed, host: env.HQ_HOST ? fallbackHost : (parsed.host ?? fallbackHost) };
  } catch {
    return { host: fallbackHost };
  }
}

export function writeState(state: HqState, env: NodeJS.ProcessEnv = process.env): void {
  const paths = hqPaths(env);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
