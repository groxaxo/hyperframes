import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanValidationError, normalizePlan, slugify, stableHash, validatePlan } from "./plan.mjs";

function basePlan() {
  return {
    version: 1,
    topic: "Why missed calls cost tradies money",
    video: {
      format: "long",
      title: "The Hidden Cost of Missed Calls",
      description: "A practical breakdown.",
      tags: ["small business", "automation"],
    },
    production: { provider_policy: "hybrid" },
    scenes: [
      {
        id: "hook",
        role: "hook",
        duration_s: 5,
        narration: "Every missed call may be a customer choosing someone else.",
        visual_prompt: "A phone ringing unanswered in a busy workshop",
      },
      {
        id: "broll-one",
        role: "broll",
        duration_s: 5,
        narration: "The leak compounds across an ordinary working week.",
        visual_prompt: "Cinematic trades workshop activity",
      },
    ],
  };
}

test("slugify creates stable kebab-case project slugs", () => {
  assert.equal(slugify("  Café & Calls: NZ!  "), "cafe-calls-nz");
});

test("hybrid normalization deliberately assigns both services", () => {
  const plan = normalizePlan(basePlan());
  assert.deepEqual(
    plan.scenes.map((scene) => scene.provider),
    ["gemini", "comfyui"],
  );
  assert.equal(plan.video.width, 1920);
  assert.equal(plan.video.height, 1080);
  assert.equal(plan.video.privacy, "private");
  assert.equal(plan.video.contains_synthetic_media, true);
});

test("explicit provider choices are preserved while hybrid fills missing rungs", () => {
  const raw = basePlan();
  raw.scenes[0].provider = "comfyui";
  raw.scenes[1].provider = "gemini";
  const { plan } = validatePlan(raw);
  assert.deepEqual(
    plan.scenes.map((scene) => scene.provider),
    ["comfyui", "gemini"],
  );
});

test("short defaults are vertical and enforce the three-minute ceiling", () => {
  const raw = basePlan();
  raw.video.format = "short";
  raw.scenes = Array.from({ length: 37 }, (_, index) => ({
    id: `scene-${index + 1}`,
    visual_prompt: "abstract motion",
    duration_s: 5,
  }));
  const result = validatePlan(raw, { throwOnError: false });
  assert.equal(result.plan.video.width, 1080);
  assert.equal(result.plan.video.height, 1920);
  assert.ok(result.errors.some((error) => /180 seconds/.test(error)));
});

test("metadata limits and scene ids are validated", () => {
  const raw = basePlan();
  raw.video.title = "x".repeat(101);
  raw.scenes[0].id = "Not Valid";
  assert.throws(() => validatePlan(raw), PlanValidationError);
});

test("narration density emits a warning rather than corrupting the plan", () => {
  const raw = basePlan();
  raw.scenes[0].duration_s = 2;
  raw.scenes[0].narration = "one two three four five six seven eight nine ten eleven twelve";
  const result = validatePlan(raw);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => /narration has/.test(warning)));
});

test("stableHash ignores object key insertion order", () => {
  assert.equal(stableHash({ b: 2, a: { y: 1, x: 0 } }), stableHash({ a: { x: 0, y: 1 }, b: 2 }));
});
