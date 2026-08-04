# YouTube production plan contract

`youtube-plan.json` is the durable creative and operational contract. Every later stage reads it and records progress under `.youtube-pipeline/state.json`. Editing the plan invalidates generated stages so a resume cannot combine assets from different briefs.

## Root shape

```json
{
  "version": 1,
  "topic": "...",
  "channel": { "name": "...", "audience": "..." },
  "video": { "format": "long", "title": "..." },
  "production": { "provider_policy": "hybrid" },
  "scenes": []
}
```

## `video`

| Field | Meaning |
| --- | --- |
| `slug` | Kebab-case project/output stem |
| `format` | `long` or `short` |
| `title` | Final YouTube title; maximum 100 characters |
| `description` | Maximum 5000 UTF-8 bytes |
| `tags` | Encoded aggregate maximum 500 characters |
| `category_id` | Default `28` |
| `privacy` | `private`, `unlisted`, or `public`; default `private` |
| `made_for_kids` | Explicit audience declaration |
| `contains_synthetic_media` | Realistic synthetic-media disclosure; default `true` |
| `language` | Metadata/audio language; default `en-NZ` |
| `width`, `height`, `fps` | Default `1920×1080@30` long or `1080×1920@30` short |
| `thumbnail.headline/subhead` | Copy for the deterministic 1280×720 thumbnail |
| `thumbnail.accent` | CSS colour used by the thumbnail |

A Short must be square or vertical and the planned duration must not exceed 180 seconds.

## `production`

| Field | Default | Meaning |
| --- | ---: | --- |
| `provider_policy` | `hybrid` | `hybrid`, `tri-hybrid`, `gemini`, `comfyui`, or `minimax` |
| `gemini_voice` | `Kore` | Gemini 3.1 Flash TTS voice |
| `transition_s` | `0.30` | Visual fade duration |
| `lead_in_s`, `tail_s` | `.25/.35` | Padding around narration |
| `words_per_minute` | `165` | Script-density check |
| `max_concurrency` | `1` | Concurrent visual generations; match independent ComfyUI worker capacity |
| `default_native_audio` | `mute` | `mute`, `duck`, or `keep` |
| `background_music` | `false` | Whether to request a bed |
| `background_music_query` | varies | Retrieval/generation brief for the bed |

### Provider policies

#### `hybrid`

Requires Gemini and ComfyUI in the finished visual manifest:

- **Gemini Omni** — hook, hero, product demo, reveal, and CTA shots.
- **ComfyUI LTX-2.3** — repeatable B-roll, visual metaphors, backgrounds, and private volume generation.

#### `tri-hybrid`

Requires all three families:

- Gemini Omni for high-value prompt-sensitive shots.
- ComfyUI LTX-2.3 for self-hosted supporting footage.
- MiniMax-H3 for 2K continuity-sensitive, reference-driven, first/last-frame, or reference-audio shots.

A plan with fewer than three scenes cannot satisfy `tri-hybrid` without explicit restructuring.

#### Standalone policies

`gemini`, `comfyui`, and `minimax` assign every scene lacking an explicit provider to that service. Controlled narration still uses Gemini TTS.

Explicit scene providers always win. The normalizer fills only missing provider choices. If every scene is explicit but the selected mixed policy is incomplete, validation fails instead of silently rewriting creative allocation.

## `scenes[]`

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique kebab-case id, up to 48 characters |
| `role` | no | `hook`, `hero`, `demo`, `broll`, `reveal`, `cta`, or custom |
| `provider` | no | `gemini`, `comfyui`, or `minimax`; assigned by policy when absent |
| `duration_s` | yes | Target editorial duration, minimum one second |
| `narration` | no | Exact spoken line for Gemini TTS |
| `visual_prompt` | yes | Self-contained generation prompt |
| `negative_prompt` | no | Provider-specific negative constraints; appended to H3 text content |
| `on_screen_text` | no | Editorial overlay, not subtitles |
| `native_audio` | no | `mute`, `duck`, or `keep` for generated source audio |
| `fallback_provider` | no | Optional alternate provider; never used after a MiniMax attempt |

### MiniMax-H3 scene rules

H3 supports source clips from 4 through 15 integer seconds. A MiniMax scene outside that window produces a warning: generation is clamped to the nearest supported source duration, then the composition trims or freezes frames to satisfy `duration_s`.

The plan intentionally contains only durable creative decisions. H3 reference media is configured through the provider's supported environment or direct provider context:

```text
MINIMAX_H3_FIRST_FRAME
MINIMAX_H3_LAST_FRAME
MINIMAX_H3_REFERENCE_IMAGES_JSON
MINIMAX_H3_REFERENCE_VIDEOS_JSON
MINIMAX_H3_REFERENCE_AUDIOS_JSON
```

Keep references scene-specific when running the pipeline by setting the environment for that stage or invoking `/media-use` directly. Do not embed API keys in the plan.

A MiniMax failure is strict. The pipeline does not invoke `fallback_provider` after H3 begins because task creation may have succeeded even when the local response was lost. Recover the recorded task ID instead of creating a replacement video.

## Narration density

At 165 words per minute, a five-second scene carries about 13–14 spoken words. The validator warns rather than rewriting copy; split dense narration into another scene instead of speeding speech unnaturally.

## Plan discipline

- One claim per scene.
- State a concrete tension or payoff in the first scene.
- Visual prompts describe subject, environment, camera, light, motion, continuity, and desired sound.
- For H3 reference shots, state exact temporal order, persistent identity/wardrobe/prop relationships, initial state, and locked end state.
- Generated UI must not contain real private data, copyrighted logos, or prompt-invented text; add reliable text in HyperFrames.
- Keep `contains_synthetic_media: true` unless the owner correctly changes it after reviewing the final edit.
- Keep upload privacy `private` until the owner reviews the render, metadata, thumbnail, and captions.
