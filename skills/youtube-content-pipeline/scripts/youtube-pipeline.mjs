#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  compositionInputFingerprint,
  packageAssetFingerprints,
  stageArtifactsCurrent,
  workflowFingerprint,
} from "./lib/artifact-guards.mjs";
import { composeProject, readCompositionManifest } from "./lib/compose.mjs";
import { generateAudio, generateVisuals } from "./lib/media-runner.mjs";
import { packageYouTubeProject, renderProject } from "./lib/package.mjs";
import { PRIVACY_VALUES, readPlan, slugify, stableHash } from "./lib/plan.mjs";
import { publishYouTubePackageSafely } from "./lib/safe-publisher.mjs";
import {
  STAGES,
  beginStage,
  completeStage,
  failStage,
  readState,
  stageIsCurrent,
  writeState,
} from "./lib/state.mjs";
import { youtubeCredentialStatus } from "./lib/youtube-api.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(HERE, "../templates/youtube-plan.example.json");

function loadEnvFromDir(startDir) {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 5; depth += 1) {
    const path = join(dir, ".env");
    if (existsSync(path)) {
      for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
        let line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        if (line.startsWith("export ")) line = line.slice(7).trim();
        const equals = line.indexOf("=");
        if (equals < 1) continue;
        const key = line.slice(0, equals).trim();
        let value = line.slice(equals + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
      }
      return path;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const COMMANDS = new Set([
  "init",
  "preflight",
  "validate",
  "visuals",
  "audio",
  "compose",
  "render",
  "package",
  "publish",
  "status",
  "run",
]);

function parseCli(argv) {
  const command = argv[0] || "help";
  if (["help", "--help", "-h"].includes(command)) return { command: "help", args: {} };
  if (!COMMANDS.has(command)) throw new Error(`unknown command: ${command}`);
  const { values } = parseArgs({
    args: argv.slice(1),
    strict: true,
    options: {
      project: { type: "string", short: "p", default: "." },
      topic: { type: "string" },
      format: { type: "string", default: "long" },
      through: { type: "string", default: "compose" },
      privacy: { type: "string" },
      resume: { type: "boolean", default: true },
      "no-resume": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "skip-check": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values["no-resume"]) values.resume = false;
  return { command: values.help ? "help" : command, args: values };
}

function helpText() {
  return `YouTube multi-provider content pipeline

Usage:
  node youtube-pipeline.mjs <command> --project <dir> [options]

Commands:
  init        Create youtube-plan.json and project notes
  preflight   Check required providers, FFmpeg, Node and optional YouTube OAuth
  validate    Validate and normalize the production plan
  visuals     Generate/resume Gemini, ComfyUI, and/or MiniMax scene assets
  audio       Generate Gemini 3.1 Flash TTS and caption timings
  compose     Build the editable HyperFrames project, captions and thumbnail project
  render      Run hyperframes check, render high quality, and verify the MP4
  package     Create youtube-package/ with video, thumbnail, captions and metadata
  publish     Dry-run or upload privately/unlisted/public via YouTube Data API
  status      Show resumable state, artifact integrity and provider allocation
  run         Execute stages in order through compose|render|package|publish

Options:
  --project, -p <dir>  Project directory (default: .)
  --topic <text>       Required by init
  --format long|short  Initial format (default: long)
  --through <stage>    Last stage for run (default: compose)
  --privacy <value>    private|unlisted|public for publish
  --resume             Reuse completed scene/stage artifacts (default)
  --no-resume          Rebuild even when state and artifacts are current
  --force              Rebuild or deliberately resubmit the selected stage
  --dry-run            Validate publishing payload without OAuth/network
  --skip-check          Render without the browser gate (not recommended)
  --json                Machine-readable output`;
}

function emit(value, { json = false, lines = [] } = {}) {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...value }, null, 2));
    return value;
  }
  for (const line of lines) console.log(line);
  return value;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${error.message}`);
  }
}

function projectPaths(projectDir) {
  return {
    projectDir,
    plan: join(projectDir, "youtube-plan.json"),
    normalizedPlan: join(projectDir, ".youtube-pipeline", "normalized-plan.json"),
    state: join(projectDir, ".youtube-pipeline", "state.json"),
    visuals: join(projectDir, ".youtube-pipeline", "scenes.json"),
    audio: join(projectDir, ".youtube-pipeline", "audio-meta.json"),
    composition: join(projectDir, ".youtube-pipeline", "composition.json"),
    render: join(projectDir, ".youtube-pipeline", "final-render.mp4"),
    packageDir: join(projectDir, "youtube-package"),
  };
}

export function createInitialPlan(topic, format = "long") {
  const base = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
  const title = String(topic || "Untitled YouTube video").trim();
  base.topic = title;
  base.channel = { name: "", audience: "" };
  base.video = {
    ...base.video,
    slug: slugify(title) || "youtube-video",
    format: format === "short" ? "short" : "long",
    title: title.slice(0, 100),
    description: "",
    tags: [],
    privacy: "private",
    made_for_kids: false,
    contains_synthetic_media: true,
    thumbnail: {
      ...base.video.thumbnail,
      headline: title.slice(0, 64).toUpperCase(),
      subhead: "",
    },
  };
  base.scenes = [
    {
      id: "hook",
      role: "hook",
      provider: "gemini",
      duration_s: 5,
      narration: "",
      visual_prompt: `A cinematic immediate hook that introduces the central tension of ${title}; one clear subject, purposeful camera movement, realistic sound, no readable text`,
      on_screen_text: "",
      native_audio: "duck",
    },
    {
      id: "context",
      role: "broll",
      provider: "comfyui",
      duration_s: 5,
      narration: "",
      visual_prompt: `LTX-2.3 documentary B-roll establishing the real-world context for ${title}; controlled movement, coherent details, no readable text`,
      on_screen_text: "",
      native_audio: "mute",
    },
    {
      id: "mechanism",
      role: "broll",
      provider: "comfyui",
      duration_s: 5,
      narration: "",
      visual_prompt: `LTX-2.3 visual metaphor that explains the mechanism behind ${title}; premium editorial imagery, restrained motion, no readable text`,
      on_screen_text: "",
      native_audio: "mute",
    },
    {
      id: "demonstration",
      role: "demo",
      provider: "gemini",
      duration_s: 5,
      narration: "",
      visual_prompt: `A precise cinematic demonstration or reveal related to ${title}; strong causal action, clean composition, synchronized native sound, no private data or readable text`,
      on_screen_text: "",
      native_audio: "duck",
    },
    {
      id: "implication",
      role: "broll",
      provider: "comfyui",
      duration_s: 5,
      narration: "",
      visual_prompt: `LTX-2.3 supporting B-roll showing the practical implication of ${title}; authentic human-scale environment, stable identity, no readable text`,
      on_screen_text: "",
      native_audio: "mute",
    },
    {
      id: "call-to-action",
      role: "cta",
      provider: "gemini",
      duration_s: 5,
      narration: "",
      visual_prompt: `A confident cinematic closing image for ${title}; resolved emotional direction, negative space for an editorial call to action, tasteful native sound, no rendered words`,
      on_screen_text: "",
      native_audio: "duck",
    },
  ];
  return base;
}

function initProject(projectDir, { topic, format, force }) {
  if (!topic?.trim()) throw new Error("init requires --topic");
  const paths = projectPaths(projectDir);
  if (existsSync(paths.plan) && !force) {
    throw new Error(`${relative(process.cwd(), paths.plan)} already exists; pass --force to replace it`);
  }
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, ".youtube-pipeline"), { recursive: true });
  const plan = createInitialPlan(topic, format);
  writeFileSync(paths.plan, `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(
    join(projectDir, "RESEARCH.md"),
    `# Research and claim ledger\n\nTopic: ${topic}\n\nRecord every factual claim, primary source, date checked, and exact scene that uses it. Do not promote unverified assertions into narration.\n`,
  );
  writeFileSync(
    join(projectDir, "README.md"),
    `# ${topic}\n\n1. Edit \`youtube-plan.json\`.\n2. Validate: \`node <SKILL_DIR>/scripts/youtube-pipeline.mjs validate --project .\`\n3. Build through preview: \`node <SKILL_DIR>/scripts/youtube-pipeline.mjs run --project . --through compose\`\n4. Preview and approve, then render/package.\n`,
  );
  writeFileSync(
    join(projectDir, ".gitignore"),
    `.youtube-pipeline/\nyoutube-package/\nassets/\nsnapshots/\nthumbnail-project/assets/\n`,
  );
  return { paths, plan };
}

