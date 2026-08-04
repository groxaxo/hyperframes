import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PLAN_VERSION = 1;
export const PROVIDERS = new Set(["gemini", "comfyui"]);
export const PROVIDER_POLICIES = new Set(["hybrid", "gemini", "comfyui"]);
export const FORMATS = new Set(["long", "short"]);
export const PRIVACY_VALUES = new Set(["private", "unlisted", "public"]);
export const DEFAULT_NEGATIVE_PROMPT =
  "text, subtitles, logos, watermarks, flicker, temporal jitter, warped anatomy, duplicate subjects, compression artifacts";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ROLE_GEMINI = new Set(["hook", "hero", "demo", "cta", "reveal"]);

export class PlanValidationError extends Error {
  constructor(errors, warnings = []) {
    super(`YouTube plan validation failed:\n${errors.map((e) => `- ${e}`).join("\n")}`);
    this.name = "PlanValidationError";
    this.errors = errors;
    this.warnings = warnings;
  }
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function string(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => string(item)).filter(Boolean)
    : [];
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

export function slugify(value) {
  return string(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function stableHash(value) {
  const sorted = stableSort(value);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableSort(value[key])]),
  );
}

function normalizeVideo(raw, format, topic) {
  const video = object(raw);
  const isShort = format === "short";
  const title = string(video.title, topic || "Untitled YouTube video");
  const slug = slugify(video.slug || title) || "youtube-video";
  return {
    slug,
    format,
    title,
    description: string(video.description),
    tags: stringArray(video.tags),
    category_id: string(video.category_id, "28"),
    privacy: PRIVACY_VALUES.has(video.privacy) ? video.privacy : "private",
    made_for_kids: boolean(video.made_for_kids, false),
    contains_synthetic_media: boolean(video.contains_synthetic_media, true),
    language: string(video.language, "en-NZ"),
    width: Math.round(number(video.width, isShort ? 1080 : 1920)),
    height: Math.round(number(video.height, isShort ? 1920 : 1080)),
    fps: Math.round(number(video.fps, 30)),
    thumbnail: {
      headline: string(object(video.thumbnail).headline, title),
      subhead: string(object(video.thumbnail).subhead),
      accent: string(object(video.thumbnail).accent, "#7c3aed"),
    },
  };
}

function normalizeProduction(raw) {
  const production = object(raw);
  const providerPolicy = PROVIDER_POLICIES.has(production.provider_policy)
    ? production.provider_policy
    : "hybrid";
  return {
    provider_policy: providerPolicy,
    gemini_voice: string(production.gemini_voice, "Kore"),
    transition_s: Math.max(0, number(production.transition_s, 0.3)),
    lead_in_s: Math.max(0, number(production.lead_in_s, 0.25)),
    tail_s: Math.max(0, number(production.tail_s, 0.35)),
    words_per_minute: Math.max(80, Math.min(240, number(production.words_per_minute, 165))),
    max_concurrency: Math.max(1, Math.min(8, Math.round(number(production.max_concurrency, 1)))),
    default_native_audio: ["mute", "duck", "keep"].includes(production.default_native_audio)
      ? production.default_native_audio
      : "mute",
    background_music: boolean(production.background_music, false),
    background_music_query: string(
      production.background_music_query,
      "subtle modern documentary underscore",
    ),
  };
}

function initialProvider(scene, policy, index) {
  if (PROVIDERS.has(scene.provider)) return scene.provider;
  if (policy === "gemini" || policy === "comfyui") return policy;
  if (ROLE_GEMINI.has(scene.role)) return "gemini";
  return index === 0 ? "gemini" : "comfyui";
}

function ensureHybridProviders(scenes) {
  if (scenes.length < 2) return scenes;
  const hasGemini = scenes.some((scene) => scene.provider === "gemini");
  const hasComfy = scenes.some((scene) => scene.provider === "comfyui");
  const result = scenes.map((scene) => ({ ...scene }));
  if (!hasGemini) result[0].provider = "gemini";
  if (!hasComfy) {
    const target = result.findIndex((scene, index) => index > 0 && !scene.provider_explicit);
    result[target >= 0 ? target : result.length - 1].provider = "comfyui";
  }
  return result;
}

function normalizeScenes(raw, production) {
  const items = Array.isArray(raw) ? raw : [];
  let scenes = items.map((input, index) => {
    const scene = object(input);
    const id = string(scene.id, `scene-${String(index + 1).padStart(2, "0")}`);
    const role = string(scene.role, index === 0 ? "hook" : "broll").toLowerCase();
    const duration = Math.max(1, number(scene.duration_s, 5));
    const explicitProvider = PROVIDERS.has(scene.provider);
    return {
      id,
      role,
      provider: initialProvider(scene, production.provider_policy, index),
      provider_explicit: explicitProvider,
      duration_s: duration,
      narration: string(scene.narration),
      visual_prompt: string(scene.visual_prompt),
      negative_prompt: string(scene.negative_prompt, DEFAULT_NEGATIVE_PROMPT),
      on_screen_text: string(scene.on_screen_text),
      native_audio: ["mute", "duck", "keep"].includes(scene.native_audio)
        ? scene.native_audio
        : production.default_native_audio,
      fallback_provider: PROVIDERS.has(scene.fallback_provider)
        ? scene.fallback_provider
        : null,
    };
  });
  if (production.provider_policy === "hybrid") scenes = ensureHybridProviders(scenes);
  return scenes.map(({ provider_explicit: _private, ...scene }) => scene);
}

