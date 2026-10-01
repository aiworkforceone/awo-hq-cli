/**
 * The per-device ed25519 key (FEATURE.md decision 6), made at `hq login`:
 *
 *  - ssh uses it (`IdentityFile ~/.hq/keys/id_ed25519`, `IdentitiesOnly yes`); the SSH door accepts
 *    exactly the key the ticket names, once per connection;
 *  - the CLI signs every state-changing request and both upgrades with it (`X-HQ-Device-Sig` over
 *    `nonce\nMETHOD\n/path\nsha256(body)`), so a stolen access token alone is useless (W3).
 *
 * The key format and the signature are the shared `hq-client` package's (hq-vscode decision 4);
 * this file keeps where the CLI stores the key: `~/.hq/keys/`, 0600 in a 0700 dir.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  deviceKeyFromOpenSsh,
  generateDeviceKeyMaterial,
  keyObjectFromSeed,
  publicLineOf,
  toOpenSshPrivateKey,
  type DeviceKey,
} from '@hq/client/device-key.js';
import { hqPaths } from './paths.js';

export * from '@hq/client/device-key.js';

/** Load the device key, creating it (0600, in a 0700 dir) when absent. */
export function ensureDeviceKey(env: NodeJS.ProcessEnv = process.env, comment = 'hq'): DeviceKey {
  const paths = hqPaths(env);
  if (existsSync(paths.privateKey)) return loadDeviceKey(env);
  mkdirSync(paths.keysDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.home, 0o700);
  const { seed32, pub32 } = generateDeviceKeyMaterial();
  writeFileSync(paths.privateKey, toOpenSshPrivateKey(seed32, pub32, comment), { mode: 0o600 });
  writeFileSync(paths.publicKey, `${publicLineOf(pub32)} ${comment}\n`, { mode: 0o644 });
  return { publicLine: publicLineOf(pub32), privateKey: keyObjectFromSeed(seed32, pub32) };
}

export function loadDeviceKey(env: NodeJS.ProcessEnv = process.env): DeviceKey {
  return deviceKeyFromOpenSsh(readFileSync(hqPaths(env).privateKey, 'utf8'));
}
