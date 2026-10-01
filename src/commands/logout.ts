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
  let revoked = true;
  try {
    await client.request('DELETE', `/api/remote/grants/${state.grantId}`, { signed: true });
  } catch (err) {
    if (err instanceof NotLoggedInError || (err instanceof HqApiError && err.status === 404)) {
      // The server already forgot this device: fine.
    } else if (err instanceof HqApiError && err.status === 401) {
      // Security review B1: a signed call's 401 can be a nonce or signature problem, not a dead
      // login. Only an unsigned read that also answers 401 confirms the grant is gone.
      if (!(await client.confirmRevoked())) {
        revoked = false;
        ctx.err(
          'hq: HQ did not confirm that this computer’s access ended. Remove it in HQ, under Account, Devices.',
        );
      }
    } else {
      revoked = false;
      ctx.err(
        `hq: could not reach HQ to revoke this device (${(err as Error).message}). Signed out locally.`,
      );
    }
  }
  deleteTokens(state.host, ctx.env);
  writeState({ host: state.host }, ctx.env);
  ctx.out(
    revoked ? "Signed out. This device's access is revoked." : 'Signed out on this computer.',
  );
  return 0;
}
