import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { completeStage, emptyState, writeState } from "./lib/state.mjs";
import { validatePlan } from "./lib/plan.mjs";
import { createInitialPlan, main, preflight, stagesThrough } from "./youtube-pipeline.mjs";

test("initial plan remains hybrid and does not introduce a paid H3 call by default", () => {
  const plan = createInitialPlan("How missed calls cost tradies money", "long");
  assert.equal(plan.production.provider_policy, "hybrid");
  assert.equal(plan.video.privacy, "private");
  assert.equal(plan.video.contains_synthetic_media, true);
  assert.ok(plan.scenes.some((scene) => scene.provider === "gemini"));
  assert.ok(plan.scenes.some((scene) => scene.provider === "comfyui"));
  assert.ok(plan.scenes.every((scene) => scene.provider !== "minimax"));
  assert.ok(plan.scenes.every((scene) => scene.narration === ""));
});

test("run defaults can stop at the preview-safe compose boundary", () => {
  assert.deepEqual(stagesThrough("compose"), ["plan", "visuals", "audio", "compose"]);
  assert.deepEqual(stagesThrough("package"), [
    "plan",
    "visuals",
    "audio",
    "compose",
    "render",
    "package",
  ]);
});

test("preflight follows the plan's provider policy and validates H3 resolution", () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-preflight-"));
  const previous = {
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
    MINIMAX_H3_RESOLUTION: process.env.MINIMAX_H3_RESOLUTION,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    COMFYUI_LTX23_WORKFLOW: process.env.COMFYUI_LTX23_WORKFLOW,
    COMFYUI_LTX_WORKFLOW: process.env.COMFYUI_LTX_WORKFLOW,
  };
  try {
    const plan = createInitialPlan("A tri-provider story", "long");
    plan.production.provider_policy = "tri-hybrid";
    plan.scenes[2].provider = "minimax";
    writeFileSync(join(dir, "youtube-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    delete process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_H3_RESOLUTION = "4K";
    const result = preflight(dir);
    assert.equal(result.provider_policy, "tri-hybrid");
    const h3 = result.checks.find((check) => check.name === "MiniMax-H3 API key");
    assert.equal(h3.optional, false);
    assert.equal(h3.ok, false);
    const resolution = result.checks.find((check) => check.name === "MiniMax-H3 resolution");
    assert.equal(resolution.optional, false);
    assert.equal(resolution.ok, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init and validate operate without provider or rendering side effects", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-pipeline-cli-"));
  const logs = [];
  t.mock.method(console, "log", (value) => logs.push(value));
  try {
    await main(["init", "--project", dir, "--topic", "A useful topic", "--json"]);
    assert.equal(existsSync(join(dir, "youtube-plan.json")), true);
    const created = JSON.parse(readFileSync(join(dir, "youtube-plan.json"), "utf8"));
    created.video.description = "A researched description.";
    created.scenes.forEach((scene, index) => {
      scene.narration = `Researched line ${index + 1}.`;
    });
    writeFileSync(join(dir, "youtube-plan.json"), `${JSON.stringify(created, null, 2)}\n`);
    await main(["validate", "--project", dir, "--json"]);
    assert.equal(existsSync(join(dir, ".youtube-pipeline/normalized-plan.json")), true);
    assert.equal(existsSync(join(dir, ".youtube-pipeline/state.json")), true);
    assert.ok(logs.some((value) => String(value).includes('"plan_hash"')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status exposes stale state when a completed artifact has disappeared", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-pipeline-status-"));
  const logs = [];
  t.mock.method(console, "log", (value) => logs.push(value));
  try {
    const raw = createInitialPlan("Artifact integrity", "long");
    raw.video.description = "Researched.";
    const validation = validatePlan(raw);
    writeFileSync(join(dir, "youtube-plan.json"), `${JSON.stringify(raw, null, 2)}\n`);
    mkdirSync(join(dir, ".youtube-pipeline"), { recursive: true });
    writeFileSync(
      join(dir, ".youtube-pipeline/normalized-plan.json"),
      JSON.stringify(validation.plan),
    );
    writeFileSync(
      join(dir, ".youtube-pipeline/scenes.json"),
      JSON.stringify({ scenes: { hook: { path: "assets/video/hook.mp4" } } }),
    );
    let state = emptyState(validation.hash);
    state = completeStage(
      state,
      "visuals",
      { scene_manifest: ".youtube-pipeline/scenes.json" },
      "visual-hash",
    );
    writeState(join(dir, ".youtube-pipeline/state.json"), state);

    await main(["status", "--project", dir, "--json"]);
    const report = JSON.parse(logs.at(-1));
    assert.equal(report.stages.visuals.status, "complete");
    assert.equal(report.artifact_integrity.visuals, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
