import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_COMFYUI_TIMEOUT_MS,
  executeComfyWorkflow,
  normalizeComfyUiUrl,
} from "./comfyui-api.mjs";

export const LTX23_COMFYUI_PROVIDER = "comfyui.ltx23";
export const DEFAULT_LTX23_MODEL = "ltx-2.3-22b-distilled-1.1.safetensors";
export const DEFAULT_LTX23_WIDTH = 960;
export const DEFAULT_LTX23_HEIGHT = 544;
export const DEFAULT_LTX23_FRAMES = 121;
export const DEFAULT_LTX23_FPS = 24;
export const DEFAULT_LTX23_NEGATIVE_PROMPT =
  "worst quality, inconsistent motion, distorted anatomy, flicker, artifacts, subtitles, watermark";

const TOKEN_PATTERN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
const BINDING_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_BINDINGS = new Set([
  "PROMPT",
  "NEGATIVE_PROMPT",
  "SEED",
  "WIDTH",
  "HEIGHT",
  "FRAMES",
  "FPS",
  "MODEL",
  "FILENAME_PREFIX",
  "DURATION_SECONDS",
  "ASPECT_RATIO",
]);
const VERTICAL_INTENT =
  /\b(9\s*:\s*16|portrait|vertical|tiktok|reels?|instagram\s+story|youtube\s+shorts?)\b/i;

function forcedComfyUi(ctx) {
  const provider = String(ctx?.provider || "");
  return provider === "comfyui" || provider.startsWith("comfyui.");
}

function envValue(env, ...names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function resolveLtx23WorkflowPath(ctx = {}, env = process.env) {
  const configured =
    ctx.workflowPath || envValue(env, "COMFYUI_LTX23_WORKFLOW", "COMFYUI_LTX_WORKFLOW");
  if (!configured) return null;
  if (isAbsolute(configured)) return configured;
  return resolve(ctx.projectDir || process.cwd(), configured);
}

export function parseComfyApiWorkflow(raw, source = "workflow") {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : structuredClone(raw);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a ComfyUI API-format JSON object`);
  }
  if (Array.isArray(parsed.nodes) || Array.isArray(parsed.links)) {
    throw new Error(
      `${source} is a ComfyUI UI workflow; enable developer mode and export it with “Save (API Format)”`,
    );
  }
  const prompt =
    parsed.prompt && typeof parsed.prompt === "object" && !Array.isArray(parsed.prompt)
      ? parsed.prompt
      : parsed;
  const nodes = Object.entries(prompt).filter(
    ([, node]) =>
      node &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      typeof node.class_type === "string" &&
      node.inputs &&
      typeof node.inputs === "object" &&
      !Array.isArray(node.inputs),
  );
  if (!nodes.length) {
    throw new Error(
      `${source} contains no API nodes (expected node-id keys with { class_type, inputs })`,
    );
  }
  return structuredClone(prompt);
}

function parseCustomBindings(raw) {
  if (!raw || !String(raw).trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`COMFYUI_LTX23_BINDINGS_JSON is invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("COMFYUI_LTX23_BINDINGS_JSON must be a JSON object");
  }
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    const normalized = String(key).trim().toUpperCase();
    if (!BINDING_NAME_PATTERN.test(normalized)) {
      throw new Error(
        `custom ComfyUI binding name "${key}" must match ${BINDING_NAME_PATTERN}`,
      );
    }
    if (RESERVED_BINDINGS.has(normalized)) {
      throw new Error(
        `custom ComfyUI binding ${normalized} cannot override a built-in LTX-2.3 binding`,
      );
    }
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`custom ComfyUI binding ${normalized} must be a scalar JSON value`);
    }
    out[normalized] = value;
  }
  return out;
}

function integerSetting(name, value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const selected = value == null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return selected;
}

function promptSeed(intent) {
  return createHash("sha256").update(String(intent)).digest().readUInt32BE(0);
}

function promptSlug(intent) {
  const text = String(intent)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(String(intent)).digest("hex").slice(0, 8);
  return `${text || "video"}-${hash}`;
}

export function buildLtx23Bindings(intent, ctx = {}, env = process.env) {
  const vertical = VERTICAL_INTENT.test(String(intent));
  const defaultWidth = vertical ? DEFAULT_LTX23_HEIGHT : DEFAULT_LTX23_WIDTH;
  const defaultHeight = vertical ? DEFAULT_LTX23_WIDTH : DEFAULT_LTX23_HEIGHT;
  const width = integerSetting(
    "COMFYUI_LTX23_WIDTH",
    ctx.width ?? env.COMFYUI_LTX23_WIDTH,
    defaultWidth,
    { min: 32, max: 4096 },
  );
  const height = integerSetting(
    "COMFYUI_LTX23_HEIGHT",
    ctx.height ?? env.COMFYUI_LTX23_HEIGHT,
    defaultHeight,
    { min: 32, max: 4096 },
  );
  if (width % 32 !== 0 || height % 32 !== 0) {
    throw new Error("LTX-2.3 width and height must be divisible by 32");
  }
  const frames = integerSetting(
    "COMFYUI_LTX23_FRAMES",
    ctx.frames ?? env.COMFYUI_LTX23_FRAMES,
    DEFAULT_LTX23_FRAMES,
    { min: 9, max: 2_001 },
  );
  if (frames % 8 !== 1) {
    throw new Error("LTX-2.3 frame count must equal 8n+1 (for example 121 or 257)");
  }
  const fps = integerSetting(
    "COMFYUI_LTX23_FPS",
    ctx.fps ?? env.COMFYUI_LTX23_FPS,
    DEFAULT_LTX23_FPS,
    { min: 1, max: 60 },
  );
  const seed = integerSetting(
    "COMFYUI_LTX23_SEED",
    ctx.seed ?? env.COMFYUI_LTX23_SEED,
    promptSeed(intent),
    { min: 0, max: Number.MAX_SAFE_INTEGER },
  );
  const model = ctx.model || envValue(env, "COMFYUI_LTX23_MODEL") || DEFAULT_LTX23_MODEL;
  const negativePrompt =
    ctx.negativePrompt ||
    envValue(env, "COMFYUI_LTX23_NEGATIVE_PROMPT") ||
    DEFAULT_LTX23_NEGATIVE_PROMPT;
  const filenamePrefix =
    ctx.filenamePrefix ||
    envValue(env, "COMFYUI_LTX23_FILENAME_PREFIX") ||
    `hyperframes/ltx23-${promptSlug(intent)}`;

  return {
    PROMPT: String(intent).trim(),
    NEGATIVE_PROMPT: negativePrompt,
    SEED: seed,
    WIDTH: width,
    HEIGHT: height,
    FRAMES: frames,
    FPS: fps,
    MODEL: model,
    FILENAME_PREFIX: filenamePrefix,
    DURATION_SECONDS: frames / fps,
    ASPECT_RATIO: width < height ? "9:16" : "16:9",
    ...parseCustomBindings(env.COMFYUI_LTX23_BINDINGS_JSON),
  };
}

