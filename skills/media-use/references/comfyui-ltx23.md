# Self-hosted LTX-2.3 through ComfyUI

The `comfyui.ltx23` video provider submits an **API-format** ComfyUI workflow to a
user-controlled ComfyUI server, waits for completion, downloads the final video,
and freezes it into the HyperFrames media manifest. The graph stays owned by the
operator: use the official single-stage, two-stage, low-VRAM, Q8, IC-LoRA, or a
custom LTX-2.3 workflow without changing provider code.

Provider order for video is:

```text
comfyui.ltx23 → gemini.omni → heygen.video → ltx.local
```

The ComfyUI rung is attempted only when a workflow path is configured. Without
one, it performs no HTTP probe and the existing cascade continues unchanged.

## 1. Prepare ComfyUI and LTX-2.3

Use a current ComfyUI installation and install `Lightricks/ComfyUI-LTXVideo`
through ComfyUI Manager. The official project ships LTX-2.3 single-stage,
two-stage, IC-LoRA, HDR, lipdub, pixel-upscaler, and audio-only examples under:

```text
ComfyUI/custom_nodes/ComfyUI-LTXVideo/example_workflows/2.3/
```

For the standard distilled path, place this checkpoint under
`ComfyUI/models/checkpoints/`:

```text
ltx-2.3-22b-distilled-1.1.safetensors
```

The development checkpoint is also supported by setting
`COMFYUI_LTX23_MODEL=ltx-2.3-22b-dev.safetensors`. Two-stage graphs additionally
need the official spatial/temporal upscalers and distilled LoRA in their
respective ComfyUI model folders.

The upstream baseline recommends at least 32 GB of VRAM. On 24 GB cards, start
from the upstream low-VRAM loader nodes (`LowVRAMCheckpointLoader`,
`LowVRAMAudioVAELoader`, and `LowVRAMLatentUpscaleModelLoader`) or its Q8 nodes,
then validate the graph manually before exporting it. Those loaders sequence
large model loads to reduce peak VRAM pressure; the HyperFrames provider does
not rewrite memory policy inside the graph.

## 2. Export the graph in API format

1. Open and validate the chosen LTX-2.3 workflow in ComfyUI.
2. Keep one intended final video output active. A graph with multiple completed
   video files is supported, but the provider deterministically selects the
   highest-ranked MP4, then WebM/MOV/MKV/GIF.
3. In ComfyUI settings, enable **Dev Mode → API save**.
4. Export with **Save (API Format)**. A normal UI workflow containing top-level
   `nodes` and `links` is rejected because it cannot be submitted to `/prompt`.

An API-format graph is keyed by node ID and each node has `class_type` and
`inputs`, for example:

```json
{
  "42": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "text": "{{PROMPT}}",
      "clip": ["10", 0]
    }
  }
}
```

## 3. Add binding placeholders

Edit scalar widget values in the exported API JSON. A placeholder that occupies
the whole string is replaced with its original JSON type, so dimensions, frame
counts, seeds, and FPS remain numbers rather than strings.

| Placeholder            | Default / meaning                                      |
| ---------------------- | ------------------------------------------------------ |
| `{{PROMPT}}`           | Resolve intent; required exactly once or more          |
| `{{NEGATIVE_PROMPT}}`  | Conservative quality/flicker/artifact negative prompt  |
| `{{SEED}}`             | Deterministic SHA-256-derived seed                      |
| `{{WIDTH}}`            | `960` landscape, `544` portrait                        |
| `{{HEIGHT}}`           | `544` landscape, `960` portrait                        |
| `{{FRAMES}}`           | `121`; must be `8n+1`                                  |
| `{{FPS}}`              | `24`                                                   |
| `{{MODEL}}`            | `ltx-2.3-22b-distilled-1.1.safetensors`                |
| `{{FILENAME_PREFIX}}`  | Unique `hyperframes/ltx23-…` output prefix             |
| `{{DURATION_SECONDS}}` | `frames / fps`                                         |
| `{{ASPECT_RATIO}}`     | `16:9` or `9:16`                                       |

Typical replacements:

