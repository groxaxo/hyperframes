# Setup and providers — install, auth, RAM ladders, forcing a provider

## Gemini setup — preferred video and cloud TTS

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

media-use holds no credentials. Remote providers read their normal environment
or CLI-owned auth, and every resolved asset is frozen locally before it enters a
composition. `resolve` spec-checks available RAM for local ladders through
`describeModelLadder`.

| Type      | Ordered provider path                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| bgm/sfx   | HeyGen catalog; bundled SFX fallback                                                                                                                |
| image     | HeyGen search; optional local mflux; Codex image generation                                                                                         |
| voice     | **Gemini 3.1 Flash TTS** when a Google key exists → HeyGen TTS → local Kokoro                                                                      |
| video     | **Gemini Omni Flash** when a Google key exists → HeyGen avatar video → local LTX                                                                   |
| icon      | HeyGen asset search                                                                                                                                |
| logo      | svgl → simple-icons → GitHub org avatar → domain favicon                                                                                           |
| grade/lut | local core-preset map, params/CDN look index, deterministic `buildCube` fallback                                                                    |

Gemini providers return a clean miss when no Google key exists, so the existing
fallback chain remains operational. Both Gemini providers are marked remote and
metered: `--local-only` skips them, and the normal cost-confirmation rule applies
to agent-initiated calls. A direct user request to generate with Gemini is
already authorization to run that provider.

To pin a generator, pass its prefix:

```bash
--provider gemini   # gemini.omni for video or gemini.tts for voice
--provider heygen
--provider kokoro
--provider ltx
```

A forced provider bypasses cache reuse and all nonmatching providers. For
example, `--provider gemini` will fail clearly when no Google key is configured
rather than silently returning a HeyGen or LTX result.

`--local-only` is a hard network guard. It skips Gemini, HeyGen, Codex, and every
other remote provider even when one is explicitly forced.

## CLI tools used

Gemini needs no installed SDK or CLI. It uses Node's built-in `fetch`. Other
providers shell their existing tools:

| Tool / credential  | Serves                                                                                  | Enable                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Google API key     | Gemini Omni video + Gemini 3.1 Flash TTS                                                 | `export GEMINI_API_KEY=...` (or `GOOGLE_API_KEY`)                                                                                             |
| `ffmpeg`/`ffprobe` | probing, adoption, smart-grade, cut, duck bake, loudnorm, non-Gemini cloud-audio convert | system package (`brew install ffmpeg` / `apt install ffmpeg`)                                                                                 |
| `heygen`           | catalogs + HeyGen TTS + avatar video                                                     | verified HeyGen install, then `heygen auth login --oauth` (needs >= v0.3.0)                                                                  |
| `mflux-generate`   | local image generation                                                                  | `uv venv ~/.venvs/mflux && VIRTUAL_ENV=~/.venvs/mflux uv pip install mflux==0.9.6`                                                            |
| `codex`            | image generation through the user's ChatGPT subscription                                | Codex CLI, logged in via ChatGPT                                                                                                              |
| `parakeet-mlx`     | local transcription                                                                     | `uv venv ~/.venvs/parakeet && VIRTUAL_ENV=~/.venvs/parakeet uv pip install parakeet-mlx`                                                      |
| `ltx-2-mlx`        | local video generation                                                                  | `git clone https://github.com/dgrauet/ltx-2-mlx && cd ltx-2-mlx && uv sync --all-extras`                                                      |
| `npx hyperframes`  | Kokoro TTS, whisper.cpp fallback, background removal                                     | via the HyperFrames CLI; whisper.cpp builds on first use and downloads its model                                                             |

Without an optional tool or credential, its provider emits at most one useful
diagnostic and the resolver falls through where another provider exists.
