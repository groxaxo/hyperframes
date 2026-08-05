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
export const MINIMAX_H3_RESOLUTIONS = new Set(["768P", "2K"]);

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

function enumSetting(name, value, fallback, allowed) {
  const selected = scalarString(value) || fallback;
  if (!allowed.has(selected)) {
    throw new Error(`${name} must be one of: ${[...allowed].join(", ")}`);
  }
  return selected;
}

function assertPublicHttpsUrl(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must contain valid URL strings`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${name} URLs must use HTTPS and must not embed credentials`);
  }
  return url.toString();
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
  return parsed.map((item) => assertPublicHttpsUrl(name, item.trim()));
}

export function resolveMiniMaxH3Duration(ctx = {}, env = process.env) {
  return integerSetting(
    "MINIMAX_H3_DURATION",
    ctx.duration ?? env.MINIMAX_H3_DURATION,
    5,
    { min: 4, max: 15 },
  );
}

export function resolveMiniMaxH3Resolution(ctx = {}, env = process.env) {
  return enumSetting(
    "MINIMAX_H3_RESOLUTION",
    ctx.resolution ?? env.MINIMAX_H3_RESOLUTION,
    "2K",
    MINIMAX_H3_RESOLUTIONS,
  );
}

export function resolveMiniMaxH3Ratio(
  intent,
  ctx = {},
  env = process.env,
  { mode = "text" } = {},
) {
  // H3 always derives image-to-video geometry from the first/last frame. The
  // API accepts concrete ratios in this mode but ignores them, so normalize the
  // request and provenance to the actual behavior instead of recording a lie.
  if (mode === "frame") return "adaptive";

  const explicit = scalarString(ctx.ratio) || scalarString(env.MINIMAX_H3_RATIO);
  if (explicit) {
    if (!MINIMAX_H3_RATIOS.has(explicit)) {
      throw new Error(
        `MINIMAX_H3_RATIO must be one of: ${[...MINIMAX_H3_RATIOS].join(", ")}`,
      );
    }
    if (mode === "text" && explicit === "adaptive") {
      throw new Error("MiniMax-H3 text-to-video requires a concrete ratio, not adaptive");
    }
    return explicit;
  }
  if (mode === "reference") return "adaptive";
  return VERTICAL_INTENT.test(String(intent || "")) ? "9:16" : "16:9";
}

