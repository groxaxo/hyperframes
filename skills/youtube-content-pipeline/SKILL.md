---
name: youtube-content-pipeline
description: >
  Build a complete, staged YouTube or YouTube Shorts production with HyperFrames,
  combining Gemini Omni hero shots, self-hosted ComfyUI LTX-2.3 B-roll, optional
  MiniMax-H3 2K continuity/reference shots, Gemini 3.1 Flash TTS narration, captions,
  thumbnail, metadata, rendering, and optional YouTube Data API publishing. Use for a
  new channel video, recurring content engine, faceless educational video, product
  story, case study, or Short when the requested deliverable is a YouTube-ready package.
---

# YouTube content pipeline

This workflow owns an end-to-end, resumable YouTube production and invokes the existing `/media-use` providers rather than duplicating API transports:

```text
brief → youtube-plan.json → multi-provider visuals → Gemini TTS → HyperFrames edit
      → QA → thumbnail/captions/metadata package → optional private upload
```

Before running it:

```bash
npx hyperframes skills update youtube-content-pipeline
```

Load `/media-use`, `/hyperframes-core`, `/hyperframes-creative`, and `/hyperframes-cli` before authoring or rendering. Provider references:

```text
../media-use/references/comfyui-ltx23.md
../media-use/references/minimax-h3.md
```

## Operating rules

1. Work stage by stage and report the completed artifact at every boundary.
2. Resume from `.youtube-pipeline/state.json`; never regenerate a completed stage whose input hash and required artifact remain current.
3. Default to `video.privacy: private`. Public publishing requires an explicit owner decision after reviewing the render, thumbnail, metadata, captions, and synthetic-media disclosure.
4. `hybrid` uses Gemini plus ComfyUI. `tri-hybrid` uses Gemini, ComfyUI, and MiniMax-H3 and requires at least one successful scene from each family.
5. MiniMax-H3 is paid and explicit. Never introduce it merely because `MINIMAX_API_KEY` exists.
6. Generated text belongs in HyperFrames, not inside video-model output.
7. Keep generated source video muted unless the scene says `duck` or `keep`; narration must remain intelligible and speech tracks must not compete.
8. Do not invent factual claims. Research-dependent scripts keep a source ledger in `RESEARCH.md`.

## Stage 0 — preflight

```bash
node ../media-use/scripts/resolve.mjs --doctor
```

Default two-provider production:

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export COMFYUI_LTX23_WORKFLOW=/absolute/path/to/ltx23-api.json
export GEMINI_API_KEY=...
```

Add H3 for `provider_policy: minimax` or `tri-hybrid`:

```bash
export MINIMAX_API_KEY=...
# Optional region override:
export MINIMAX_API_HOST=global # or cn
```

Also require Node 22+, FFmpeg/ffprobe, and a functioning HyperFrames renderer. YouTube OAuth is unnecessary until Stage 7.

## Stage 1 — brief, research, and plan

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs init \
  --project videos/<slug> \
  --topic "<topic>" \
  --format long
```

Write `youtube-plan.json` using `references/plan-schema.md`. The plan locks the script, shot list, provider allocation, metadata, disclosure, thumbnail copy, and publishing intent.

### Provider policies

**`hybrid` — default and cheapest mixed path**

- Gemini: hook, hero, demo, reveal, and CTA shots.
- ComfyUI LTX-2.3: repeatable B-roll, visual metaphors, environments, and volume work.

**`tri-hybrid` — use all three intentionally**

- Gemini: prompt-sensitive hero and native-sound shots.
- ComfyUI: private/self-hosted supporting footage.
- MiniMax-H3: 2K continuity-sensitive shots, first/last-frame transitions, ordered reference imagery, reference video, or reference-audio synchronization.

**`minimax` — H3-only visual generation**

Use when every scene depends on MiniMax references or continuity. Gemini TTS still supplies controlled narration unless the plan has no narration.