```json
{
  "positive_prompt_node": {
    "class_type": "CLIPTextEncode",
    "inputs": { "text": "{{PROMPT}}", "clip": ["loader", 1] }
  },
  "negative_prompt_node": {
    "class_type": "CLIPTextEncode",
    "inputs": { "text": "{{NEGATIVE_PROMPT}}", "clip": ["loader", 1] }
  },
  "latent_node": {
    "class_type": "EmptyLTXVLatentVideo",
    "inputs": {
      "width": "{{WIDTH}}",
      "height": "{{HEIGHT}}",
      "length": "{{FRAMES}}",
      "batch_size": 1
    }
  },
  "noise_node": {
    "class_type": "RandomNoise",
    "inputs": { "noise_seed": "{{SEED}}" }
  },
  "checkpoint_node": {
    "class_type": "CheckpointLoaderSimple",
    "inputs": { "ckpt_name": "{{MODEL}}" }
  },
  "save_node": {
    "class_type": "SaveVideo",
    "inputs": {
      "filename_prefix": "{{FILENAME_PREFIX}}",
      "frame_rate": "{{FPS}}"
    }
  }
}
```

Keep every existing node connection (`[node_id, output_index]`) unchanged. Only
replace scalar widget values.

A graph may expose additional placeholders such as `{{STEPS}}`, `{{CFG}}`, or
`{{SAMPLER}}`. Supply them as scalar JSON values:

```bash
export COMFYUI_LTX23_BINDINGS_JSON='{"STEPS":8,"CFG":1.2}'
```

Custom names must use `A-Z`, `0-9`, and underscore, and cannot override built-in
bindings such as `PROMPT`, `SEED`, or `MODEL`.

## 4. Configure HyperFrames

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export COMFYUI_LTX23_WORKFLOW=/absolute/path/to/ltx23-api.json
```

`COMFYUI_LTX_WORKFLOW` remains accepted as a compatibility alias. A relative
workflow path is resolved from `--project`.

Optional generation controls:

```bash
export COMFYUI_LTX23_MODEL=ltx-2.3-22b-distilled-1.1.safetensors
export COMFYUI_LTX23_WIDTH=960
export COMFYUI_LTX23_HEIGHT=544
export COMFYUI_LTX23_FRAMES=121
export COMFYUI_LTX23_FPS=24
export COMFYUI_LTX23_SEED=42
export COMFYUI_LTX23_NEGATIVE_PROMPT='flicker, artifacts, watermark'
export COMFYUI_LTX23_FILENAME_PREFIX='hyperframes/ltx23-campaign'
export COMFYUI_LTX23_TIMEOUT_MS=1800000
export COMFYUI_POLL_MS=2000
```

Portrait intent is inferred from words such as `vertical`, `portrait`, `Reel`,
`TikTok`, `Story`, or `YouTube Short`. Explicit width and height override that
inference. Dimensions must be divisible by 32 and frames must be `8n+1`.

### Reverse proxy or authenticated server

The API key is sent only as a header and is never placed in a URL:

```bash
export COMFYUI_API_KEY='secret'
# Default: Authorization: Bearer secret
export COMFYUI_API_KEY_HEADER='X-API-Key'
```

Additional string headers, including Cloudflare Access service credentials:

```bash
export COMFYUI_HEADERS_JSON='{
  "CF-Access-Client-Id":"…",
  "CF-Access-Client-Secret":"…"
}'
```

Keep ComfyUI private. For a non-loopback endpoint, terminate TLS and enforce
proxy authentication rather than exposing the native service directly.

## 5. Generate

```bash
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video \
  --provider comfyui \
  --intent "A cinematic product reveal in warm Auckland morning light" \
  --project .
```

The provider performs this lifecycle:

1. `POST /prompt` with the bound API graph.
2. Poll `GET /history/{prompt_id}` until completion.
3. On timeout, target `POST /interrupt` at that prompt ID.
4. Select the final video record from history.
5. Stream `GET /view?filename=…&subfolder=…&type=…` to a temporary file.
6. Freeze the file into the project manifest and global media cache.

LTX-2.3 workflows produce synchronized audio/video when the graph includes the
audio latent, audio VAE decode, `CreateVideo`, and final `SaveVideo` path. The
provider preserves that native audio and records `native_audio: true` in
provenance. Do not layer a second narration track unless the composition
explicitly mutes or ducks the generated audio.

`--local-only` intentionally skips ComfyUI because its provider uses HTTP, even
when the endpoint is self-hosted. Use the direct `ltx.local` CLI provider for a
strict zero-network run, or omit `--local-only` and pin `--provider comfyui`.
