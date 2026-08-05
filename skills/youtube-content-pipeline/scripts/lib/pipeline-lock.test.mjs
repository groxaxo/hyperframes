import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquirePipelineLock, PipelineLockError } from "./pipeline-lock.mjs";

test("only one mutating pipeline process can hold a project lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-lock-"));
  const path = join(dir, ".youtube-pipeline/run.lock");
  try {
    const release = acquirePipelineLock(path, {
      token: "first",
      pid: 11,
      host: "worker-a",
      now: () => 1_000,
    });
    assert.equal(existsSync(path), true);
    assert.throws(
      () =>
        acquirePipelineLock(path, {
          token: "second",
          pid: 12,
          host: "worker-b",
          now: () => 2_000,
        }),
      (error) => {
        assert.ok(error instanceof PipelineLockError);
        assert.equal(error.holder.pid, 11);
        return true;
      },
    );
    release();
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale lock can be taken over without allowing the old owner to remove the new lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-stale-lock-"));
  const path = join(dir, ".youtube-pipeline/run.lock");
  try {
    writeFileSync(
      path,
      JSON.stringify({ token: "stale", pid: 1, host: "old", started_at: "1970-01-01T00:00:00.000Z" }),
      { mode: 0o600 },
    );
    const release = acquirePipelineLock(path, {
      token: "replacement",
      pid: 2,
      host: "new",
      staleMs: 1_000,
      now: () => 10_000,
    });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "replacement");
    release();
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-lock-release-"));
  const path = join(dir, ".youtube-pipeline/run.lock");
  try {
    const release = acquirePipelineLock(path, { token: "once" });
    release();
    release();
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
