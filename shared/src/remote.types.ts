/**
 * remote-dev-access — the WIRE CONTRACT shared by the server (`src/remote/*`, `src/api/remote.ts`),
 * the HQ client (Settings, `/device`, Account → Devices) and the `hq` CLI (`cli/`).
 *
 * One file so the three can never disagree about a header name, a token prefix or a response shape.
 * Mirrors `designs/remote-dev-access/contracts/openapi.yaml` and `contracts/events.json`.
 *
 * ⛔ PURE. No `node:crypto`, no DOM, no Node built-ins: the client bundle imports this module too.
 *    Anything that signs or hashes lives in `src/remote/` (server) or `cli/src/` (laptop).
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Credentials and headers
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Access token prefix (15 min). The prefix is what lets secret scanners match a leaked one. */
export const REMOTE_ACCESS_TOKEN_PREFIX = 'hqa_';
/** Refresh token prefix (rotates on every use; reuse revokes the family). */
export const REMOTE_REFRESH_TOKEN_PREFIX = 'hqr_';
/** Shim token prefix (the in-container `claude` shim, read from `<remoteHome>/.hq/current.json`). */
export const REMOTE_SHIM_TOKEN_PREFIX = 'hqs_';
/** Every token body is 32 random bytes as base64url: 43 characters. */
export const REMOTE_TOKEN_BODY_CHARS = 43;

export const REMOTE_ACCESS_TTL_SEC = 15 * 60;
export const REMOTE_REFRESH_IDLE_TTL_SEC = 30 * 24 * 60 * 60;
export const REMOTE_REFRESH_ABSOLUTE_TTL_SEC = 90 * 24 * 60 * 60;
/** Device code / user code lifetime (RFC 8628 `expires_in`). */
export const REMOTE_DEVICE_CODE_TTL_SEC = 600;
/** RFC 8628 default polling interval, and the `slow_down` increment. */
export const REMOTE_POLL_INTERVAL_SEC = 5;
/** Device-signature nonce lifetime. Single use. */
export const REMOTE_NONCE_TTL_SEC = 60;
/** One-time connect code lifetime (S4: header only). */
export const REMOTE_CONNECT_CODE_TTL_SEC = 60;

/** RFC 8628 §6.1: a base-20 consonant alphabet, no vowels (no accidental words), no lookalikes. */
export const REMOTE_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
/** `XXXX-XXXX`. */
export const REMOTE_USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

export const HQ_HEADER_ORG = 'x-hq-org';
export const HQ_HEADER_NONCE = 'x-hq-nonce';
export const HQ_HEADER_DEVICE_SIG = 'x-hq-device-sig';
export const HQ_HEADER_CONNECT_CODE = 'x-hq-connect-code';
export const HQ_HEADER_CLI_VERSION = 'x-hq-cli-version';

/**
 * The bytes a device signature covers, as one string: `nonce\nMETHOD\n/path\nsha256hex(body)`.
 *
 * Newline-separated rather than concatenated, so no field can bleed into the next (`nonce || method`
 * with a method of `POST` and a path starting with `T` is otherwise ambiguous). The PATH is the
 * request path WITHOUT the query string; the body hash is the lowercase hex SHA-256 of the exact
 * request body bytes (empty body → the hash of the empty string). Both ends build the payload with
 * THIS function, so the order cannot drift.
 */
export function deviceSignaturePayload(
  nonce: string,
  method: string,
  path: string,
  bodySha256Hex: string,
): string {
  return `${nonce}\n${method.toUpperCase()}\n${path}\n${bodySha256Hex.toLowerCase()}`;
}

/** SHA-256 of the empty string, lowercase hex — the body hash of a GET or an upgrade. */
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Device authorization (hq login)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface DeviceStartRequest {
  clientName: 'hq';
  clientVersion: string;
  platform: string;
  deviceLabel?: string;
  /** One `ssh-ed25519 <base64>` line; the per-device key made at `hq login` (decision 6). */
  devicePubkey: string;
}

export interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResponse =
  | { status: 'authorization_pending' | 'slow_down'; interval: number }
  | {
      status: 'approved';
      /** This device's grant id — what `hq logout` revokes (`DELETE /api/remote/grants/:id`). */
      grantId: string;
      accessToken: string;
      accessExpiresAt: string;
      refreshToken: string;
      user: { id: string; email: string; name: string };
      orgs: RemoteOrg[];
    };

export interface DeviceLookupOrg {
  id: string;
  slug: string;
  name: string;
  requires2fa: boolean;
  /** How many teams in this org the approver may reach over SSH (the "N teams" sentence, S3). */
  teams: number;
}

export interface DeviceLookupResponse {
  deviceLabel: string;
  clientVersion: string;
  platform: string;
  requestedAt: string;
  requesterIp: string;
  requesterCountry: string | null;
  orgs: DeviceLookupOrg[];
  /** S3: the request came from a different IP / country than the approving browser. */
  mismatch: { ip: boolean; country: boolean };
  /** True when the approver must type a TOTP (enrolled, or any org mandates 2FA). */
  totpRequired: boolean;
}

