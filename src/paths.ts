/**
 * Where the CLI keeps its state (FEATURE.md §13): `~/.hq/` (0700).
 *
 *   ~/.hq/keys/id_ed25519       the per-device key (OpenSSH format, 0600), made at `hq login`
 *   ~/.hq/keys/id_ed25519.pub   its public line
 *   ~/.hq/state.json            host, user, grant id, org/team cache — NO secrets
 *   ~/.hq/credentials.json      the token FALLBACK when no OS keychain tool exists (0600, warned)
 *
 * `HQ_HOME` overrides the directory (tests, and people who keep dotfiles elsewhere).
 *
 * The directory and its variable follow the build's brand (`homeDirName`, `<envPrefix>_HOME`), so
 * two brands' CLIs can live on one computer with separate logins.
 */
import os from 'node:os';
import path from 'node:path';
import { ACTIVE_DEV_BRAND } from '@kpa/shared/active-dev-brand';
import { devBrandEnv, type DevBrand } from '@kpa/shared/dev-brand-core';

export function hqHome(
  env: NodeJS.ProcessEnv = process.env,
  brand: DevBrand = ACTIVE_DEV_BRAND,
): string {
  const override = devBrandEnv(brand, env, 'HOME');
  return typeof override === 'string' && override.length > 0
    ? override
    : path.join(os.homedir(), brand.cli.homeDirName);
}

export const hqPaths = (
  env: NodeJS.ProcessEnv = process.env,
  brand: DevBrand = ACTIVE_DEV_BRAND,
) => {
  const home = hqHome(env, brand);
  return {
    home,
    keysDir: path.join(home, 'keys'),
    privateKey: path.join(home, 'keys', 'id_ed25519'),
    publicKey: path.join(home, 'keys', 'id_ed25519.pub'),
    state: path.join(home, 'state.json'),
    credentials: path.join(home, 'credentials.json'),
  };
};