function bindValue(value, bindings, counts) {
  if (typeof value === "string") {
    const exact = /^\{\{([A-Z][A-Z0-9_]*)\}\}$/.exec(value);
    if (exact && Object.hasOwn(bindings, exact[1])) {
      counts[exact[1]] = (counts[exact[1]] || 0) + 1;
      return bindings[exact[1]];
    }
    return value.replace(TOKEN_PATTERN, (token, name) => {
      if (!Object.hasOwn(bindings, name)) return token;
      counts[name] = (counts[name] || 0) + 1;
      return String(bindings[name]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => bindValue(item, bindings, counts));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, bindValue(child, bindings, counts)]),
    );
  }
  return value;
}

function unresolvedTokens(value, found = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(TOKEN_PATTERN)) found.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) unresolvedTokens(item, found);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) unresolvedTokens(child, found);
  }
  return found;
}

export function bindComfyWorkflow(workflow, bindings) {
  const counts = {};
  const prompt = bindValue(workflow, bindings, counts);
  if (!counts.PROMPT) {
    throw new Error(
      "ComfyUI LTX-2.3 workflow has no {{PROMPT}} placeholder; export API format and replace the positive prompt text with {{PROMPT}}",
    );
  }
  const unresolved = [...unresolvedTokens(prompt)];
  if (unresolved.length) {
    throw new Error(`ComfyUI workflow has unresolved binding(s): ${unresolved.join(", ")}`);
  }
  return { prompt, counts };
}

export async function ltx23ComfyUiGenerate(intent, ctx = {}, deps = {}) {
  const env = deps.env || process.env;
  const workflowPath = resolveLtx23WorkflowPath(ctx, env);
  if (!workflowPath) {
    if (forcedComfyUi(ctx)) {
      console.error(
        "media-use: ComfyUI LTX-2.3 requires COMFYUI_LTX23_WORKFLOW pointing to an API-format workflow JSON",
      );
    }
    return null;
  }
  if (!existsSync(workflowPath)) {
    console.error(`media-use: ComfyUI LTX-2.3 workflow not found: ${workflowPath}`);
    return null;
  }

  try {
    const workflow = parseComfyApiWorkflow(readFileSync(workflowPath, "utf8"), workflowPath);
    const bindings = buildLtx23Bindings(intent, ctx, env);
    const { prompt, counts } = bindComfyWorkflow(workflow, bindings);
    const baseUrl = normalizeComfyUiUrl(env.COMFYUI_URL);
    const timeoutMs = integerSetting(
      "COMFYUI_LTX23_TIMEOUT_MS",
      env.COMFYUI_LTX23_TIMEOUT_MS,
      DEFAULT_COMFYUI_TIMEOUT_MS,
      { min: 1_000, max: 86_400_000 },
    );
    const pollIntervalMs = integerSetting(
      "COMFYUI_POLL_MS",
      env.COMFYUI_POLL_MS,
      2_000,
      { min: 0, max: 60_000 },
    );
    const execute = deps.executeWorkflow || executeComfyWorkflow;
    const generated = await execute(prompt, {
      baseUrl,
      env,
      timeoutMs,
      pollIntervalMs,
      fetch: deps.fetch,
      sleep: deps.sleep,
      now: deps.now,
      outputPath: (file, promptId) => {
        const extension = extname(file.filename).toLowerCase() || ".mp4";
        return join(
          tmpdir(),
          `media-use-ltx23-comfyui-${process.pid}-${promptId.slice(0, 8)}-${Date.now()}${extension}`,
        );
      },
    });
    const extension = extname(generated.outputPath).toLowerCase() || ".mp4";
    return {
      localPath: generated.outputPath,
      ext: extension,
      source: "generated",
      metadata: {
        description: intent,
        provider: LTX23_COMFYUI_PROVIDER,
        duration: bindings.DURATION_SECONDS,
        width: bindings.WIDTH,
        height: bindings.HEIGHT,
        provenance: {
          prompt: intent,
          model: bindings.MODEL,
          workflow: basename(workflowPath),
          seed: bindings.SEED,
          frames: bindings.FRAMES,
          fps: bindings.FPS,
          native_audio: true,
          prompt_id: generated.promptId,
          output_node_path: generated.file.path,
          bindings: counts,
        },
      },
    };
  } catch (error) {
    console.error(`media-use: ComfyUI LTX-2.3 failed: ${error?.message || error}`);
    return null;
  }
}
