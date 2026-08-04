import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  geminiAvailable,
  pickProvider,
  resolveVoiceId,
  synthesizeGemini,
} from "./tts.mjs";

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("audio engine auto-selects Gemini before other cloud TTS providers", async () => {
  await withEnv({ GEMINI_API_KEY: "test-key" }, async () => {
    assert.equal(geminiAvailable(), true);
    assert.equal(pickProvider(null), "gemini");
  });
});

test("audio engine validates an explicitly requested Gemini provider", async () => {
  await withEnv({ GEMINI_API_KEY: null, GOOGLE_API_KEY: null }, async () => {
    assert.throws(() => pickProvider("gemini"), /no Google API key/);
  });
});

test("Gemini voice resolution uses Kore unless overridden", async () => {
  await withEnv({ GEMINI_TTS_VOICE: null }, async () => {
    assert.equal(await resolveVoiceId({ provider: "gemini" }), "Kore");
    assert.equal(
      await resolveVoiceId({ provider: "gemini", userVoice: "Puck" }),
      "Puck",
    );
  });
});

test("synthesizeGemini delegates to the shared provider and returns no native word timings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audio-tts-gemini-"));
  const wavAbs = join(dir, "voice.wav");
  let received;
  try {
    const result = await synthesizeGemini(
      {
        text: "Welcome.",
        voiceId: "Charon",
        speed: 1.1,
        wavAbs,
      },
      {
        generateGeminiTtsWav: async (request) => {
          received = request;
          writeFileSync(request.outputPath, "wav");
        },
      },
    );
    assert.deepEqual(received, {
      text: "Welcome.",
      voice: "Charon",
      speed: 1.1,
      outputPath: wavAbs,
    });
    assert.deepEqual(result, { ok: true, words: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesizeGemini surfaces provider failures instead of silently dropping narration", async () => {
  const result = await synthesizeGemini(
    {
      text: "Welcome.",
      voiceId: "Kore",
      speed: 1,
      wavAbs: "/tmp/never-created.wav",
    },
    {
      generateGeminiTtsWav: async () => {
        throw new Error("HTTP 500 — transient TTS failure");
      },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 500/);
});