function loadValidatedPlan(paths) {
  const result = readPlan(paths.plan);
  mkdirSync(dirname(paths.normalizedPlan), { recursive: true });
  writeFileSync(paths.normalizedPlan, `${JSON.stringify(result.plan, null, 2)}\n`);
  return result;
}

function planSummary(result) {
  const split = result.plan.scenes.reduce(
    (counts, scene) => ({ ...counts, [scene.provider]: (counts[scene.provider] || 0) + 1 }),
    {},
  );
  return {
    title: result.plan.video.title,
    format: result.plan.video.format,
    planned_duration_s: result.total_duration_s,
    scenes: result.plan.scenes.length,
    provider_split: split,
    warnings: result.warnings,
    plan_hash: result.hash,
  };
}

function readPipelineState(paths, planHash = null) {
  return readState(paths.state, planHash);
}

function persistPlanStage(paths, validation) {
  let state = readPipelineState(paths, validation.hash);
  if (!stageIsCurrent(state, "plan", validation.hash) || !stageArtifactsCurrent("plan", paths)) {
    state = completeStage(
      state,
      "plan",
      { normalized_plan: relative(paths.projectDir, paths.normalizedPlan) },
      validation.hash,
    );
    state.plan_hash = validation.hash;
    writeState(paths.state, state);
  }
  return state;
}

