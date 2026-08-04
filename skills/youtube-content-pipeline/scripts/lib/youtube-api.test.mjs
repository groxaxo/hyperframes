import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GOOGLE_TOKEN_ENDPOINT,
  buildCaptionMultipart,
  buildYouTubeVideoResource,
  getYouTubeAccessToken,
  initiateYouTubeUpload,
  insertYouTubeCaptions,
  publishYouTubePackage,
  setYouTubeThumbnail,
  uploadYouTubeVideo,
} from "./youtube-api.mjs";

function plan() {
  return {
    video: {
      title: "A useful title",
      description: "Description",
      tags: ["automation"],
      category_id: "28",
      privacy: "private",
      made_for_kids: false,
      contains_synthetic_media: true,
      language: "en-NZ",
    },
  };
}

function response({ status = 200, json = {}, text = "", headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) || null },
    json: async () => json,
    text: async () => text || JSON.stringify(json),
  };
}

test("video resource carries privacy, audience, language and synthetic-media disclosure", () => {
  const value = buildYouTubeVideoResource(plan(), "unlisted");
  assert.equal(value.status.privacyStatus, "unlisted");
  assert.equal(value.status.selfDeclaredMadeForKids, false);
  assert.equal(value.status.containsSyntheticMedia, true);
  assert.equal(value.snippet.defaultAudioLanguage, "en-NZ");
});

test("OAuth supports direct access tokens and refresh-token exchange", async () => {
  assert.deepEqual(
    await getYouTubeAccessToken({ env: { YOUTUBE_ACCESS_TOKEN: "direct" } }),
    { accessToken: "direct", source: "access_token" },
  );
  let request;
  const refreshed = await getYouTubeAccessToken({
    env: {
      YOUTUBE_CLIENT_ID: "client",
      YOUTUBE_CLIENT_SECRET: "secret",
      YOUTUBE_REFRESH_TOKEN: "refresh",
    },
    fetch: async (url, options) => {
      request = { url, options };
      return response({ json: { access_token: "new-token", expires_in: 3600 } });
    },
  });
  assert.equal(request.url, GOOGLE_TOKEN_ENDPOINT);
  assert.match(String(request.options.body), /grant_type=refresh_token/);
  assert.equal(refreshed.accessToken, "new-token");
});

test("resumable upload session declares size and returns Location", async () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-session-"));
  try {
    const file = join(dir, "video.mp4");
    writeFileSync(file, "video-bytes");
    let request;
    const session = await initiateYouTubeUpload(file, buildYouTubeVideoResource(plan()), {
      accessToken: "token",
      fetch: async (url, options) => {
        request = { url, options };
        return response({ headers: { location: "https://upload.example/session" } });
      },
    });
    assert.equal(session.sessionUrl, "https://upload.example/session");
    assert.equal(request.options.headers["X-Upload-Content-Length"], "11");
    assert.match(request.url, /uploadType=resumable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("video upload resumes from a 308 Range and returns the video id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-upload-"));
  try {
    const file = join(dir, "video.mp4");
    writeFileSync(file, "abcdefghij");
    const calls = [];
    const responses = [
      response({ status: 308, headers: { range: "bytes=0-4" } }),
      response({ status: 201, json: { id: "video123" } }),
    ];
    const result = await uploadYouTubeVideo(
      file,
      { sessionUrl: "https://upload.example/session", size: 10, mimeType: "video/mp4" },
      {
        accessToken: "token",
        fetch: async (_url, options) => {
          calls.push(options.headers["Content-Range"]);
          for await (const _chunk of options.body) {
            // Consume the stream like fetch does so the test leaves no open file handle.
          }
          return responses.shift();
        },
      },
    );
    assert.deepEqual(calls, ["bytes 0-9/10", "bytes 5-9/10"]);
    assert.equal(result.videoId, "video123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("thumbnail and caption uploads use media endpoints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-assets-"));
  try {
    const thumb = join(dir, "thumbnail.png");
    const captions = join(dir, "captions.srt");
    writeFileSync(thumb, "png");
    writeFileSync(captions, "1\n00:00:00,000 --> 00:00:01,000\nHello\n");
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      return response({ json: { id: "caption1", items: [] } });
    };
    await setYouTubeThumbnail("video123", thumb, { accessToken: "token", fetch });
    await insertYouTubeCaptions("video123", captions, "en-NZ", {
      accessToken: "token",
      fetch,
    });
    assert.match(urls[0], /thumbnails\/set/);
    assert.match(urls[1], /captions\?part=snippet/);
    const multipart = buildCaptionMultipart("video123", captions, "en-NZ");
    assert.match(multipart.body.toString(), /"videoId":"video123"/);
    assert.match(multipart.body.toString(), /Hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run publishing validates a complete package without network access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-package-"));
  try {
    for (const [name, data] of [
      ["video.mp4", "video"],
      ["thumbnail.png", "thumb"],
      ["captions.srt", "captions"],
      ["metadata.json", "{}"],
    ]) writeFileSync(join(dir, name), data);
    const result = await publishYouTubePackage(plan(), dir, {
      privacy: "private",
      dryRun: true,
      fetch: async () => {
        throw new Error("network should not run");
      },
    });
    assert.equal(result.dry_run, true);
    assert.equal(result.resource.status.privacyStatus, "private");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
