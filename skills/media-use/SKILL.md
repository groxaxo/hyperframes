---
name: media-use
description: Agent Media OS, the single skill for every media need in a HyperFrames project. Resolve BGM, SFX, image, icon, brand logo, voice, generated video, color grade, or LUT into a frozen local file or paste-ready block + ledger record (one verb, `resolve`); generate video through self-hosted ComfyUI LTX-2.3 or Gemini Omni Flash, narration with Gemini 3.1 Flash TTS, and retain HeyGen and local fallbacks; produce voiceover, transcription, captions, and background removal through one shared audio engine; operate on media (cut / reframe / transform); and reuse assets across projects. Also use for vague feedback that real footage looks dark, flat, boring, should feel retro/camcorder/print/ASCII, needs privacy, or needs a media reveal.
---

# media-use

The media OS for HyperFrames: resolve · generate · operate · remember — every media type, one skill, zero context noise.

For private generated video, configure a self-hosted ComfyUI LTX-2.3 API workflow. Otherwise set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) for Gemini Omni video and Gemini 3.1 Flash TTS. For catalog search, avatar-video fallback, and the HeyGen TTS fallback, install and sign in to the `heygen` CLI. Verify the wider toolchain with `node <SKILL_DIR>/scripts/resolve.mjs --doctor`. Setup and providers: `references/setup-providers.md`.

## Resolve — the one verb

```bash
node <SKILL_DIR>/scripts/resolve.mjs --type <type> --intent "<description>" --project <dir>
```

Returns one line: `resolved <id> → <path> (<type>, <metadata>)`. All search noise stays on disk.

| Type    | One-line intent                                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `bgm`   | background music (HeyGen catalog, 10k+ tracks)                                                                                   |
| `sfx`   | sound effects (bundled 19-file library + catalog)                                                                                |
| `image` | photos, backgrounds (HeyGen asset search, local mflux, Codex image generation)                                                   |
| `icon`  | icons, symbols (transparent)                                                                                                     |
| `logo`  | official brand marks (svgl → simple-icons → GitHub avatar → favicon; never redrawn)                                              |
| `voice` | TTS voiceover (Gemini 3.1 Flash TTS → HeyGen → local Kokoro)                                                                     |
| `video` | generated video (self-hosted ComfyUI LTX-2.3 → Gemini Omni → HeyGen avatar video → direct local LTX)                             |
| `grade` | measured correction candidate; broad polish/stylization follows Media Treatments                                                 |
| `lut`   | user-provided or explicitly chosen reusable validated `.cube` file                                                               |

Before resolving fresh, list reusable candidates with `--candidates` and judge fit yourself — reuse rules, all flags, ingest (`--from`), and adopt are in `references/resolve.md`.

### Self-hosted LTX-2.3

Export a working LTX-2.3 graph with ComfyUI's **Save (API Format)** option, put `{{PROMPT}}` in its positive-prompt scalar, and configure:

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export COMFYUI_LTX23_WORKFLOW=/absolute/path/to/ltx23-api.json
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video \
  --provider comfyui \
  --intent "A cinematic product reveal with synchronized environmental audio" \
  --project .
```

The adapter binds prompt, negative prompt, deterministic seed, dimensions, frame count, FPS, model, and output prefix; submits `/prompt`; polls history; interrupts the exact prompt on timeout; downloads `/view`; and records native audio provenance. The graph remains the source of truth, so official single-stage, two-stage, low-VRAM, Q8, and custom LTX-2.3 workflows all use the same adapter. Full workflow contract: `references/comfyui-ltx23.md`.

### Gemini Omni

Force Gemini when the brief explicitly requests it:

```bash
# Landscape is the default. Set 9:16 explicitly or include "vertical/Reel/TikTok"
# in the intent so the provider infers portrait output.
export GEMINI_API_KEY=...
export GEMINI_VIDEO_ASPECT_RATIO=9:16
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video \
  --provider gemini \
  --intent "A vertical cinematic product reveal with precise camera movement" \
  --project .
