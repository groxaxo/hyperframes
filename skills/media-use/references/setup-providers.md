# Setup and providers — install, auth, RAM ladders, forcing a provider

## ComfyUI LTX-2.3 — preferred private video path

When `COMFYUI_LTX23_WORKFLOW` is configured, media-use first attempts a
self-hosted LTX-2.3 graph through ComfyUI's HTTP API. The graph, models, GPU
policy, and output encoding stay on infrastructure you control.

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export COMFYUI_LTX23_WORKFLOW=/absolute/path/to/ltx23-api.json
```

The workflow must be exported through ComfyUI's **Save (API Format)** option and
must contain a `{{PROMPT}}` scalar placeholder. The provider also understands
placeholders for negative prompt, seed, width, height, frames, FPS, checkpoint,
filename prefix, duration, and aspect ratio. Full preparation and deployment
instructions: `comfyui-ltx23.md`.

Generate explicitly:

```bash
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video \
  --provider comfyui \
  --intent "A cinematic product reveal with synchronized sound" \
  --project .
```

The adapter uses the native ComfyUI lifecycle: queue `/prompt`, poll
`/history/{prompt_id}`, target `/interrupt` on timeout, and stream the selected
video through `/view`. It supports authenticated reverse proxies with
`COMFYUI_API_KEY`, `COMFYUI_API_KEY_HEADER`, and `COMFYUI_HEADERS_JSON`; secrets
are sent only in headers.

ComfyUI is marked as a network provider because it uses HTTP, even when hosted on
the same machine. Therefore the hard `--local-only` guard skips it and keeps the
direct `ltx.local` CLI as the zero-network fallback.

## Gemini setup — preferred managed video and cloud TTS

HyperFrames uses Google's dependency-free Interactions REST API for both
generated video and narration. The skill never writes the key to disk or places
it in a URL; it reads the key from the environment for each request and sends it
through `x-goog-api-key`.

```bash
export GEMINI_API_KEY=...       # preferred
# or:
export GOOGLE_API_KEY=...
```

A project `.env` also works when the shared audio engine is run from that
project, because its preflight loader imports environment variables before
provider selection.

The exact preview models are deliberately centralized in
`scripts/lib/gemini-api.mjs`:

- video: `gemini-omni-flash-preview`
- narration: `gemini-3.1-flash-tts-preview`

These are preview model IDs. Keep model changes isolated to the shared constants
and re-run the provider tests before changing them.

### Generate video with Gemini Omni

```bash
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video \
  --provider gemini \
  --intent "A continuous cinematic product reveal, soft morning light" \
  --project .
```

Landscape `16:9` is the default. Portrait `9:16` is selected when the intent
clearly says vertical, portrait, Reel, TikTok, Story, or YouTube Short. Pin it
without changing the prompt:

```bash
GEMINI_VIDEO_ASPECT_RATIO=9:16 \
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video --provider gemini --intent "A premium product reveal" --project .
```

Only `16:9` and `9:16` are accepted. The provider requests URI delivery, polls
the authenticated Gemini Files API until the asset is active, and then downloads
the MP4. This avoids the inline-response size limit while retaining inline-base64
compatibility for smaller or mocked responses. Gemini Omni's generated MP4
already carries native audio. Keep that track unless the composition deliberately
replaces it; separate TTS is for controlled copy, narration voices, or caption
timing.

### Generate narration with Gemini 3.1 Flash TTS

The shared audio engine automatically chooses Gemini when a Google key exists:

```bash
node <SKILL_DIR>/audio/scripts/audio.mjs \
  --request ./audio_request.json \
  --out ./audio_meta.json \
  --provider gemini