Keep five-second narration near 13 words at the default delivery rate and use one meaningful claim per shot.

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs validate --project videos/<slug>
```

Checkpoint: report title, format, planned duration, scene count, provider split, and validation warnings.

## Stage 2 — generate visuals

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs visuals \
  --project videos/<slug> \
  --resume
```

Each scene invokes `/media-use` with its explicit provider and freezes the resulting local asset. A failed scene is the retry unit. `fallback_provider` is supported for Gemini and ComfyUI, but MiniMax scenes are strict: after any H3 attempt the pipeline never invokes another generator, because a paid remote task may already exist even if the local response was interrupted.

H3 source generation is constrained to 4–15 seconds and 2K. Longer or shorter editorial scenes are trimmed or padded during composition. The task ID, ratio, duration, usage, and reference counts are stored in provenance.

Checkpoint: inspect a contact sheet or representative midpoint from every scene. Reject identity drift, prompt-invented text, warped anatomy, flicker, broken reference continuity, or shots contradicting narration.

## Stage 3 — Gemini narration and captions

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs audio \
  --project videos/<slug> \
  --resume
```

This writes `audio_request.json`, runs Gemini 3.1 Flash TTS, and keeps one voice file per narrated scene. Word timestamps feed captions; when ASR is unavailable, deterministic approximate timing is generated from measured duration rather than dropping captions.

Checkpoint: listen for pronunciation, pacing, missing words, duplicated phrases, and lines exceeding their scene budget.

## Stage 4 — assemble the HyperFrames edit

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs compose \
  --project videos/<slug> \
  --resume
```

The composer:

- normalizes every provider's output to the target canvas, FPS, H.264, and scene duration;
- freezes the final frame when narration outlasts a source clip;
- creates `index.html` and `compositions/captions.html`;
- mounts generated videos muted with optional separate native-audio tracks;
- separates editorial text from captions;
- adds restrained deterministic transitions;
- creates a deterministic 1280×720 thumbnail project;
- writes metadata and chapter timestamps.

```bash
cd videos/<slug>
npx hyperframes check --snapshots
npx hyperframes preview
```

## Stage 5 — render and verify

Only after final-preview approval:

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs render --project videos/<slug>
```

The command runs the required browser check, renders high quality, verifies file size, duration, dimensions, and expected audio, then writes `.youtube-pipeline/final-render.mp4`.

## Stage 6 — package

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs package --project videos/<slug>
```

```text
youtube-package/
  video.mp4
  thumbnail.jpg
  captions.srt
  captions.vtt
  metadata.json
  description.txt
  chapters.txt
  provenance.json
```

Review the package as one release unit. Standard videos default to 1920×1080; Shorts default to 1080×1920 and are capped at three minutes.

## Stage 7 — optional YouTube upload

Read `references/publishing.md` before authentication or upload. Start private and dry-run the payload:

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs publish \
  --project videos/<slug> \
  --privacy private \
  --dry-run
```

Remove `--dry-run` only after review. The publisher uses resumable `videos.insert`, sets the custom thumbnail, uploads captions, records the returned video ID, and never changes privacy from the explicit CLI value.

## Status and recovery

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs status --project videos/<slug>
node <SKILL_DIR>/scripts/youtube-pipeline.mjs run --project videos/<slug> --through compose --resume
```

A plan change invalidates visuals and downstream stages. A failed visual or upload resumes without repeating completed work. For H3, preserve the task ID and recover the same task; never submit a replacement automatically.

## Done

The run is complete when:

- the plan has no validation errors;
- every provider required by the selected policy appears in the actual visual manifest;
- generated media was visually inspected, including H3 continuity when used;
- narration was listened to and captions checked;
- `npx hyperframes check` passes;
- the final preview was approved before render;
- the rendered file and package were verified;
- publishing began as private unless the owner explicitly selected another status;
- the handoff reports duration, resolution, provider split, package path, disclosure, H3 task IDs when used, and YouTube video ID when uploaded.
