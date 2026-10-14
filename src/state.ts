/**
 * `~/.hq/state.json` — what the CLI remembers between runs. NEVER a secret: tokens live in the
 * keychain (keychain.ts); this file holds the host, who is signed in, the grant id (for `hq logout`)
 * and a cache of the teams (for alias resolution without a round trip).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { RemoteOrg } from '@kpa/shared/remote.types';
import { ACTIVE_DEV_BRAND } from '@kpa/shared/active-dev-brand';
import { devBrandEnv, type DevBrand } from '@kpa/shared/dev-brand-core';
import { brandCopyTag } from '@kpa/shared/dev-brand-copy';
import { hqPaths } from './paths.js';

export interface HqState {
  host: string;
  user?: { id: string; email: string; name: string };
  grantId?: string;
  orgs?: RemoteOrg[];
}

/**
 * Where `hq login` signs in when nothing else is named. `''` for a brand with no address of its own
 * (`defaultHost: null`): its `login` asks for `--host`.
 */
export const DEFAULT_HOST: string = ACTIVE_DEV_BRAND.defaultHost ?? '';

/** A refused address. Its message is complete (`hq: "…" must use https://…`): print it as is. */
export class InvalidHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHostError';
  }
}

/** Loopback hosts may use plain http (a local HQ during development, the CLI's own tests). */
const LOOPBACK_HOST = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * An HQ address: `https://host[:port]`, nothing else. Plain `http` is refused for any non-loopback
 * host, because every call carries a bearer token, the refresh token and a device signature, and the
 * tunnels carry SSH traffic (review suggestion: CLI transport hardening).
 */
export function normalizeHost(host: string, brand: DevBrand = ACTIVE_DEV_BRAND): string {
  // Named `copy` on purpose: another brand's build rewrites the literals of templates tagged `copy`
  // (scripts/dev-brand-build.mjs), so its bundle never carries our address in these messages.
  const copy = brandCopyTag(brand);
  const trimmed = host.trim().replace(/\/+$/, '');
  if (LOOPBACK_HOST.test(trimmed)) return trimmed;
  if (/^http:\/\//i.test(trimmed)) {
    throw new InvalidHostError(
      copy`hq: "${host}" must use https:// (only localhost may use http).`,
    );
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(trimmed)) {
    // A brand with no address of its own has no product address to show: "an address like …".
    throw new InvalidHostError(
      brand.defaultHost !== null
        ? copy`hq: "${host}" is not an HQ address like https://hq.aiworkforceone.com`
        : copy`hq: "${host}" is not an address like https://hq.aiworkforceone.com`,
    );
  }
  return trimmed;
}

/**
 * The saved state, with the address every command uses: `HQ_HOST` (the brand's variable) when set,
 * else the one saved at login, else the brand's default (`''` when it has none).
 */
export function readState(
  env: NodeJS.ProcessEnv = process.env,
  brand: DevBrand = ACTIVE_DEV_BRAND,
): HqState {
  const p = hqPaths(env, brand).state;
  const override = devBrandEnv(brand, env, 'HOST');
  const fallbackHost = override ? normalizeHost(override, brand) : (brand.defaultHost ?? '');
  if (!existsSync(p)) return { host: fallbackHost };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as HqState;
    return { ...parsed, host: override ? fallbackHost : (parsed.host ?? fallbackHost) };
  } catch {
    return { host: fallbackHost };
  }
}

export function writeState(state: HqState, env: NodeJS.ProcessEnv = process.env): void {
  const paths = hqPaths(env);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