```

The default voice is `Kore`. Override it per request with `"voice": "Puck"`, with
`--voice Puck`, or globally with `GEMINI_TTS_VOICE=Puck`. The API returns raw
24 kHz, 16-bit, mono PCM; media-use wraps it into a valid WAV without adding an
SDK or requiring ffmpeg. Gemini TTS does not return word timestamps, so the
shared engine transcribes the WAV for captions.

## HeyGen setup — catalog and cloud fallbacks

Install the HeyGen CLI through its
[verified release instructions](https://developers.heygen.com/cli), then run:

```bash
heygen update             # free usage needs the OAuth-capable CLI (v0.3.0+)
heygen auth login --oauth # OAuth = free subscription credits; --api-key bills API credits
```

HeyGen remains the catalog path for bgm/sfx/image/icon, the cloud fallback for
TTS, and the avatar-video fallback. Sign in with `--oauth` when you want the
eligible web-plan allowance; an API key follows normal API billing.

Before resolving a full project, verify the wider local setup:

```bash
node <SKILL_DIR>/scripts/resolve.mjs --doctor
```

## Provider order

media-use stores no credentials. Remote providers read their normal environment
or CLI-owned auth, and every resolved asset is frozen locally before it enters a
composition. `resolve` spec-checks available RAM for direct local model ladders
through `describeModelLadder`.

| Type      | Ordered provider path                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bgm/sfx   | HeyGen catalog; bundled SFX fallback                                                                                                                      |
| image     | HeyGen search; optional local mflux; Codex image generation                                                                                               |
| voice     | **Gemini 3.1 Flash TTS** when a Google key exists → HeyGen TTS → local Kokoro                                                                            |
| video     | **self-hosted ComfyUI LTX-2.3** when a workflow is configured → Gemini Omni → HeyGen avatar video → direct local LTX                                    |
| icon      | HeyGen asset search                                                                                                                                      |
| logo      | svgl → simple-icons → GitHub org avatar → domain favicon                                                                                                 |
| grade/lut | local core-preset map, params/CDN look index, deterministic `buildCube` fallback                                                                          |

The ComfyUI provider returns a clean miss without a workflow path, and Gemini
providers return a clean miss without a Google key, so existing installations
continue through the cascade without probes they did not configure. Gemini and
HeyGen providers are marked remote and metered where applicable. ComfyUI is
remote-but-self-hosted and free; direct LTX, Kokoro, mflux, and bundled SFX are
local.

To pin a generator, pass its prefix:

```bash
--provider comfyui # comfyui.ltx23, video only
--provider gemini  # gemini.omni for video or gemini.tts for voice
--provider heygen
--provider kokoro
--provider ltx     # direct local LTX CLI
```

A forced provider bypasses cache reuse and all nonmatching providers. For
example, `--provider comfyui` fails clearly when the API-format workflow is not
configured rather than silently returning a Gemini or LTX result.

`--local-only` is a hard HTTP/network guard. It skips ComfyUI, Gemini, HeyGen,
Codex, and every other network provider even when one is explicitly forced.

## CLI tools and services used

Gemini and ComfyUI need no installed JavaScript SDK. Both use Node's built-in
`fetch`; ComfyUI itself runs as a separately managed service.

| Tool / credential  | Serves                                                                                  | Enable                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| ComfyUI + LTXVideo | self-hosted LTX-2.3 workflows with native audio                                          | install current ComfyUI and `Lightricks/ComfyUI-LTXVideo`; export an API-format graph and set `COMFYUI_LTX23_WORKFLOW`                        |
| Google API key     | Gemini Omni video + Gemini 3.1 Flash TTS                                                 | `export GEMINI_API_KEY=...` (or `GOOGLE_API_KEY`)                                                                                             |
| `ffmpeg`/`ffprobe` | probing, adoption, smart-grade, cut, duck bake, loudnorm, non-Gemini cloud-audio convert | system package (`brew install ffmpeg` / `apt install ffmpeg`)                                                                                 |
| `heygen`           | catalogs + HeyGen TTS + avatar video                                                     | verified HeyGen install, then `heygen auth login --oauth` (needs >= v0.3.0)                                                                  |
| `mflux-generate`   | local image generation                                                                  | `uv venv ~/.venvs/mflux && VIRTUAL_ENV=~/.venvs/mflux uv pip install mflux==0.9.6`                                                            |
| `codex`            | image generation through the user's ChatGPT subscription                                | Codex CLI, logged in via ChatGPT                                                                                                              |
| `parakeet-mlx`     | local transcription                                                                     | `uv venv ~/.venvs/parakeet && VIRTUAL_ENV=~/.venvs/parakeet uv pip install parakeet-mlx`                                                      |
| `ltx-2-mlx`        | direct local video generation                                                           | `git clone https://github.com/dgrauet/ltx-2-mlx && cd ltx-2-mlx && uv sync --all-extras`                                                      |
| `npx hyperframes`  | Kokoro TTS, whisper.cpp fallback, background removal                                     | via the HyperFrames CLI; whisper.cpp builds on first use and downloads its model                                                             |

Without an optional tool, service, workflow, or credential, its provider emits
at most one useful diagnostic and the resolver falls through where another
provider exists.