```

Gemini Omni returns an MP4 with a native generated audio track. Preserve it unless the composition deliberately replaces it. Generate separate Gemini TTS only when the workflow needs controlled narration, exact copy, caption timing, or a different voice; do not stack narration over generated video audio accidentally.

## Treat broad visual feedback as media intent

When a user explicitly asks to fix, polish, stylize, obscure, emphasize, or
reveal photographic media, read `references/media-treatments.md` even if they
do not name color grading or an effect. Inspect the real `<img>`/`<video>`,
choose one primary intent, then use deterministic persistence and verification.
Use a matching recipe as an optional tested seed, or inspect
`hyperframes media-treatment --capabilities --json`, then request one relevant
family/effect with `--capability <id>` and assemble a custom treatment from
canonical controls. Never load `--all` for ordinary authoring. A treatment may
compose correction, a preset, finishing, compatible shader effects, supported
keyframes, and optional Registry overlays. Add only source-justified bounded
tuning and compatible parts, never effects merely to make the result look more
sophisticated. Persist the final combined payload with
`hyperframes media-treatment`.

Use one progressively escalating workflow. For video, inspect one labeled
early/middle/late contact sheet rather than reading frames separately. Apply one
candidate and inspect one after-sheet for ordinary correction or polish.
Escalate to individual frames or moving draft evidence only when the result is
ambiguous, temporal, stylized, LUT-based, HDR/LOG-sensitive, private, or
brand-critical.

For ordinary correction or polish, persist the final treatment's
preset/adjustment JSON.
Do not generate a `.cube` LUT merely to encode exposure, shadows, contrast, or
warmth. Use a LUT only when the user supplies one or the selected treatment
explicitly owns one. `resolve --type grade --for ... --analyze` is measurement
evidence, not permission to replace the chosen treatment with a generated LUT.
Do not recreate supported vignette, grain, blur, pixelate, color, or treatment
effects with CSS/SVG overlays; that bypasses Studio controls and the canonical
preview/render shader path.

## Be proactive — run a media opportunity pass

The human usually can't tell which media would lift the piece. You can. When you build or review a composition, do **one** grounded scan and then **ask once** — don't silently add, and don't nag per asset.

Surface an opportunity only when a concrete signal is present:

| Signal detected                                          | Offer                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| On-screen text / a script with no voiceover              | Gemini 3.1 Flash TTS voiceover through the shared audio engine                                         |
| Emoji or a `<div>` styled as an icon                     | resolve real `icon`s                                                                                   |
| Image that is a placeholder, tiny, or upscaled-looking   | a better `image` (and/or upscale — see `references/operations.md`)                                     |
| Hard scene cuts / transitions with no sound              | transition `sfx`                                                                                       |
| A piece over ~10s with no music bed                      | `bgm`                                                                                                  |
| Footage that reads under/over-exposed or color-cast      | a corrective grade (inspect it with `hyperframes media-treatment --selector '#hero' --analyze --json`) |
| Photographic media that feels visually flat or off-topic | one specific source-appropriate preset or custom treatment, with the intended target named             |
| A meaningful media entrance/reveal that feels static     | one supported seek-safe treatment animation; preserve color unless the request also justifies a preset |

Rules that keep this a help, not nagware: **grounded, not generic** (no signal → no suggestion); **opinionated + concrete** (propose the specific fix with defaults chosen — the human approves **all / some / none**); **once per project** (one consolidated ask; respect "leave it"); **surface, never silently mutate** (color grades especially: propose and preview — a gray-world "correction" ruins an intentional sunset or neon look).

## Where to look — read only the file your task needs

| Task                                                                      | Read                             |
| ------------------------------------------------------------------------- | -------------------------------- |
| resolve / reuse / adopt / ingest, flags, cascade, inventory               | `references/resolve.md`          |
| self-hosted ComfyUI LTX-2.3 workflow export, bindings, auth, operations   | `references/comfyui-ltx23.md`    |
| color grading, LUTs, smart grade (`--for`), grade-compare                 | `references/grading.md`          |
| voiceover / TTS, music, SFX, captions, transcription (audio engine)       | `references/audio.md`            |
| cut / reframe / transform existing media, exact error diffusion, HEVC     | `references/operations.md`       |
| source-aware creative treatments, realtime effects, overlays, reveals     | `references/media-treatments.md` |
| install + auth, provider table, RAM ladders, `--local-only`, `--provider` | `references/setup-providers.md`  |
| remembered preferences + frozen recipes (user memory)                     | `references/memory.md`           |
| ownership matrix, usage stats, telemetry, privacy (maintainer-facing)     | `references/meta.md`             |