function checkpointArtifacts(checkpoint, inputHash) {
  return {
    youtube_upload_input_hash: inputHash,
    youtube_upload_session: checkpoint.upload_session || null,
    youtube_video_id: checkpoint.video_id || null,
    youtube_watch_url: checkpoint.watch_url || null,
    youtube_video_fingerprint: checkpoint.video_fingerprint || null,
    youtube_metadata_fingerprint: checkpoint.metadata_fingerprint || null,
    youtube_thumbnail_fingerprint: checkpoint.thumbnail_fingerprint || null,
    youtube_caption_fingerprint: checkpoint.caption_fingerprint || null,
    youtube_metadata_set: Boolean(checkpoint.metadata_set),
    youtube_thumbnail_set: Boolean(checkpoint.thumbnail_set),
    youtube_caption_id: checkpoint.caption_id || null,
    youtube_captions_skipped: Boolean(checkpoint.captions_skipped),
    youtube_publish_stage: checkpoint.stage || null,
    publish_receipt: "youtube-package/publish-receipt.json",
  };
}

async function executeStage(paths, validation, name, inputHash, worker, options = {}) {
  const force = Boolean(options.force || options.resume === false);
  let state = persistPlanStage(paths, validation);
  if (!force && stageIsCurrent(state, name, inputHash) && stageArtifactsCurrent(name, paths)) {
    return { skipped: true, state, result: null };
  }
  state = beginStage(state, name, inputHash);
  writeState(paths.state, state);
  try {
    const result = await worker();
    state = readPipelineState(paths, validation.hash);
    state = completeStage(state, name, result?.artifacts || {}, inputHash);
    writeState(paths.state, state);
    return { skipped: false, state, result };
  } catch (error) {
    state = readPipelineState(paths, validation.hash);
    state = failStage(state, name, error);
    if (error?.checkpoint) {
      state.artifacts = {
        ...state.artifacts,
        ...checkpointArtifacts(error.checkpoint, inputHash),
      };
    } else {
      if (error?.sessionUrl) {
        state.artifacts = { ...state.artifacts, youtube_upload_session: error.sessionUrl };
      }
      if (error?.videoId) {
        state.artifacts = {
          ...state.artifacts,
          youtube_video_id: error.videoId,
          youtube_watch_url: `https://www.youtube.com/watch?v=${error.videoId}`,
        };
      }
      if (error?.taskId) {
        state.artifacts = {
          ...state.artifacts,
          minimax_task_checkpoint: {
            scene_id: error.sceneId || null,
            task_id: error.taskId,
            code: error.code || null,
            retryable: Boolean(error.retryable),
          },
        };
      }
    }
    writeState(paths.state, state);
    throw error;
  }
}

