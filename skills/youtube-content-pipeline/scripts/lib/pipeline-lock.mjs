import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export const DEFAULT_PIPELINE_LOCK_STALE_MS = 48 * 60 * 60 * 1000;

export class PipelineLockError extends Error {
  constructor(message, { lockPath = null, holder = null } = {}) {
    super(message);
    this.name = "PipelineLockError";
    this.code = "pipeline_locked";
    this.lockPath = lockPath;
    this.holder = holder;
  }
}

function readLock(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function stale(lock, staleMs, now) {
  const started = Date.parse(lock?.started_at || "");
  return Number.isFinite(started) && now() - started > staleMs;
}

export function acquirePipelineLock(
  lockPath,
  {
    staleMs = DEFAULT_PIPELINE_LOCK_STALE_MS,
    now = Date.now,
    token = randomUUID(),
    pid = process.pid,
    host = hostname(),
  } = {},
) {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const holder = readLock(lockPath);
    if (stale(holder, staleMs, now)) {
      rmSync(lockPath, { force: true });
      return acquirePipelineLock(lockPath, { staleMs, now, token, pid, host });
    }
    const detail = holder
      ? `holder pid=${holder.pid || "unknown"} host=${holder.host || "unknown"} started=${holder.started_at || "unknown"}`
      : "holder details unavailable";
    throw new PipelineLockError(`YouTube pipeline is already running (${detail})`, {
      lockPath,
      holder,
    });
  }

  const record = {
    token,
    pid,
    host,
    started_at: new Date(now()).toISOString(),
  };
  writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
  closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = readLock(lockPath);
    if (current?.token === token) rmSync(lockPath, { force: true });
  };
}
