import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const YOUTUBE_PACKAGE_FILES = [
  "video.mp4",
  "thumbnail.jpg",
  "captions.srt",
  "captions.vtt",
  "metadata.json",
  "description.txt",
  "chapters.txt",
  "provenance.json",
];

export function isNonEmptyFile(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export function readJsonIfValid(path) {
  if (!isNonEmptyFile(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function absolute(projectDir, path) {
  if (!path || typeof path !== "string") return null;
  return isAbsolute(path) ? path : resolve(projectDir, path);
}

function allPathsExist(projectDir, paths) {
  return paths.every((path) => {
    const resolved = absolute(projectDir, path);
    return resolved ? isNonEmptyFile(resolved) : false;
  });
}

export function visualArtifactsCurrent(paths) {
  const manifest = readJsonIfValid(paths.visuals);
  const scenes =
    manifest?.scenes && typeof manifest.scenes === "object"
      ? Object.values(manifest.scenes)
      : [];
  return scenes.length > 0 && allPathsExist(paths.projectDir, scenes.map((scene) => scene?.path));
}

export function audioArtifactsCurrent(paths) {
  const meta = readJsonIfValid(paths.audio);
  if (!meta || !Array.isArray(meta.voices)) return false;
  const voicePaths = meta.voices.map((voice) => voice?.path);
  if (!allPathsExist(paths.projectDir, voicePaths)) return false;
  if (meta.bgm?.path && !allPathsExist(paths.projectDir, [meta.bgm.path])) return false;
  return true;
}

export function composeArtifactsCurrent(paths) {
  const composition = readJsonIfValid(paths.composition);
  if (!composition) return false;
  const files = composition.files || {};
  const required = [
    files.index || "index.html",
    files.captions_html || "compositions/captions.html",
    files.captions_srt || "captions.srt",
    files.captions_vtt || "captions.vtt",
    join(files.thumbnail_project || "thumbnail-project", "index.html"),
    join(files.thumbnail_project || "thumbnail-project", "assets", "hero.jpg"),
    ...Object.values(composition.scenes || {}).map((scene) => scene?.normalized_path),
  ];
  return allPathsExist(paths.projectDir, required);
}

export function renderArtifactsCurrent(paths) {
  return isNonEmptyFile(paths.render);
}

export function packageArtifactsCurrent(paths) {
  return YOUTUBE_PACKAGE_FILES.every((file) => isNonEmptyFile(join(paths.packageDir, file)));
}

export function publishArtifactsCurrent(paths) {
  const receipt = readJsonIfValid(join(paths.packageDir, "publish-receipt.json"));
  return Boolean(
    receipt?.video_id &&
      receipt?.video_upload_complete &&
      receipt?.metadata_set &&
      receipt?.thumbnail_set &&
      (receipt?.caption_id || receipt?.captions_skipped) &&
      receipt?.publish_complete,
  );
}

export function stageArtifactsCurrent(name, paths) {
  if (name === "plan") return isNonEmptyFile(paths.normalizedPlan);
  if (name === "visuals") return visualArtifactsCurrent(paths);
  if (name === "audio") return audioArtifactsCurrent(paths);
  if (name === "compose") return composeArtifactsCurrent(paths);
  if (name === "render") return renderArtifactsCurrent(paths);
  if (name === "package") return packageArtifactsCurrent(paths);
  if (name === "publish") return publishArtifactsCurrent(paths);
  return false;
}

export function hashFileOrMissing(path) {
  if (!isNonEmptyFile(path)) return `missing:${path}`;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function fingerprintFiles(projectDir, paths) {
  return paths.map((path) => {
    const resolved = absolute(projectDir, path);
    return {
      path: String(path),
      hash: resolved ? hashFileOrMissing(resolved) : "missing:null",
    };
  });
}

export function compositionInputFingerprint(projectDir, composition) {
  const files = composition?.files || {};
  const voicePaths = (composition?.schedule?.scenes || []).flatMap((scene) =>
    scene?.voice_path ? [scene.voice_path] : [],
  );
  return fingerprintFiles(
    projectDir,
    [
      files.index || "index.html",
      files.captions_html || "compositions/captions.html",
      ...Object.values(composition?.scenes || {}).flatMap((scene) => [
        scene?.normalized_path,
        scene?.path,
      ]),
      ...voicePaths,
      composition?.audio?.bgm_path,
    ].filter(Boolean),
  );
}

export function packageAssetFingerprints(packageDir) {
  return {
    video: hashFileOrMissing(join(packageDir, "video.mp4")),
    thumbnail: hashFileOrMissing(join(packageDir, "thumbnail.jpg")),
    captions: hashFileOrMissing(join(packageDir, "captions.srt")),
    metadata: hashFileOrMissing(join(packageDir, "metadata.json")),
  };
}

export function packageUploadFingerprint(packageDir) {
  return fingerprintFiles(packageDir, [
    "video.mp4",
    "thumbnail.jpg",
    "captions.srt",
    "metadata.json",
  ]);
}

export function workflowFingerprint(projectDir, env = process.env) {
  const configured = env.COMFYUI_LTX23_WORKFLOW || env.COMFYUI_LTX_WORKFLOW;
  if (!configured) return null;
  const path = isAbsolute(configured) ? configured : resolve(projectDir, configured);
  return hashFileOrMissing(path);
}
