---
name: media-use
description: Agent Media OS for every HyperFrames media need. Resolve BGM, SFX, image, icon, logo, voice, generated video, grade, or LUT into frozen local assets and ledger records; generate video through self-hosted ComfyUI LTX-2.3, Gemini Omni, or opt-in MiniMax-H3; generate narration with Gemini 3.1 Flash TTS; retain HeyGen and local fallbacks; transcribe, caption, remove backgrounds, cut, reframe, transform, and reuse media. Also use when real footage looks dark, flat, boring, needs privacy, or needs a stronger reveal.
---

# media-use

The media OS for HyperFrames: resolve · generate · operate · remember.

Configure the provider appropriate to the job:

- private/self-hosted video: ComfyUI LTX-2.3;
- managed general video and narration: Gemini Omni + Gemini 3.1 Flash TTS;
- reference-driven 2K multimodal video: MiniMax-H3;
- catalogs/avatar fallback: HeyGen;
- zero-network fallback: direct local LTX, Kokoro, mflux, bundled SFX.

Verify the wider toolchain with:

```bash
node <SKILL_DIR>/scripts/resolve.mjs --doctor
```

Provider setup: `references/setup-providers.md`.

## Resolve — the one verb

```bash
node <SKILL_DIR>/scripts/resolve.mjs --type <type> --intent "<description>" --project <dir>
```

| Type | Provider path |
| --- | --- |
| `bgm` | HeyGen catalog |
| `sfx` | HeyGen catalog → bundled library |
| `image` | HeyGen search → local mflux → Codex |
| `icon` | HeyGen asset search |
| `logo` | svgl → simple-icons → GitHub avatar → favicon |
| `voice` | Gemini 3.1 Flash TTS → HeyGen → Kokoro |
| `video` | configured ComfyUI LTX-2.3 → Gemini Omni → opt-in MiniMax-H3 → HeyGen avatar → local LTX |
| `grade` | measured correction candidate; broad styling follows media treatments |
| `lut` | user-provided or explicitly selected reusable `.cube` |

Before resolving fresh, list reusable candidates with `--candidates`. Reuse, adoption, ingest, flags, and inventory are in `references/resolve.md`.

## Self-hosted LTX-2.3

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export COMFYUI_LTX23_WORKFLOW=/absolute/path/to/ltx23-api.json
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video --provider comfyui \
  --intent "A cinematic product reveal with synchronized environmental audio" \
  --project .
```

The graph remains the source of truth, so single-stage, two-stage, low-VRAM, Q8, and custom workflows share the same adapter. Full contract: `references/comfyui-ltx23.md`.

## Gemini Omni

```bash
export GEMINI_API_KEY=...
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video --provider gemini \
  --intent "A vertical cinematic product reveal" \
  --project .
```

Gemini returns an MP4 with native generated audio. Generate separate TTS only for controlled narration, exact copy, captions, or a different voice.

## MiniMax-H3

MiniMax-H3 is paid and opt-in. Setting its key alone does not trigger a paid fallback.

```bash
export MINIMAX_API_KEY=...
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video --provider minimax \
  --intent "A continuous reference-driven product story with synchronized sound" \
  --project .
```

H3 supports 2K video, 4–15 seconds, landscape/portrait/cinematic ratios, first/last frames, and mixed image/video/audio references. It uses the official asynchronous V2 lifecycle and freezes the temporary result URL immediately.

After a task ID exists, query and download failures stay on that task. The resolver never falls through and creates a duplicate paid generation. Full contract: `references/minimax-h3.md`.

Automatic H3 fallback is explicit:

```bash
export MINIMAX_H3_AUTO=1
```

## Treat broad visual feedback as media intent

When a user asks to fix, polish, stylize, obscure, emphasize, or reveal photographic media, read `references/media-treatments.md`. Inspect the real media, choose one primary intent, and use deterministic persistence and verification. Do not replace canonical treatments with ad hoc CSS/SVG overlays or generic LUTs.

Use one progressively escalating workflow. For video, inspect an early/middle/late contact sheet, apply one candidate, then inspect an after-sheet. Escalate only when the result is ambiguous, temporal, stylized, HDR/LOG-sensitive, private, or brand-critical.

## Media opportunity pass

During a build or review, make one grounded scan and offer only specific improvements supported by the artifact:

| Signal | Offer |
| --- | --- |
| script without voice | Gemini TTS |
| placeholder image or emoji icon | resolved image/icon |
| hard cuts without sound | transition SFX |
| piece over ~10 seconds without a bed | BGM |
| under/over-exposed or color-cast footage | corrective grade |
| flat photographic media | source-appropriate treatment |
| static meaningful reveal | seek-safe treatment animation |

Surface opportunities; never silently mutate the project.

## Read only what the task needs

| Task | Read |
| --- | --- |
| resolve/reuse/adopt/ingest | `references/resolve.md` |
| ComfyUI LTX-2.3 | `references/comfyui-ltx23.md` |
| MiniMax-H3 | `references/minimax-h3.md` |
| grading/LUTs | `references/grading.md` |
| voice/music/SFX/captions/transcription | `references/audio.md` |
| cut/reframe/transform | `references/operations.md` |
| treatments/effects/reveals | `references/media-treatments.md` |
| provider auth/install | `references/setup-providers.md` |
| preferences/recipes | `references/memory.md` |
| ownership/telemetry/privacy | `references/meta.md` |
