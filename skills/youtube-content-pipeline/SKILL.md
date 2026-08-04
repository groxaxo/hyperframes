---
name: youtube-content-pipeline
description: >
  Build a complete, staged YouTube or YouTube Shorts production with HyperFrames,
  deliberately combining Gemini Omni hero shots and self-hosted ComfyUI LTX-2.3 B-roll,
  Gemini 3.1 Flash TTS narration, captions, thumbnail, metadata, rendering, and optional
  YouTube Data API publishing. Use for a new channel video, recurring content engine,
  faceless educational video, product story, case study, or Short when the requested
  deliverable is a YouTube-ready package rather than a one-off generic composition.
---

# YouTube content pipeline

This workflow owns an end-to-end, resumable YouTube production. It uses the
existing `/media-use` providers rather than calling Gemini or ComfyUI directly:

```text
brief → youtube-plan.json → hybrid visuals → Gemini TTS → HyperFrames edit
      → QA → thumbnail/captions/metadata package → optional private upload
```

Before running it:

```bash
npx hyperframes skills update youtube-content-pipeline
```

Load `/media-use`, `/hyperframes-core`, `/hyperframes-creative`, and
`/hyperframes-cli` before authoring or rendering. For ComfyUI setup, read
`../media-use/references/comfyui-ltx23.md`. This skill never duplicates provider
credentials or model workflows.

## Operating rules

1. Work stage by stage and report the completed artifact at every boundary.
2. Resume from `.youtube-pipeline/state.json`; never regenerate a completed stage
   whose input hash is unchanged.
3. Default to `video.privacy: private`. Publishing publicly requires an explicit
   owner decision after the render, thumbnail, metadata, captions, and synthetic
   media disclosure are reviewed.
4. In `hybrid` mode, the finished production uses **both** Gemini and ComfyUI:
   Gemini for high-value hook/hero/demo/CTA shots; LTX-2.3 for scalable private
   B-roll and visual metaphors.
5. Generated text belongs in HyperFrames, not inside a video-model prompt.
6. Keep generated source video muted unless a scene explicitly says `duck` or
   `keep`. Narration remains intelligible and no two speech tracks compete.
7. Do not invent factual claims. Research-dependent scripts must carry source
   notes in `RESEARCH.md`; this workflow is production machinery, not permission
   to fabricate evidence.

## Stage 0 — preflight

Confirm the project can reach both visual providers and Gemini TTS:

```bash
node ../media-use/scripts/resolve.mjs --doctor
```

Required for the default hybrid path:

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export COMFYUI_LTX23_WORKFLOW=/absolute/path/to/ltx23-api.json
export GEMINI_API_KEY=...
```

Also require Node 22+, FFmpeg/ffprobe, and a functioning HyperFrames renderer.
YouTube OAuth is not needed until Stage 7.

## Stage 1 — brief, research, and plan

Create the project and a plan template:

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs init \
  --project videos/<slug> \
  --topic "<topic>" \
  --format long
```

Then write `youtube-plan.json` using `references/plan-schema.md`. The plan is the
locked script, shot list, provider allocation, metadata, disclosure, thumbnail
copy, and publishing intent.

For `provider_policy: hybrid`:

- Give Gemini the hook and at least one hero/demo/CTA scene.
- Give ComfyUI LTX-2.3 the supporting B-roll and visual-metaphor scenes.
- Keep five-second narration near 13 words at the default delivery rate.
- Use one meaningful claim per shot and a designed open and close.

Validate before spending generation credits or GPU time:

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs validate --project videos/<slug>
```

Checkpoint: report title, format, total planned duration, scene count, Gemini
scene count, ComfyUI scene count, and validation warnings.

## Stage 2 — generate hybrid visuals

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs visuals \
  --project videos/<slug> \
  --resume
```

The runner invokes `/media-use` with each scene's explicit provider, records the
frozen local asset path, and advances scene by scene. A failed scene is the only
unit retried. `fallback_provider` is honored when present; otherwise a forced
provider failure remains visible rather than silently changing the creative
plan.

Checkpoint: inspect one contact sheet or representative midpoint from every
scene. Reject identity drift, prompt-invented text, warped anatomy, flicker, or
shots that contradict the narration before producing audio.

## Stage 3 — Gemini narration and captions

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs audio \
  --project videos/<slug> \
  --resume
```

This writes `audio_request.json`, runs the shared audio engine with Gemini 3.1
Flash TTS, and keeps one voice file per scene. Word timestamps feed captions;
where ASR is unavailable, the pipeline produces deterministic phrase timings
from the narration and measured file duration rather than dropping captions.

Checkpoint: listen for pronunciation, pacing, missing words, duplicated phrases,
and scene lines that exceed their visual budget. Correct the plan and rerun from
this stage when copy changes.

## Stage 4 — assemble the HyperFrames edit

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs compose \
  --project videos/<slug> \
  --resume
```

The composer:

- normalizes generated clips to the target canvas and scene duration;
- freezes the final frame when narration slightly outlasts a source clip;
- creates `index.html` and `compositions/captions.html`;
- mounts each generated video muted, with optional separate native audio;
- places editorial text independently from captions;
- adds restrained deterministic transitions;
- creates `thumbnail.html` at 1280×720;
- writes a YouTube metadata manifest and chapter timestamps.

The result remains an ordinary HyperFrames project and can be edited manually.

Checkpoint: run the composition gates and inspect the full timeline:

```bash
cd videos/<slug>
npx hyperframes check --snapshots
npx hyperframes preview
```

## Stage 5 — render and verify

Only after final-preview approval:

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs render \
  --project videos/<slug>
```

The command runs the required check, renders high quality, verifies a non-empty
file and plausible duration, and writes the result under
`youtube-package/video.mp4`.

## Stage 6 — package

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs package \
  --project videos/<slug>
```

The package contains:

```text
youtube-package/
  video.mp4
  thumbnail.png
  captions.srt
  captions.vtt
  metadata.json
  description.txt
  chapters.txt
  provenance.json
```

Review the package as one release unit. YouTube recommends 16:9 for standard
computer playback; the pipeline defaults to H.264/AAC-compatible output and
uses a 1280×720 thumbnail. Shorts default to 1080×1920 and are capped at three
minutes.

## Stage 7 — optional YouTube upload

Read `references/publishing.md` before auth or upload. Authentication is a
one-time local OAuth operation; service accounts cannot upload to an ordinary
YouTube channel.

Start safely:

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs publish \
  --project videos/<slug> \
  --privacy private \
  --dry-run
```

Then remove `--dry-run` after reviewing the exact payload. The publisher uses a
resumable `videos.insert`, sets the custom thumbnail, uploads captions, records
the returned video ID, and never changes privacy from the explicit CLI value.

## Status and recovery

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs status --project videos/<slug>
node <SKILL_DIR>/scripts/youtube-pipeline.mjs run --project videos/<slug> --through compose --resume
```

A plan change invalidates visuals and every downstream stage. A failed visual
or upload can resume without repeating completed work. Delete only the affected
artifact or use the stage-specific `--force`; do not clear the whole project to
recover one scene.

## Done

The run is complete when:

- the plan has no validation errors;
- both Gemini and ComfyUI are represented in a hybrid production;
- generated media was visually inspected;
- narration was listened to and captions checked;
- `npx hyperframes check` passes;
- the final preview was approved before render;
- the rendered file and package were verified;
- publishing, when requested, began as private unless the owner explicitly chose
  another status;
- the final handoff reports duration, resolution, provider split, package path,
  disclosure value, and YouTube video ID when uploaded.
