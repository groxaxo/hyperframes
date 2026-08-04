import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { stableHash } from "./plan.mjs";

function round(value, digits = 3) {
  return Number(Number(value).toFixed(digits));
}

function npxBinary(platform = process.platform) {
  return platform === "win32" ? "npx.cmd" : "npx";
}

export class PackageCommandError extends Error {
  constructor(message, result = {}) {
    super(message);
    this.name = "PackageCommandError";
    this.status = result.status ?? null;
    this.stdout = result.stdout || "";
    this.stderr = result.stderr || "";
  }
}

export function runCommand(
  bin,
  args,
  {
    cwd,
    env = process.env,
    timeoutMs = 1_800_000,
    spawnSync = nodeSpawnSync,
  } = {},
) {
  const result = spawnSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new PackageCommandError(
      `${bin} ${args.join(" ")} failed${result.status != null ? ` with status ${result.status}` : ""}: ${
        result.error?.message || String(result.stderr || result.stdout || "").trim()
      }`,
      result,
    );
  }
  return result;
}

export function formatChapterTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function chapterTitle(scene, index) {
  return scene.on_screen_text || scene.role || `Part ${index + 1}`;
}

export function buildChapterLines(schedule) {
  const scenes = schedule?.scenes || [];
  if (scenes.length < 3) return [];
  const validDurations = scenes.every((scene) => Number(scene.duration_s) >= 10);
  if (!validDurations) return [];
  return scenes.map(
    (scene, index) => `${formatChapterTimestamp(scene.start_s)} ${chapterTitle(scene, index)}`,
  );
}

export function buildPackageMetadata(plan, composition) {
  const providers = Object.values(composition.scenes || {}).reduce((counts, scene) => {
    const provider = scene.provider || "unknown";
    counts[provider] = (counts[provider] || 0) + 1;
    return counts;
  }, {});
  const chapters = buildChapterLines(composition.schedule);
  const description = [plan.video.description, chapters.length ? chapters.join("\n") : ""]
    .filter(Boolean)
    .join("\n\n");
  return {
    version: 1,
    title: plan.video.title,
    description,
    tags: plan.video.tags,
    category_id: plan.video.category_id,
    privacy: plan.video.privacy,
    made_for_kids: plan.video.made_for_kids,
    contains_synthetic_media: plan.video.contains_synthetic_media,
    language: plan.video.language,
    format: plan.video.format,
    duration_s: composition.total_duration_s,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    provider_split: providers,
    chapters,
    plan_hash: stableHash(plan),
  };
}

export function verifyRenderedVideo(
  videoPath,
  expected,
  {
    spawnSync = nodeSpawnSync,
  } = {},
) {
  if (!existsSync(videoPath) || statSync(videoPath).size === 0) {
    throw new Error(`rendered video is missing or empty: ${videoPath}`);
  }
  const result = runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height",
      "-of",
      "json",
      videoPath,
    ],
    { spawnSync, timeoutMs: 60_000 },
  );
  let probe;
  try {
    probe = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON: ${error.message}`);
  }
  const duration = Number(probe?.format?.duration);
  if (!(duration > 0)) throw new Error("rendered video has no measurable duration");
  const expectedDuration = Number(expected.duration_s ?? expected.total_duration_s);
  if (!(expectedDuration > 0)) throw new Error("composition has no expected duration");
  const tolerance = Math.max(1, expectedDuration * 0.05);
  if (Math.abs(duration - expectedDuration) > tolerance) {
    throw new Error(
      `rendered duration ${round(duration)}s differs from composition ${expectedDuration}s by more than ${round(tolerance)}s`,
    );
  }
  const video = (probe.streams || []).find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("rendered file contains no video stream");
  if (Number(video.width) !== Number(expected.width) || Number(video.height) !== Number(expected.height)) {
    throw new Error(
      `rendered dimensions ${video.width}x${video.height} do not match ${expected.width}x${expected.height}`,
    );
  }
  return { duration_s: round(duration), video, probe };
}

export function renderProject(
  composition,
  {
    projectDir,
    outputPath = join(projectDir, ".youtube-pipeline", "final-render.mp4"),
    spawnSync = nodeSpawnSync,
    env = process.env,
    skipCheck = false,
  } = {},
) {
  mkdirSync(join(projectDir, ".youtube-pipeline"), { recursive: true });
  if (!skipCheck) {
    runCommand(npxBinary(), ["hyperframes", "check"], {
      cwd: projectDir,
      env,
      spawnSync,
    });
  }
  runCommand(
    npxBinary(),
    ["hyperframes", "render", "--quality", "high", "--output", outputPath],
    {
      cwd: projectDir,
      env,
      spawnSync,
      timeoutMs: 7_200_000,
    },
  );
  const verification = verifyRenderedVideo(outputPath, composition, { spawnSync });
  return { outputPath, verification };
}

function snapshotThumbnail(thumbnailProject, packageDir, { spawnSync, env }) {
  const snapshots = join(packageDir, ".thumbnail-snapshots");
  rmSync(snapshots, { recursive: true, force: true });
  mkdirSync(snapshots, { recursive: true });
  runCommand(
    npxBinary(),
    [
      "hyperframes",
      "snapshot",
      thumbnailProject,
      "--frames",
      "1",
      "--no-end",
      "--output",
      snapshots,
      "--describe",
      "false",
    ],
    { cwd: thumbnailProject, env, spawnSync, timeoutMs: 300_000 },
  );
  const frame = readdirSync(snapshots)
    .filter((name) => /^frame-.*\.png$/i.test(name))
    .sort()[0];
  if (!frame) throw new Error("thumbnail snapshot produced no PNG frame");
  const source = join(snapshots, frame);
  const target = join(packageDir, "thumbnail.jpg");
  const maxBytes = 2 * 1024 * 1024;
  for (const quality of [2, 4, 6, 8, 10, 14]) {
    runCommand(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        source,
        "-frames:v",
        "1",
        "-q:v",
        String(quality),
        target,
      ],
      { spawnSync, env, timeoutMs: 120_000 },
    );
    if (existsSync(target) && statSync(target).size > 0 && statSync(target).size <= maxBytes) break;
  }
  rmSync(snapshots, { recursive: true, force: true });
  if (!existsSync(target) || statSync(target).size === 0) {
    throw new Error("thumbnail conversion produced no JPEG");
  }
  if (statSync(target).size > maxBytes) {
    throw new Error(`thumbnail remains larger than YouTube's 2 MB limit: ${statSync(target).size} bytes`);
  }
  return target;
}

