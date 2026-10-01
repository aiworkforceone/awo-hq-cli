/**
 * `hq attach` local echo: which mode this invocation asked for (feature `local-echo`, Decision 16).
 *
 * `--local-echo` (bare, meaning `auto`) or `--local-echo=<auto|always|off>` wins over
 * `HQ_LOCAL_ECHO=<auto|always|off>` (case-insensitive; `1`/`true` mean `always` and `0`/`false`
 * mean `off`, for shell-profile convenience). Neither present: OFF. Read fresh on every invocation;
 * nothing is persisted. It is only a REQUEST: the org and the environment still decide
 * (`RemoteSessionSummary.localEchoAvailable`, Decision 18).
 */
import type { LocalEchoMode } from '@kpa/shared/local-echo-engine';

export type { LocalEchoMode };

const MODES: ReadonlySet<string> = new Set(['auto', 'always', 'off']);

export function resolveLocalEchoMode(
  flag: string | true | undefined,
  env: string | undefined,
): { mode: LocalEchoMode } | { error: string } {
  if (flag === true) return { mode: 'auto' };
  if (typeof flag === 'string') {
    const v = flag.trim().toLowerCase();
    return MODES.has(v)
      ? { mode: v as LocalEchoMode }
      : { error: 'hq: --local-echo takes auto, always or off.' };
  }
  const v = (env ?? '').trim().toLowerCase();
  if (MODES.has(v)) return { mode: v as LocalEchoMode };
  if (v === '1' || v === 'true') return { mode: 'always' };
  return { mode: 'off' };
}
