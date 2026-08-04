import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInitialPlan, main, stagesThrough } from "./youtube-pipeline.mjs";

test("initial plan is hybrid, private, disclosed, and contains no invented narration", () => {
  const plan = createInitialPlan("How missed calls cost tradies money", "long");
  assert.equal(plan.production.provider_policy, "hybrid");
  assert.equal(plan.video.privacy, "private");
  assert.equal(plan.video.contains_synthetic_media, true);
  assert.ok(plan.scenes.some((scene) => scene.provider === "gemini"));
  assert.ok(plan.scenes.some((scene) => scene.provider === "comfyui"));
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
    await import("node:fs").then(({ writeFileSync }) =>
      writeFileSync(join(dir, "youtube-plan.json"), `${JSON.stringify(created, null, 2)}\n`),
    );
    await main(["validate", "--project", dir, "--json"]);
    assert.equal(existsSync(join(dir, ".youtube-pipeline/normalized-plan.json")), true);
    assert.equal(existsSync(join(dir, ".youtube-pipeline/state.json")), true);
    assert.ok(logs.some((value) => String(value).includes('"plan_hash"')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
