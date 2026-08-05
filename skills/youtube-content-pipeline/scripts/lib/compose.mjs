import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { stableHash } from "./plan.mjs";

export const NORMALIZED_SCENE_DIR = "assets/youtube/scenes";
export const DEFAULT_CAPTION_WORDS = 6;

function round(value, digits = 3) {
  return Number(Number(value).toFixed(digits));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e");
}

function voiceMap(audioMeta) {
  return new Map((audioMeta?.voices || []).map((voice) => [String(voice.id), voice]));
}

export function buildSchedule(plan, audioMeta = {}) {
  const voices = voiceMap(audioMeta);
  let cursor = 0;
  const scenes = plan.scenes.map((scene, index) => {
    const voice = voices.get(scene.id) || null;
    const voiceDuration = voice ? Number(voice.duration_s) : 0;
    const narrationStart = cursor + plan.production.lead_in_s;
    const requiredDuration = voiceDuration
      ? plan.production.lead_in_s + voiceDuration + plan.production.tail_s
      : scene.duration_s;
    const duration = Math.max(Number(scene.duration_s), requiredDuration);
    const scheduled = {
      ...scene,
      index,
      start_s: round(cursor),
      end_s: round(cursor + duration),
      duration_s: round(duration),
      narration_start_s: round(narrationStart),
      narration_end_s: round(narrationStart + voiceDuration),
      voice_duration_s: round(voiceDuration),
      voice_path: voice?.path || null,
      words: Array.isArray(voice?.words) ? voice.words : [],
    };
    cursor += duration;
    return scheduled;
  });
  return { scenes, total_duration_s: round(cursor) };
}

export function applyVerifiedMediaCapabilities(schedule, visualManifest = {}) {
  return {
    ...schedule,
    scenes: schedule.scenes.map((scene) => {
      const record = visualManifest?.scenes?.[scene.id] || {};
      const hasNativeAudio = record.has_native_audio === true;
      const requested = record.native_audio_requested || scene.native_audio || "mute";
      return {
        ...scene,
        native_audio_requested: requested,
        native_audio: hasNativeAudio && requested !== "mute" ? requested : "mute",
        has_native_audio: hasNativeAudio,
        native_audio_verified: hasNativeAudio,
      };
    }),
  };
}

export function buildNormalizeVideoArgs({
  inputPath,
  outputPath,
  width,
  height,
  fps,
  durationS,
}) {
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `fps=${fps}`,
    `tpad=stop_mode=clone:stop_duration=${round(durationS + 1, 3)}`,
    `trim=duration=${round(durationS, 3)}`,
    "setpts=PTS-STARTPTS",
  ].join(",");
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-vf",
    filter,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

function runFfmpeg(args, { spawnSync = nodeSpawnSync, timeoutMs = 1_800_000 } = {}) {
  const result = spawnSync("ffmpeg", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `ffmpeg failed${result.status != null ? ` with status ${result.status}` : ""}: ${
        result.error?.message || String(result.stderr || result.stdout || "").trim()
      }`,
    );
  }
  return result;
}