function visualRuntimeFingerprint(plan, projectDir, env = process.env) {
  return stableHash({
    workflow: workflowFingerprint(projectDir, env),
    comfyui: {
      model: env.COMFYUI_LTX23_MODEL || null,
      bindings: env.COMFYUI_LTX23_BINDINGS_JSON || null,
      width: env.COMFYUI_LTX23_WIDTH || null,
      height: env.COMFYUI_LTX23_HEIGHT || null,
      fps: env.COMFYUI_LTX23_FPS || null,
    },
    gemini: { model: env.GEMINI_VIDEO_MODEL || "gemini-omni-flash-preview" },
    minimax: {
      host: env.MINIMAX_API_HOST || env.MINIMAX_API_BASE_URL || "global",
      resolution: env.MINIMAX_H3_RESOLUTION || "2K",
      first_frame: env.MINIMAX_H3_FIRST_FRAME || null,
      last_frame: env.MINIMAX_H3_LAST_FRAME || null,
      reference_images: env.MINIMAX_H3_REFERENCE_IMAGES_JSON || null,
      reference_videos: env.MINIMAX_H3_REFERENCE_VIDEOS_JSON || null,
      reference_audios: env.MINIMAX_H3_REFERENCE_AUDIOS_JSON || null,
    },
    scenes: plan.scenes.map((scene) => ({
      id: scene.id,
      provider: scene.provider,
      fallback_provider: scene.fallback_provider,
      duration_s: scene.duration_s,
      negative_prompt: scene.negative_prompt,
    })),
  });
}

async function runVisualsStage(paths, validation, args) {
  const inputHash = stableHash({
    plan_hash: validation.hash,
    scenes: validation.plan.scenes,
    video: validation.plan.video,
    runtime: visualRuntimeFingerprint(validation.plan, paths.projectDir),
  });
  return executeStage(
    paths,
    validation,
    "visuals",
    inputHash,
    async () => {
      const generated = await generateVisuals(validation.plan, {
        projectDir: paths.projectDir,
        force: args.force || args.resume === false,
        onProgress: (event) => {
          if (args.json) return;
          if (event.type === "start") {
            console.error(`· visuals: ${event.scene.id} with ${event.scene.provider}`);
          }
          if (event.type === "resume") {
            console.error(`· visuals: resume ${event.scene.id} task ${event.taskId}`);
          }
          if (event.type === "skip") console.error(`· visuals: ${event.scene.id} already current`);
          if (event.type === "provider-failed") {
            console.error(`  ${event.scene.provider} failed: ${event.error.message}`);
          }
        },
      });
      return {
        ...generated,
        artifacts: {
          scene_manifest: relative(paths.projectDir, generated.manifestPath),
          minimax_task_checkpoint: null,
        },
      };
    },
    args,
  );
}

async function runAudioStage(paths, validation, args) {
  const inputHash = stableHash({
    plan_hash: validation.hash,
    model: process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview",
    voice: validation.plan.production.gemini_voice,
    scenes: validation.plan.scenes.map((scene) => ({ id: scene.id, narration: scene.narration })),
    bgm: validation.plan.production.background_music,
    bgm_query: validation.plan.production.background_music_query,
  });
  return executeStage(
    paths,
    validation,
    "audio",
    inputHash,
    async () => {
      const generated = generateAudio(validation.plan, { projectDir: paths.projectDir });
      return {
        ...generated,
        artifacts: {
          audio_request: generated.requestPath,
          audio_meta: generated.outputPath,
        },
      };
    },
    args,
  );
}

