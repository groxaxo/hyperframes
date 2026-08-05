import { execFile as nodeExecFile, spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableHash } from "./plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RESOLVE_SCRIPT = resolve(HERE, "../../../media-use/scripts/resolve.mjs");
export const DEFAULT_AUDIO_SCRIPT = resolve(HERE, "../../../media-use/audio/scripts/audio.mjs");

const TERMINAL_MINIMAX_CODES = new Set(["failed", "cancelled", "expired"]);

export class PipelineCommandError extends Error {
  constructor(
    message,
    {
      status = null,
      stdout = "",
      stderr = "",
      code = null,
      retryable = false,
      taskId = null,
      sessionUrl = null,
    } = {},
  ) {
    super(message);
    this.name = "PipelineCommandError";
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
    this.retryable = Boolean(retryable);
    this.taskId = taskId;
    this.sessionUrl = sessionUrl;
  }
}

function parseJsonOutput(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Child tools may print progress before their final JSON line.
    }
  }
  return null;
}

function taskIdFromText(value) {
  const text = String(value || "");
  const match = /(?:task[_ -]?id|task)\s*(?:=|:|is)?\s*["']?([A-Za-z0-9_-]{4,})/i.exec(text);
  return match?.[1] || null;
}

export function runNodeJson(
  script,
  args,
  {
    cwd,
    env = process.env,
    timeoutMs = 7_200_000,
    maxBuffer = 16 * 1024 * 1024,
    execFile = nodeExecFile,
  } = {},
) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [script, ...args],
      { cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer, windowsHide: true },
      (error, stdout = "", stderr = "") => {
        const payload = parseJsonOutput(stdout);
        const status = error && Number.isInteger(error.code) ? error.code : error ? null : 0;
        if (error || payload?.ok === false) {
          const detail = payload?.error || String(stderr || stdout || error?.message || "").trim();
          const taskId =
            payload?.task_id ||
            payload?.taskId ||
            taskIdFromText(payload?.error) ||
            taskIdFromText(stderr);
          reject(
            new PipelineCommandError(
              `${script} exited${status != null ? ` with status ${status}` : ""}${detail ? ` — ${detail}` : ""}`,
              {
                status,
                stdout,
                stderr,
                code: payload?.code || null,
                retryable: payload?.retryable || false,
                taskId,
                sessionUrl: payload?.session_url || payload?.sessionUrl || null,
              },
            ),
          );
          return;
        }
        if (!payload) {
          reject(new PipelineCommandError(`${script} returned no JSON payload`, { status, stdout, stderr }));
          return;
        }
        resolvePromise(payload);
      },
    );
  });
}

export function ltxFramesForDuration(durationS, fps = 24) {
  const target = Math.max(9, Math.ceil(Number(durationS) * fps));
  return Math.ceil((target - 1) / 8) * 8 + 1;
}

export function miniMaxDurationForScene(durationS) {
  return Math.max(4, Math.min(15, Math.round(Number(durationS) || 5)));
}

