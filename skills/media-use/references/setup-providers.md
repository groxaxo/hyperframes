# Setup and providers — install, auth, RAM ladders, forcing a provider

## ComfyUI LTX-2.3 — preferred private video path

When `COMFYUI_LTX23_WORKFLOW` is configured, media-use first attempts a self-hosted LTX-2.3 graph through ComfyUI's HTTP API. The graph, models, GPU policy, and output encoding stay on infrastructure you control.

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export COMFYUI_LTX23_WORKFLOW=/absolute/path/to/ltx23-api.json
```

The workflow must be exported through ComfyUI's **Save (API Format)** option and contain a `{{PROMPT}}` scalar placeholder. Full preparation and deployment instructions: `comfyui-ltx23.md`.

```bash
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video --provider comfyui \
  --intent "A cinematic product reveal with synchronized sound" \
  --project .
```

ComfyUI is marked as a network provider because it uses HTTP, even when hosted locally. Therefore `--local-only` skips it and keeps `ltx.local` as the zero-network fallback.

## Gemini — managed video and preferred cloud TTS

```bash
export GEMINI_API_KEY=...
# GOOGLE_API_KEY is also accepted
```

Centralized model IDs:

```text
gemini-omni-flash-preview
gemini-3.1-flash-tts-preview
```

Generate video:

```bash
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video --provider gemini \
  --intent "A continuous cinematic product reveal" \
  --project .
```

Landscape `16:9` is the default. Portrait `9:16` is inferred from vertical/Reel/TikTok/Story/Short language or pinned with `GEMINI_VIDEO_ASPECT_RATIO=9:16`. Omni output carries native audio.

Generate narration:

```bash
node <SKILL_DIR>/audio/scripts/audio.mjs \
  --request ./audio_request.json \
  --out ./audio_meta.json \
  --provider gemini
```

The default voice is `Kore`; override it in the request, with `--voice`, or with `GEMINI_TTS_VOICE`.

## MiniMax-H3 — opt-in 2K multimodal video

MiniMax-H3 is a paid provider and is intentionally opt-in. Configure a Pay-as-you-go/Credit API key:

```bash
export MINIMAX_API_KEY=...
```

Global API is the default. Select the China endpoint when required:

```bash
export MINIMAX_API_HOST=global # https://api.minimax.io
export MINIMAX_API_HOST=cn     # https://api.minimaxi.com
```

Generate explicitly:

```bash
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video --provider minimax \
  --intent "A continuous reference-driven product story with synchronized sound" \
  --project .
```

H3 supports 2K clips from 4 to 15 seconds, ratios `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, and adaptive media-driven output. It supports text, first/last frames, up to nine reference images, three reference videos, and three reference audios. Full contract: `minimax-h3.md`.

Setting an API key alone does **not** make H3 run automatically. Use explicit `--provider minimax`, or deliberately enable automatic fallback:

```bash
export MINIMAX_H3_AUTO=1
```

After a task ID exists, the provider never falls through to another generator. Query and download retries stay on the same paid task to prevent duplicate billing.

## HeyGen — catalog and cloud fallbacks

Install the official HeyGen CLI, then authenticate:

```bash
heygen update
heygen auth login --oauth
```

HeyGen remains the catalog path for BGM/SFX/image/icon, the cloud TTS fallback, and the avatar-video fallback.

## Provider order

| Type | Ordered provider path |
| --- | --- |
| BGM/SFX | HeyGen catalog → bundled SFX fallback |
| image | HeyGen search → local mflux → Codex image generation |
| voice | Gemini 3.1 Flash TTS → HeyGen TTS → local Kokoro |
| video | configured ComfyUI LTX-2.3 → Gemini Omni → opt-in MiniMax-H3 → HeyGen avatar video → direct local LTX |
| icon | HeyGen asset search |
| logo | svgl → simple-icons → GitHub org avatar → domain favicon |
| grade/LUT | local preset and deterministic LUT paths |

MiniMax-H3 is present in the ordered registry but returns a clean miss unless it is forced or `MINIMAX_H3_AUTO=1`. This preserves the existing Gemini behavior and prevents unexpected paid calls.

Pin a provider by prefix:

```bash
--provider comfyui
--provider gemini
--provider minimax
--provider heygen
--provider kokoro
--provider ltx
```

A forced provider bypasses cache reuse and all nonmatching providers. `--local-only` is a hard HTTP/network guard: it skips ComfyUI, Gemini, MiniMax, HeyGen, Codex, and every other network provider even when explicitly forced.

## CLI tools and services

| Tool / credential | Serves | Enable |
| --- | --- | --- |
| ComfyUI + LTXVideo | self-hosted LTX-2.3 | install current ComfyUI/LTXVideo, export API graph, set `COMFYUI_LTX23_WORKFLOW` |
| Google API key | Gemini Omni + Gemini TTS | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| MiniMax API key | MiniMax-H3 V2 video | `MINIMAX_API_KEY`; optional `MINIMAX_API_HOST=cn` |
| `ffmpeg` / `ffprobe` | media probing, normalization, mixing | system package |
| `heygen` | catalogs, HeyGen TTS, avatar video | official CLI + OAuth/API-key auth |
| `mflux-generate` | local image generation | mflux environment |
| `codex` | image generation through ChatGPT subscription | Codex CLI login |
| `parakeet-mlx` | local transcription | Parakeet environment |
| `ltx-2-mlx` | direct local video generation | local LTX MLX environment |
| `npx hyperframes` | Kokoro, Whisper fallback, background removal | HyperFrames CLI |

Before resolving a full project:

```bash
node <SKILL_DIR>/scripts/resolve.mjs --doctor
```

Without an optional tool, service, workflow, or credential, its provider emits at most one useful diagnostic and falls through where another provider exists—except a MiniMax failure carrying a task ID, which is deliberately terminal to avoid duplicate paid generation.
