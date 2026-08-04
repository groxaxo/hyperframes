# Text To Speech

The shared audio engine supports Gemini, HeyGen, ElevenLabs, and local Kokoro.
`npx hyperframes tts` itself remains the direct local Kokoro command; provider
selection lives in `audio/scripts/audio.mjs` and its shared `lib/tts.mjs`.

## Available routes

| Order | Provider                       | Credential / trigger                                      | Voice IDs                              | Word timestamps                           | Audio format                    |
| ----- | ------------------------------ | --------------------------------------------------------- | -------------------------------------- | ----------------------------------------- | ------------------------------- |
| 1     | Gemini 3.1 Flash TTS Preview   | `$GEMINI_API_KEY` or `$GOOGLE_API_KEY`                    | named voices such as `Kore`, `Puck`    | No — engine transcribes the WAV           | 24 kHz mono PCM → WAV locally   |
| 2     | HeyGen (Starfish)              | `$HEYGEN_API_KEY` / `~/.heygen/credentials`               | Starfish UUIDs                         | **Yes** (`word_timestamps[]`)              | mp3 → WAV via ffmpeg            |
| 3     | ElevenLabs                     | `$ELEVENLABS_API_KEY` plus installed Python package       | dashboard UUIDs                        | No — engine transcribes the WAV           | mp3 → WAV via ffmpeg            |
| 4     | Kokoro-82M                     | always available as the local fallback                    | `am_michael`, `af_heart`, …            | No — engine transcribes the WAV           | WAV direct                      |

`auto` chooses the first configured route. A user-requested provider is strict:
`--provider gemini` never silently substitutes HeyGen or Kokoro.

## Gemini 3.1 Flash TTS

Configure one environment variable:

```bash
export GEMINI_API_KEY=...
# GOOGLE_API_KEY is also accepted
```

Then run the shared engine:

```bash
node skills/media-use/audio/scripts/audio.mjs \
  --request ./audio_request.json \
  --out ./audio_meta.json \
  --provider gemini
```

Example request:

```json
{
  "provider": "gemini",
  "voice": "Kore",
  "lang": "en",
  "speed": 1.0,
  "lines": [
    { "id": "01", "text": "Welcome to HyperFrames." }
  ],
  "bgm": { "mode": "none" }
}
```

The implementation uses the Google Interactions REST endpoint directly with
model `gemini-3.1-flash-tts-preview`; no Google SDK dependency is added. The key
is sent through the `x-goog-api-key` header and is never persisted.

### Voice

The deterministic default is `Kore`. Override it with any supported named
voice:

```bash
GEMINI_TTS_VOICE=Puck node skills/media-use/audio/scripts/audio.mjs ...
# or:
node skills/media-use/audio/scripts/audio.mjs ... --voice Charon
```

Common choices include `Kore`, `Puck`, `Charon`, `Fenrir`, `Aoede`, `Leda`,
`Orus`, and `Zephyr`. The API validates the final voice name.

### Output and captions

Gemini TTS returns base64-encoded 24 kHz, 16-bit, mono PCM. media-use writes a
standard RIFF/WAVE header around those bytes, so Gemini output does not need
ffmpeg. Gemini currently supplies no word timestamps in this path; the audio
engine runs the normal transcription step and emits the same
`[{id,text,start,end}]` shape used by captions.

### Prompt and pacing safety

The provider prepends an explicit synthesis instruction and labels the spoken
transcript. This reduces two preview-model failure modes: reading director notes
aloud and returning no audio for an ambiguous prompt. It also tells the model to
speak only the supplied transcript without adding or omitting words.

`speed` is translated to a natural-language delivery direction because Gemini
TTS uses prompt steering rather than a numeric playback-rate field:

- `0.5–0.8` — slow and deliberate
- `0.8–0.95` — slightly slower than normal
- `0.95–1.1` — natural and conversational
- `1.1–1.35` — brisk and energetic
- `1.35–2.0` — fast but still clear

