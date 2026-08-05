import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  audioArtifactsCurrent,
  composeArtifactsCurrent,
  packageArtifactsCurrent,
  publishArtifactsCurrent,
  visualArtifactsCurrent,
} from "./artifact-guards.mjs";

function project() {
  const projectDir = mkdtempSync(join(tmpdir(), "youtube-artifacts-"));
  const paths = {
    projectDir,
    normalizedPlan: join(projectDir, ".youtube-pipeline/normalized-plan.json"),
    visuals: join(projectDir, ".youtube-pipeline/scenes.json"),
    audio: join(projectDir, ".youtube-pipeline/audio-meta.json"),
    composition: join(projectDir, ".youtube-pipeline/composition.json"),
    render: join(projectDir, ".youtube-pipeline/final-render.mp4"),
    packageDir: join(projectDir, "youtube-package"),
  };
  mkdirSync(join(projectDir, ".youtube-pipeline"), { recursive: true });
  return paths;
}

function write(path, content = "x") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

test("visual and audio stages require every referenced frozen asset", () => {
  const paths = project();
  try {
    write(join(paths.projectDir, "assets/video/hook.mp4"), "video");
    write(
      paths.visuals,
      JSON.stringify({ scenes: { hook: { path: "assets/video/hook.mp4" } } }),
    );
    assert.equal(visualArtifactsCurrent(paths), true);
    write(join(paths.projectDir, "assets/video/hook.mp4"), "");
    assert.equal(visualArtifactsCurrent(paths), false);

    write(join(paths.projectDir, "assets/voice/hook.wav"), "voice");
    write(
      paths.audio,
      JSON.stringify({ voices: [{ id: "hook", path: "assets/voice/hook.wav" }] }),
    );
    assert.equal(audioArtifactsCurrent(paths), true);
    rmSync(join(paths.projectDir, "assets/voice/hook.wav"));
    assert.equal(audioArtifactsCurrent(paths), false);
  } finally {
    rmSync(paths.projectDir, { recursive: true, force: true });
  }
});

test("compose integrity covers editable HTML, captions, thumbnail, and normalized clips", () => {
  const paths = project();
  try {
    for (const file of [
      "index.html",
      "compositions/captions.html",
      "captions.srt",
      "captions.vtt",
      "thumbnail-project/index.html",
      "thumbnail-project/assets/hero.jpg",
      "assets/youtube/scenes/hook.mp4",
    ]) write(join(paths.projectDir, file), file);
    write(
      paths.composition,
      JSON.stringify({
        files: {
          index: "index.html",
          captions_html: "compositions/captions.html",
          captions_srt: "captions.srt",
          captions_vtt: "captions.vtt",
          thumbnail_project: "thumbnail-project",
        },
        scenes: { hook: { normalized_path: "assets/youtube/scenes/hook.mp4" } },
      }),
    );
    assert.equal(composeArtifactsCurrent(paths), true);
    rmSync(join(paths.projectDir, "captions.srt"));
    assert.equal(composeArtifactsCurrent(paths), false);
  } finally {
    rmSync(paths.projectDir, { recursive: true, force: true });
  }
});

test("package and publish are current only when the complete release unit exists", () => {
  const paths = project();
  try {
    for (const file of [
      "video.mp4",
      "thumbnail.jpg",
      "captions.srt",
      "captions.vtt",
      "metadata.json",
      "description.txt",
      "chapters.txt",
      "provenance.json",
    ]) write(join(paths.packageDir, file), file);
    assert.equal(packageArtifactsCurrent(paths), true);

    write(
      join(paths.packageDir, "publish-receipt.json"),
      JSON.stringify({
        video_id: "video123",
        video_upload_complete: true,
        thumbnail_set: false,
        caption_id: null,
        publish_complete: false,
      }),
    );
    assert.equal(publishArtifactsCurrent(paths), false);

    write(
      join(paths.packageDir, "publish-receipt.json"),
      JSON.stringify({
        video_id: "video123",
        video_upload_complete: true,
        thumbnail_set: true,
        caption_id: "caption123",
        publish_complete: true,
      }),
    );
    assert.equal(publishArtifactsCurrent(paths), true);

    write(join(paths.packageDir, "thumbnail.jpg"), "");
    assert.equal(packageArtifactsCurrent(paths), false);
  } finally {
    rmSync(paths.projectDir, { recursive: true, force: true });
  }
});
