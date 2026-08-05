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

function makePackage() {
  const dir = mkdtempSync(join(tmpdir(), "youtube-safe-publish-"));
  for (const [name, data] of [
    ["video.mp4", "video"],
    ["thumbnail.jpg", "thumb"],
    ["captions.srt", "captions"],
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
        if (url.includes("/youtube/v3/captions?")) return response({ json: { items: [] } });
        if (url.includes("/upload/youtube/v3/captions?")) {
          return response({ json: { id: "caption123" } });
        }
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    assert.equal(result.video_id, "video123");
    assert.equal(result.caption_id, "caption123");
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
      fetch: async (url) => {
        if (url.includes("/videos?uploadType=resumable") || url === "https://upload.example/session") {
          duplicateUploadCalls += 1;
          throw new Error("video upload must not repeat");
        }
        if (url.includes("/thumbnails/set")) return response({ json: { items: [] } });
        if (url.includes("/youtube/v3/captions?")) {
          return response({
            json: {
              items: [{ id: "existing-caption", snippet: { language: "en-NZ", name: "en-NZ" } }],
            },
          });
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

test("a changed publish fingerprint never reuses an older video's checkpoint", async () => {
  const dir = makePackage();
  try {
    writeFileSync(
      join(dir, "publish-receipt.json"),
      JSON.stringify({
        publish_fingerprint: "old",
        video_id: "old-video",
        video_upload_complete: true,
        thumbnail_set: true,
        caption_id: "old-caption",
      }),
    );
    let sessionCreated = false;
    await publishYouTubePackageSafely(plan(), dir, {
      env: { YOUTUBE_ACCESS_TOKEN: "token" },
      publishFingerprint: "new",
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
        if (url.includes("/youtube/v3/captions?")) return response({ json: { items: [] } });
        if (url.includes("/upload/youtube/v3/captions?")) return response({ json: { id: "new-caption" } });
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    assert.equal(sessionCreated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
