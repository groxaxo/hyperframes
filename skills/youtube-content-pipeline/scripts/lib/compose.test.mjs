import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyVerifiedMediaCapabilities,
  buildCaptionGroups,
  buildMainHtml,
  buildNormalizeVideoArgs,
  buildSchedule,
  captionsToSrt,
  captionsToVtt,
  composeProject,
} from "./compose.mjs";

function plan() {
  return {
    topic: "Automation",
    channel: { name: "Auckland Automate IT" },
    video: {
      slug: "automation",
      format: "long",
      title: "Automation",
      language: "en-NZ",
      width: 1920,
      height: 1080,
      fps: 30,
      thumbnail: { headline: "AUTOMATION", subhead: "Less admin", accent: "#7c3aed" },
    },
    production: { transition_s: 0.3, lead_in_s: 0.25, tail_s: 0.35 },
    scenes: [
      {
        id: "hook",
        duration_s: 3,
        narration: "A useful opening line.",
        on_screen_text: "Start here",
        native_audio: "duck",
      },
      {
        id: "broll",
        duration_s: 4,
        narration: "A useful supporting line.",
        on_screen_text: "Then scale",
        native_audio: "mute",
      },
    ],
  };
}

function audio() {
  return {
    voices: [
      {
        id: "hook",
        path: "assets/voice/hook.wav",
        duration_s: 3.2,
        words: [
          { text: "A", start: 0, end: 0.2 },
          { text: "useful", start: 0.2, end: 0.8 },
          { text: "opening", start: 0.8, end: 1.5 },
          { text: "line.", start: 1.5, end: 2 },
        ],
      },
      {
        id: "broll",
        path: "assets/voice/broll.wav",
        duration_s: 2,
        words: [
          { text: "A", start: 0, end: 0.2 },
          { text: "supporting", start: 0.2, end: 1.1 },
          { text: "line.", start: 1.1, end: 1.8 },
        ],
      },
    ],
  };
}

function visualManifest({ verifiedHookAudio = true } = {}) {
  return {
    scenes: {
      hook: {
        path: "assets/video/hook.mp4",
        provider: "gemini",
        native_audio_requested: "duck",
        native_audio: verifiedHookAudio ? "duck" : "mute",
        has_native_audio: verifiedHookAudio,
      },
      broll: {
        path: "assets/video/broll.mp4",
        provider: "comfyui",
        native_audio_requested: "mute",
        native_audio: "mute",
        has_native_audio: false,
      },
    },
  };
}

test("schedule extends only the scene whose narration exceeds its shot budget", () => {
  const schedule = buildSchedule(plan(), audio());
  assert.equal(schedule.scenes[0].duration_s, 3.8);
  assert.equal(schedule.scenes[1].start_s, 3.8);
  assert.equal(schedule.scenes[1].duration_s, 4);
  assert.equal(schedule.total_duration_s, 7.8);
});

test("verified media capabilities mute native audio unless its stream is confirmed", () => {
  const verified = applyVerifiedMediaCapabilities(
    buildSchedule(plan(), audio()),
    visualManifest({ verifiedHookAudio: true }),
  );
  assert.equal(verified.scenes[0].native_audio, "duck");
  assert.equal(verified.scenes[0].native_audio_verified, true);

  const unverified = applyVerifiedMediaCapabilities(
    buildSchedule(plan(), audio()),
    visualManifest({ verifiedHookAudio: false }),
  );
  assert.equal(unverified.scenes[0].native_audio_requested, "duck");
  assert.equal(unverified.scenes[0].native_audio, "mute");
  assert.equal(unverified.scenes[0].native_audio_verified, false);
});

test("normalization command pads, trims, removes audio, and emits YouTube-safe H.264", () => {
  const args = buildNormalizeVideoArgs({
    inputPath: "in.webm",
    outputPath: "out.mp4",
    width: 1920,
    height: 1080,
    fps: 30,
    durationS: 5,
  });
  const filter = args[args.indexOf("-vf") + 1];
  assert.match(filter, /scale=1920:1080/);
  assert.match(filter, /tpad=stop_mode=clone/);
  assert.match(filter, /trim=duration=5/);
  assert.ok(args.includes("-an"));
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p");
});

test("caption groups use global scene offsets and serialize to SRT/VTT", () => {
  const schedule = buildSchedule(plan(), audio());
  const groups = buildCaptionGroups(schedule, { maxWords: 3 });
  assert.equal(groups[0].start, 0.25);
  assert.ok(groups.some((group) => group.scene_id === "broll" && group.start >= 4.05));
  assert.match(captionsToSrt(groups), /00:00:00,250/);
  assert.match(captionsToVtt(groups), /^WEBVTT/);
});

