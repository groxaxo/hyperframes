import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GEMINI_FLASH_TTS_MODEL } from "./gemini-api.mjs";
import {
  DEFAULT_GEMINI_TTS_VOICE,
  buildGeminiTtsInput,
  generateGeminiTtsWav,
  geminiTtsGenerate,
} from "./gemini-tts-provider.mjs";

test("buildGeminiTtsInput protects the transcript and maps pacing", () => {
  const natural = buildGeminiTtsInput("Hello world.");
  assert.match(natural, /Speak only the transcript/);
  assert.match(natural, /natural and conversational/);
  assert.match(natural, /Transcript:\nHello world\./);

  const brisk = buildGeminiTtsInput("Go.", { speed: 1.2 });
  assert.match(brisk, /brisk and energetic/);
});

test("generateGeminiTtsWav uses Gemini 3.1 Flash TTS and wraps PCM as WAV", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gemini-tts-provider-"));
  const outputPath = join(dir, "voice.wav");
  const pcm = Buffer.from([0, 0, 1, 0, 255, 255, 0, 0]);
  let request;
  try {
    const generated = await generateGeminiTtsWav(
      {
        text: "Welcome to HyperFrames.",
        voice: "Puck",
        speed: 1.2,
        outputPath,
      },
      {
        apiKey: "test-key",
        createInteraction: async (body, options) => {
          request = { body, options };
          return {
            output_audio: {
              data: pcm.toString("base64"),
              mime_type: "audio/L16;rate=24000",
            },
          };
        },
      },
    );

    assert.equal(request.body.model, GEMINI_FLASH_TTS_MODEL);
    assert.deepEqual(request.body.response_format, { type: "audio" });
    assert.deepEqual(request.body.generation_config, {
      speech_config: [{ voice: "Puck" }],
    });
    assert.match(request.body.input, /Welcome to HyperFrames/);
    assert.equal(request.options.apiKey, "test-key");
    assert.equal(generated.voice, "Puck");
    assert.ok(generated.duration > 0);
    const wav = readFileSync(outputPath);
    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wav.readUInt32LE(24), 24_000);
    assert.deepEqual(wav.subarray(44), pcm);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geminiTtsGenerate returns a resolver-compatible local asset", async () => {
  let generatedPath;
  try {
    const result = await geminiTtsGenerate(
      "A concise launch line.",
      { provider: "gemini", voiceId: "Charon" },
      {
        apiKey: "test-key",
        createInteraction: async () => ({
          output_audio: { data: Buffer.from([0, 0, 1, 0]).toString("base64") },
        }),
      },
    );
    generatedPath = result?.localPath;
    assert.ok(result);
    assert.equal(result.ext, ".wav");
    assert.equal(result.metadata.provider, "gemini.tts");
    assert.equal(result.metadata.provenance.model, GEMINI_FLASH_TTS_MODEL);
    assert.equal(result.metadata.provenance.voice, "Charon");
    assert.equal(existsSync(result.localPath), true);
  } finally {
    if (generatedPath) rmSync(generatedPath, { force: true });
  }
});

test("geminiTtsGenerate falls through cleanly when no Google key is configured", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(message));
  const result = await geminiTtsGenerate("No key", { provider: "gemini" }, { env: {} });
  assert.equal(result, null);
  assert.ok(errors.some((line) => /GEMINI_API_KEY/.test(line)));
});

test("Gemini TTS default voice remains deterministic", () => {
  assert.equal(DEFAULT_GEMINI_TTS_VOICE, "Kore");
});
