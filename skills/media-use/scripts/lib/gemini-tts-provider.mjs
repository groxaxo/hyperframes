import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GEMINI_FLASH_TTS_MODEL,
  GEMINI_TTS_CHANNELS,
  GEMINI_TTS_SAMPLE_RATE,
  GEMINI_TTS_SAMPLE_WIDTH,
  createGeminiInteraction,
  decodeGeminiMedia,
  findGeminiMedia,
  geminiApiKey,
  geminiCredentialHint,
  isWavBuffer,
  pcm16leToWav,
} from "./gemini-api.mjs";

export const DEFAULT_GEMINI_TTS_VOICE = "Kore";

function normalizedSpeed(speed) {
  const n = Number(speed);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(2, Math.max(0.5, n));
}

function paceDirection(speed) {
  if (speed <= 0.8) return "slow and deliberate";
  if (speed < 0.95) return "slightly slower than normal";
  if (speed >= 1.35) return "fast but still clear";
  if (speed > 1.1) return "brisk and energetic";
  return "natural and conversational";
}

export function buildGeminiTtsInput(text, { speed = 1 } = {}) {
  const transcript = String(text ?? "").trim();
  if (!transcript) throw new Error("Gemini TTS transcript must not be empty");
  return [
    "Synthesize speech audio from the transcript below.",
    "Speak only the transcript. Do not read these instructions or the label aloud.",
    "Do not add, omit, summarize, or rephrase any words.",
    `Delivery: ${paceDirection(normalizedSpeed(speed))}.`,
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

function forcedGemini(ctx) {
  const provider = String(ctx?.provider || "");
  return provider === "gemini" || provider.startsWith("gemini.");
}

function wavDurationFromPcmBytes(byteLength) {
  return byteLength / (GEMINI_TTS_SAMPLE_RATE * GEMINI_TTS_CHANNELS * GEMINI_TTS_SAMPLE_WIDTH);
}

export async function generateGeminiTtsWav(
  {
    text,
    voice = DEFAULT_GEMINI_TTS_VOICE,
    speed = 1,
    outputPath,
  },
  {
    apiKey,
    env = process.env,
    createInteraction = createGeminiInteraction,
    timeoutMs = 180_000,
    retries = 2,
    sleep,
    fetch,
  } = {},
) {
  const key = apiKey || geminiApiKey(env);
  if (!key) throw new Error(`Gemini TTS unavailable — ${geminiCredentialHint()}`);
  if (!outputPath) throw new Error("Gemini TTS outputPath is required");

  const selectedVoice = String(voice || DEFAULT_GEMINI_TTS_VOICE).trim();
  if (!selectedVoice) throw new Error("Gemini TTS voice must not be empty");
  const request = {
    model: GEMINI_FLASH_TTS_MODEL,
    input: buildGeminiTtsInput(text, { speed }),
    response_format: { type: "audio" },
    generation_config: {
      speech_config: [{ voice: selectedVoice }],
    },
  };
  const interaction = await createInteraction(request, {
    apiKey: key,
    env,
    timeoutMs,
    retries,
    sleep,
    fetch,
  });
  const block = findGeminiMedia(interaction, "audio");
  if (!block) {
    throw new Error(
      "Gemini 3.1 Flash TTS returned no audio output; retry the request or split long narration",
    );
  }
  const audioBytes = decodeGeminiMedia(block, "audio");
  const alreadyWav = isWavBuffer(audioBytes);
  const wavBytes = alreadyWav ? audioBytes : pcm16leToWav(audioBytes);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, wavBytes);

  return {
    outputPath,
    model: GEMINI_FLASH_TTS_MODEL,
    voice: selectedVoice,
    mimeType: block.mime_type || (alreadyWav ? "audio/wav" : "audio/L16;rate=24000"),
    duration: alreadyWav ? null : wavDurationFromPcmBytes(audioBytes.length),
  };
}

export async function geminiTtsGenerate(intent, ctx = {}, deps = {}) {
  const env = deps.env || process.env;
  const apiKey = deps.apiKey || geminiApiKey(env);
  if (!apiKey) {
    if (forcedGemini(ctx)) {
      console.error(`media-use: Gemini TTS requires ${geminiCredentialHint()}`);
    }
    return null;
  }

  const voice = ctx.voiceId || env.GEMINI_TTS_VOICE || DEFAULT_GEMINI_TTS_VOICE;
  const outputPath = join(
    tmpdir(),
    `media-use-gemini-tts-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.wav`,
  );
  try {
    const generated = await generateGeminiTtsWav(
      {
        text: intent,
        voice,
        speed: ctx.speed || 1,
        outputPath,
      },
      {
        ...deps,
        apiKey,
        env,
      },
    );
    return {
      localPath: outputPath,
      ext: ".wav",
      source: "generated",
      metadata: {
        description: intent,
        provider: "gemini.tts",
        ...(generated.duration != null && { duration: generated.duration }),
        provenance: {
          prompt: intent,
          model: generated.model,
          voice: generated.voice,
          sample_rate_hz: GEMINI_TTS_SAMPLE_RATE,
        },
      },
    };
  } catch (error) {
    console.error(`media-use: Gemini TTS failed: ${error?.message || error}`);
    return null;
  }
}