function copyRequired(source, target, label) {
  if (!existsSync(source) || statSync(source).size === 0) {
    throw new Error(`${label} is missing or empty: ${source}`);
  }
  copyFileSync(source, target);
}

export function packageYouTubeProject(
  plan,
  composition,
  {
    projectDir,
    videoPath = join(projectDir, ".youtube-pipeline", "final-render.mp4"),
    packageDir = join(projectDir, "youtube-package"),
    spawnSync = nodeSpawnSync,
    env = process.env,
    force = false,
  } = {},
) {
  if (force) rmSync(packageDir, { recursive: true, force: true });
  mkdirSync(packageDir, { recursive: true });
  copyRequired(videoPath, join(packageDir, "video.mp4"), "rendered video");
  copyRequired(join(projectDir, "captions.srt"), join(packageDir, "captions.srt"), "SRT captions");
  copyRequired(join(projectDir, "captions.vtt"), join(packageDir, "captions.vtt"), "VTT captions");
  const thumbnailPath = snapshotThumbnail(join(projectDir, "thumbnail-project"), packageDir, {
    spawnSync,
    env,
  });

  const metadata = buildPackageMetadata(plan, composition);
  writeFileSync(join(packageDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(join(packageDir, "description.txt"), `${metadata.description}\n`);
  writeFileSync(
    join(packageDir, "chapters.txt"),
    metadata.chapters.length
      ? `${metadata.chapters.join("\n")}\n`
      : "No chapter block generated: YouTube requires at least three timestamps and each chapter must be at least 10 seconds.\n",
  );
  const provenance = {
    generated_at: new Date().toISOString(),
    authoring_skill: "youtube-content-pipeline",
    plan_hash: metadata.plan_hash,
    provider_split: metadata.provider_split,
    tts_provider: "gemini",
    scenes: Object.fromEntries(
      Object.entries(composition.scenes || {}).map(([id, scene]) => [id, {
        requested_provider: scene.requested_provider,
        provider: scene.provider,
        source_path: scene.path,
        normalized_path: scene.normalized_path,
        provenance: scene.provenance || {},
      }]),
    ),
  };
  writeFileSync(join(packageDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);

  const files = [
    "video.mp4",
    basename(thumbnailPath),
    "captions.srt",
    "captions.vtt",
    "metadata.json",
    "description.txt",
    "chapters.txt",
    "provenance.json",
  ];
  for (const file of files) {
    const path = join(packageDir, file);
    if (!existsSync(path) || statSync(path).size === 0) throw new Error(`package file is empty: ${file}`);
  }
  return {
    packageDir,
    files,
    metadata,
    paths: Object.fromEntries(files.map((file) => [file, relative(projectDir, join(packageDir, file))])),
  };
}