function isNonEmptyFile(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export function normalizeVisualAssets(
  plan,
  schedule,
  visualManifest,
  {
    projectDir,
    spawnSync = nodeSpawnSync,
    onProgress = () => {},
  } = {},
) {
  const outDir = join(projectDir, NORMALIZED_SCENE_DIR);
  mkdirSync(outDir, { recursive: true });
  const records = {};
  for (const scene of schedule.scenes) {
    const source = visualManifest?.scenes?.[scene.id];
    if (!source?.path) throw new Error(`visual manifest has no asset for scene ${scene.id}`);
    const inputPath = resolve(projectDir, source.path);
    if (!isNonEmptyFile(inputPath)) throw new Error(`scene ${scene.id} asset is missing or empty: ${source.path}`);
    const outputPath = join(outDir, `${scene.id}.mp4`);
    const inputHash = stableHash({
      source,
      duration: scene.duration_s,
      width: plan.video.width,
      height: plan.video.height,
      fps: plan.video.fps,
    });
    onProgress({ type: "start", scene, outputPath });
    runFfmpeg(
      buildNormalizeVideoArgs({
        inputPath,
        outputPath,
        width: plan.video.width,
        height: plan.video.height,
        fps: plan.video.fps,
        durationS: scene.duration_s,
      }),
      { spawnSync },
    );
    if (!isNonEmptyFile(outputPath)) throw new Error(`ffmpeg produced no normalized clip for ${scene.id}`);
    records[scene.id] = {
      ...source,
      normalized_path: relative(projectDir, outputPath),
      input_hash: inputHash,
    };
    onProgress({ type: "complete", scene, outputPath });
  }
  return records;
}

function punctuationBreak(text) {
  return /[.!?…][\"')\]]?$/.test(String(text));
}

export function buildCaptionGroups(schedule, { maxWords = DEFAULT_CAPTION_WORDS } = {}) {
  const groups = [];
  for (const scene of schedule.scenes) {
    if (!scene.words.length) continue;
    let current = [];
    const flush = () => {
      if (!current.length) return;
      const words = current.map((word) => ({
        t: String(word.text),
        s: round(scene.narration_start_s + Number(word.start || 0)),
        e: round(scene.narration_start_s + Number(word.end || word.start || 0)),
      }));
      const start = words[0].s;
      const end = Math.min(scene.end_s, round(words.at(-1).e + 0.18));
      groups.push({
        id: `${scene.id}-${groups.length + 1}`,
        scene_id: scene.id,
        start,
        end: Math.max(start + 0.2, end),
        words,
        text: words.map((word) => word.t).join(" "),
      });
      current = [];
    };
    for (const word of scene.words) {
      current.push(word);
      if (current.length >= maxWords || punctuationBreak(word.text)) flush();
    }
    flush();
  }
  return groups;
}

function timestampParts(seconds, separator) {
  const totalMs = Math.max(0, Math.round(Number(seconds) * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(
    2,
    "0",
  )}${separator}${String(ms).padStart(3, "0")}`;
}

export function captionsToSrt(groups) {
  return `${groups
    .map(
      (group, index) =>
        `${index + 1}\n${timestampParts(group.start, ",")} --> ${timestampParts(group.end, ",")}\n${group.text}`,
    )
    .join("\n\n")}\n`;
}

export function captionsToVtt(groups) {
  return `WEBVTT\n\n${groups
    .map(
      (group) =>
        `${timestampParts(group.start, ".")} --> ${timestampParts(group.end, ".")}\n${group.text}`,
    )
    .join("\n\n")}\n`;
}

function captionFontSize(plan) {
  return plan.video.height > plan.video.width ? 58 : 46;
}

export function buildCaptionsHtml(plan, schedule, groups) {
  const groupJson = safeJson(groups);
  const maxWidth = plan.video.height > plan.video.width ? Math.round(plan.video.width * 0.84) : 1420;
  const bottom = plan.video.height > plan.video.width ? 180 : 72;
  return `<!doctype html>
<html lang="${escapeHtml(plan.video.language)}">
  <head><meta charset="UTF-8" /><title>YouTube captions</title></head>
  <body>
    <template>
      <style>
        #root { position:absolute; inset:0; width:${plan.video.width}px; height:${plan.video.height}px; pointer-events:none; }
        .caption-group { position:absolute; left:0; right:0; bottom:${bottom}px; text-align:center; opacity:0; visibility:hidden; }
        .caption-pill { display:inline-block; max-width:${maxWidth}px; padding:16px 28px; border-radius:16px; background:rgba(8,10,16,.88); box-shadow:0 10px 36px rgba(0,0,0,.35); font-family:Inter,Arial,sans-serif; font-size:${captionFontSize(
          plan,
        )}px; line-height:1.16; font-weight:800; letter-spacing:-.025em; color:#a8adb9; }
        .caption-word { color:#a8adb9; }
      </style>
      <div id="root" data-composition-id="captions" data-start="0" data-duration="${schedule.total_duration_s}" data-width="${plan.video.width}" data-height="${plan.video.height}" data-layout-allow-caption-zone></div>
      <script>
        (function () {
          var GROUPS = ${groupJson};
          var root = document.getElementById("root");
          GROUPS.forEach(function (group, gi) {
            var outer = document.createElement("div");
            outer.id = "caption-group-" + gi;
            outer.className = "caption-group";
            var pill = document.createElement("div");
            pill.className = "caption-pill";
            group.words.forEach(function (word, wi) {
              if (wi) pill.appendChild(document.createTextNode(" "));
              var span = document.createElement("span");
              span.id = "caption-word-" + gi + "-" + wi;
              span.className = "caption-word";
              span.textContent = word.t;
              pill.appendChild(span);
            });
            outer.appendChild(pill);
            root.appendChild(outer);
          });
          window.__timelines = window.__timelines || {};
          var tl = gsap.timeline({ paused: true });
          GROUPS.forEach(function (group, gi) {
            var selector = "#caption-group-" + gi;
            tl.fromTo(selector, { autoAlpha:0, y:14 }, { autoAlpha:1, y:0, duration:.16, ease:"power3.out" }, group.start);
            group.words.forEach(function (word, wi) {
              tl.to("#caption-word-" + gi + "-" + wi, { color:"#ffffff", duration:.12, ease:"none" }, word.s);
            });
            tl.to(selector, { autoAlpha:0, y:-8, duration:.1, ease:"power2.in" }, Math.max(group.start, group.end - .1));
            tl.set(selector, { opacity:0, visibility:"hidden" }, group.end);
          });
          window.__timelines.captions = tl;
        })();
      </script>
    </template>
  </body>
</html>\n`;
}

function sceneCopyClass(plan) {
  return plan.video.height > plan.video.width ? "portrait" : "landscape";
}

function mediaPathForHtml(path) {
  return String(path).split("\\").join("/");
}

export function buildMainHtml(plan, schedule, normalized, audioMeta) {
  const sceneLayers = schedule.scenes
    .map((scene) => {
      const record = normalized[scene.id];
      const copy = scene.on_screen_text
        ? `<div id="copy-${escapeHtml(scene.id)}" class="clip scene-copy ${sceneCopyClass(
            plan,
          )}" data-start="${scene.start_s}" data-duration="${scene.duration_s}" data-track-index="2"><span>${escapeHtml(
            scene.on_screen_text,
          )}</span></div>`
        : "";
      return `<video id="video-${escapeHtml(scene.id)}" class="clip scene-video" src="${escapeHtml(
        mediaPathForHtml(record.normalized_path),
      )}" data-start="${scene.start_s}" data-duration="${scene.duration_s}" data-track-index="1" muted playsinline preload="auto"></video>\n${copy}`;
    })
    .join("\n");

  const voiceAudio = schedule.scenes
    .filter((scene) => scene.voice_path)
    .map(
      (scene, index) =>
        `<audio id="voice-${escapeHtml(scene.id)}" src="${escapeHtml(
          mediaPathForHtml(scene.voice_path),
        )}" data-start="${scene.narration_start_s}" data-duration="${scene.voice_duration_s}" data-track-index="${20 + index}" data-volume="1"></audio>`,
    )
    .join("\n");

  const nativeAudio = schedule.scenes
    .filter((scene) => scene.native_audio !== "mute" && scene.native_audio_verified)
    .map((scene, index) => {
      const source = normalized[scene.id].path;
      const volume = scene.native_audio === "keep" ? 0.52 : 0.12;
      return `<audio id="native-${escapeHtml(scene.id)}" src="${escapeHtml(
        mediaPathForHtml(source),
      )}" data-start="${scene.start_s}" data-duration="${scene.duration_s}" data-track-index="${40 + index}" data-volume="${volume}"></audio>`;
    })
    .join("\n");

  const bgm = audioMeta?.bgm?.path
    ? `<audio id="bgm" src="${escapeHtml(mediaPathForHtml(audioMeta.bgm.path))}" data-start="0" data-duration="${schedule.total_duration_s}" data-track-index="60" data-volume="0.16" loop></audio>`
    : "";

  const fade = Math.min(plan.production.transition_s, 0.8);
  const timeline = schedule.scenes
    .map((scene) => {
      const sceneFade = Math.min(fade, scene.duration_s / 3);
      const copy = scene.on_screen_text
        ? `tl.fromTo("#copy-${scene.id}", { autoAlpha:0, y:26 }, { autoAlpha:1, y:0, duration:${round(
            sceneFade,
          )}, ease:"power3.out" }, ${round(scene.start_s + 0.12)});\ntl.to("#copy-${scene.id}", { autoAlpha:0, y:-16, duration:${round(
            sceneFade,
          )}, ease:"power2.in" }, ${round(scene.end_s - sceneFade)});`
        : "";
      const bgmDuck =
        bgm && scene.voice_duration_s
          ? `tl.to("#bgm", { volume:.07, duration:.22, ease:"sine.inOut" }, ${round(
              Math.max(0, scene.narration_start_s - 0.15),
            )});\ntl.to("#bgm", { volume:.16, duration:.35, ease:"sine.inOut" }, ${round(
              scene.narration_end_s + 0.08,
            )});`
          : "";
      return `tl.fromTo("#video-${scene.id}", { autoAlpha:0, scale:1.025 }, { autoAlpha:1, scale:1, duration:${round(
        sceneFade,
      )}, ease:"power2.out" }, ${scene.start_s});\ntl.to("#video-${scene.id}", { autoAlpha:0, duration:${round(
        sceneFade,
      )}, ease:"power2.in" }, ${round(scene.end_s - sceneFade)});\n${copy}\n${bgmDuck}`;
    })
    .join("\n");

  const captionBand = plan.video.height > plan.video.width ? 320 : 190;
  return `<!doctype html>
<html lang="${escapeHtml(plan.video.language)}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${plan.video.width}, height=${plan.video.height}" />
    <title>${escapeHtml(plan.video.title)}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { box-sizing:border-box; margin:0; padding:0; }
      html, body { width:${plan.video.width}px; height:${plan.video.height}px; overflow:hidden; background:#050609; }
      #root { position:relative; width:${plan.video.width}px; height:${plan.video.height}px; overflow:hidden; background:#050609; font-family:Inter,Arial,sans-serif; }
      .ground { position:absolute; inset:0; background:#050609; }
      .scene-video { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; opacity:0; }
      .scene-copy { position:absolute; left:0; right:0; bottom:${captionBand}px; padding:0 ${Math.round(
        plan.video.width * 0.07,
      )}px; opacity:0; pointer-events:none; }
      .scene-copy span { display:inline-block; max-width:90%; padding:12px 20px; border-left:8px solid ${escapeHtml(
        plan.video.thumbnail.accent,
      )}; background:rgba(5,6,9,.72); color:#fff; font-weight:900; font-size:${
        plan.video.height > plan.video.width ? 64 : 58
      }px; line-height:1.02; letter-spacing:-.035em; text-transform:uppercase; text-shadow:0 4px 18px rgba(0,0,0,.45); }
      .scene-copy.portrait span { max-width:96%; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${schedule.total_duration_s}" data-fps="${plan.video.fps}" data-width="${plan.video.width}" data-height="${plan.video.height}">
      <div class="clip ground" data-start="0" data-duration="${schedule.total_duration_s}" data-track-index="0"></div>
      ${sceneLayers}
      <div id="captions-slot" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${schedule.total_duration_s}" data-track-index="5" data-width="${plan.video.width}" data-height="${plan.video.height}"></div>
      ${voiceAudio}
      ${nativeAudio}
      ${bgm}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      var tl = gsap.timeline({ paused:true });
      ${timeline}
      ${bgm ? `tl.to("#bgm", { volume:0, duration:.8, ease:"sine.in" }, ${round(Math.max(0, schedule.total_duration_s - 0.8))});` : ""}
      window.__timelines.main = tl;
    </script>
  </body>
</html>\n`;
}