export function sceneGenerationIntent(plan, scene) {
  const orientation =
    plan.video.height > plan.video.width
      ? "Vertical 9:16 YouTube Short composition."
      : "Landscape 16:9 YouTube composition.";
  return [
    orientation,
    scene.visual_prompt,
    "Do not render captions, logos, watermarks, or readable interface text; editorial text will be added in post-production.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function sceneProviderEnv(
  plan,
  scene,
  baseEnv = process.env,
  { workerSlot = 0, resumeTaskId = null } = {},
) {
  const env = { ...baseEnv };
  if (scene.provider === "comfyui") {
    const fps = 24;
    const workers = comfyUiWorkerUrls(baseEnv);
    env.COMFYUI_URL = workers[Math.abs(workerSlot) % workers.length];
    env.COMFYUI_LTX23_FRAMES = String(ltxFramesForDuration(scene.duration_s, fps));
    env.COMFYUI_LTX23_FPS = String(fps);
    env.COMFYUI_LTX23_NEGATIVE_PROMPT = scene.negative_prompt;
  }
  if (scene.provider === "gemini") {
    env.GEMINI_VIDEO_ASPECT_RATIO = plan.video.height > plan.video.width ? "9:16" : "16:9";
  }
  if (scene.provider === "minimax") {
    env.MINIMAX_H3_DURATION = String(miniMaxDurationForScene(scene.duration_s));
    env.MINIMAX_H3_RATIO = plan.video.height > plan.video.width ? "9:16" : "16:9";
    env.MINIMAX_H3_NEGATIVE_PROMPT = scene.negative_prompt;
    if (resumeTaskId) env.MINIMAX_H3_RESUME_TASK_ID = String(resumeTaskId);
    else delete env.MINIMAX_H3_RESUME_TASK_ID;
  }
  return env;
}

export function comfyUiWorkerUrls(env = process.env) {
  let values = [];
  if (typeof env.COMFYUI_URLS_JSON === "string" && env.COMFYUI_URLS_JSON.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(env.COMFYUI_URLS_JSON);
    } catch (error) {
      throw new Error(`COMFYUI_URLS_JSON must be a JSON array: ${error.message}`);
    }
    if (!Array.isArray(parsed)) throw new Error("COMFYUI_URLS_JSON must be a JSON array");
    values = parsed;
  } else if (typeof env.COMFYUI_URLS === "string" && env.COMFYUI_URLS.trim()) {
    values = env.COMFYUI_URLS.split(",");
  } else {
    values = [env.COMFYUI_URL || "http://127.0.0.1:8188"];
  }
  const normalized = [];
  for (const raw of values) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    let url;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new Error(`invalid ComfyUI worker URL: ${raw}`);
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error(`ComfyUI worker URL must use http or https: ${raw}`);
    if (url.username || url.password)
      throw new Error("ComfyUI worker URLs must not embed credentials; use header environment variables");
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    const value = url.toString().replace(/\/$/, "");
    if (!normalized.includes(value)) normalized.push(value);
  }
  if (!normalized.length) throw new Error("at least one ComfyUI worker URL is required");
  return normalized;
}

function providerFamily(provider) {
  const value = String(provider || "");
  if (value.startsWith("gemini")) return "gemini";
  if (value.startsWith("comfyui")) return "comfyui";
  if (value.startsWith("minimax")) return "minimax";
  return value || "unknown";
}

function absoluteAsset(projectDir, assetPath) {
  return resolve(projectDir, assetPath);
}

