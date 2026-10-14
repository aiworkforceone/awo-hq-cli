/**
 * The name a host gives itself, for what `hq login` prints ("Logged in to Acme Console as ...").
 * The CLI signs in against whatever host it is pointed at, so the name comes from that host, never
 * from the build.
 *
 * `GET /api/brand` is public and cookie-less: `{ branded: false }` on HQ, the host's own `appName`
 * on a host that has one. Anything else (a 404 on a server without the route, a
 * timeout, a malformed body) is "no brand", and the caller prints its usual line. The name is
 * server text, so it is cleaned to one short printable line before it is shown.
 */
import type { FetchLike } from './api.js';
import { oneLine } from './safe-text.js';

/** Long enough for any valid brand name (1-40 characters, WL2's rule), short enough for a line. */
const MAX_NAME = 40;
const LOOKUP_TIMEOUT_MS = 3000;
// Bidi overrides and isolates: a server name must never reorder the line it is printed in.
const BIDI = /[‪-‮⁦-⁩]/gu;

export async function hostBrandName(fetchFn: FetchLike, host: string): Promise<string | null> {
  let body: unknown;
  try {
    const res = await fetchFn(`${host}/api/brand`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const { branded, appName } = body as { branded?: unknown; appName?: unknown };
  if (branded !== true || typeof appName !== 'string') return null;
  const name = oneLine(appName).replace(BIDI, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return name.length > 0 ? name : null;
}
