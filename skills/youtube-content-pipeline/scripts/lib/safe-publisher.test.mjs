import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishYouTubePackageSafely } from "./safe-publisher.mjs";

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

function makePackage({ captions = "1\n00:00:00,000 --> 00:00:01,000\nHello\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "youtube-safe-publish-"));
  for (const [name, data] of [
    ["video.mp4", "video"],
    ["thumbnail.jpg", "thumb"],
    ["captions.srt", captions],
    ["metadata.json", "{}"],
  ]) writeFileSync(join(dir, name), data);
  return dir;
}

async function consumeBody(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") return;
  for await (const _chunk of body) {
    // Consume upload streams so tests do not leave file descriptors open.
  }
}

function isCaptionWrite(url) {
  return url.includes("/upload/youtube/v3/captions?");
}

function isCaptionList(url) {
  return url.includes("/youtube/v3/captions?") && !isCaptionWrite(url);
}

test("dry-run validates the package without OAuth or network", async () => {
  const dir = makePackage();
  try {
    const result = await publishYouTubePackageSafely(plan(), dir, {
      dryRun: true,
      fetch: async () => {
        throw new Error("network must not run");
      },
    });
    assert.equal(result.dry_run, true);
    assert.equal(result.resource.status.privacyStatus, "private");
    assert.equal(result.captions_will_upload, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("successful publishing checkpoints session, video, thumbnail, captions, and completion", async () => {
  const dir = makePackage();
  const checkpoints = [];
  const calls = [];
  try {
    const result = await publishYouTubePackageSafely(plan(), dir, {
      env: { YOUTUBE_ACCESS_TOKEN: "token" },
      publishFingerprint: "fingerprint-a",
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint.stage),
      fetch: async (url, options = {}) => {
        calls.push({ url, method: options.method || "GET" });
        await consumeBody(options.body);
        if (url.includes("/videos?uploadType=resumable")) {
          return response({ headers: { location: "https://upload.example/session" } });
        }
        if (url === "https://upload.example/session") {
          return response({ status: 201, json: { id: "video123" } });
        }
        if (url.includes("/thumbnails/set")) return response({ json: { items: [] } });
        if (isCaptionWrite(url)) return response({ json: { id: "caption123" } });
        if (isCaptionList(url)) return response({ json: { items: [] } });
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    assert.equal(result.video_id, "video123");
    assert.equal(result.metadata_set, true);
    assert.equal(result.caption_id, "caption123");
    assert.equal(result.captions_skipped, false);
    assert.equal(result.publish_complete, true);
    assert.deepEqual(checkpoints, [
      "upload_session_created",
      "video_uploaded",
      "thumbnail_set",
      "captions_set",
      "complete",
    ]);
    const receipt = JSON.parse(readFileSync(join(dir, "publish-receipt.json"), "utf8"));
    assert.equal(receipt.video_upload_complete, true);
    assert.equal(receipt.publish_complete, true);
    assert.equal(calls.filter((call) => call.url.includes("/videos?uploadType=resumable")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a narration-free package skips caption APIs and still completes", async () => {
  const dir = makePackage({ captions: "\n" });
  const urls = [];
  try {
    const result = await publishYouTubePackageSafely(plan(), dir, {
      env: { YOUTUBE_ACCESS_TOKEN: "token" },
      publishFingerprint: "captionless",
      fetch: async (url, options = {}) => {
        urls.push(url);
        await consumeBody(options.body);
        if (url.includes("/videos?uploadType=resumable")) {
          return response({ headers: { location: "https://upload.example/captionless" } });
        }
        if (url === "https://upload.example/captionless") {
          return response({ status: 201, json: { id: "video-captionless" } });
        }
        if (url.includes("/thumbnails/set")) return response({ json: {} });
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    assert.equal(result.captions_skipped, true);
    assert.equal(result.caption_id, null);
    assert.equal(result.publish_complete, true);
    assert.equal(urls.some((url) => url.includes("/captions")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutable metadata, thumbnail, and captions update the existing video in place", async () => {
  const dir = makePackage();
  const initial = { video: "v1", metadata: "m1", thumbnail: "t1", captions: "c1" };
  const changed = { video: "v1", metadata: "m2", thumbnail: "t2", captions: "c2" };
  try {
    await publishYouTubePackageSafely(plan(), dir, {
      env: { YOUTUBE_ACCESS_TOKEN: "token" },
      publishFingerprint: "release-1",
      assetFingerprints: initial,
      fetch: async (url, options = {}) => {
        await consumeBody(options.body);
        if (url.includes("/videos?uploadType=resumable")) {
          return response({ headers: { location: "https://upload.example/original" } });
        }
        if (url === "https://upload.example/original") {
          return response({ status: 201, json: { id: "stable-video" } });
        }
        if (url.includes("/thumbnails/set")) return response({ json: {} });
        if (isCaptionList(url)) return response({ json: { items: [] } });
        if (isCaptionWrite(url)) return response({ json: { id: "stable-caption" } });
        throw new Error(`unexpected URL: ${url}`);
      },
    });

    const calls = [];
    const checkpoints = [];
    const result = await publishYouTubePackageSafely(plan(), dir, {
      env: { YOUTUBE_ACCESS_TOKEN: "token" },
      publishFingerprint: "release-2",
      assetFingerprints: changed,
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint.stage),
      fetch: async (url, options = {}) => {
        calls.push({ url, method: options.method || "GET" });
        if (url.includes("/videos?uploadType=resumable") || url === "https://upload.example/original") {
          throw new Error("the video payload must not upload again");
        }
        if (url.includes("/youtube/v3/videos?")) {
          assert.equal(options.method, "PUT");
          return response({ json: { id: "stable-video" } });
        }
        if (url.includes("/thumbnails/set")) return response({ json: {} });
        if (isCaptionWrite(url)) {
          assert.equal(options.method, "PUT");
          return response({ json: { id: "stable-caption" } });
        }
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    assert.equal(result.video_id, "stable-video");
    assert.equal(result.caption_id, "stable-caption");
    assert.equal(calls.some((call) => call.url.includes("uploadType=resumable")), false);
    assert.deepEqual(checkpoints, ["metadata_set", "thumbnail_set", "captions_updated", "complete"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a post-upload failure preserves the video id and resumes without a duplicate video upload", async () => {
  const dir = makePackage();
  let firstUploadCalls = 0;
  try {
    await assert.rejects(
      publishYouTubePackageSafely(plan(), dir, {
        env: { YOUTUBE_ACCESS_TOKEN: "token" },
        publishFingerprint: "fingerprint-b",
        fetch: async (url, options = {}) => {
          await consumeBody(options.body);
          if (url.includes("/videos?uploadType=resumable")) {
            firstUploadCalls += 1;
            return response({ headers: { location: "https://upload.example/session" } });
          }
          if (url === "https://upload.example/session") {
            return response({ status: 201, json: { id: "video456" } });
          }
          if (url.includes("/thumbnails/set")) return response({ status: 500, text: "temporary" });
          throw new Error(`unexpected URL: ${url}`);
        },
      }),
      (error) => {
        assert.equal(error.videoId, "video456");
        assert.equal(error.sessionUrl, "https://upload.example/session");
        assert.equal(error.publishStage, "thumbnail");
        return true;
      },
    );
    const partial = JSON.parse(readFileSync(join(dir, "publish-receipt.json"), "utf8"));
    assert.equal(partial.video_id, "video456");
    assert.equal(partial.video_upload_complete, true);

    let duplicateUploadCalls = 0;
    const resumed = await publishYouTubePackageSafely(plan(), dir, {
      env: { YOUTUBE_ACCESS_TOKEN: "token" },
      publishFingerprint: "fingerprint-b",
      fetch: async (url, options = {}) => {
        if (url.includes("/videos?uploadType=resumable") || url === "https://upload.example/session") {
          duplicateUploadCalls += 1;
          throw new Error("video upload must not repeat");
        }
        if (url.includes("/thumbnails/set")) return response({ json: { items: [] } });
        if (isCaptionList(url)) {
          return response({
            json: {
              items: [{ id: "existing-caption", snippet: { language: "en-NZ", name: "en-NZ" } }],
            },
          });
        }
        if (isCaptionWrite(url)) {
          assert.equal(options.method, "PUT");
          return response({ json: { id: "existing-caption" } });
        }
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    assert.equal(firstUploadCalls, 1);
    assert.equal(duplicateUploadCalls, 0);
    assert.equal(resumed.video_id, "video456");
    assert.equal(resumed.caption_id, "existing-caption");
    assert.equal(resumed.publish_complete, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crash after upload can recover the video id from the persisted resumable session", async () => {
  const dir = makePackage();
  const checkpoints = [];
  try {
    const result = await publishYouTubePackageSafely(plan(), dir, {
      env: { YOUTUBE_ACCESS_TOKEN: "token" },
      publishFingerprint: "fingerprint-session",
      resume: { sessionUrl: "https://upload.example/completed" },
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint.stage),
      fetch: async (url, options = {}) => {
        if (url === "https://upload.example/completed") {
          assert.equal(options.headers["Content-Range"], "bytes */5");
          return response({ json: { id: "recovered-video" } });
        }
        if (url.includes("/thumbnails/set")) return response({ json: {} });
        if (isCaptionList(url)) return response({ json: { items: [] } });
        if (isCaptionWrite(url)) return response({ json: { id: "recovered-caption" } });
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    assert.equal(result.video_id, "recovered-video");
    assert.ok(checkpoints.includes("video_recovered_from_session"));
    assert.equal(checkpoints.includes("video_uploaded"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a changed video fingerprint starts a new upload instead of reusing an older video", async () => {
  const dir = makePackage();
  try {
    writeFileSync(
      join(dir, "publish-receipt.json"),
      JSON.stringify({
        publish_fingerprint: "old",
        video_fingerprint: "old-video-bytes",
        metadata_fingerprint: "m",
        thumbnail_fingerprint: "t",
        caption_fingerprint: "c",
        video_id: "old-video",
        video_upload_complete: true,
        metadata_set: true,
        thumbnail_set: true,
        caption_id: "old-caption",
      }),
    );
    let sessionCreated = false;
    await publishYouTubePackageSafely(plan(), dir, {
      env: { YOUTUBE_ACCESS_TOKEN: "token" },
      publishFingerprint: "new",
      assetFingerprints: { video: "new-video-bytes", metadata: "m", thumbnail: "t", captions: "c" },
      fetch: async (url, options = {}) => {
        await consumeBody(options.body);
        if (url.includes("/videos?uploadType=resumable")) {
          sessionCreated = true;
          return response({ headers: { location: "https://upload.example/new-session" } });
        }
        if (url === "https://upload.example/new-session") {
          return response({ status: 201, json: { id: "new-video" } });
        }
        if (url.includes("/thumbnails/set")) return response({ json: {} });
        if (isCaptionList(url)) return response({ json: { items: [] } });
        if (isCaptionWrite(url)) return response({ json: { id: "new-caption" } });
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    assert.equal(sessionCreated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
