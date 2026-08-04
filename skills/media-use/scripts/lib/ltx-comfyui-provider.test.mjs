import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_LTX23_MODEL,
  bindComfyWorkflow,
  buildLtx23Bindings,
  ltx23ComfyUiGenerate,
  parseComfyApiWorkflow,
  resolveLtx23WorkflowPath,
} from "./ltx-comfyui-provider.mjs";

const API_WORKFLOW = {
  "1": {
    class_type: "LTXVGemmaCLIPTextEncode",
    inputs: { text: "{{PROMPT}}", negative: "{{NEGATIVE_PROMPT}}" },
  },
  "2": {
    class_type: "EmptyLTXVLatentVideo",
    inputs: { width: "{{WIDTH}}", height: "{{HEIGHT}}", length: "{{FRAMES}}" },
  },
  "3": {
    class_type: "RandomNoise",
    inputs: { noise_seed: "{{SEED}}" },
  },
  "4": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "{{MODEL}}" },
  },
  "5": {
    class_type: "SaveVideo",
    inputs: { filename_prefix: "{{FILENAME_PREFIX}}", frame_rate: "{{FPS}}" },
  },
};

function withWorkflow(run) {
  const dir = mkdtempSync(join(tmpdir(), "ltx23-workflow-"));
  const path = join(dir, "ltx23-api.json");
  writeFileSync(path, JSON.stringify(API_WORKFLOW));
  return Promise.resolve()
    .then(() => run({ dir, path }))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("resolveLtx23WorkflowPath resolves project-relative configuration", () => {
  assert.equal(
    resolveLtx23WorkflowPath(
      { projectDir: "/srv/project" },
      { COMFYUI_LTX23_WORKFLOW: "workflows/ltx23.json" },
    ),
    "/srv/project/workflows/ltx23.json",
  );
  assert.equal(resolveLtx23WorkflowPath({}, {}), null);
});

test("parseComfyApiWorkflow accepts bare and wrapped API prompts", () => {
  assert.deepEqual(parseComfyApiWorkflow(API_WORKFLOW), API_WORKFLOW);
  assert.deepEqual(parseComfyApiWorkflow({ prompt: API_WORKFLOW }), API_WORKFLOW);
  assert.throws(() => parseComfyApiWorkflow({ nodes: [], links: [] }), /Save \(API Format\)/);
  assert.throws(() => parseComfyApiWorkflow({ hello: "world" }), /contains no API nodes/);
});

test("buildLtx23Bindings is deterministic and respects LTX shape constraints", () => {
  const first = buildLtx23Bindings("A cinematic harbour reveal", {}, {});
  const second = buildLtx23Bindings("A cinematic harbour reveal", {}, {});
  assert.equal(first.SEED, second.SEED);
  assert.equal(first.WIDTH, 960);
  assert.equal(first.HEIGHT, 544);
  assert.equal(first.FRAMES, 121);
  assert.equal(first.FPS, 24);
  assert.equal(first.MODEL, DEFAULT_LTX23_MODEL);
  assert.equal(first.DURATION_SECONDS, 121 / 24);

  const vertical = buildLtx23Bindings("A vertical Instagram Reel", {}, {});
  assert.equal(vertical.WIDTH, 544);
  assert.equal(vertical.HEIGHT, 960);
  assert.throws(
    () => buildLtx23Bindings("x", {}, { COMFYUI_LTX23_FRAMES: "120" }),
    /8n\+1/,
  );
  assert.throws(
    () => buildLtx23Bindings("x", {}, { COMFYUI_LTX23_WIDTH: "950" }),
    /divisible by 32/,
  );
});

test("custom bindings can tune workflow-specific nodes without changing provider code", () => {
  const bindings = buildLtx23Bindings("A product shot", {}, {
    COMFYUI_LTX23_BINDINGS_JSON: JSON.stringify({ steps: 8, cfg: 1.2 }),
  });
  assert.equal(bindings.STEPS, 8);
  assert.equal(bindings.CFG, 1.2);
  assert.throws(
    () =>
      buildLtx23Bindings("A product shot", {}, {
        COMFYUI_LTX23_BINDINGS_JSON: JSON.stringify({ prompt: "override" }),
      }),
    /cannot override a built-in/,
  );
  assert.throws(
    () =>
      buildLtx23Bindings("A product shot", {}, {
        COMFYUI_LTX23_BINDINGS_JSON: JSON.stringify({ "bad-name": 1 }),
      }),
    /must match/,
  );
});

test("bindComfyWorkflow preserves scalar types and records each injected binding", () => {
  const bindings = buildLtx23Bindings("A cinematic harbour reveal", {}, {});
  const { prompt, counts } = bindComfyWorkflow(API_WORKFLOW, bindings);
  assert.equal(prompt["1"].inputs.text, "A cinematic harbour reveal");
  assert.equal(typeof prompt["2"].inputs.width, "number");
  assert.equal(prompt["2"].inputs.width, 960);
  assert.equal(prompt["2"].inputs.length, 121);
  assert.equal(prompt["4"].inputs.ckpt_name, DEFAULT_LTX23_MODEL);
  assert.equal(counts.PROMPT, 1);
  assert.equal(counts.WIDTH, 1);
  assert.equal(counts.FILENAME_PREFIX, 1);
});

test("bindComfyWorkflow requires a positive prompt binding and rejects unknown tokens", () => {
  assert.throws(
    () => bindComfyWorkflow({ "1": { class_type: "X", inputs: { text: "literal" } } }, {}),
    /no \{\{PROMPT\}\} placeholder/,
  );
  assert.throws(
    () =>
      bindComfyWorkflow(
        { "1": { class_type: "X", inputs: { text: "{{PROMPT}}", cfg: "{{UNKNOWN}}" } } },
        { PROMPT: "x" },
      ),
    /unresolved binding\(s\): UNKNOWN/,
  );
});

test("unconfigured ComfyUI provider falls through silently unless explicitly forced", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(message));
  assert.equal(await ltx23ComfyUiGenerate("x", {}, { env: {} }), null);
  assert.deepEqual(errors, []);
  assert.equal(
    await ltx23ComfyUiGenerate("x", { provider: "comfyui" }, { env: {} }),
    null,
  );
  assert.ok(errors.some((message) => /COMFYUI_LTX23_WORKFLOW/.test(message)));
});