async function runComposeStage(paths, validation, args) {
  if (!existsSync(paths.visuals)) throw new Error("visual stage is incomplete: scenes.json is missing");
  if (!existsSync(paths.audio)) throw new Error("audio stage is incomplete: audio-meta.json is missing");
  const inputHash = stableHash({
    plan_hash: validation.hash,
    visuals: hashFile(paths.visuals),
    audio: hashFile(paths.audio),
  });
  return executeStage(
    paths,
    validation,
    "compose",
    inputHash,
    async () => {
      const result = composeProject(
        validation.plan,
        readJson(paths.visuals, "visual manifest"),
        readJson(paths.audio, "audio metadata"),
        {
          projectDir: paths.projectDir,
          force: args.force || args.resume === false,
          onProgress: (event) => {
            if (!args.json && event.type === "start") {
              console.error(`· compose: normalize ${event.scene.id}`);
            }
          },
        },
      );
      return {
        ...result,
        artifacts: {
          composition_manifest: relative(paths.projectDir, result.manifestPath),
          preview: "index.html",
          thumbnail_project: "thumbnail-project",
        },
      };
    },
    args,
  );
}

async function runRenderStage(paths, validation, args) {
  if (!existsSync(paths.composition)) throw new Error("compose stage is incomplete: composition.json is missing");
  const composition = readCompositionManifest(paths.projectDir);
  const inputHash = stableHash({
    composition: hashFile(paths.composition),
    source_files: compositionInputFingerprint(paths.projectDir, composition),
    skip_check: args["skip-check"],
  });
  return executeStage(
    paths,
    validation,
    "render",
    inputHash,
    async () => {
      const result = renderProject(composition, {
        projectDir: paths.projectDir,
        outputPath: paths.render,
        skipCheck: args["skip-check"],
      });
      return {
        ...result,
        artifacts: { rendered_video: relative(paths.projectDir, result.outputPath) },
      };
    },
    args,
  );
}

async function runPackageStage(paths, validation, args) {
  if (!existsSync(paths.render)) throw new Error("render stage is incomplete: final-render.mp4 is missing");
  const composition = readCompositionManifest(paths.projectDir);
  const inputHash = stableHash({
    plan_hash: validation.hash,
    composition: hashFile(paths.composition),
    composition_sources: compositionInputFingerprint(paths.projectDir, composition),
    rendered_video: hashFile(paths.render),
    captions_srt: hashFile(join(paths.projectDir, "captions.srt")),
    captions_vtt: hashFile(join(paths.projectDir, "captions.vtt")),
  });
  return executeStage(
    paths,
    validation,
    "package",
    inputHash,
    async () => {
      const result = packageYouTubeProject(validation.plan, composition, {
        projectDir: paths.projectDir,
        videoPath: paths.render,
        packageDir: paths.packageDir,
        force: args.force || args.resume === false,
      });
      return {
        ...result,
        artifacts: {
          youtube_package: relative(paths.projectDir, result.packageDir),
          package_metadata: relative(paths.projectDir, join(result.packageDir, "metadata.json")),
        },
      };
    },
    args,
  );
}

function persistPublishCheckpoint(paths, validation, inputHash, checkpoint) {
  let state = readPipelineState(paths, validation.hash);
  state = {
    ...state,
    stages: {
      ...state.stages,
      publish: {
        ...(state.stages.publish || {}),
        status: "running",
        input_hash: inputHash,
        checkpoint_stage: checkpoint.stage,
        checkpoint_at: new Date().toISOString(),
      },
    },
    artifacts: {
      ...state.artifacts,
      ...checkpointArtifacts(checkpoint, inputHash),
    },
  };
  writeState(paths.state, state);
}

