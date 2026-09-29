/** `hq logout` — revoke THIS device's grant server-side (every org), then forget it locally. */
import { HqApiError, NotLoggedInError } from '../api.js';
import { clientFor, type Ctx } from '../context.js';
import { deleteTokens, loadTokens } from '../keychain.js';
import { readState, writeState } from '../state.js';

export async function logout(ctx: Ctx): Promise<number> {
  const state = readState(ctx.env);
  if (!loadTokens(state.host, ctx.env) || !state.grantId) {
    deleteTokens(state.host, ctx.env);
    ctx.out('Signed out.');
    return 0;
  }
  const client = clientFor(ctx, state);
  try {
    await client.request('DELETE', `/api/remote/grants/${state.grantId}`, { signed: true });
  } catch (err) {
    // A token that is already dead means the server already forgot this device: fine.
    if (
      !(err instanceof NotLoggedInError) &&
      !(err instanceof HqApiError && (err.status === 401 || err.status === 404))
    ) {
      ctx.err(
        `hq: could not reach HQ to revoke this device (${(err as Error).message}). Signed out locally.`,
      );
    }
  }
  deleteTokens(state.host, ctx.env);
  writeState({ host: state.host }, ctx.env);
  ctx.out("Signed out. This device's access is revoked.");
  return 0;
}
