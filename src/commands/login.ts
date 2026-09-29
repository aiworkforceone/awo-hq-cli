/**
 * `hq login` — the device flow (FEATURE.md §13, D1). The code is TYPED on the approval page, never
 * prefilled; the laptop only polls. Tokens go to the OS keychain, never to a file we can avoid.
 */
import type { DevicePollResponse, DeviceStartResponse } from '@kpa/shared/remote.types';
import { postJson } from '../api.js';
import type { Ctx } from '../context.js';
import { ensureDeviceKey } from '../device-key.js';
import { saveTokens } from '../keychain.js';
import { readState, writeState, normalizeHost } from '../state.js';
import { HQ_VERSION } from '../version.js';

function platformLabel(platform: NodeJS.Platform, arch: string): string {
  const os =
    platform === 'darwin'
      ? 'macOS'
      : platform === 'win32'
        ? 'Windows'
        : platform === 'linux'
          ? 'Linux'
          : platform;
  return `${os} ${arch}`;
}

/**
 * Is `url` a plain http(s) URL on exactly the configured HQ address? The login page URL comes from
 * the server; the CLI opens (and prints) only a URL on the address it is logging in to, so a
 * tampered answer cannot send a browser, or a Windows shell, anywhere else.
 */
export function isOnHost(url: string, host: string): boolean {
  let u: URL;
  let h: URL;
  try {
    u = new URL(url);
    h = new URL(host);
  } catch {
    return false;
  }
  if (u.origin !== h.origin || (u.protocol !== 'https:' && u.protocol !== 'http:')) return false;
  // Nothing a shell or a URL handler could read as a second argument or command.
  return !/[\s"'`<>|&^%]/.test(url);
}

export async function login(ctx: Ctx, opts: { host?: string }): Promise<number> {
  const state = readState(ctx.env);
  const host = opts.host ? normalizeHost(opts.host) : state.host;
  const key = ensureDeviceKey(ctx.env, `hq@${ctx.hostname()}`);
  const deviceLabel = ctx.hostname();
  const start = await postJson<DeviceStartResponse & { error?: string }>(
    ctx.fetch,
    `${host}/api/remote/device/start`,
    {
      clientName: 'hq',
      clientVersion: HQ_VERSION,
      platform: `${ctx.platform}-${ctx.arch}`,
      deviceLabel,
      devicePubkey: key.publicLine,
    },
  );
  if (start.status === 404) {
    ctx.err('hq: remote access is not available on this HQ yet.');
    return 1;
  }
  if (start.status !== 200) {
    ctx.err(`hq: ${start.body?.error ?? `could not start the login (HTTP ${start.status})`}`);
    return 1;
  }
  const s = start.body;
  // Only a URL on THIS HQ address is opened or printed; anything else falls back to our own page.
  const pageUrl = isOnHost(s.verificationUrl, host) ? s.verificationUrl : `${host}/device`;
  const openUrl = isOnHost(s.verificationUrlComplete, host) ? s.verificationUrlComplete : pageUrl;
  ctx.out(`Opening ${openUrl}`);
  ctx.out(`If your browser did not open, go to ${pageUrl} and enter:`);
  ctx.out('');
  ctx.out(`    ${s.userCode}`);
  ctx.out('');
  ctx.out(
    `This computer: ${deviceLabel} (hq ${HQ_VERSION}, ${platformLabel(ctx.platform, ctx.arch)})`,
  );
  ctx.out(
    `Waiting for approval (code expires in ${Math.round(s.expiresIn / 60)} min, Ctrl-C to cancel)...`,
  );
  ctx.openUrl(openUrl);

  let interval = Math.max(5, s.interval);
  const deadline = ctx.now() + s.expiresIn * 1000;
  while (ctx.now() < deadline) {
    await ctx.sleep(interval * 1000);
    const poll = await postJson<DevicePollResponse & { error?: string; code?: string }>(
      ctx.fetch,
      `${host}/api/remote/device/poll`,
      { deviceCode: s.deviceCode },
    );
    if (poll.status === 200 && poll.body.status === 'approved') {
      const approved = poll.body;
      saveTokens(
        host,
        {
          accessToken: approved.accessToken,
          accessExpiresAt: approved.accessExpiresAt,
          refreshToken: approved.refreshToken,
        },
        ctx.env,
      );
      writeState(
        { host, user: approved.user, grantId: approved.grantId, orgs: approved.orgs },
        ctx.env,
      );
      ctx.out(`Logged in as ${approved.user.email} · access renews automatically on this device`);
      if (approved.orgs.length > 0) {
        ctx.out(`Orgs: ${approved.orgs.map((o) => `${o.name} (${o.slug})`).join(', ')}`);
      }
      ctx.out('Next: hq ssh --config');
      return 0;
    }
    if (
      poll.status === 200 &&
      (poll.body.status === 'authorization_pending' || poll.body.status === 'slow_down')
    ) {
      interval = Math.max(interval, poll.body.interval);
      continue;
    }
    if (poll.status === 403) {
      ctx.err('hq: the login was denied in the browser.');
      return 1;
    }
    if (poll.status === 410) {
      ctx.err('hq: this login code expired. Run hq login again.');
      return 1;
    }
    if (poll.status === 429) {
      interval += 5;
      continue;
    }
    ctx.err(`hq: ${poll.body?.error ?? `login failed (HTTP ${poll.status})`}`);
    return 1;
  }
  ctx.err('hq: this login code expired. Run hq login again.');
  return 1;
}
