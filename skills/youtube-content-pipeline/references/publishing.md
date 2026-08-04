# YouTube publishing setup and safety

The pipeline can stop at a complete `youtube-package/` or publish that package
through the YouTube Data API. Publishing is always a separate final stage so a
successful render never becomes an accidental public upload.

## Authorization model

YouTube write operations require OAuth 2.0 user authorization. An ordinary
service account cannot be linked to a YouTube channel and therefore cannot
upload to it. Use a Desktop application OAuth client owned by the Google Cloud
project that has **YouTube Data API v3** enabled.

The publisher needs these scopes:

```text
https://www.googleapis.com/auth/youtube.upload
https://www.googleapis.com/auth/youtube.force-ssl
```

The first authorizes video and thumbnail upload. The second is needed for
caption insertion. Request offline access once and keep the resulting refresh
token private; the pipeline exchanges it for short-lived access tokens when a
publish starts.

## One-time Google Cloud setup

1. Create or choose a Google Cloud project.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen and add the Google account that owns or
   manages the target channel as a test user while the app is in testing.
4. Create an OAuth client of type **Desktop app**.
5. Complete one installed-application authorization for the two scopes above
   with `access_type=offline` and consent forced once. Google's OAuth Playground
   can perform this exchange when its settings are configured to use your own
   client ID and client secret.
6. Store the client ID, client secret, and refresh token outside the repository.

Configure the pipeline process:

```bash
export YOUTUBE_CLIENT_ID='...apps.googleusercontent.com'
export YOUTUBE_CLIENT_SECRET='...'
export YOUTUBE_REFRESH_TOKEN='...'
```

For a short-lived manual session, `YOUTUBE_ACCESS_TOKEN` can be used instead;
it takes precedence over the refresh-token tuple.

Never put these values in `youtube-plan.json`, `metadata.json`, a composition,
or Git history. A project-local `.env` is loaded by the pipeline and must remain
ignored. Resumable upload session URLs and publish receipts are written under
`.youtube-pipeline/` or `youtube-package/` with private file permissions where
they contain recovery data.

## Private-first release flow

First inspect the exact API payload without authorization or network calls:

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs publish \
  --project videos/<slug> \
  --privacy private \
  --dry-run
```

The dry run validates that the video, JPEG thumbnail, SRT captions, and metadata
exist and are non-empty. It prints the precise `snippet` and `status` resource
that `videos.insert` will receive, including:

- title, description, tags, category and language;
- `privacyStatus`;
- `selfDeclaredMadeForKids`;
- `containsSyntheticMedia`.

After reviewing it, publish privately:

```bash
node <SKILL_DIR>/scripts/youtube-pipeline.mjs publish \
  --project videos/<slug> \
  --privacy private
```

The publisher then:

1. exchanges the refresh token for an access token;
2. opens a resumable `videos.insert` session;
3. uploads or resumes the MP4 at the byte offset acknowledged by YouTube;
4. sets the custom thumbnail;
5. inserts the caption track;
6. writes `youtube-package/publish-receipt.json` with the video ID and watch URL.

A failed upload stores its session URI in `.youtube-pipeline/state.json`. Rerun
the same publish command shortly afterward to query the acknowledged byte range
and continue instead of retransmitting a completed prefix. Resumable session
URIs have finite lifetimes, so do not treat one as a permanent credential.

## Public and unlisted uploads

`--privacy unlisted` or `--privacy public` is accepted only when explicitly
passed or already set in the reviewed plan. Be aware that YouTube restricts
uploads from unverified API projects created after 28 July 2020 to private
viewing until the API project passes YouTube's compliance audit. That platform
restriction can override a requested public status.

The pipeline does not automatically make a private upload public later. Review
processing, copyright checks, captions, thumbnail, description, chapters, and
the altered/synthetic-content disclosure in YouTube Studio before changing its
visibility.

## Thumbnail contract

The thumbnail project renders at 1280×720. Packaging converts its PNG snapshot
to JPEG and iteratively compresses it until it is non-empty and no larger than
YouTube's 2 MB custom-thumbnail limit. Publishing refuses an incomplete package
before opening an upload session.

## Captions

`captions.srt` and `captions.vtt` remain in the package. The publisher inserts
the SRT track with the plan's language code. Gemini TTS does not return word
timestamps through this provider path, so the audio stage uses the shared ASR
result when available and deterministic duration-weighted word timing as an
explicitly marked fallback. Review caption timing before upload.

## Recovery and revocation

- `status` shows whether publish is pending, running, failed, or complete.
- A changed plan invalidates generated stages but does not delete a video already
  uploaded to YouTube.
- Revoke the app from the Google Account's third-party access settings if a
  refresh token is exposed, then issue a new token.
- Rotate the OAuth client secret if it is exposed.
- Delete local token material and upload session data when decommissioning the
  pipeline host.
