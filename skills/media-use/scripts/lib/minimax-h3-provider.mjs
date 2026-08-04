import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MINIMAX_H3_MODEL,
  MiniMaxH3ApiError,
  minimaxApiKey,
  runMiniMaxH3Video,
} from "./minimax-h3-api.mjs";

export const MINIMAX_H3_PROVIDER = "minimax.h3";
export const MINIMAX_H3_RATIOS = new Set([
  "adaptive",
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
]);

const VERTICAL_INTENT =
  /\b(9\s*:\s*16|portrait|vertical|tiktok|reels?|instagram\s+story|youtube\s+shorts?)\b/i;

function forcedMiniMax(ctx) {
  const provider = String(ctx?.provider || "");
  return provider === "minimax" || provider.startsWith("minimax.");
}

export function miniMaxH3AutoEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env?.MINIMAX_H3_AUTO || "").trim());
}

function scalarString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerSetting(name, value, fallback, { min, max }) {
  const selected = value == null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(selected) || selected < min || selected > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return selected;
}

function stringArraySetting(name, value) {
  if (value == null || value === "") return [];
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${name} must be a JSON array: ${error.message}`);
    }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be a JSON array of non-empty URL strings`);
  }
  return parsed.map((item) => item.trim());
}

export function resolveMiniMaxH3Duration(ctx = {}, env = process.env) {
  return integerSetting(
    "MINIMAX_H3_DURATION",
    ctx.duration ?? env.MINIMAX_H3_DURATION,
    5,
    { min: 4, max: 15 },
  );
}

export function resolveMiniMaxH3Ratio(intent, ctx = {}, env = process.env, { hasMedia = false } = {}) {
  const explicit = scalarString(ctx.ratio) || scalarString(env.MINIMAX_H3_RATIO);
  if (explicit) {
    if (!MINIMAX_H3_RATIOS.has(explicit)) {
      throw new Error(
        `MINIMAX_H3_RATIO must be one of: ${[...MINIMAX_H3_RATIOS].join(", ")}`,
      );
    }
    if (!hasMedia && explicit === "adaptive") {
      throw new Error("MiniMax-H3 text-to-video requires a concrete ratio, not adaptive");
    }
    return explicit;
  }
  if (hasMedia) return "adaptive";
  return VERTICAL_INTENT.test(String(intent || "")) ? "9:16" : "16:9";
}

function referenceInputs(ctx = {}, env = process.env) {
  const firstFrame =
    scalarString(ctx.firstFrame) || scalarString(env.MINIMAX_H3_FIRST_FRAME);
  const lastFrame =
    scalarString(ctx.lastFrame) || scalarString(env.MINIMAX_H3_LAST_FRAME);
  const referenceImages =
    ctx.referenceImages ||
    stringArraySetting("MINIMAX_H3_REFERENCE_IMAGES_JSON", env.MINIMAX_H3_REFERENCE_IMAGES_JSON);
  const referenceVideos =
    ctx.referenceVideos ||
    stringArraySetting("MINIMAX_H3_REFERENCE_VIDEOS_JSON", env.MINIMAX_H3_REFERENCE_VIDEOS_JSON);
  const referenceAudios =
    ctx.referenceAudios ||
    stringArraySetting("MINIMAX_H3_REFERENCE_AUDIOS_JSON", env.MINIMAX_H3_REFERENCE_AUDIOS_JSON);

  if (lastFrame && !firstFrame) {
    throw new Error("MINIMAX_H3_LAST_FRAME requires MINIMAX_H3_FIRST_FRAME");
  }
  if (referenceImages.length > 9) throw new Error("MiniMax-H3 accepts at most 9 reference images");
  if (referenceVideos.length > 3) throw new Error("MiniMax-H3 accepts at most 3 reference videos");
  if (referenceAudios.length > 3) throw new Error("MiniMax-H3 accepts at most 3 reference audios");

  const frameMode = Boolean(firstFrame || lastFrame);
  const referenceMode =
    referenceImages.length > 0 || referenceVideos.length > 0 || referenceAudios.length > 0;
  if (frameMode && referenceMode) {
    throw new Error("MiniMax-H3 frame inputs and reference inputs cannot be combined");
  }
  if (referenceAudios.length && !referenceImages.length && !referenceVideos.length) {
    throw new Error("MiniMax-H3 reference audio requires a reference image or reference video");
  }
  if (referenceImages.length + referenceVideos.length + referenceAudios.length > 12) {
    throw new Error("MiniMax-H3 accepts at most 12 total reference media items");
  }
  return {
    firstFrame,
    lastFrame,
    referenceImages,
    referenceVideos,
    referenceAudios,
    hasMedia: frameMode || referenceMode,
  };
}