function thumbnailProjectHtml(plan) {
  const headline = escapeHtml(plan.video.thumbnail.headline);
  const subhead = escapeHtml(plan.video.thumbnail.subhead);
  return `<!doctype html>
<html lang="${escapeHtml(plan.video.language)}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1280, height=720" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { box-sizing:border-box; margin:0; padding:0; }
      html,body { width:1280px; height:720px; overflow:hidden; background:#050609; }
      #root { position:relative; width:1280px; height:720px; overflow:hidden; font-family:Inter,Arial,sans-serif; color:#fff; }
      .hero { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; filter:saturate(.9) contrast(1.08) brightness(.7); }
      .shade { position:absolute; inset:0; background:linear-gradient(90deg, rgba(4,5,8,.95) 0%, rgba(4,5,8,.73) 48%, rgba(4,5,8,.1) 100%); }
      .rule { position:absolute; left:76px; top:82px; width:118px; height:14px; background:${escapeHtml(
        plan.video.thumbnail.accent,
      )}; }
      .copy { position:absolute; left:76px; top:128px; width:760px; }
      h1 { font-size:86px; line-height:.94; letter-spacing:-.055em; font-weight:950; text-transform:uppercase; text-shadow:0 10px 36px rgba(0,0,0,.55); }
      p { margin-top:28px; font-size:34px; line-height:1.1; font-weight:750; color:#d9dbe3; }
      .badge { position:absolute; left:76px; bottom:68px; padding:12px 18px; border:2px solid rgba(255,255,255,.7); border-radius:999px; font-size:22px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="thumbnail" data-start="0" data-duration="1" data-fps="30" data-width="1280" data-height="720">
      <img class="clip hero" src="assets/hero.jpg" data-start="0" data-duration="1" data-track-index="0" alt="" />
      <div class="clip shade" data-start="0" data-duration="1" data-track-index="1"></div>
      <div class="clip rule" data-start="0" data-duration="1" data-track-index="2"></div>
      <div class="clip copy" data-start="0" data-duration="1" data-track-index="3"><h1>${headline}</h1>${subhead ? `<p>${subhead}</p>` : ""}</div>
      <div class="clip badge" data-start="0" data-duration="1" data-track-index="4">${escapeHtml(
        plan.channel.name || "New video",
      )}</div>
    </div>
    <script>window.__timelines=window.__timelines||{};window.__timelines.thumbnail=gsap.timeline({paused:true});</script>
  </body>
</html>\n`;
}

