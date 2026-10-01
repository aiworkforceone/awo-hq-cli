/**
 * Where the CLI keeps its state (FEATURE.md §13): `~/.hq/` (0700).
 *
 *   ~/.hq/keys/id_ed25519       the per-device key (OpenSSH format, 0600), made at `hq login`
 *   ~/.hq/keys/id_ed25519.pub   its public line
 *   ~/.hq/state.json            host, user, grant id, org/team cache — NO secrets
 *   ~/.hq/credentials.json      the token FALLBACK when no OS keychain tool exists (0600, warned)
 *
 * `HQ_HOME` overrides the directory (tests, and people who keep dotfiles elsewhere).
 */
import os from 'node:os';
import path from 'node:path';

export function hqHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HQ_HOME;
  return typeof override === 'string' && override.length > 0
    ? override
    : path.join(os.homedir(), '.hq');
}

export const hqPaths = (env: NodeJS.ProcessEnv = process.env) => {
  const home = hqHome(env);
  return {
    home,
    keysDir: path.join(home, 'keys'),
    privateKey: path.join(home, 'keys', 'id_ed25519'),
    publicKey: path.join(home, 'keys', 'id_ed25519.pub'),
    state: path.join(home, 'state.json'),
    credentials: path.join(home, 'credentials.json'),
  };
};
