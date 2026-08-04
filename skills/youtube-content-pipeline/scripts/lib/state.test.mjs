import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  beginStage,
  completeStage,
  emptyState,
  failStage,
  invalidateFrom,
  readState,
  stageIsCurrent,
  writeState,
} from "./state.mjs";

test("stage lifecycle is resumable and input-hash aware", () => {
  let state = emptyState("plan-a");
  state = beginStage(state, "visuals", "visuals-a");
  assert.equal(state.stages.visuals.status, "running");
  state = completeStage(state, "visuals", { scene_manifest: "scenes.json" }, "visuals-a");
  assert.equal(stageIsCurrent(state, "visuals", "visuals-a"), true);
  assert.equal(stageIsCurrent(state, "visuals", "visuals-b"), false);
  assert.equal(state.artifacts.scene_manifest, "scenes.json");
  state = failStage(state, "audio", new Error("tts failed"));
  assert.equal(state.stages.audio.status, "failed");
  assert.match(state.stages.audio.error, /tts failed/);
});

test("plan hash changes invalidate generated stages", () => {
  let state = emptyState("old");
  state = completeStage(state, "visuals", { x: 1 }, "v");
  state = completeStage(state, "audio", { y: 2 }, "a");
  const next = invalidateFrom(state, "visuals", "new");
  assert.equal(next.plan_hash, "new");
  assert.equal(next.stages.visuals.status, "pending");
  assert.equal(next.stages.audio.status, "pending");
  assert.deepEqual(next.artifacts, {});
});

test("state writes atomically with private file permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-state-"));
  const path = join(dir, ".youtube-pipeline", "state.json");
  try {
    writeState(path, completeStage(emptyState("hash"), "plan", {}, "hash"));
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(raw.stages.plan.status, "complete");
    assert.equal(readState(path, "hash").plan_hash, "hash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