test("main composition uses muted video, separate verified audio, and captions", () => {
  const schedule = applyVerifiedMediaCapabilities(
    buildSchedule(plan(), audio()),
    visualManifest(),
  );
  const normalized = {
    hook: { path: "assets/video/hook.mp4", normalized_path: "assets/youtube/scenes/hook.mp4" },
    broll: { path: "assets/video/broll.mp4", normalized_path: "assets/youtube/scenes/broll.mp4" },
  };
  const html = buildMainHtml(plan(), schedule, normalized, audio());
  assert.match(html, /id="video-hook"[^>]*muted playsinline/);
  assert.match(html, /id="voice-hook"/);
  assert.match(html, /id="native-hook"/);
  assert.doesNotMatch(html, /id="native-broll"/);
  assert.match(html, /data-composition-src="compositions\/captions.html"/);
  assert.match(html, /window\.__timelines\.main = tl/);
});

test("main composition never mounts requested but unverified native audio", () => {
  const schedule = applyVerifiedMediaCapabilities(
    buildSchedule(plan(), audio()),
    visualManifest({ verifiedHookAudio: false }),
  );
  const normalized = {
    hook: { path: "assets/video/hook.mp4", normalized_path: "assets/youtube/scenes/hook.mp4" },
    broll: { path: "assets/video/broll.mp4", normalized_path: "assets/youtube/scenes/broll.mp4" },
  };
  const html = buildMainHtml(plan(), schedule, normalized, audio());
  assert.doesNotMatch(html, /id="native-hook"/);
});

test("composeProject writes an editable HyperFrames project and thumbnail subproject", () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-compose-"));
  try {
    mkdirSync(join(dir, "assets/video"), { recursive: true });
    mkdirSync(join(dir, "assets/voice"), { recursive: true });
    writeFileSync(join(dir, "assets/video/hook.mp4"), "hook");
    writeFileSync(join(dir, "assets/video/broll.mp4"), "broll");
    writeFileSync(join(dir, "assets/voice/hook.wav"), "voice");
    writeFileSync(join(dir, "assets/voice/broll.wav"), "voice");
    const fakeSpawn = (_bin, args) => {
      const output = args.at(-1);
      mkdirSync(join(output, ".."), { recursive: true });
      writeFileSync(output, "generated");
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = composeProject(plan(), visualManifest(), audio(), {
      projectDir: dir,
      force: true,
      spawnSync: fakeSpawn,
    });
    assert.equal(result.schedule.total_duration_s, 7.8);
    assert.equal(result.composition.expected_audio, true);
    assert.equal(result.composition.audio.voice_count, 2);
    assert.equal(result.composition.audio.verified_native_audio_count, 1);
    for (const path of [
      "index.html",
      "compositions/captions.html",
      "captions.srt",
      "captions.vtt",
      "thumbnail-project/index.html",
      "thumbnail-project/assets/hero.jpg",
      ".youtube-pipeline/composition.json",
    ]) {
      assert.equal(existsSync(join(dir, path)), true, path);
    }
    assert.equal(
      JSON.parse(readFileSync(join(dir, "hyperframes.json"), "utf8")).authoringSkill,
      "youtube-content-pipeline",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rerun never reuses a stale normalized clip merely because the output path exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-compose-stale-"));
  try {
    mkdirSync(join(dir, "assets/video"), { recursive: true });
    mkdirSync(join(dir, "assets/voice"), { recursive: true });
    mkdirSync(join(dir, "assets/youtube/scenes"), { recursive: true });
    writeFileSync(join(dir, "assets/video/hook.mp4"), "new-hook");
    writeFileSync(join(dir, "assets/video/broll.mp4"), "new-broll");
    writeFileSync(join(dir, "assets/voice/hook.wav"), "voice");
    writeFileSync(join(dir, "assets/voice/broll.wav"), "voice");
    writeFileSync(join(dir, "assets/youtube/scenes/hook.mp4"), "stale");
    writeFileSync(join(dir, "assets/youtube/scenes/broll.mp4"), "stale");
    const calls = [];
    const fakeSpawn = (_bin, args) => {
      calls.push(args);
      const output = args.at(-1);
      mkdirSync(join(output, ".."), { recursive: true });
      writeFileSync(output, "fresh");
      return { status: 0, stdout: "", stderr: "" };
    };
    composeProject(plan(), visualManifest(), audio(), {
      projectDir: dir,
      spawnSync: fakeSpawn,
    });
    assert.ok(calls.filter((args) => args.includes("-c:v")).length >= 2);
    assert.equal(readFileSync(join(dir, "assets/youtube/scenes/hook.mp4"), "utf8"), "fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
