/**
 * Token storage (FEATURE.md §13, S2): the OS keychain through the OS's OWN tools — `security` on
 * macOS, `secret-tool` (libsecret) on Linux — never a native Node module.
 *
 * ⚠️ WHAT THIS DOES AND DOES NOT PROTECT (security review S5). The token is kept out of plain files,
 *    backups of dotfiles, argv and the environment, and it is locked with the user's login keychain.
 *    It is NOT isolated per application: on macOS the item is created by `/usr/bin/security`, so any
 *    process running as this user can read it back with the same tool, without a prompt; libsecret
 *    items are likewise readable by any process in the user's session. The boundary is the user
 *    account. What makes a stolen token alone useless is the device key (every request and upgrade
 *    is device-signed) and the 15-minute access lifetime, not the keychain.
 *
 * The secret NEVER travels on a command line (another process could read argv): macOS gets it on
 * `security -i`'s stdin, libsecret on `secret-tool store`'s stdin.
 *
 * FALLBACK: `~/.hq/credentials.json`, 0600, with a warning on stderr — Windows (no stdin-capable
 * store tool), a Linux box without a secret service, or `HQ_KEYCHAIN=file`.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hqPaths } from './paths.js';

const SERVICE = 'hq.aiworkforceone';

export interface StoredTokens {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
}

type Backend = 'macos' | 'libsecret' | 'file';

function hasTool(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function keychainBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  if (env.HQ_KEYCHAIN === 'file') return 'file';
  // Explicit choice (and the test seam for the fallback below); still falls back to the file store
  // when the Secret Service does not answer.
  if (env.HQ_KEYCHAIN === 'libsecret') return 'libsecret';
  if (process.platform === 'darwin' && (env.HQ_KEYCHAIN_MACOS_FILE || hasTool('security'))) {
    return 'macos';
  }
  if (process.platform === 'linux' && hasTool('secret-tool')) return 'libsecret';
  return 'file';
}

let warned = false;
function warnFile(reason: 'no-tool' | 'no-service' = 'no-tool'): void {
  if (warned) return;
  warned = true;
  process.stderr.write(
    reason === 'no-service'
      ? 'hq: the system keychain is not answering (no Secret Service running), so your login is stored in ~/.hq/credentials.json (readable only by you).\n'
      : 'hq: no system keychain tool found, so your login is stored in ~/.hq/credentials.json (readable only by you).\n',
  );
}

function readFileStore(env: NodeJS.ProcessEnv): Record<string, StoredTokens> {
  const p = hqPaths(env).credentials;
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, StoredTokens>;
  } catch {
    return {};
  }
}

function writeFileStore(env: NodeJS.ProcessEnv, data: Record<string, StoredTokens>): void {
  const paths = hqPaths(env);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  writeFileSync(paths.credentials, JSON.stringify(data), { mode: 0o600 });
  chmodSync(paths.credentials, 0o600);
}

function isTokens(v: unknown): v is StoredTokens {
  const t = v as StoredTokens | null;
  return (
    typeof t === 'object' &&
    t !== null &&
    typeof t.accessToken === 'string' &&
    typeof t.refreshToken === 'string' &&
    typeof t.accessExpiresAt === 'string'
  );
}

/**
 * The value stored in the macOS keychain: `b64:` + base64url(JSON). `security -i` parses its own
 * command line, and whether that parser honours backslash escapes inside a quoted argument is not
 * something to bet a login on (review W14): a base64url value contains no quote, no backslash and
 * no space, so it needs no escaping at all.
 */
export function encodeKeychainValue(tokens: StoredTokens): string {
  return `b64:${Buffer.from(JSON.stringify(tokens), 'utf8').toString('base64url')}`;
}

/** Read a stored value: the `b64:` form, or the plain JSON an older hq wrote. Null if unusable. */
export function decodeKeychainValue(raw: string): StoredTokens | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  let json: string;
  if (value.startsWith('b64:')) {
    const body = value.slice(4);
    if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
    json = Buffer.from(body, 'base64url').toString('utf8');
  } else {
    json = value;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return isTokens(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Quote one argument for `security -i`'s command line (host names, the test keychain path). */
function securityArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `HQ_KEYCHAIN_MACOS_FILE`: a specific keychain file instead of the login keychain (tests). */
function macosKeychainArgs(env: NodeJS.ProcessEnv): string[] {
  const file = env.HQ_KEYCHAIN_MACOS_FILE;
  return typeof file === 'string' && file.length > 0 ? [file] : [];
}

export function saveTokens(
  host: string,
  tokens: StoredTokens,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const secret = JSON.stringify(tokens);
  const backend = keychainBackend(env);
  if (backend === 'macos') {
    // `security -i` reads the command from stdin: the token never reaches argv. The value is
    // base64url (see encodeKeychainValue), so it needs no escaping; the host and the optional
    // keychain path are quoted.
    const keychain = macosKeychainArgs(env)
      .map((k) => ` ${securityArg(k)}`)
      .join('');
    execFileSync('security', ['-i'], {
      input: `add-generic-password -U -s ${securityArg(SERVICE)} -a ${securityArg(host)} -w ${encodeKeychainValue(tokens)}${keychain}\n`,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return;
  }
  if (backend === 'libsecret') {
    try {
      execFileSync(
        'secret-tool',
        ['store', '--label=hq login', 'service', SERVICE, 'account', host],
        {
          input: secret,
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      );
      return;
    } catch {
      // Review 2026-09-27: `secret-tool` installed but no Secret Service / D-Bus session (a common
      // headless box). Failing here threw AFTER the device grant was consumed and wasted the
      // approval; the 0600 file store is the documented fallback instead.
      warnFile('no-service');
    }
  } else {
    warnFile();
  }
  const data = readFileStore(env);
  data[host] = tokens;
  writeFileStore(env, data);
}

export function loadTokens(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredTokens | null {
  const backend = keychainBackend(env);
  try {
    if (backend === 'macos') {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-s', SERVICE, '-a', host, '-w', ...macosKeychainArgs(env)],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).toString('utf8');
      return decodeKeychainValue(out);
    }
  } catch {
    return null;
  }
  if (backend === 'libsecret') {
    try {
      const out = execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', host], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString('utf8')
        .trim();
      const found = decodeKeychainValue(out);
      if (found) return found;
    } catch {
      /* no Secret Service: the login may be in the file store (see saveTokens) */
    }
  }
  const t = readFileStore(env)[host];
  return isTokens(t) ? t : null;
}

export function deleteTokens(host: string, env: NodeJS.ProcessEnv = process.env): void {
  const backend = keychainBackend(env);
  try {
    if (backend === 'macos') {
      execFileSync(
        'security',
        ['delete-generic-password', '-s', SERVICE, '-a', host, ...macosKeychainArgs(env)],
        { stdio: 'ignore' },
      );
      return;
    }
  } catch {
    return;
  }
  if (backend === 'libsecret') {
    try {
      execFileSync('secret-tool', ['clear', 'service', SERVICE, 'account', host], {
        stdio: 'ignore',
      });
    } catch {
      /* no Secret Service: the file-store copy (if any) is cleared below */
    }
  }
  const data = readFileStore(env);
  delete data[host];
  if (Object.keys(data).length === 0) rmSync(hqPaths(env).credentials, { force: true });
  else writeFileStore(env, data);
}
