/**
 * A cross-process lock file, the pattern `HqClient.acquireRefreshLock` (api.ts) uses: created with
 * O_EXCL (atomic on every local filesystem) and carrying OUR random token. A lock whose mtime is
 * older than `staleMs` belongs to a process that died holding it and is broken; after `waitMs` of
 * waiting we break it ourselves rather than hang an editor's ProxyCommand. The release removes the
 * file only while it still carries our token, so a lock broken and re-taken by another process is
 * never deleted from under it. Real time, not an injected clock: file mtimes are wall-clock.
 */
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function acquireFileLock(
  file: string,
  opts: { staleMs?: number; waitMs?: number } = {},
): Promise<() => void> {
  const staleMs = opts.staleMs ?? 10_000;
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  const mine = `${process.pid}:${randomBytes(8).toString('hex')}`;
  let delay = 10;
  for (;;) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(file, 'utf8') === mine) rmSync(file, { force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(file).mtimeMs;
    } catch {
      continue; // released between our open and our stat: try again at once
    }
    if (age > staleMs || Date.now() > deadline) {
      rmSync(file, { force: true });
      continue;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 250);
  }
}
