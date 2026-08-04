# Audio engine — voiceover, music, SFX, captions, transcription

For a full audio pass (TTS voiceover + background music + sound effects in one
shot), use the shared engine at `audio/scripts/audio.mjs`. It takes a neutral
`audio_request.json` and writes `audio_meta.json` plus assets under
`.media/audio/{voice,bgm,sfx}`:

```bash
node <SKILL_DIR>/audio/scripts/audio.mjs \
  --request ./audio_request.json \
  --out ./audio_meta.json
```

- **Request** `{ provider?, voice?, lang?, speed?, lines: [{ id, text, sfx?: [names] }], bgm: { mode?, query?, prompt? } }`: `id` joins each line back to your model; `provider` = `auto | gemini | heygen | elevenlabs | kokoro`; `bgm.mode` = `retrieve | generate | none` (omit for auto). `--only tts,bgm,sfx` runs a subset and merges into an existing `--out`.
- **Output** `audio_meta.json` (id-keyed): `voices[].{path,duration_s,words[]}` (word timestamps for captions), `sfx[]`, `bgm`, `total_duration_s`.
- **Gemini default:** when `GEMINI_API_KEY` or `GOOGLE_API_KEY` exists, `auto` selects `gemini-3.1-flash-tts-preview`. The default voice is `Kore`; set `request.voice`, `--voice`, or `GEMINI_TTS_VOICE` to override it.
- **Gemini audio shape:** the API returns 24 kHz, 16-bit, mono PCM. The provider wraps it as WAV locally, then the engine transcribes it because Gemini TTS does not return word timestamps.
- **Fallbacks:** without a Google key, TTS falls through to HeyGen, then ElevenLabs when configured, then local Kokoro. HeyGen remains the retrieval path for music and SFX; local/provider-specific generators remain explicit alternatives.
- If BGM took the generate path (`bgm_pending: true`), run `audio/scripts/wait-bgm.mjs` before final render.

Force Gemini for narration:

```bash
export GEMINI_API_KEY=...
node <SKILL_DIR>/audio/scripts/audio.mjs \
  --request ./audio_request.json \
  --out ./audio_meta.json \
  --provider gemini
```

Gemini Omni video generated through `resolve --type video --provider gemini`
already contains a native audio track. Use this TTS path only when the project
needs controlled narration, exact spoken copy, a selected voice, or caption
timings. When both assets are used, explicitly mute or duck the Omni track so
the final mix never carries two competing narration layers.

Single-shot helpers: `audio/scripts/heygen-tts.mjs` remains available for a
HeyGen-specific file with native word timestamps. Transcription / background
removal / captions use the `hyperframes` CLI (`transcribe`,
`remove-background`); see the per-topic guides in `audio/references/`
(`tts.md`, `bgm.md`, `sfx.md`, `transcribe.md`, `remove-background.md`,
`captions/`).

Transcription defaults to Parakeet (better than whisper.cpp in the tracked
benchmark) via `scripts/transcribe.mjs`, with whisper.cpp auto-fallback (see
`references/operations.md`).
