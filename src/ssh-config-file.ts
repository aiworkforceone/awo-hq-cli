/**
 * `~/.ssh/hq_config` — the managed blocks (FEATURE.md §13), the `Include` line in `~/.ssh/config`,
 * the Windows `hq.cmd` shim and `~/.hq/known_hosts`. Pure string builders + small file writers, so
 * the exact bytes are unit-tested.
 *
 * ABSOLUTE PATHS: an editor launched from the Dock runs under launchd's PATH (no Homebrew, no nvm),
 * so the ProxyCommand names the node binary and the bundled script by absolute path.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { acquireFileLock } from './file-lock.js';
import { hqPaths, sshDir } from './paths.js';
import { ALIAS_RE, oneLine } from './safe-text.js';
import { isWellFormedTeam, type Team } from './teams.js';

export const BLOCK_BEGIN =
  '# >>> hq managed block. Do not edit; regenerate with `hq ssh --config` <<<';
export const BLOCK_END = '# <<< hq managed block >>>';

/** `~/…` when the path is under the home directory (what ssh expands), else absolute. */
export function tildify(p: string, home: string = os.homedir()): string {
  return p === home
    ? '~'
    : p.startsWith(home + path.sep)
      ? `~/${path.relative(home, p).split(path.sep).join('/')}`
      : p;
}

/** Windows (`hq.cmd`, and the ProxyCommand that names it): a double-quoted path. */
function quote(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}

/**
 * POSIX (review S2): ssh runs the ProxyCommand through `/bin/sh -c`, so a path goes in SINGLE
 * quotes (no `$`, backtick or `\` expansion inside), with an embedded `'` closed, escaped and
 * reopened.
 */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/** ssh expands `%h`, `%p`, … in a ProxyCommand BEFORE the shell sees it: a literal `%` is `%%`. */
function sshTokenEscape(command: string): string {
  return command.replace(/%/g, '%%');
}

/** Paths that move under the user's feet (review S2): the ProxyCommand would silently break. */
function unstablePathWarnings(nodePath: string, script: string): string[] {
  const warnings: string[] = [];
  if (/[\\/]_npx[\\/]/.test(script)) {
    warnings.push(
      `hq: this hq runs from an npx cache (${script}), which npm clears, and your SSH config would then point at nothing. Install it with \`npm install -g --ignore-scripts @aiworkforceoneofficial/hq\` and run \`hq ssh --config\` again.`,
    );
  }
  const nvm = /[\\/]\.nvm[\\/]versions[\\/]node[\\/]v[^\\/]+[\\/]/;
  if (nvm.test(nodePath) || nvm.test(script)) {
    warnings.push(
      'hq: node and hq come from an nvm install of ONE Node version; after you switch or remove that version the SSH config points at a path that is gone. Run `hq ssh --config` again after changing Node versions.',
    );
  }
  return warnings;
}

export interface ProxyLauncher {
  /** The ProxyCommand prefix, already quoted and ssh-token-escaped: `'node' 'script'` or `"…\hq.cmd"`. */
  command: string;
  /** Things the member should know about these paths (printed by `hq ssh --config`). */
  warnings?: string[];
}

/**
 * Resolve how ssh should run this CLI. POSIX: `"<node>" "<real path of hq.cjs>"`. Windows: a
 * `~/.hq/bin/hq.cmd` shim with the same two absolute paths, because Windows OpenSSH starts the
 * ProxyCommand without a shell.
 */
export function resolveLauncher(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  nodePath: string = process.execPath,
  scriptPath: string = process.argv[1] ?? '',
): ProxyLauncher {
  let script = scriptPath;
  try {
    script = realpathSync(scriptPath);
  } catch {
    /* keep what we were given */
  }
  const warnings = unstablePathWarnings(nodePath, script);
  if (platform === 'win32') {
    const bin = hqPaths(env).binDir;
    mkdirSync(bin, { recursive: true });
    const cmd = path.join(bin, 'hq.cmd');
    writeFileSync(cmd, `@echo off\r\n${quote(nodePath)} ${quote(script)} %*\r\n`);
    return { command: sshTokenEscape(quote(cmd)), warnings };
  }
  return { command: sshTokenEscape(`${shQuote(nodePath)} ${shQuote(script)}`), warnings };
}

/** A team whose alias, id or org slug is not the server's exact shape (review C4). */
export class UnsafeTeamError extends Error {
  constructor() {
    super('hq: refusing to write a team whose name or id is not in the expected form');
    this.name = 'UnsafeTeamError';
  }
}

/**
 * One managed block. THROWS `UnsafeTeamError` unless the alias, the team id and the org slug have
 * the server's exact shape: the slug and id go into `ProxyCommand`, which ssh runs through
 * /bin/sh, and the alias is a `Host` pattern. The names go into a `#` comment and are cleaned to ONE
 * line first: a newline there would start a real directive (`Match exec` runs a command on every
 * ssh the member makes, because this file is Included at the top of ~/.ssh/config).
 */
