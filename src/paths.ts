/**
 * Where the CLI keeps its state (FEATURE.md §13): `~/.hq/` (0700).
 *
 *   ~/.hq/keys/id_ed25519       the per-device key (OpenSSH format, 0600), made at `hq login`
 *   ~/.hq/keys/id_ed25519.pub   its public line
 *   ~/.hq/known_hosts           the HQ-pinned host keys (never TOFU)
 *   ~/.hq/state.json            host, user, grant id, org/team cache — NO secrets
 *   ~/.hq/credentials.json      the token FALLBACK when no OS keychain tool exists (0600, warned)
 *   ~/.hq/bin/hq.cmd            Windows: the ProxyCommand shim with absolute paths
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
    knownHosts: path.join(home, 'known_hosts'),
    state: path.join(home, 'state.json'),
    credentials: path.join(home, 'credentials.json'),
    binDir: path.join(home, 'bin'),
  };
};

/** `~/.ssh` — overridable for tests with `HQ_SSH_DIR`. */
export function sshDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HQ_SSH_DIR;
  return typeof override === 'string' && override.length > 0
    ? override
    : path.join(os.homedir(), '.ssh');
}