function h3Prompt(intent, ctx = {}, env = process.env) {
  const base = String(intent || "").trim();
  if (!base) throw new Error("MiniMax-H3 requires a non-empty prompt");
  const negative =
    scalarString(ctx.negativePrompt) || scalarString(env.MINIMAX_H3_NEGATIVE_PROMPT);
  const prompt = negative
    ? `${base}\n\n[NEGATIVE CONSTRAINTS]\nAvoid ${negative}.`
    : base;
  if (prompt.length > 7000) {
    throw new Error("MiniMax-H3 prompt must not exceed 7000 characters");
  }
  return prompt;
}

export function buildMiniMaxH3Request(intent, ctx = {}, env = process.env) {
  const references = referenceInputs(ctx, env);
  const content = [{ type: "text", text: h3Prompt(intent, ctx, env) }];
  if (references.firstFrame) {
    content.push({
      type: "image_url",
      image_url: { url: references.firstFrame },
      role: "first_frame",
    });
  }
  if (references.lastFrame) {
    content.push({
      type: "image_url",
      image_url: { url: references.lastFrame },
      role: "last_frame",
    });
  }
  for (const url of references.referenceImages) {
    content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  }
  for (const url of references.referenceVideos) {
    content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
  }
  for (const url of references.referenceAudios) {
    content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
  }

  return {
    model: MINIMAX_H3_MODEL,
    content,
    resolution: "2K",
    duration: resolveMiniMaxH3Duration(ctx, env),
    ratio: resolveMiniMaxH3Ratio(intent, ctx, env, { hasMedia: references.hasMedia }),
    ...(scalarString(ctx.callbackUrl) || scalarString(env.MINIMAX_H3_CALLBACK_URL)
      ? { callback_url: scalarString(ctx.callbackUrl) || scalarString(env.MINIMAX_H3_CALLBACK_URL) }
      : {}),
  };
}

export async function miniMaxH3Generate(intent, ctx = {}, deps = {}) {
  const env = deps.env || process.env;
  if (!forcedMiniMax(ctx) && !miniMaxH3AutoEnabled(env)) return null;

  const apiKey = deps.apiKey || minimaxApiKey(env);
  if (!apiKey) {
    if (forcedMiniMax(ctx)) {
      console.error("media-use: MiniMax-H3 requires $MINIMAX_API_KEY");
    }
    return null;
  }

  try {
    const request = buildMiniMaxH3Request(intent, ctx, env);
    const runVideo = deps.runVideo || runMiniMaxH3Video;
    const result = await runVideo(request, {
      apiKey,
      env,
      fetch: deps.fetch,
      sleep: deps.sleep,
      now: deps.now,
      pollIntervalMs:
        deps.pollIntervalMs ??
        integerSetting("MINIMAX_H3_POLL_MS", env.MINIMAX_H3_POLL_MS, 10_000, {
          min: 10_000,
          max: 300_000,
        }),
      timeoutMs:
        deps.timeoutMs ??
        integerSetting("MINIMAX_H3_TIMEOUT_MS", env.MINIMAX_H3_TIMEOUT_MS, 1_800_000, {
          min: 60_000,
          max: 86_400_000,
        }),
      requestTimeoutMs: deps.requestTimeoutMs,
      retries: deps.retries,
    });
    const outputPath = join(
      tmpdir(),
      `media-use-minimax-h3-${process.pid}-${result.taskId}-${Date.now()}.mp4`,
    );
    writeFileSync(outputPath, result.bytes);
    const referenceCounts = request.content.reduce(
      (counts, item) => {
        if (item.type === "image_url") counts.images += 1;
        if (item.type === "video_url") counts.videos += 1;
        if (item.type === "audio_url") counts.audios += 1;
        return counts;
      },
      { images: 0, videos: 0, audios: 0 },
    );
    return {
      localPath: outputPath,
      ext: ".mp4",
      source: "generated",
      metadata: {
        description: intent,
        provider: MINIMAX_H3_PROVIDER,
        duration: result.task?.duration || request.duration,
        provenance: {
          prompt: request.content[0].text,
          model: MINIMAX_H3_MODEL,
          task_id: result.taskId,
          resolution: result.task?.resolution || request.resolution,
          duration: result.task?.duration || request.duration,
          ratio: result.task?.ratio || request.ratio,
          task_type: result.task?.task_type || null,
          usage: result.task?.usage || null,
          reference_counts: referenceCounts,
          native_audio: true,
        },
      },
    };
  } catch (error) {
    console.error(`media-use: MiniMax-H3 failed: ${error?.message || error}`);
    // A task ID means a paid remote task may already exist. Propagate instead
    // of falling through and creating a second paid video with another provider.
    if (error instanceof MiniMaxH3ApiError && error.taskId) throw error;
    return null;
  }
}