test("successful generation runs the bound workflow and returns native-audio metadata", async () => {
  await withWorkflow(async ({ path }) => {
    let receivedPrompt;
    let receivedOptions;
    const result = await ltx23ComfyUiGenerate(
      "A vertical cinematic product reveal",
      { provider: "comfyui" },
      {
        env: {
          COMFYUI_URL: "http://renderbox:8188",
          COMFYUI_LTX23_WORKFLOW: path,
          COMFYUI_LTX23_SEED: "42",
        },
        executeWorkflow: async (prompt, options) => {
          receivedPrompt = prompt;
          receivedOptions = options;
          const file = {
            filename: "ltx/final-audio.mp4",
            type: "output",
            path: "9.videos.0",
          };
          return {
            promptId: "12345678-abcd-efgh",
            file,
            outputPath: options.outputPath(file, "12345678-abcd-efgh"),
          };
        },
      },
    );

    assert.ok(result);
    assert.equal(receivedPrompt["1"].inputs.text, "A vertical cinematic product reveal");
    assert.equal(receivedPrompt["2"].inputs.width, 544);
    assert.equal(receivedPrompt["2"].inputs.height, 960);
    assert.equal(receivedPrompt["3"].inputs.noise_seed, 42);
    assert.equal(receivedOptions.baseUrl, "http://renderbox:8188");
    assert.equal(result.ext, ".mp4");
    assert.equal(result.metadata.provider, "comfyui.ltx23");
    assert.equal(result.metadata.width, 544);
    assert.equal(result.metadata.height, 960);
    assert.equal(result.metadata.provenance.native_audio, true);
    assert.equal(result.metadata.provenance.prompt_id, "12345678-abcd-efgh");
    assert.equal(result.metadata.provenance.output_node_path, "9.videos.0");
  });
});

test("provider reports API-format mistakes and returns null instead of breaking the cascade", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ltx23-ui-workflow-"));
  const path = join(dir, "ui.json");
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(message));
  try {
    writeFileSync(path, JSON.stringify({ nodes: [], links: [] }));
    const result = await ltx23ComfyUiGenerate(
      "x",
      { provider: "comfyui" },
      { env: { COMFYUI_LTX23_WORKFLOW: path } },
    );
    assert.equal(result, null);
    assert.ok(errors.some((message) => /Save \(API Format\)/.test(message)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
