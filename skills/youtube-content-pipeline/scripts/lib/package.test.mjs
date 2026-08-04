import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildChapterLines,
  buildPackageMetadata,
  formatChapterTimestamp,
  packageYouTubeProject,
  renderProject,
  verifyRenderedVideo,
} from "./package.mjs";

function plan() {
  return {
    video: {
      title: "A title",
      description: "Description",
      tags: ["automation"],
      category_id: "28",
      privacy: "private",
      made_for_kids: false,
      contains_synthetic_media: true,
      language: "en-NZ",
      format: "long",
    },
  };
}

function composition() {
  return {
    total_duration_s: 30,
    width: 1920,
    height: 1080,
    fps: 30,
    schedule: {
      scenes: [
        { start_s: 0, duration_s: 10, role: "Hook", on_screen_text: "The problem" },
        { start_s: 10, duration_s: 10, role: "Proof", on_screen_text: "The evidence" },
        { start_s: 20, duration_s: 10, role: "CTA", on_screen_text: "The action" },
      ],
    },
    scenes: {
      hook: { provider: "gemini", path: "a.mp4", normalized_path: "na.mp4" },
      broll: { provider: "comfyui", path: "b.mp4", normalized_path: "nb.mp4" },
    },
  };
}

test("chapter formatting emits a compliant 0:00 block only for eligible schedules", () => {
  assert.equal(formatChapterTimestamp(65), "1:05");
  assert.deepEqual(buildChapterLines(composition().schedule), [
    "0:00 The problem",
    "0:10 The evidence",
    "0:20 The action",
  ]);
  const tooShort = composition().schedule;
  tooShort.scenes[0].duration_s = 9;
  assert.deepEqual(buildChapterLines(tooShort), []);
});

test("package metadata appends chapters and summarizes provider split", () => {
  const metadata = buildPackageMetadata(plan(), composition());
  assert.match(metadata.description, /0:00 The problem/);
  assert.deepEqual(metadata.provider_split, { gemini: 1, comfyui: 1 });
  assert.equal(metadata.contains_synthetic_media, true);
});

test("render stage runs check, render, and ffprobe verification", () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-render-"));
  const calls = [];
  try {
    const output = join(dir, ".youtube-pipeline", "final-render.mp4");
    const spawnSync = (bin, args) => {
      calls.push([bin, args]);
      if (bin.includes("npx") && args[1] === "render") {
        mkdirSync(join(output, ".."), { recursive: true });
        writeFileSync(output, "video");
      }
      if (bin === "ffprobe") {
        return {
          status: 0,
          stdout: JSON.stringify({
            format: { duration: "30.0" },
            streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }],
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = renderProject(composition(), { projectDir: dir, outputPath: output, spawnSync });
    assert.equal(result.verification.duration_s, 30);
    assert.equal(calls.filter(([bin]) => bin.includes("npx")).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyRenderedVideo rejects an implausible render duration", () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-probe-"));
  try {
    const video = join(dir, "video.mp4");
    writeFileSync(video, "video");
    assert.throws(
      () =>
        verifyRenderedVideo(video, composition(), {
          spawnSync: () => ({
            status: 0,
            stdout: JSON.stringify({
              format: { duration: "10" },
              streams: [{ codec_type: "video", width: 1920, height: 1080 }],
            }),
            stderr: "",
          }),
        }),
      /differs from composition/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package stage creates the complete release unit", () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-package-stage-"));
  try {
    mkdirSync(join(dir, ".youtube-pipeline"), { recursive: true });
    mkdirSync(join(dir, "thumbnail-project"), { recursive: true });
    writeFileSync(join(dir, ".youtube-pipeline/final-render.mp4"), "video");
    writeFileSync(join(dir, "captions.srt"), "srt");
    writeFileSync(join(dir, "captions.vtt"), "vtt");
    const spawnSync = (bin, args) => {
      if (bin.includes("npx") && args[1] === "snapshot") {
        const out = args[args.indexOf("--output") + 1];
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "frame-00-at-0.5s.png"), "png");
      } else if (bin === "ffmpeg") {
        writeFileSync(args.at(-1), "jpeg");
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = packageYouTubeProject(plan(), composition(), {
      projectDir: dir,
      force: true,
      spawnSync,
    });
    assert.equal(result.files.length, 8);
    assert.equal(existsSync(join(dir, "youtube-package/thumbnail.jpg")), true);
    assert.match(readFileSync(join(dir, "youtube-package/description.txt"), "utf8"), /0:10/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