The HTTP transport retries transient timeouts, rate limits, and server failures.
For narration longer than a few minutes, split the script into scene-sized lines
to preserve voice consistency and make retries granular.

## Local Kokoro CLI

```bash
npx hyperframes tts "Welcome to HyperFrames" -o narration.wav
```

The published `hyperframes tts` command synthesizes locally with Kokoro. It does
not accept a cloud `--provider` or `--words` flag. Use the shared audio engine
for automatic provider selection.

## Self-contained HeyGen helper

When HeyGen is required specifically — for its Starfish catalog and native word
timestamps — use the bundled helper:

```bash
node skills/media-use/audio/scripts/heygen-tts.mjs \
  "Welcome to HyperFrames." \
  -o narration.wav \
  --words narration.words.json

node skills/media-use/audio/scripts/heygen-tts.mjs ./script.txt -o narration.wav
node skills/media-use/audio/scripts/heygen-tts.mjs --list
```

The helper resolves credentials in this order:
`$HEYGEN_API_KEY` → `$HYPERFRAMES_API_KEY` → a nearby project `.env` →
`~/.heygen/credentials`. OAuth uses `Authorization: Bearer`; API keys use
`X-Api-Key`.

- **Voice:** `--voice <id>` must be a Starfish voice ID. English defaults to the fixed Marcia ID `05f19352e8f74b0392a8f411eba40de1`.
- **Output:** `.wav` is transcoded to 44.1 kHz mono through ffmpeg; `.mp3` writes the returned bytes.
- **Words:** `--words <path>` emits the flat caption-compatible timestamp array.
- **Non-English:** pass `--lang <code>` when needed.

## When to use which provider

| Goal                                                        | Use                                      |
| ----------------------------------------------------------- | ---------------------------------------- |
| Preferred low-cost cloud narration, expressive prompting    | **Gemini 3.1 Flash TTS**                 |
| Native word timestamps in the synthesis response            | **HeyGen**                               |
| Large third-party cloud voice catalog                       | **ElevenLabs**                           |
| Offline, private, no API key                                | **Kokoro**                               |
| Exact caption timing with Gemini / ElevenLabs / Kokoro       | generate, then run the engine transcript |

## ffmpeg requirement

Gemini and Kokoro produce WAV without ffmpeg. HeyGen and ElevenLabs return
compressed audio that is transcoded when WAV output is requested. `ffprobe`
remains part of the full audio-engine preflight because it measures durations
for every provider.

## Voice selection (Kokoro)

Default `af_heart` for the direct CLI; the shared audio engine uses its existing
deterministic Kokoro default. Curated picks:

| Content type      | Voice                  |
| ----------------- | ---------------------- |
| Product demo      | `af_heart`, `af_nova`  |
| Tutorial / how-to | `am_adam`, `bf_emma`   |
| Marketing / promo | `af_sky`, `am_michael` |
| Documentation     | `bf_emma`, `bm_george` |
| Casual / social   | `af_heart`, `af_sky`   |

Run `npx hyperframes tts --list` for the bundled set.

## Multilingual Kokoro

The first character of a Kokoro voice ID selects the phonemizer language;
`--lang` overrides auto-detection.

| Prefix | Language             |
| ------ | -------------------- |
| `a`    | American English     |
| `b`    | British English      |
| `e`    | Spanish              |
| `f`    | French               |
| `h`    | Hindi                |
| `i`    | Italian              |
| `j`    | Japanese             |
| `p`    | Brazilian Portuguese |
| `z`    | Mandarin             |

```bash
npx hyperframes tts "La reunión empieza a las nueve" --voice ef_dora
npx hyperframes tts "Today is a nice day" --voice af_heart
```

Non-English phonemization needs `espeak-ng` system-wide.

## Caption timestamp shape

HeyGen can return this directly; Gemini, ElevenLabs, and Kokoro reach the same
shape through transcription:

```json
[
  { "id": "w0", "text": "Hi", "start": 0.0, "end": 0.21 },
  { "id": "w1", "text": "there", "start": 0.22, "end": 0.55 }
]
```
