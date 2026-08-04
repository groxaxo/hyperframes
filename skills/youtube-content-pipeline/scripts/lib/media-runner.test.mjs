import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  approximateWordTimings,
  buildAudioRequest,
  comfyUiWorkerUrls,
  generateAudio,
  generateVisuals,
  ltxFramesForDuration,
  miniMaxDurationForScene,
  normalizeAudioMeta,
  runNodeJson,
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

function triPlan() {
  const value = plan();
  value.production.provider_policy = "tri-hybrid";
  value.production.max_concurrency = 3;
  value.scenes.push({
    id: "continuity",
    provider: "minimax",
    duration_s: 8,
    narration: "A reference-driven continuity shot.",
    visual_prompt: "A continuous customer journey",
    negative_prompt: "identity drift",
    native_audio: "duck",
    fallback_provider: null,
  });
  return value;
}

test("LTX frames are always 8n+1 and cover the requested duration", () => {
  assert.equal(ltxFramesForDuration(5, 24), 121);
  assert.equal(ltxFramesForDuration(6, 24), 145);
  assert.equal((ltxFramesForDuration(6, 24) - 1) % 8, 0);
});

test("MiniMax scene durations clamp to the official 4-15 second window", () => {
  assert.equal(miniMaxDurationForScene(2), 4);
  assert.equal(miniMaxDurationForScene(8.4), 8);
  assert.equal(miniMaxDurationForScene(30), 15);
});

test("generation intent pins YouTube orientation and excludes model-rendered text", () => {
  const value = sceneGenerationIntent(plan(), plan().scenes[0]);
  assert.match(value, /Landscape 16:9/);
  assert.match(value, /Do not render captions/);
});

test("provider environments carry scene-specific duration, ratio, and negative constraints", () => {
  const comfy = sceneProviderEnv(plan(), plan().scenes[1], {});
  assert.equal(comfy.COMFYUI_LTX23_FRAMES, "121");
  assert.equal(comfy.COMFYUI_LTX23_FPS, "24");
  assert.equal(comfy.COMFYUI_LTX23_NEGATIVE_PROMPT, "flicker");

  const h3 = sceneProviderEnv(triPlan(), triPlan().scenes[2], {});
  assert.equal(h3.MINIMAX_H3_DURATION, "8");
  assert.equal(h3.MINIMAX_H3_RATIO, "16:9");
  assert.equal(h3.MINIMAX_H3_NEGATIVE_PROMPT, "identity drift");
});

test("ComfyUI worker pool accepts JSON or comma-separated URLs and rejects credentials", () => {
  assert.deepEqual(
    comfyUiWorkerUrls({
      COMFYUI_URLS_JSON: '["http://127.0.0.1:8188/","http://127.0.0.1:8189"]',
    }),
    ["http://127.0.0.1:8188", "http://127.0.0.1:8189"],
  );
  assert.deepEqual(
    comfyUiWorkerUrls({ COMFYUI_URLS: "http://127.0.0.1:8188, http://127.0.0.1:8188" }),
    ["http://127.0.0.1:8188"],
  );
  assert.throws(
    () => comfyUiWorkerUrls({ COMFYUI_URL: "http://user:pass@127.0.0.1:8188" }),
    /must not embed credentials/,
  );
});

test("runNodeJson supports real asynchronous child processes", async () => {
  const payload = await runNodeJson("resolve.mjs", ["--json"], {
    execFile: (_bin, _args, _options, callback) => {
      setTimeout(() => callback(null, '{"ok":true,"path":"assets/video.mp4"}\n', ""), 5);
    },
  });
  assert.equal(payload.path, "assets/video.mp4");
});

test("tri-hybrid generation invokes all three providers and persists a resumable manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-visuals-"));
  const calls = [];
  try {
    const result = await generateVisuals(triPlan(), {
      projectDir: dir,
      runJson: async (_script, args) => {
        const provider = args[args.indexOf("--provider") + 1];
        const id = provider === "gemini" ? "hook" : provider === "comfyui" ? "broll" : "continuity";
        const path = `assets/video/${id}.mp4`;
        mkdirSync(join(dir, "assets/video"), { recursive: true });
        writeFileSync(join(dir, path), provider);
        calls.push(provider);
        return {
          ok: true,
          path,
          provenance: {
            provider:
              provider === "gemini"
                ? "gemini.omni"
                : provider === "comfyui"
                  ? "comfyui.ltx23"
                  : "minimax.h3",
          },
        };
      },
    });
    assert.deepEqual(calls, ["gemini", "comfyui", "minimax"]);
    assert.deepEqual(result.generated.map((record) => record.provider), ["gemini", "comfyui", "minimax"]);
    assert.equal(existsSync(result.manifestPath), true);

    calls.length = 0;
    await generateVisuals(triPlan(), {
      projectDir: dir,
      runJson: async () => {
        throw new Error("should not regenerate");
      },
    });
    assert.deepEqual(calls, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a MiniMax task-id failure never falls through to a second provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-minimax-paid-"));
  const value = triPlan();
  value.scenes = [
    {
      ...value.scenes[2],
      fallback_provider: "gemini",
    },
  ];
  value.production.provider_policy = "minimax";
  let calls = 0;
  try {
    await assert.rejects(
      generateVisuals(value, {
        projectDir: dir,
        runJson: async () => {
          calls += 1;
          const error = new Error("polling timed out");
          error.taskId = "paid-task";
          throw error;
        },
      }),
      (error) => error.taskId === "paid-task",
    );
    assert.equal(calls, 1);
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
