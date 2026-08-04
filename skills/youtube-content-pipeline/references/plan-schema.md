# YouTube production plan contract

`youtube-plan.json` is the durable creative and operational contract. The agent
writes it once in Stage 1; every later stage reads it and records progress under
`.youtube-pipeline/state.json`. Editing the plan invalidates generated stages so a
resume never silently combines assets from two different briefs.

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

| Field                        | Meaning                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `slug`                       | Kebab-case project and output stem                                     |
| `format`                     | `long` or `short`                                                      |
| `title`                      | Final YouTube title; maximum 100 characters                            |
| `description`                | Final description; maximum 5000 UTF-8 bytes                            |
| `tags`                       | Tag list; encoded aggregate maximum 500 characters                     |
| `category_id`                | YouTube category, default `28`                                         |
| `privacy`                    | `private`, `unlisted`, or `public`; default `private`                   |
| `made_for_kids`              | Explicit audience declaration                                          |
| `contains_synthetic_media`   | YouTube realistic synthetic-media disclosure; default `true`           |
| `language`                   | Metadata/audio language, default `en-NZ`                               |
| `width`, `height`, `fps`     | Optional; defaults `1920×1080@30` long or `1080×1920@30` short         |
| `thumbnail.headline/subhead` | Copy for the deterministic 1280×720 thumbnail                          |
| `thumbnail.accent`           | CSS colour used by the generated thumbnail                             |

A `short` must be square or vertical and the planned scene duration must not
exceed 180 seconds. A normal channel upload on or after 15 October 2024 is
classified as a Short when it is square/vertical and no longer than three
minutes. Keep music rights especially conservative above one minute: a Short
over one minute with an active Content ID claim is blocked globally.

## `production`

| Field                    | Default | Meaning                                                                 |
| ------------------------ | ------- | ----------------------------------------------------------------------- |
| `provider_policy`        | hybrid  | `hybrid`, `gemini`, or `comfyui`                                        |
| `gemini_voice`           | Kore    | Gemini 3.1 Flash TTS voice                                              |
| `transition_s`           | 0.30    | Visual fade duration                                                     |
| `lead_in_s`, `tail_s`    | .25/.35 | Padding around each scene's narration                                   |
| `words_per_minute`       | 165     | Script-density check                                                     |
| `max_concurrency`        | 1       | Concurrent visual generations; keep `1` on a single ComfyUI worker      |
| `default_native_audio`   | mute    | `mute`, `duck`, or `keep`                                                |
| `background_music`       | false   | Whether to ask the media audio engine for a bed                          |
| `background_music_query` | ...     | Retrieval/generation brief for the bed                                  |

### Hybrid provider policy

The pipeline is intentionally not a simple fallback chain. In `hybrid` mode it
uses both systems in the finished production:

- **Gemini Omni** — hook, hero, product demo, reveal, and CTA shots where prompt
  understanding, native sound, or a single high-value shot matters most.
- **ComfyUI LTX-2.3** — repeatable B-roll, visual metaphors, backgrounds,
  transitions, and volume generation on infrastructure you control.

Explicit scene providers win. Missing providers are assigned by role, and a
multi-scene hybrid plan is normalized so at least one scene uses each service.

## `scenes[]`

| Field               | Required | Meaning                                                                |
| ------------------- | -------- | ---------------------------------------------------------------------- |
| `id`                | yes      | Unique kebab-case id, up to 48 characters                              |
| `role`              | no       | `hook`, `hero`, `demo`, `broll`, `reveal`, `cta`, or a custom label   |
| `provider`          | no       | `gemini` or `comfyui`; assigned by policy when absent                  |
| `duration_s`        | yes      | Target edit duration, minimum one second                               |
| `narration`         | no       | Exact spoken line for Gemini TTS                                       |
| `visual_prompt`     | yes      | Self-contained generation prompt                                       |
| `negative_prompt`   | no       | ComfyUI negative prompt; safe artifact/flicker default when absent     |
| `on_screen_text`    | no       | Short editorial overlay, not subtitles                                 |
| `native_audio`      | no       | `mute`, `duck`, or `keep` for generated source audio                   |
| `fallback_provider` | no       | Optional alternate service if the chosen provider fails                |

Keep each narration line inside its shot budget. At 165 words per minute, a
five-second scene carries about 13–14 spoken words. The validator warns rather
than rewriting copy; split a dense line into another scene instead of speeding
speech unnaturally.

## Plan discipline

- One claim per scene.
- The first scene states a concrete tension or payoff immediately.
- Visual prompts describe subject, setting, shot, camera, light, motion, and
  desired sound when native audio is useful.
- Generated UI must not contain real private data, copyrighted logos, or
  unreadable prompt-invented text. Add reliable text in HyperFrames instead.
- `contains_synthetic_media` remains `true` unless the owner deliberately and
  correctly changes the disclosure after reviewing the finished edit.
- Upload privacy remains `private` until the owner reviews the render, metadata,
  thumbnail, and captions.
