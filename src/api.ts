/**
 * The HQ API as the CLI sees it: the shared `HqClient` (`hq-client`, hq-vscode decision 4) with the
 * CLI's own defaults, so every caller and test keeps constructing it exactly as before:
 *
 *  - tokens in the OS keychain (`keychain.ts`) unless a `store` is passed;
 *  - the cross-process refresh lock in `~/.hq` (`HQ_HOME`);
 *  - `X-HQ-CLI-Version` (the header every CLI release sends) plus `X-HQ-Client: hq/<version>` and
 *    `X-HQ-Want-Nonce: 1` (decisions 22 and 24), on every request, nonce fetch and upgrade.
 */
import type { KeyObject } from 'node:crypto';
import {
  HQ_HEADER_CLI_VERSION,
  HQ_HEADER_CLIENT,
  HQ_HEADER_WANT_NONCE,
} from '@kpa/shared/remote.types';
import {
  HqClient as SharedHqClient,
  postJson as sharedPostJson,
  type FetchLike,
  type TokenStore,
} from '@hq/client/api.js';
import { loadTokens, saveTokens } from './keychain.js';
import { hqPaths } from './paths.js';
import { HQ_VERSION } from './version.js';

export {
  HqApiError,
  NotLoggedInError,
  RefreshBusyError,
  REFRESH_LOCK_STALE_MS,
  REFRESH_LOCK_WAIT_MS,
  REFRESH_MARGIN_MS,
  type FetchLike,
  type StoredTokens,
  type TokenStore,
} from '@hq/client/api.js';

/** The headers every `hq` request carries. */
export const CLI_CLIENT_HEADERS: Readonly<Record<string, string>> = {
  [HQ_HEADER_CLI_VERSION]: HQ_VERSION,
  [HQ_HEADER_CLIENT]: `hq/${HQ_VERSION}`,
  [HQ_HEADER_WANT_NONCE]: '1',
};

export interface HqClientOptions {
  host: string;
  key: KeyObject;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  now?: () => number;
  /** Override token storage (tests). */
  store?: TokenStore;
  /** Where the cross-process refresh lock lives. Default: `~/.hq` (`HQ_HOME`). */
  lockDir?: string;
}

export class HqClient extends SharedHqClient {
  constructor(opts: HqClientOptions) {
    const env = opts.env ?? process.env;
    super({
      host: opts.host,
      key: opts.key,
      store: opts.store ?? {
        load: (h) => loadTokens(h, env),
        save: (h, t) => saveTokens(h, t, env),
      },
      lockDir: opts.lockDir ?? hqPaths(env).home,
      clientHeaders: { ...CLI_CLIENT_HEADERS },
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
  }
}

/** Unauthenticated JSON POST (device start / poll) with the CLI's headers. */
export function postJson<T>(
  fetchFn: FetchLike,
  url: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  return sharedPostJson<T>(fetchFn, url, body, { ...CLI_CLIENT_HEADERS });
}