async function runPublishStage(paths, validation, args) {
  if (!existsSync(join(paths.packageDir, "metadata.json"))) {
    throw new Error("package stage is incomplete: youtube-package/metadata.json is missing");
  }
  const privacy = args.privacy || validation.plan.video.privacy || "private";
  if (!PRIVACY_VALUES.has(privacy)) throw new Error(`invalid privacy value: ${privacy}`);

  const assetFingerprints = packageAssetFingerprints(paths.packageDir);
  const inputHash = stableHash({
    plan_hash: validation.hash,
    asset_fingerprints: assetFingerprints,
    privacy,
  });

  if (args["dry-run"]) {
    const preview = await publishYouTubePackageSafely(validation.plan, paths.packageDir, {
      privacy,
      dryRun: true,
      publishFingerprint: inputHash,
      assetFingerprints,
    });
    return { skipped: false, result: preview, state: readPipelineState(paths, validation.hash) };
  }

  return executeStage(
    paths,
    validation,
    "publish",
    inputHash,
    async () => {
      const currentState = readPipelineState(paths, validation.hash);
      const canResume =
        currentState.artifacts?.youtube_video_fingerprint === assetFingerprints.video;
      const published = await publishYouTubePackageSafely(validation.plan, paths.packageDir, {
        privacy,
        dryRun: false,
        publishFingerprint: inputHash,
        assetFingerprints,
        resume: canResume
          ? {
              sessionUrl: currentState.artifacts?.youtube_upload_session || null,
              videoId: currentState.artifacts?.youtube_video_id || null,
              videoFingerprint: currentState.artifacts?.youtube_video_fingerprint || null,
              metadataSet: currentState.artifacts?.youtube_metadata_set || false,
              metadataFingerprint:
                currentState.artifacts?.youtube_metadata_fingerprint || null,
              thumbnailSet: currentState.artifacts?.youtube_thumbnail_set || false,
              thumbnailFingerprint:
                currentState.artifacts?.youtube_thumbnail_fingerprint || null,
              captionId: currentState.artifacts?.youtube_caption_id || null,
              captionFingerprint:
                currentState.artifacts?.youtube_caption_fingerprint || null,
              captionsSkipped:
                currentState.artifacts?.youtube_captions_skipped || false,
            }
          : {},
        onCheckpoint: async (checkpoint) => {
          persistPublishCheckpoint(paths, validation, inputHash, checkpoint);
        },
      });
      return {
        ...published,
        artifacts: {
          ...checkpointArtifacts(published, inputHash),
          youtube_publish_complete: true,
        },
      };
    },
    args,
  );
}

function binaryCheck(name, args = ["--version"]) {
  const result = nodeSpawnSync(name, args, { encoding: "utf8", timeout: 10_000 });
  return {
    name,
    ok: !result.error && result.status === 0,
    detail:
      !result.error && result.status === 0
        ? String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0]
        : result.error?.message || String(result.stderr || "not found").trim(),
  };
}

function providerRequirements(projectDir) {
  const planPath = join(projectDir, "youtube-plan.json");
  let plan = null;
  if (existsSync(planPath)) {
    try {
      plan = readPlan(planPath).plan;
    } catch {
      // Validation reports plan errors. Preflight falls back to default hybrid.
    }
  }
  const policy = plan?.production?.provider_policy || "hybrid";
  const sceneProviders = new Set(plan?.scenes?.map((scene) => scene.provider) || []);
  const hasNarration = plan ? plan.scenes.some((scene) => scene.narration) : true;
  return {
    policy,
    gemini:
      hasNarration ||
      sceneProviders.has("gemini") ||
      policy === "hybrid" ||
      policy === "tri-hybrid",
    comfyui:
      sceneProviders.has("comfyui") ||
      policy === "hybrid" ||
      policy === "tri-hybrid" ||
      policy === "comfyui",
    minimax:
      sceneProviders.has("minimax") || policy === "tri-hybrid" || policy === "minimax",
  };
}

