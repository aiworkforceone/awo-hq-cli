/** A tiny argv parser: positionals plus `--flag`, `--flag value` and `--flag=value`. No dependency. */
export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

/**
 * Flags that never take a value as a SEPARATE token (`--flag=value` still works). `local-echo` is
 * here so `hq attach --local-echo mysession` keeps `mysession` as the session (feature `local-echo`,
 * Decision 16); its mode, when given, is `--local-echo=<auto|always|off>`.
 */
const BOOLEAN_FLAGS = new Set(['config', 'wake', 'help', 'version', 'local-echo']);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
        flags.set(name, next);
        i += 1;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    if (a === '-h') {
      flags.set('help', true);
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}
