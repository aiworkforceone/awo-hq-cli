/**
 * The per-device ed25519 key (FEATURE.md decision 6), made at `hq login`:
 *
 *  - ssh uses it (`IdentityFile ~/.hq/keys/id_ed25519`, `IdentitiesOnly yes`); the SSH door accepts
 *    exactly the key the ticket names, once per connection;
 *  - the CLI signs every state-changing request and both upgrades with it (`X-HQ-Device-Sig` over
 *    `nonce\nMETHOD\n/path\nsha256(body)`), so a stolen access token alone is useless (W3).
 *
 * Written in OpenSSH's own `openssh-key-v1` format (unencrypted), so every OpenSSH client reads it;
 * the private half never leaves this computer. Built with `node:crypto` only — no native module.
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deviceSignaturePayload } from '@kpa/shared/remote.types';
import { hqPaths } from './paths.js';

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function readString(buf: Buffer, offset: number): { value: Buffer; next: number } {
  if (offset + 4 > buf.length) throw new Error('truncated key');
  const len = buf.readUInt32BE(offset);
  const start = offset + 4;
  if (start + len > buf.length) throw new Error('truncated key');
  return { value: buf.subarray(start, start + len), next: start + len };
}

const KEY_TYPE = Buffer.from('ssh-ed25519');

/** The SSH wire blob of an ed25519 public key. */
function publicBlob(pub32: Buffer): Buffer {
  return Buffer.concat([sshString(KEY_TYPE), sshString(pub32)]);
}

export interface DeviceKey {
  /** `ssh-ed25519 <base64>` (no comment) — what the server stores on the grant. */
  publicLine: string;
  privateKey: KeyObject;
}

/** Serialize a key pair as an unencrypted `openssh-key-v1` PEM. */
export function toOpenSshPrivateKey(seed32: Buffer, pub32: Buffer, comment: string): string {
  const check = randomBytes(4);
  const priv = Buffer.concat([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(pub32),
    sshString(Buffer.concat([seed32, pub32])),
    sshString(Buffer.from(comment, 'utf8')),
  ]);
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString(Buffer.from('none')),
    sshString(Buffer.from('none')),
    sshString(Buffer.alloc(0)),
    Buffer.from([0, 0, 0, 1]),
    sshString(publicBlob(pub32)),
    sshString(Buffer.concat([priv, Buffer.from(pad)])),
  ]);
  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64.trim()}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** Parse an unencrypted `openssh-key-v1` ed25519 private key back into (seed, public). */
export function fromOpenSshPrivateKey(pem: string): { seed32: Buffer; pub32: Buffer } {
  const b64 = pem
    .replace('-----BEGIN OPENSSH PRIVATE KEY-----', '')
    .replace('-----END OPENSSH PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  const magic = 'openssh-key-v1\0';
  if (buf.subarray(0, magic.length).toString('latin1') !== magic)
    throw new Error('not an OpenSSH key');
  let off = magic.length;
  const cipher = readString(buf, off);
  off = cipher.next;
  if (cipher.value.toString() !== 'none') throw new Error('encrypted keys are not supported');
  off = readString(buf, off).next; // kdfname
  off = readString(buf, off).next; // kdfoptions
  const n = buf.readUInt32BE(off);
  off += 4;
  if (n !== 1) throw new Error('expected one key');
  off = readString(buf, off).next; // public blob
  const priv = readString(buf, off).value;
  let p = 8; // two check ints
  const type = readString(priv, p);
  p = type.next;
  if (type.value.toString() !== 'ssh-ed25519') throw new Error('not an ed25519 key');
  const pub = readString(priv, p);
  p = pub.next;
  const both = readString(priv, p).value;
  if (both.length !== 64 || pub.value.length !== 32) throw new Error('malformed ed25519 key');
  return { seed32: Buffer.from(both.subarray(0, 32)), pub32: Buffer.from(pub.value) };
}

function keyObjectFromSeed(seed32: Buffer, pub32: Buffer): KeyObject {
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: seed32.toString('base64url'),
      x: pub32.toString('base64url'),
    },
    format: 'jwk',
  });
}

export function publicLineOf(pub32: Buffer): string {
  return `ssh-ed25519 ${publicBlob(pub32).toString('base64')}`;
}

/** Load the device key, creating it (0600, in a 0700 dir) when absent. */
export function ensureDeviceKey(env: NodeJS.ProcessEnv = process.env, comment = 'hq'): DeviceKey {
  const paths = hqPaths(env);
  if (existsSync(paths.privateKey)) return loadDeviceKey(env);
  mkdirSync(paths.keysDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.home, 0o700);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwkPriv = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  const seed32 = Buffer.from(jwkPriv.d, 'base64url');
  const pub32 = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  writeFileSync(paths.privateKey, toOpenSshPrivateKey(seed32, pub32, comment), { mode: 0o600 });
  writeFileSync(paths.publicKey, `${publicLineOf(pub32)} ${comment}\n`, { mode: 0o644 });
  return { publicLine: publicLineOf(pub32), privateKey: keyObjectFromSeed(seed32, pub32) };
}

export function loadDeviceKey(env: NodeJS.ProcessEnv = process.env): DeviceKey {
  const { seed32, pub32 } = fromOpenSshPrivateKey(readFileSync(hqPaths(env).privateKey, 'utf8'));
  return { publicLine: publicLineOf(pub32), privateKey: keyObjectFromSeed(seed32, pub32) };
}

/** Lowercase hex sha256. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `X-HQ-Device-Sig` for one request. */
export function signRequest(
  key: KeyObject,
  nonce: string,
  method: string,
  path: string,
  body: Buffer | string,
): string {
  const payload = deviceSignaturePayload(nonce, method, path, sha256Hex(body));
  return sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
}
