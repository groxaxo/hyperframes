import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  approximateWordTimings,
  buildAudioRequest,
  generateAudio,
  generateVisuals,
  ltxFramesForDuration,
  normalizeAudioMeta,
  sceneGenerationIntent,
  sceneProviderEnv,
} from "./media-runner.mjs";

function plan() {
  return {
    video: { width: 1920, height: 1080, language: "en-NZ", format: "long" },
    production: {
      provider_policy: "hybrid",
      gemini_voice: "Kore",
      max_concurrency: 1,
      background_music: false,
      background_music_query: "none",
    },
    scenes: [
      {
        id: "hook",
        provider: "gemini",
        duration_s: 5,
        narration: "A clear opening line.",
        visual_prompt: "A cinematic phone close-up",
        negative_prompt: "bad",
        native_audio: "duck",
        fallback_provider: null,
      },
      {
        id: "broll",
        provider: "comfyui",
        duration_s: 5,
        narration: "A supporting line.",
        visual_prompt: "Workshop B-roll",
        negative_prompt: "flicker",
        native_audio: "mute",
        fallback_provider: null,
      },
    ],
  };
}

test("LTX frames are always 8n+1 and cover the requested duration", () => {
  assert.equal(ltxFramesForDuration(5, 24), 121);
  assert.equal(ltxFramesForDuration(6, 24), 145);
  assert.equal((ltxFramesForDuration(6, 24) - 1) % 8, 0);
});

test("generation intent pins YouTube orientation and excludes model-rendered text", () => {
  const value = sceneGenerationIntent(plan(), plan().scenes[0]);
  assert.match(value, /Landscape 16:9/);
  assert.match(value, /Do not render captions/);
});

test("ComfyUI receives per-scene duration and negative prompt through its supported env", () => {
  const env = sceneProviderEnv(plan(), plan().scenes[1], {});
  assert.equal(env.COMFYUI_LTX23_FRAMES, "121");
  assert.equal(env.COMFYUI_LTX23_FPS, "24");
  assert.equal(env.COMFYUI_LTX23_NEGATIVE_PROMPT, "flicker");
});

test("visual generation invokes both providers and persists a resumable manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-visuals-"));
  const calls = [];
  try {
    const result = await generateVisuals(plan(), {
      projectDir: dir,
      runJson: (_script, args) => {
        const provider = args[args.indexOf("--provider") + 1];
        const id = provider === "gemini" ? "hook" : "broll";
        const path = `assets/video/${id}.mp4`;
        mkdirSync(join(dir, "assets/video"), { recursive: true });
        writeFileSync(join(dir, path), provider);
        calls.push(provider);
        return {
          ok: true,
          path,
          provenance: { provider: provider === "gemini" ? "gemini.omni" : "comfyui.ltx23" },
        };
      },
    });
    assert.deepEqual(calls, ["gemini", "comfyui"]);
    assert.equal(result.generated[0].provider, "gemini");
    assert.equal(result.generated[1].provider, "comfyui");
    assert.equal(existsSync(result.manifestPath), true);

    calls.length = 0;
    await generateVisuals(plan(), {
      projectDir: dir,
      runJson: () => {
        throw new Error("should not regenerate");
      },
    });
    assert.deepEqual(calls, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approximate word timings are contiguous and end at the measured duration", () => {
  const words = approximateWordTimings("A useful short phrase", 2.5);
  assert.equal(words[0].start, 0);
  assert.equal(words.at(-1).end, 2.5);
  assert.ok(words.every((word) => word.approximate));
});

test("audio request pins Gemini and normalized metadata fills missing timestamps", () => {
  const request = buildAudioRequest(plan());
  assert.equal(request.provider, "gemini");
  assert.equal(request.voice, "Kore");
  assert.equal(request.lines.length, 2);
  const meta = normalizeAudioMeta(plan(), {
    voices: [
      { id: "hook", path: "assets/voice/hook.wav", duration_s: 2, words: [] },
      { id: "broll", path: "assets/voice/broll.wav", duration_s: 2.5, words: [] },
    ],
  });
  assert.ok(meta.voices[0].words.length > 0);
  assert.equal(meta.total_duration_s, 4.5);
});

test("audio stage invokes the shared engine and writes normalized metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-audio-"));
  try {
    const output = join(dir, "audio_meta.json");
    const result = generateAudio(plan(), {
      projectDir: dir,
      spawnSync: (_bin, args) => {
        const out = args[args.indexOf("--out") + 1];
        writeFileSync(
          out,
          JSON.stringify({
            voices: [
              { id: "hook", path: "assets/voice/hook.wav", duration_s: 2, words: [] },
              { id: "broll", path: "assets/voice/broll.wav", duration_s: 2, words: [] },
            ],
          }),
        );
        return { status: 0, stdout: "ok", stderr: "" };
      },
    });
    assert.equal(result.meta.tts_provider, "gemini");
    assert.equal(existsSync(join(dir, result.outputPath)), true);
    assert.equal(JSON.parse(readFileSync(output, "utf8")).voices.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
