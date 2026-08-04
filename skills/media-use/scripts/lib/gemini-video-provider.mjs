import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GEMINI_OMNI_VIDEO_MODEL,
  createGeminiInteraction,
  decodeGeminiMedia,
  findGeminiMedia,
  geminiApiKey,
  geminiCredentialHint,
} from "./gemini-api.mjs";

const SUPPORTED_ASPECT_RATIOS = new Set(["16:9", "9:16"]);
const VERTICAL_INTENT =
  /\b(9\s*:\s*16|portrait|vertical|tiktok|reels?|instagram\s+story|youtube\s+shorts?|short-form\s+vertical)\b/i;

function forcedGemini(ctx) {
  const provider = String(ctx?.provider || "");
  return provider === "gemini" || provider.startsWith("gemini.");
}

export function resolveGeminiVideoAspectRatio(intent, ctx = {}, env = process.env) {
  const explicit = ctx.aspectRatio || env.GEMINI_VIDEO_ASPECT_RATIO;
  if (explicit != null && String(explicit).trim()) {
    const value = String(explicit).trim();
    if (!SUPPORTED_ASPECT_RATIOS.has(value)) {
      throw new Error(
        `unsupported Gemini video aspect ratio "${value}" (expected 16:9 or 9:16)`,
      );
    }
    return value;
  }
  return VERTICAL_INTENT.test(String(intent || "")) ? "9:16" : "16:9";
}

export async function geminiVideoGenerate(intent, ctx = {}, deps = {}) {
  const env = deps.env || process.env;
  const apiKey = deps.apiKey || geminiApiKey(env);
  if (!apiKey) {
    if (forcedGemini(ctx)) {
      console.error(`media-use: Gemini Omni video requires ${geminiCredentialHint()}`);
    }
    return null;
  }

  try {
    const aspectRatio = resolveGeminiVideoAspectRatio(intent, ctx, env);
    const request = {
      model: GEMINI_OMNI_VIDEO_MODEL,
      input: String(intent).trim(),
      response_format: {
        type: "video",
        aspect_ratio: aspectRatio,
      },
      background: false,
      store: false,
      stream: false,
    };
    const createInteraction = deps.createInteraction || createGeminiInteraction;
    const interaction = await createInteraction(request, {
      apiKey,
      env,
      timeoutMs: deps.timeoutMs || 900_000,
      retries: deps.retries ?? 2,
      sleep: deps.sleep,
      fetch: deps.fetch,
    });
    const block = findGeminiMedia(interaction, "video");
    if (!block) {
      throw new Error("Gemini Omni returned no video output");
    }
    const videoBytes = decodeGeminiMedia(block, "video");
    const outputPath = join(
      tmpdir(),
      `media-use-gemini-omni-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.mp4`,
    );
    writeFileSync(outputPath, videoBytes);
    return {
      localPath: outputPath,
      ext: ".mp4",
      source: "generated",
      metadata: {
        description: intent,
        provider: "gemini.omni",
        provenance: {
          prompt: intent,
          model: GEMINI_OMNI_VIDEO_MODEL,
          aspect_ratio: aspectRatio,
          native_audio: true,
        },
      },
    };
  } catch (error) {
    console.error(`media-use: Gemini Omni video failed: ${error?.message || error}`);
    return null;
  }
}