export function preflight(projectDir) {
  loadEnvFromDir(projectDir);
  const required = providerRequirements(projectDir);
  const workflowRaw = process.env.COMFYUI_LTX23_WORKFLOW || process.env.COMFYUI_LTX_WORKFLOW;
  const workflow = workflowRaw
    ? workflowRaw.startsWith("/")
      ? workflowRaw
      : resolve(projectDir, workflowRaw)
    : null;
  const geminiReady = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  const comfyReady = Boolean(workflow && existsSync(workflow));
  const minimaxReady = Boolean(process.env.MINIMAX_API_KEY);
  const minimaxResolution = process.env.MINIMAX_H3_RESOLUTION || "2K";
  const checks = [
    {
      name: "Node.js 22+",
      ok: Number(process.versions.node.split(".")[0]) >= 22,
      detail: process.version,
    },
    binaryCheck("ffmpeg", ["-version"]),
    binaryCheck("ffprobe", ["-version"]),
    binaryCheck(process.platform === "win32" ? "npx.cmd" : "npx", ["hyperframes", "--version"]),
    {
      name: "Gemini API key",
      ok: geminiReady,
      optional: !required.gemini,
      detail: geminiReady ? "configured" : "set GEMINI_API_KEY",
    },
    {
      name: "ComfyUI LTX-2.3 workflow",
      ok: comfyReady,
      optional: !required.comfyui,
      detail: workflow
        ? existsSync(workflow)
          ? workflow
          : `not found: ${workflow}`
        : "set COMFYUI_LTX23_WORKFLOW",
    },
    {
      name: "ComfyUI URL",
      ok: true,
      optional: !required.comfyui,
      detail:
        process.env.COMFYUI_URLS_JSON ||
        process.env.COMFYUI_URLS ||
        process.env.COMFYUI_URL ||
        "http://127.0.0.1:8188",
    },
    {
      name: "MiniMax-H3 API key",
      ok: minimaxReady,
      optional: !required.minimax,
      detail: minimaxReady
        ? `configured (${process.env.MINIMAX_API_HOST || "global"}, ${minimaxResolution})`
        : "set MINIMAX_API_KEY for minimax or tri-hybrid plans",
    },
    {
      name: "MiniMax-H3 resolution",
      ok: ["768P", "2K"].includes(minimaxResolution),
      optional: !required.minimax,
      detail: ["768P", "2K"].includes(minimaxResolution)
        ? minimaxResolution
        : `invalid: ${minimaxResolution} (expected 768P or 2K)`,
    },
  ];
  const youtube = youtubeCredentialStatus(process.env);
  checks.push({
    name: "YouTube OAuth (optional until publish)",
    ok: youtube.ready,
    optional: true,
    detail: youtube.ready ? youtube.mode : `missing ${youtube.missing.join(", ")}`,
  });
  return {
    ok: checks.filter((check) => !check.optional).every((check) => check.ok),
    provider_policy: required.policy,
    checks,
  };
}

export function stagesThrough(name) {
  const index = STAGES.indexOf(name);
  if (index < 0) throw new Error(`unknown --through stage: ${name} (expected ${STAGES.join(", ")})`);
  return STAGES.slice(0, index + 1);
}

async function runThrough(paths, validation, args) {
  const stages = stagesThrough(args.through || "compose");
  const results = {};
  for (const stage of stages) {
    if (stage === "plan") {
      persistPlanStage(paths, validation);
      results.plan = planSummary(validation);
    } else if (stage === "visuals") {
      results.visuals = await runVisualsStage(paths, validation, args);
    } else if (stage === "audio") {
      results.audio = await runAudioStage(paths, validation, args);
    } else if (stage === "compose") {
      results.compose = await runComposeStage(paths, validation, args);
    } else if (stage === "render") {
      results.render = await runRenderStage(paths, validation, args);
    } else if (stage === "package") {
      results.package = await runPackageStage(paths, validation, args);
    } else if (stage === "publish") {
      results.publish = await runPublishStage(paths, validation, args);
    }
  }
  return results;
}