export interface DeviceApproveRequest {
  userCode: string;
  orgIds: string[];
  totpCode?: string;
}

export interface TokenRefreshRequest {
  refreshToken: string;
}

export interface TokenPair {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
}

export interface NonceResponse {
  nonce: string;
  expiresIn: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Orgs, teams, capabilities (bearer)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** `asleep` = idle-slept (a connect or `hq up` wakes it); `stopped` = no machine (never started or stopped). */
export type RemoteWorkspaceState = 'running' | 'starting' | 'asleep' | 'stopped';

export interface RemoteWorkspace {
  id: string;
  /** `hq-<first 8 hex of the workspace id>`, extended to 12 on a prefix collision (the CLI does it). */
  alias: string;
  name: string;
  state: RemoteWorkspaceState;
  rights: { ssh: boolean; forward: boolean; attach: boolean };
  /**
   * False only when the machine's report PROVES its image lacks SSH ("machine needs an update",
   * D12). A team whose machine never started, or has not reported yet, is not judged (FAIL 6).
   */
  supported: boolean;
  hostKeyFingerprint?: string;
  hostKey?: string;
}

export interface RemoteOrg {
  id: string;
  slug: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  remoteAccess: { allowed: boolean; reason?: RemoteAccessDeniedReason };
  workspaces: RemoteWorkspace[];
}

/** Why an org's remote access is not available to this member. A closed vocabulary, never text. */
export type RemoteAccessDeniedReason =
  | 'org_disabled'
  | 'advanced_terminal_off'
  | 'plan_inactive'
  | 'feature_not_in_plan'
  | 'staged_rollout'
  | 'two_factor_required';

export interface RemoteCapabilities {
  ssh?: number;
  /**
   * The door's `claude` shim report, or `false` on a team whose engines do not include Claude Code
   * (a Codex-only team, train 26): the shim refuses there, whatever the machine carries.
   */
  shim?: number | false;
  ideBridge?: number;
  sftp?: boolean;
  hostKeyFingerprint?: string;
  hostKey?: string;
  tunnel?: number;
}

export interface RemoteCapabilitiesResponse {
  state: RemoteWorkspaceState;
  supported: boolean;
  checkedAt: string;
  capabilities?: RemoteCapabilities;
}

export type RemoteScope = 'ssh' | 'forward';
export type RemoteClientKind =
  | 'vscode'
  | 'cursor'
  | 'jetbrains'
  | 'zed'
  | 'ssh'
  | 'sshfs'
  | 'hq'
  | 'unknown';
export const REMOTE_CLIENT_KINDS: readonly RemoteClientKind[] = [
  'vscode',
  'cursor',
  'jetbrains',
  'zed',
  'ssh',
  'sshfs',
  'hq',
  'unknown',
];

export interface ConnectionRequest {
  scope: RemoteScope;
  /** forward only; ≥ 1024. */
  port?: number;
  /** forward only; informational. */
  localPort?: number;
  client: RemoteClientKind;
  /** A HINT. The server classifies reconnects itself (decision 23). */
  intent: 'open' | 'reconnect';
  /** `--wake`: forces `open` and counts as a human signal. */
  wake?: boolean;
}

export interface ConnectionReady {
  id: string;
  state: 'ready';
  connectCode: string;
  hostKey: string | null;
  expiresAt: string;
}

export interface ConnectionWaking {
  id: string;
  state: 'waking';
  code: 'SESSION_RESUMING' | 'SESSION_RESUME_COLD_RESTART' | 'SESSION_RESUME_FAILED';
}

export interface RemoteSessionSummary {
  id: string;
  name: string;
  ownerName: string;
  status: 'running' | 'idle' | 'stopped';
  canType: boolean;
  /**
   * local-echo (Decision 18): the `KR_LOCAL_ECHO` env flag AND the org's `local_echo_enabled` both
   * allow Instant Local Echo. `hq attach --local-echo` predicts only when this is `true`; ABSENT (an
   * older HQ) reads as false, so the org kill switch holds whatever CLI version attaches.
   */
  localEchoAvailable?: boolean;
}

export interface ShimSessionCreateRequest {
  term: string;
  cols: number;
  rows: number;
  initialPrompt?: string;
}

export interface ShimSessionCreateResponse {
  sessionId: string;
  url: string;
  canType: boolean;
}

/**
 * The `claude` shim's answer on a team whose engines do not include Claude Code (a Codex-only team):
 * `409 SHIM_ENGINE_UNSUPPORTED`, printed verbatim by the shim (src/runner/hq-shim/logic.ts carries
 * the same sentence; a test pins the two together). Plain words, no em dash.
 */
export const REMOTE_SHIM_ENGINE_UNSUPPORTED_MESSAGE =
  'This team runs Codex; the claude command works on Claude teams.';

/** `<remoteHome>/.hq/current.json` (events.json CurrentConnectionFile). Written by the door. */
export interface CurrentConnectionFile {
  v: 1;
  connId: string;
  shimToken: string;
  workspaceId: string;
  orgSlug: string;
  hqHost: string;
  at: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Cookie (HQ UI) surfaces
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type RemotePresenceClient =
  | 'vscode'
  | 'cursor'
  | 'zed'
  | 'jetbrains'
  | 'sftp'
  | 'terminal'
  | 'unknown'
  | 'forward';

export interface RemotePresenceEntry {
  connectionId: string;
  userId: string;
  displayName: string;
  client: RemotePresenceClient;
  scope: RemoteScope;
  since: string;
}

export interface RemotePresenceResponse {
  connections: RemotePresenceEntry[];
  unmanagedClaude: { ssh: number; shell: number; orphan: number; measuredAt: string | null };
}

export interface RemoteGrantRow {
  id: string;
  userId: string;
  displayName: string;
  deviceLabel: string;
  platform: string;
  approvedAt: string;
  lastUsedAt: string | null;
}

export interface RemoteConnectionRow {
  id: string;
  userId: string;
  displayName: string;
  client: string;
  workspaceId: string;
  workspaceName: string;
  scope: RemoteScope;
  since: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Owner copy (review W7 / Test Plan A6e): ONE source for the Settings description and the consent,
// served by `GET /api/org/remote/availability` and rendered by the Settings page. Decision 22: both
// say that SSH shells receive the team's stored secrets and that SSH output is not masked.
// Decision 18: never names VS Code. No em dashes.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const REMOTE_ACCESS_SETTING_DESCRIPTION =
  "Let members with raw-shell rights connect from their laptop editor over SSH. Members connected over SSH receive this team's stored secrets in their shell, and SSH output is not masked. Every connection is recorded in the audit log.";

export const REMOTE_ACCESS_CONSENT_PARAGRAPHS: readonly string[] = [
  "Members who can use the Advanced terminal will be able to connect to their team's machine from their own computer over SSH, using Remote-SSH-compatible editors such as Cursor, JetBrains Gateway or Zed, or sshfs.",
  "Everyone on a team machine shares one system account. Anyone connected over SSH can read, and can use, everything any session on that machine can read, including other members' Claude sign-ins, the team's session history, and the secrets passed to running sessions. Every member with a Claude sign-in on these machines will be notified and can remove it.",
  "Files in the shared team folder (editor tasks set to run on open, git hooks, .envrc) run in every member's editor and outlive a member's removal.",
  "Members connected over SSH receive this team's stored secrets and variables in their shell environment, and output over SSH is not masked, so a secret can be shown on their computer. Every connection records which secret names were delivered. Secret masking in HQ reduces accidental leaks; it is not a security boundary.",
  'Editor extensions and tools your members install run on the team machine with the same access.',
  "Machines can reach the internet. Tunnels or public exposure your members create are your organisation's responsibility under our Acceptable Use Policy.",
  'Every connection is recorded in your audit log. You can turn this off at any time; open connections close within 30 seconds.',
];

/** `GET /api/org/remote/availability` — whether Settings may offer the switch, and what it says. */
export interface RemoteAvailabilityResponse {
  /** `KR_REMOTE_ACCESS` is on for this deploy. */
  flag: boolean;
  /** The org is on `KR_REMOTE_ACCESS_ORGS` (or no allow-list is set). */
  allowListed: boolean;
  /** The plan carries `remote_access`. */
  planIncludes: boolean;
  /** The owner-facing copy (A6e). */
  copy: { setting: string; consent: readonly string[] };
  /**
   * Teams whose RUNNING machine booted before remote access was turned on, so it must restart
   * before SSH works (its relay still accepts its static bearer: DEF-201 condition d, review W11).
   */
  restartNeeded: string[];
}

export interface RemoteMemberNotice {
  workspaceId: string;
  workspaceName: string;
  otherMembers: number;
  createdAt: string;
}

/** The org settings keys this feature adds (both owner-editable through `PUT /api/org`). */
export type RemoteUnmanagedPolicy = 'label' | 'kill';

/** Thin `remote-presence-changed` frame (events.json RemotePresenceChangedFrame). */
export interface RemotePresenceChangedFrame {
  type: 'remote-presence-changed';
  workspaceId: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Close codes (tunnel.md rev 2 §5, events.json TunnelCloseCodes)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const REMOTE_CLOSE_UNAUTHORIZED = 4401;
export const REMOTE_CLOSE_SSH_KEY_REFUSED = 4420;
export const REMOTE_CLOSE_SSH_CONN_REVOKED = 4421;
export const REMOTE_CLOSE_SSH_IDLE_SLEEP = 4422;
export const REMOTE_CLOSE_SSH_LIFETIME = 4423;
export const REMOTE_CLOSE_RUNNER_UNAVAILABLE = 4503;

/**
 * The workspace alias the CLI writes into `~/.ssh/hq_config` (`Host hq-<8hex>`). `workspaces` has no
 * slug column, so the alias is derived from the id: stable across renames, unique enough, and the
 * CLI widens it to 12 hex when two of the user's teams collide on 8.
 */
export function workspaceAlias(workspaceId: string, hexChars = 8): string {
  return `hq-${workspaceId.replace(/-/g, '').slice(0, hexChars).toLowerCase()}`;
}