export function renderTeamBlock(
  team: Team,
  launcher: ProxyLauncher,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isWellFormedTeam(team)) throw new UnsafeTeamError();
  const paths = hqPaths(env);
  return [
    BLOCK_BEGIN,
    `# ${oneLine(team.org.name)} (${team.org.slug}) / ${oneLine(team.workspace.name)}`,
    `Host ${team.alias}`,
    `  HostName ${team.alias}.hq.invalid`,
    '  User node',
    `  ProxyCommand ${launcher.command} ssh-proxy --workspace ${team.workspace.id} --org ${team.org.slug}`,
    `  HostKeyAlias ${team.alias}`,
    `  UserKnownHostsFile ${tildify(paths.knownHosts, home)}`,
    '  StrictHostKeyChecking yes',
    `  IdentityFile ${tildify(paths.privateKey, home)}`,
    '  IdentitiesOnly yes',
    '  ConnectTimeout 180',
    '  ServerAliveInterval 30',
    '  ServerAliveCountMax 4',
    '  ForwardAgent no',
    BLOCK_END,
  ].join('\n');
}

/** The whole file. A malformed team is left out (the caller reports it; see `writeSshConfig`). */
export function renderHqConfig(
  teams: Team[],
  launcher: ProxyLauncher,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const blocks = teams.filter(isWellFormedTeam).map((t) => renderTeamBlock(t, launcher, home, env));
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}

/** Add `Include <hq_config>` at the TOP of `~/.ssh/config` once (an Include below a Host is scoped to it). */
export function withIncludeLine(
  existing: string,
  includeTarget: string,
): { text: string; changed: boolean } {
  const already = existing
    .split(/\r?\n/)
    .some((l) => /^\s*include\s+/i.test(l) && l.includes('hq_config'));
  if (already) return { text: existing, changed: false };
  const line = `Include ${includeTarget}`;
  const text = existing.length === 0 ? `${line}\n` : `${line}\n\n${existing}`;
  return { text, changed: true };
}

export interface WriteSshConfigResult {
  hqConfigPath: string;
  sshConfigPath: string;
  includeAdded: boolean;
  /** How many team blocks were written. */
  written: number;
  /** Teams left out because their alias, id or org slug was malformed (never written). */
  skipped: Team[];
}

export function writeSshConfig(
  teams: Team[],
  launcher: ProxyLauncher,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): WriteSshConfigResult {
  const dir = sshDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hqConfigPath = path.join(dir, 'hq_config');
  writeFileSync(hqConfigPath, renderHqConfig(teams, launcher, home, env), { mode: 0o600 });
  chmodSync(hqConfigPath, 0o600);
  const sshConfigPath = path.join(dir, 'config');
  const existing = existsSync(sshConfigPath) ? readFileSync(sshConfigPath, 'utf8') : '';
  const { text, changed } = withIncludeLine(existing, tildify(hqConfigPath, home));
  if (changed) writeFileSync(sshConfigPath, text, { mode: 0o600 });
  // The key must exist before ssh reads IdentityFile.
  const skipped = teams.filter((t) => !isWellFormedTeam(t));
  return {
    hqConfigPath,
    sshConfigPath,
    includeAdded: changed,
    written: teams.length - skipped.length,
    skipped,
  };
}

/**
 * Pin the team's CURRENT host key under its alias (per-boot keys, decision 7): replace the alias's
 * line, keep every other line. The key comes from HQ over the authenticated API, never from TOFU.
 *
 * Review W3: an editor opens several connections at once, each an `hq ssh-proxy` pinning its own
 * team. The read-modify-write runs under an O_EXCL lock file (the refresh lock's pattern,
 * file-lock.ts) and the new file is written to a temp file and RENAMED over, so two concurrent pins
 * of different teams both survive and a reader never sees a half-written file. `afterRead` is a
 * test seam that widens the race window.
 */
export async function pinHostKey(
  alias: string,
  hostKeyLine: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    afterRead?: () => Promise<void>;
    writeFile?: (file: string, data: string) => void;
    rename?: (from: string, to: string) => void;
  } = {},
): Promise<void> {
  const parts = hostKeyLine.trim().split(/\s+/);
  if (
    !ALIAS_RE.test(alias) ||
    parts.length < 2 ||
    !/^ssh-ed25519$|^ecdsa-sha2-nistp256$|^ssh-rsa$/.test(parts[0]!) ||
    !/^[A-Za-z0-9+/=]+$/.test(parts[1]!)
  ) {
    return;
  }
  const file = hqPaths(env).knownHosts;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = await acquireFileLock(`${file}.lock`);
  try {
    const lines = existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter((l) => l.trim().length > 0)
      : [];
    await deps.afterRead?.();
    const kept = lines.filter((l) => l.split(/\s+/)[0] !== alias);
    kept.push(`${alias} ${parts[0]} ${parts[1]}`);
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const writeFile =
      deps.writeFile ?? ((f: string, data: string) => writeFileSync(f, data, { mode: 0o600 }));
    try {
      writeFile(tmp, `${kept.join('\n')}\n`);
      (deps.rename ?? renameSync)(tmp, file);
    } catch (err) {
      // Code review S-f: a full disk or a failed rename leaves no stray temp file beside the pins.
      rmSync(tmp, { force: true });
      throw err;
    }
  } finally {
    release();
  }
}