function referenceInputs(ctx = {}, env = process.env) {
  const firstFrameRaw =
    scalarString(ctx.firstFrame) || scalarString(env.MINIMAX_H3_FIRST_FRAME);
  const lastFrameRaw =
    scalarString(ctx.lastFrame) || scalarString(env.MINIMAX_H3_LAST_FRAME);
  const firstFrame = firstFrameRaw
    ? assertPublicHttpsUrl("MINIMAX_H3_FIRST_FRAME", firstFrameRaw)
    : null;
  const lastFrame = lastFrameRaw
    ? assertPublicHttpsUrl("MINIMAX_H3_LAST_FRAME", lastFrameRaw)
    : null;
  const referenceImages =
    ctx.referenceImages ||
    stringArraySetting("MINIMAX_H3_REFERENCE_IMAGES_JSON", env.MINIMAX_H3_REFERENCE_IMAGES_JSON);
  const referenceVideos =
    ctx.referenceVideos ||
    stringArraySetting("MINIMAX_H3_REFERENCE_VIDEOS_JSON", env.MINIMAX_H3_REFERENCE_VIDEOS_JSON);
  const referenceAudios =
    ctx.referenceAudios ||
    stringArraySetting("MINIMAX_H3_REFERENCE_AUDIOS_JSON", env.MINIMAX_H3_REFERENCE_AUDIOS_JSON);

  const normalizedImages = referenceImages.map((value) =>
    assertPublicHttpsUrl("MINIMAX_H3_REFERENCE_IMAGES_JSON", value),
  );
  const normalizedVideos = referenceVideos.map((value) =>
    assertPublicHttpsUrl("MINIMAX_H3_REFERENCE_VIDEOS_JSON", value),
  );
  const normalizedAudios = referenceAudios.map((value) =>
    assertPublicHttpsUrl("MINIMAX_H3_REFERENCE_AUDIOS_JSON", value),
  );

  if (normalizedImages.length > 9) throw new Error("MiniMax-H3 accepts at most 9 reference images");
  if (normalizedVideos.length > 3) throw new Error("MiniMax-H3 accepts at most 3 reference videos");
  if (normalizedAudios.length > 3) throw new Error("MiniMax-H3 accepts at most 3 reference audios");

  const frameMode = Boolean(firstFrame || lastFrame);
  const referenceMode =
    normalizedImages.length > 0 || normalizedVideos.length > 0 || normalizedAudios.length > 0;
  if (frameMode && referenceMode) {
    throw new Error("MiniMax-H3 frame inputs and reference inputs cannot be combined");
  }
  if (normalizedAudios.length && !normalizedImages.length && !normalizedVideos.length) {
    throw new Error("MiniMax-H3 reference audio requires a reference image or reference video");
  }
  if (normalizedImages.length + normalizedVideos.length + normalizedAudios.length > 12) {
    throw new Error("MiniMax-H3 accepts at most 12 total reference media items");
  }
  return {
    firstFrame,
    lastFrame,
    referenceImages: normalizedImages,
    referenceVideos: normalizedVideos,
    referenceAudios: normalizedAudios,
    mode: frameMode ? "frame" : referenceMode ? "reference" : "text",
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

function callbackUrl(ctx = {}, env = process.env) {
  const value = scalarString(ctx.callbackUrl) || scalarString(env.MINIMAX_H3_CALLBACK_URL);
  return value ? assertPublicHttpsUrl("MINIMAX_H3_CALLBACK_URL", value) : null;
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

  const callback = callbackUrl(ctx, env);
  return {
    model: MINIMAX_H3_MODEL,
    content,
    resolution: resolveMiniMaxH3Resolution(ctx, env),
    duration: resolveMiniMaxH3Duration(ctx, env),
    ratio: resolveMiniMaxH3Ratio(intent, ctx, env, { mode: references.mode }),
    ...(callback ? { callback_url: callback } : {}),
  };
}

function isIsoBaseMedia(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return false;
  const scanEnd = Math.min(bytes.length - 4, 64);
  for (let offset = 4; offset <= scanEnd; offset += 1) {
    if (bytes.subarray(offset, offset + 4).toString("ascii") === "ftyp") return true;
  }
  return false;
}

export async function miniMaxH3Generate(intent, ctx = {}, deps = {}) {
  const env = deps.env || process.env;
  const forced = forcedMiniMax(ctx);
  if (!forced && !miniMaxH3AutoEnabled(env)) return null;

  const apiKey = deps.apiKey || minimaxApiKey(env);
  if (!apiKey) {
    if (forced) {
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
    if (!isIsoBaseMedia(result.bytes)) {
      throw new MiniMaxH3ApiError(
        "MiniMax-H3 returned bytes that are not a valid MP4/ISO base media file",
        { code: "invalid_video_container", taskId: result.taskId },
      );
    }
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
          // H3 can use audio as a reference, but the API contract does not
          // promise that every resulting MP4 contains an audio stream. The
          // YouTube composer probes the frozen source before mounting it as
          // native audio instead of assuming one exists.
          native_audio: "probe",
        },
      },
    };
  } catch (error) {
    console.error(`media-use: MiniMax-H3 failed: ${error?.message || error}`);
    // Explicit H3 selection is a paid operation. Even a creation timeout with
    // no task ID is ambiguous—the server may have accepted the request—so never
    // fall through and submit another provider automatically. Auto-enabled H3
    // may fall through only when no task was created and it was not forced.
    if (forced || (error instanceof MiniMaxH3ApiError && error.taskId)) throw error;
    return null;
  }
}
