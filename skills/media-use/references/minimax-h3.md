# MiniMax-H3 video through the V2 API

`minimax.h3` generates 2K video with MiniMax-H3 through the official asynchronous V2 API. It supports text-to-video, first-frame and first/last-frame animation, and mixed image/video/audio references.

The provider is **paid and opt-in**. It runs when explicitly selected with `--provider minimax`. Merely setting an API key does not insert paid H3 calls into an existing cascade. Set `MINIMAX_H3_AUTO=1` only when automatic H3 fallback is intentional.

## Credentials and region

H3 requires a standard Pay-as-you-go/Credit API key. Token Plan and OAuth credentials are not interchangeable with the H3 API key.

```bash
export MINIMAX_API_KEY=...
```

Global is the default API region:

```bash
export MINIMAX_API_HOST=global # https://api.minimax.io
```

China-region endpoint:

```bash
export MINIMAX_API_HOST=cn # https://api.minimaxi.com
```

A custom HTTPS reverse-proxy base URL can be supplied with `MINIMAX_API_BASE_URL`. Usernames and passwords are forbidden in the URL; credentials are transmitted only through `Authorization: Bearer`.

## Text-to-video

```bash
node <SKILL_DIR>/scripts/resolve.mjs \
  --type video \
  --provider minimax \
  --intent "A continuous cinematic product reveal with synchronized workshop ambience" \
  --project .
```

Defaults:

```text
model       MiniMax-H3
resolution  2K
duration    5 seconds
ratio       16:9, or 9:16 when the intent clearly requests vertical output
polling     every 10 seconds
timeout     30 minutes
```

Supported ratios:

```text
21:9  16:9  4:3  1:1  3:4  9:16  adaptive
```

`adaptive` is available only when reference media supplies an aspect ratio. Text-only requests require a concrete ratio.

Controls:

```bash
export MINIMAX_H3_DURATION=8       # integer, 4-15
export MINIMAX_H3_RATIO=9:16
export MINIMAX_H3_POLL_MS=10000    # production minimum
export MINIMAX_H3_TIMEOUT_MS=1800000
export MINIMAX_H3_NEGATIVE_PROMPT="subtitles, logos, flicker, identity drift"
```

The prompt may contain at most 7000 characters. Negative constraints are appended to the text content because the H3 V2 request does not expose a separate negative-prompt field.

## First and last frames

```bash
export MINIMAX_H3_FIRST_FRAME="https://example.com/open.png"
export MINIMAX_H3_LAST_FRAME="https://example.com/close.png"
```

A last frame requires a first frame. Frame mode cannot be combined with reference mode.

## Reference images, video, and audio

Pass JSON arrays of public URLs, data URLs, or supported MiniMax file references:

```bash
export MINIMAX_H3_REFERENCE_IMAGES_JSON='[
  "https://example.com/character.png",
  "https://example.com/product.png"
]'

export MINIMAX_H3_REFERENCE_VIDEOS_JSON='[
  "https://example.com/movement-reference.mp4"
]'

export MINIMAX_H3_REFERENCE_AUDIOS_JSON='[
  "https://example.com/voice-or-music.wav"
]'
```

Limits enforced before a paid task is submitted:

| Input | Limit |
| --- | ---: |
| first frame | 1 |
| last frame | 1 |
| reference images | 9 |
| reference videos | 3 |
| reference audios | 3 |
| total mixed references | 12 |

Reference audio requires at least one reference image or reference video. Frame mode and reference mode cannot be mixed.

## Task lifecycle and duplicate prevention

The provider performs the official lifecycle:

```text
POST /v2/video_generation
GET  /v2/query/video_generation/{task_id}
download task.content.url
freeze the MP4 into the project media cache
```

Valid task states are `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `expired`.

Creation POSTs are deliberately never retried automatically. A lost response may have already created a paid task. After a `task_id` exists, all retries stay on that task:

- transient query failures retry the same query;
- a timeout reports the task ID and notes that it may still finish remotely;
- result-download failures retry the same temporary result URL;
- terminal failures report the task ID and provider error;
- the media cascade is stopped rather than creating another paid video with Gemini, HeyGen, or a second H3 task.

Keep task IDs in the project provenance. MiniMax result URLs may expire, so the provider downloads and freezes successful output immediately.

## YouTube pipeline

The staged YouTube workflow accepts either:

```json
{ "provider_policy": "minimax" }
```

or:

```json
{ "provider_policy": "tri-hybrid" }
```

`tri-hybrid` requires at least one successful scene from each provider family:

```text
Gemini Omni + ComfyUI LTX-2.3 + MiniMax-H3
```

Use H3 for continuity-sensitive, reference-driven, first/last-frame, or audio-reference shots. The pipeline clamps the generated source request to H3's 4-15 second window, then trims or pads it to the scene's editorial duration during composition.

## Audio mixing

H3 can generate or synchronize sound. The resolver records `native_audio: true`. In HyperFrames, keep video elements muted and mount the same MP4 as a separate `<audio>` track only when the scene's policy is `duck` or `keep`. Controlled Gemini TTS narration remains a separate track; do not layer two competing speech performances.