function isNonEmptyFile(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function existingSceneRecord(record, projectDir, inputHash) {
  return (
    record &&
    record.status !== "pending_remote" &&
    record.status !== "failed_remote" &&
    record.input_hash === inputHash &&
    typeof record.path === "string" &&
    isNonEmptyFile(absoluteAsset(projectDir, record.path))
  );
}

function sha256File(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function configuredWorkflow(projectDir, env) {
  const value = env.COMFYUI_LTX23_WORKFLOW || env.COMFYUI_LTX_WORKFLOW;
  if (!value) return { path: null, hash: null };
  const path = isAbsolute(value) ? value : resolve(projectDir, value);
  return { path, hash: sha256File(path) };
}

export function sceneProviderFingerprint(
  plan,
  scene,
  { projectDir, env = process.env, workerSlot = 0 } = {},
) {
  const providerEnv = sceneProviderEnv(plan, scene, env, { workerSlot });
  if (scene.provider === "comfyui") {
    const workflow = configuredWorkflow(projectDir, providerEnv);
    return stableHash({
      provider: "comfyui",
      workflow_hash: workflow.hash,
      workflow_configured: Boolean(workflow.path),
      model: providerEnv.COMFYUI_LTX23_MODEL || null,
      bindings: providerEnv.COMFYUI_LTX23_BINDINGS_JSON || null,
      width: providerEnv.COMFYUI_LTX23_WIDTH || null,
      height: providerEnv.COMFYUI_LTX23_HEIGHT || null,
      frames: providerEnv.COMFYUI_LTX23_FRAMES,
      fps: providerEnv.COMFYUI_LTX23_FPS,
      negative_prompt: providerEnv.COMFYUI_LTX23_NEGATIVE_PROMPT,
    });
  }
  if (scene.provider === "minimax") {
    return stableHash({
      provider: "minimax",
      api_host: providerEnv.MINIMAX_API_HOST || providerEnv.MINIMAX_API_BASE_URL || "global",
      resolution: providerEnv.MINIMAX_H3_RESOLUTION || "2K",
      duration: providerEnv.MINIMAX_H3_DURATION,
      ratio: providerEnv.MINIMAX_H3_RATIO,
      negative_prompt: providerEnv.MINIMAX_H3_NEGATIVE_PROMPT,
      first_frame: providerEnv.MINIMAX_H3_FIRST_FRAME || null,
      last_frame: providerEnv.MINIMAX_H3_LAST_FRAME || null,
      reference_images: providerEnv.MINIMAX_H3_REFERENCE_IMAGES_JSON || null,
      reference_videos: providerEnv.MINIMAX_H3_REFERENCE_VIDEOS_JSON || null,
      reference_audios: providerEnv.MINIMAX_H3_REFERENCE_AUDIOS_JSON || null,
    });
  }
  if (scene.provider === "gemini") {
    return stableHash({
      provider: "gemini",
      model: providerEnv.GEMINI_VIDEO_MODEL || "gemini-omni-flash-preview",
      aspect_ratio: providerEnv.GEMINI_VIDEO_ASPECT_RATIO,
    });
  }
  return stableHash({ provider: scene.provider });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let firstError = null;
  async function runWorker() {
    while (!firstError) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        firstError ||= error;
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  if (firstError) throw firstError;
  return results;
}

function requiredProviderFamilies(policy) {
  if (policy === "tri-hybrid") return ["gemini", "comfyui", "minimax"];
  if (policy === "hybrid") return ["gemini", "comfyui"];
  return [];
}

let manifestWriteSequence = 0;
function writeManifestAtomic(path, value) {
  manifestWriteSequence += 1;
  const temp = `${path}.tmp-${process.pid}-${manifestWriteSequence}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function miniMaxCheckpointRecord(scene, inputHash, error, status) {
  return {
    id: scene.id,
    status,
    requested_provider: "minimax",
    provider: "minimax",
    task_id: error.taskId,
    target_duration_s: scene.duration_s,
    native_audio: "mute",
    native_audio_requested: scene.native_audio,
    input_hash: inputHash,
    error_code: error.code || null,
    error_message: error.message,
    updated_at: new Date().toISOString(),
  };
}

export async function generateVisuals(
  plan,
  {
    projectDir,
    manifestPath = join(projectDir, ".youtube-pipeline", "scenes.json"),
    resolveScript = DEFAULT_RESOLVE_SCRIPT,
    force = false,
    env = process.env,
    runJson = runNodeJson,
    onProgress = () => {},
  },
) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  let previous = { version: 1, scenes: {} };
  try {
    previous = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    // A missing or invalid manifest is a fresh visual stage.
  }
  const records = { ...(previous.scenes || {}) };
  const comfySceneIds = plan.scenes
    .filter((scene) => scene.provider === "comfyui" || scene.fallback_provider === "comfyui")
    .map((scene) => scene.id);
  const comfyPoolSize = comfySceneIds.length ? comfyUiWorkerUrls(env).length : 0;

  const generated = await mapWithConcurrency(
    plan.scenes,
    plan.production.max_concurrency,
    async (scene, index) => {
      const providers = [scene.provider, scene.fallback_provider].filter(
        (provider, position, all) => provider && all.indexOf(provider) === position,
      );
      const comfyOrdinal = Math.max(0, comfySceneIds.indexOf(scene.id));
      const runtimeFingerprints = providers.map((provider) => {
        const candidate = { ...scene, provider };
        return sceneProviderFingerprint(plan, candidate, {
          projectDir,
          env,
          workerSlot: provider === "comfyui" ? comfyOrdinal : 0,
        });
      });
      const inputHash = stableHash({
        scene,
        format: plan.video.format,
        width: plan.video.width,
        height: plan.video.height,
        runtime_fingerprints: runtimeFingerprints,
      });
      const previousRecord = records[scene.id];
      if (!force && existingSceneRecord(previousRecord, projectDir, inputHash)) {
        onProgress({ type: "skip", scene, index, record: previousRecord });
        return previousRecord;
      }
      if (
        !force &&
        previousRecord?.status === "failed_remote" &&
        previousRecord.input_hash === inputHash
      ) {
        throw new PipelineCommandError(
          `scene ${scene.id} has a terminal MiniMax task failure (${previousRecord.task_id}); pass --force only after deciding to submit a new paid task`,
          {
            code: previousRecord.error_code || "failed_remote",
            taskId: previousRecord.task_id,
          },
        );
      }

      const resumableTaskId =
        previousRecord?.status === "pending_remote" && previousRecord.input_hash === inputHash
          ? previousRecord.task_id
          : null;
      let lastError;
      for (const provider of providers) {
        const candidate = { ...scene, provider };
        const workerSlot = provider === "comfyui" ? comfyOrdinal : 0;
        const providerResumeTaskId = provider === "minimax" ? resumableTaskId : null;
        onProgress({
          type: providerResumeTaskId ? "resume" : "start",
          scene: candidate,
          index,
          workerSlot,
          taskId: providerResumeTaskId,
        });
        try {
          const payload = await runJson(
            resolveScript,
            [
              "--type",
              "video",
              "--provider",
              provider,
              "--intent",
              sceneGenerationIntent(plan, candidate),
              "--project",
              projectDir,
              "--json",
            ],
            {
              cwd: projectDir,
              env: sceneProviderEnv(plan, candidate, env, {
                workerSlot,
                resumeTaskId: providerResumeTaskId,
              }),
            },
          );
          if (!payload.path) throw new Error("media-use returned no frozen asset path");
          const actualProvider = providerFamily(payload.provenance?.provider || provider);
          const nativeAudioVerified = payload.provenance?.native_audio === true;
          const record = {
            id: scene.id,
            status: "complete",
            requested_provider: provider,
            provider: actualProvider,
            path: payload.path,
            source_duration_s: payload.duration ?? null,
            target_duration_s: scene.duration_s,
            native_audio_requested: scene.native_audio,
            native_audio:
              scene.native_audio !== "mute" && nativeAudioVerified
                ? scene.native_audio
                : "mute",
            has_native_audio: nativeAudioVerified,
            ...(actualProvider === "comfyui" && {
              worker_slot: workerSlot % comfyPoolSize,
              worker_pool_size: comfyPoolSize,
            }),
            input_hash: inputHash,
            runtime_fingerprint: runtimeFingerprints[providers.indexOf(provider)],
            provenance: payload.provenance || {},
          };
          records[scene.id] = record;
          writeManifestAtomic(manifestPath, {
            version: 1,
            plan_hash: stableHash(plan),
            scenes: records,
          });
          onProgress({ type: "complete", scene: candidate, index, record });
          return record;
        } catch (error) {
          lastError = error;
          error.sceneId ||= scene.id;
          onProgress({ type: "provider-failed", scene: candidate, index, error });
          if (provider === "minimax" || error?.taskId) {
            if (error?.taskId) {
              const status = TERMINAL_MINIMAX_CODES.has(String(error.code || "").toLowerCase())
                ? "failed_remote"
                : "pending_remote";
              records[scene.id] = miniMaxCheckpointRecord(scene, inputHash, error, status);
              writeManifestAtomic(manifestPath, {
                version: 1,
                plan_hash: stableHash(plan),
                scenes: records,
              });
            }
            throw error;
          }
        }
      }
      throw new Error(
        `scene ${scene.id} failed with ${providers.join(" and ")}: ${lastError?.message || lastError}`,
      );
    },
  );

  const families = new Set(generated.map((record) => record.provider));
  const missing = requiredProviderFamilies(plan.production.provider_policy).filter(
    (provider) => !families.has(provider),
  );
  if (missing.length) {
    throw new Error(
      `${plan.production.provider_policy} visual stage completed without ${missing.join(", ")} (actual: ${[...families].join(", ")})`,
    );
  }
  const manifest = { version: 1, plan_hash: stableHash(plan), scenes: records };
  writeManifestAtomic(manifestPath, manifest);
  return { manifestPath, manifest, generated };
}

export function buildAudioRequest(plan) {
  return {
    provider: "gemini",
    voice: plan.production.gemini_voice,
    lang: plan.video.language,
    speed: 1,
    lines: plan.scenes
      .filter((scene) => scene.narration)
      .map((scene) => ({ id: scene.id, text: scene.narration })),
    bgm: plan.production.background_music
      ? { mode: "retrieve", query: plan.production.background_music_query }
      : { mode: "none" },
  };
}

export function approximateWordTimings(text, durationS) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || !(durationS > 0)) return [];
  const weights = words.map((word) => Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, "").length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;
  return words.map((word, index) => {
    const start = cursor;
    cursor += (weights[index] / total) * durationS;
    return {
      id: `w${index}`,
      text: word,
      start: Number(start.toFixed(3)),
      end: Number(cursor.toFixed(3)),
      approximate: true,
    };
  });
}

export function normalizeAudioMeta(plan, meta) {
  const voices = Array.isArray(meta?.voices) ? meta.voices : [];
  const byId = new Map(voices.map((voice) => [String(voice.id), voice]));
  const normalized = [];
  for (const scene of plan.scenes) {
    if (!scene.narration) continue;
    const voice = byId.get(scene.id);
    if (!voice) throw new Error(`Gemini TTS produced no voice asset for scene ${scene.id}`);
    const duration = Number(voice.duration_s);
    if (!(duration > 0)) throw new Error(`voice asset for scene ${scene.id} has no valid duration`);
    const words =
      Array.isArray(voice.words) && voice.words.length
        ? voice.words
        : approximateWordTimings(scene.narration, duration);
    normalized.push({ ...voice, id: scene.id, words });
  }
  return {
    ...meta,
    tts_provider: "gemini",
    voice_id: plan.production.gemini_voice,
    voices: normalized,
    total_duration_s: Number(
      normalized.reduce((sum, voice) => sum + Number(voice.duration_s || 0), 0).toFixed(3),
    ),
  };
}

export function generateAudio(
  plan,
  {
    projectDir,
    audioScript = DEFAULT_AUDIO_SCRIPT,
    requestPath = join(projectDir, "audio_request.json"),
    outputPath = join(projectDir, "audio_meta.json"),
    normalizedPath = join(projectDir, ".youtube-pipeline", "audio-meta.json"),
    env = process.env,
    spawnSync = nodeSpawnSync,
  },
) {
  const request = buildAudioRequest(plan);
  mkdirSync(dirname(normalizedPath), { recursive: true });
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const only = plan.production.background_music ? "tts,bgm" : "tts";
  const result = spawnSync(
    process.execPath,
    [
      audioScript,
      "--request",
      requestPath,
      "--hyperframes",
      projectDir,
      "--out",
      outputPath,
      "--provider",
      "gemini",
      "--voice",
      plan.production.gemini_voice,
      "--only",
      only,
    ],
    {
      cwd: projectDir,
      env,
      encoding: "utf8",
      timeout: 1_800_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new PipelineCommandError(
      `Gemini audio stage failed${result.status != null ? ` with status ${result.status}` : ""}: ${
        result.error?.message || String(result.stderr || result.stdout || "").trim()
      }`,
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
    );
  }
  let meta;
  try {
    meta = JSON.parse(readFileSync(outputPath, "utf8"));
  } catch (error) {
    throw new Error(`audio engine produced invalid metadata: ${error.message}`);
  }
  const normalized = normalizeAudioMeta(plan, meta);
  writeFileSync(normalizedPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return {
    requestPath: relative(projectDir, requestPath),
    outputPath: relative(projectDir, normalizedPath),
    meta: normalized,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