function writeProjectFiles(projectDir, plan) {
  const packageJson = {
    name: plan.video.slug,
    private: true,
    type: "module",
    scripts: {
      dev: "npx hyperframes preview",
      check: "npx hyperframes check",
      render: "npx hyperframes render",
    },
  };
  const hyperframes = {
    $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
    registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
    paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
    media: { autoProxy: true },
    authoringSkill: "youtube-content-pipeline",
  };
  writeFileSync(join(projectDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(join(projectDir, "hyperframes.json"), `${JSON.stringify(hyperframes, null, 2)}\n`);
}

function extractThumbnailHero(firstNormalizedPath, thumbnailDir, spawnSync) {
  const assetsDir = join(thumbnailDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const target = join(assetsDir, "hero.jpg");
  runFfmpeg(
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "1",
      "-i",
      firstNormalizedPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
      "-q:v",
      "2",
      target,
    ],
    { spawnSync },
  );
  if (!isNonEmptyFile(target)) throw new Error("ffmpeg produced no thumbnail hero frame");
  return target;
}

export function composeProject(
  plan,
  visualManifest,
  audioMeta,
  {
    projectDir,
    force = false,
    spawnSync = nodeSpawnSync,
    onProgress = () => {},
  } = {},
) {
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, "compositions"), { recursive: true });
  mkdirSync(join(projectDir, ".youtube-pipeline"), { recursive: true });
  const schedule = applyVerifiedMediaCapabilities(
    buildSchedule(plan, audioMeta),
    visualManifest,
  );
  const normalized = normalizeVisualAssets(plan, schedule, visualManifest, {
    projectDir,
    spawnSync,
    onProgress,
  });
  const groups = buildCaptionGroups(schedule);

  writeProjectFiles(projectDir, plan);
  writeFileSync(join(projectDir, "index.html"), buildMainHtml(plan, schedule, normalized, audioMeta));
  writeFileSync(
    join(projectDir, "compositions", "captions.html"),
    buildCaptionsHtml(plan, schedule, groups),
  );
  writeFileSync(join(projectDir, "captions.srt"), captionsToSrt(groups));
  writeFileSync(join(projectDir, "captions.vtt"), captionsToVtt(groups));

  const thumbnailDir = join(projectDir, "thumbnail-project");
  if (force) rmSync(thumbnailDir, { recursive: true, force: true });
  mkdirSync(thumbnailDir, { recursive: true });
  const first = schedule.scenes[0];
  extractThumbnailHero(resolve(projectDir, normalized[first.id].normalized_path), thumbnailDir, spawnSync);
  writeFileSync(join(thumbnailDir, "index.html"), thumbnailProjectHtml(plan));
  writeFileSync(
    join(thumbnailDir, "hyperframes.json"),
    `${JSON.stringify(
      {
        $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
        paths: { assets: "assets" },
        media: { autoProxy: true },
        authoringSkill: "youtube-content-pipeline",
      },
      null,
      2,
    )}\n`,
  );

  const expectedAudio = Boolean(
    audioMeta?.bgm?.path ||
      schedule.scenes.some(
        (scene) => scene.voice_path || (scene.native_audio_verified && scene.native_audio !== "mute"),
      ),
  );
  const composition = {
    version: 1,
    plan_hash: stableHash(plan),
    total_duration_s: schedule.total_duration_s,
    width: plan.video.width,
    height: plan.video.height,
    fps: plan.video.fps,
    expected_audio: expectedAudio,
    schedule,
    scenes: normalized,
    captions: groups,
    audio: {
      bgm_path: audioMeta?.bgm?.path || null,
      voice_count: schedule.scenes.filter((scene) => scene.voice_path).length,
      verified_native_audio_count: schedule.scenes.filter(
        (scene) => scene.native_audio_verified && scene.native_audio !== "mute",
      ).length,
    },
    files: {
      index: "index.html",
      captions_html: "compositions/captions.html",
      captions_srt: "captions.srt",
      captions_vtt: "captions.vtt",
      thumbnail_project: "thumbnail-project",
    },
  };
  const manifestPath = join(projectDir, ".youtube-pipeline", "composition.json");
  writeFileSync(manifestPath, `${JSON.stringify(composition, null, 2)}\n`);
  return { composition, manifestPath, schedule, normalized, groups };
}

export function readCompositionManifest(projectDir) {
  return JSON.parse(readFileSync(join(projectDir, ".youtube-pipeline", "composition.json"), "utf8"));
}