function validateMetadata(plan, errors) {
  if (!plan.video.title) errors.push("video.title is required");
  if (plan.video.title.length > 100) errors.push("video.title must be at most 100 characters");
  if (/[<>]/.test(plan.video.title)) errors.push("video.title cannot contain < or >");
  if (byteLength(plan.video.description) > 5000)
    errors.push("video.description must be at most 5000 UTF-8 bytes");
  if (/[<>]/.test(plan.video.description)) errors.push("video.description cannot contain < or >");
  const tagsLength = plan.video.tags
    .map((tag) => (tag.includes(" ") ? `\"${tag}\"` : tag))
    .join(",").length;
  if (tagsLength > 500) errors.push("video.tags exceed YouTube's 500-character encoded limit");
}

function validateDimensions(plan, errors) {
  const { width, height, fps, format } = plan.video;
  if (!Number.isInteger(width) || width < 320 || width > 7680)
    errors.push("video.width must be an integer between 320 and 7680");
  if (!Number.isInteger(height) || height < 320 || height > 7680)
    errors.push("video.height must be an integer between 320 and 7680");
  if (!Number.isInteger(fps) || fps < 24 || fps > 60)
    errors.push("video.fps must be an integer between 24 and 60");
  if (format === "short" && height < width)
    errors.push("short-form videos must be square or vertical (height >= width)");
}

function validateScenes(plan, errors, warnings) {
  if (plan.scenes.length === 0) errors.push("at least one scene is required");
  const ids = new Set();
  for (const [index, scene] of plan.scenes.entries()) {
    const prefix = `scenes[${index}]`;
    if (!ID_RE.test(scene.id)) errors.push(`${prefix}.id must be a kebab-case identifier`);
    if (ids.has(scene.id)) errors.push(`${prefix}.id duplicates ${scene.id}`);
    ids.add(scene.id);
    if (!scene.visual_prompt) errors.push(`${prefix}.visual_prompt is required`);
    if (!PROVIDERS.has(scene.provider)) errors.push(`${prefix}.provider must be gemini or comfyui`);
    if (scene.fallback_provider === scene.provider)
      errors.push(`${prefix}.fallback_provider must differ from provider`);
    const estimatedWords = Math.floor(
      (scene.duration_s * plan.production.words_per_minute) / 60,
    );
    const actualWords = scene.narration ? scene.narration.split(/\s+/).filter(Boolean).length : 0;
    if (actualWords > estimatedWords + 2) {
      warnings.push(
        `${prefix}.narration has ${actualWords} words for ${scene.duration_s}s; target about ${estimatedWords} to avoid extending the shot`,
      );
    }
  }

  if (plan.production.provider_policy === "hybrid" && plan.scenes.length >= 2) {
    if (!plan.scenes.some((scene) => scene.provider === "gemini"))
      errors.push("hybrid production requires at least one Gemini scene");
    if (!plan.scenes.some((scene) => scene.provider === "comfyui"))
      errors.push("hybrid production requires at least one ComfyUI scene");
  }
}

export function normalizePlan(raw) {
  const root = object(raw);
  const topic = string(root.topic);
  const format = FORMATS.has(object(root.video).format) ? object(root.video).format : "long";
  const production = normalizeProduction(root.production);
  const plan = {
    version: PLAN_VERSION,
    topic,
    channel: {
      name: string(object(root.channel).name),
      audience: string(object(root.channel).audience),
    },
    video: normalizeVideo(root.video, format, topic),
    production,
    scenes: normalizeScenes(root.scenes, production),
  };
  return plan;
}

export function validatePlan(raw, { throwOnError = true } = {}) {
  const plan = normalizePlan(raw);
  const errors = [];
  const warnings = [];
  if (Number(raw?.version ?? PLAN_VERSION) !== PLAN_VERSION)
    errors.push(`version must be ${PLAN_VERSION}`);
  if (!plan.topic) errors.push("topic is required");
  validateMetadata(plan, errors);
  validateDimensions(plan, errors);
  validateScenes(plan, errors, warnings);
  const totalDuration = plan.scenes.reduce((sum, scene) => sum + scene.duration_s, 0);
  if (plan.video.format === "short" && totalDuration > 180)
    errors.push("YouTube Shorts must not exceed 180 seconds");
  if (throwOnError && errors.length) throw new PlanValidationError(errors, warnings);
  return {
    ok: errors.length === 0,
    plan,
    errors,
    warnings,
    total_duration_s: totalDuration,
    hash: stableHash(plan),
  };
}

export function readPlan(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PlanValidationError([`cannot parse ${path}: ${error?.message || error}`]);
  }
  return validatePlan(parsed);
}