function statusReport(paths) {
  const validation = existsSync(paths.plan) ? readPlan(paths.plan) : null;
  const state = readPipelineState(paths, validation?.hash || null);
  let providerSplit = {};
  if (existsSync(paths.visuals)) {
    const scenes = Object.values(readJson(paths.visuals, "visual manifest").scenes || {});
    providerSplit = scenes
      .filter((scene) => scene.status === "complete" || !scene.status)
      .reduce(
        (counts, scene) => ({
          ...counts,
          [scene.provider]: (counts[scene.provider] || 0) + 1,
        }),
        {},
      );
  }
  return {
    project: paths.projectDir,
    plan: validation ? planSummary(validation) : null,
    stages: state.stages,
    artifact_integrity: Object.fromEntries(
      STAGES.map((stage) => [stage, stageArtifactsCurrent(stage, paths)]),
    ),
    artifacts: state.artifacts,
    actual_provider_split: providerSplit,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  if (parsed.command === "help") {
    console.log(helpText());
    return { help: true };
  }
  const args = parsed.args;
  const projectDir = resolve(String(args.project || "."));
  const paths = projectPaths(projectDir);
  loadEnvFromDir(projectDir);

  if (parsed.command === "init") {
    const result = initProject(projectDir, args);
    return emit(
      { project: projectDir, plan: relative(projectDir, result.paths.plan) },
      {
        json: args.json,
        lines: [
          `✓ YouTube project initialized: ${projectDir}`,
          `  plan: ${relative(projectDir, result.paths.plan)}`,
          "  next: edit youtube-plan.json, then run validate",
        ],
      },
    );
  }

  if (parsed.command === "preflight") {
    const result = preflight(projectDir);
    if (!args.json) {
      for (const check of result.checks) {
        const mark = check.ok ? "✓" : check.optional ? "·" : "✗";
        console.log(`${mark} ${check.name}: ${check.detail}`);
      }
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    if (!result.ok) process.exitCode = 1;
    return result;
  }

  if (parsed.command === "status") {
    const report = statusReport(paths);
    if (args.json) {
      console.log(JSON.stringify({ ok: true, ...report }, null, 2));
    } else {
      console.log(`YouTube pipeline: ${projectDir}`);
      for (const stage of STAGES) {
        const status = report.stages[stage]?.status || "pending";
        const integrity = report.artifact_integrity[stage] ? "artifacts-ok" : "artifacts-missing";
        console.log(`  ${stage.padEnd(8)} ${status.padEnd(9)} ${integrity}`);
      }
      if (Object.keys(report.actual_provider_split).length) {
        console.log(`  providers ${JSON.stringify(report.actual_provider_split)}`);
      }
    }
    return report;
  }

  const validation = loadValidatedPlan(paths);
  if (parsed.command === "validate") {
    persistPlanStage(paths, validation);
    const summary = planSummary(validation);
    return emit(summary, {
      json: args.json,
      lines: [
        `✓ plan valid: ${summary.title}`,
        `  ${summary.format} · ${summary.scenes} scenes · ${summary.planned_duration_s}s planned`,
        `  providers: ${JSON.stringify(summary.provider_split)}`,
        ...summary.warnings.map((warning) => `  warning: ${warning}`),
      ],
    });
  }

  let stageResult;
  if (parsed.command === "visuals") stageResult = await runVisualsStage(paths, validation, args);
  else if (parsed.command === "audio") stageResult = await runAudioStage(paths, validation, args);
  else if (parsed.command === "compose") stageResult = await runComposeStage(paths, validation, args);
  else if (parsed.command === "render") stageResult = await runRenderStage(paths, validation, args);
  else if (parsed.command === "package") stageResult = await runPackageStage(paths, validation, args);
  else if (parsed.command === "publish") stageResult = await runPublishStage(paths, validation, args);
  else if (parsed.command === "run") stageResult = await runThrough(paths, validation, args);

  const value = {
    command: parsed.command,
    skipped: stageResult?.skipped || false,
    result: stageResult?.result || stageResult,
  };
  return emit(value, {
    json: args.json,
    lines: [
      `✓ ${parsed.command} ${stageResult?.skipped ? "already current" : "complete"}`,
      parsed.command === "compose" ? "  preview: npx hyperframes preview" : "",
      parsed.command === "package" ? `  package: ${paths.packageDir}` : "",
      parsed.command === "publish" && stageResult?.result?.video_id
        ? `  YouTube video id: ${stageResult.result.video_id}`
        : "",
    ].filter(Boolean),
  });
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) {
  main().catch((error) => {
    const json = process.argv.includes("--json");
    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: error?.message || String(error),
            code: error?.code || null,
            retryable: Boolean(error?.retryable),
            task_id: error?.taskId || null,
            scene_id: error?.sceneId || null,
            session_url: error?.sessionUrl || null,
            video_id: error?.videoId || null,
            publish_stage: error?.publishStage || null,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`✗ ${error?.message || error}`);
      if (error?.taskId) {
        console.error(`  MiniMax task id: ${error.taskId}${error.sceneId ? ` (${error.sceneId})` : ""}`);
      }
      if (error?.videoId) console.error(`  YouTube video id: ${error.videoId}`);
      if (error?.sessionUrl) console.error("  upload session preserved for resume");
    }
    process.exitCode = 1;
  });
}
