import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { MiniMaxH3ApiError } from "./minimax-h3-api.mjs";
import {
  buildMiniMaxH3Request,
  miniMaxH3AutoEnabled,
  miniMaxH3Generate,
  resolveMiniMaxH3Duration,
  resolveMiniMaxH3Ratio,
  resolveMiniMaxH3Resolution,
} from "./minimax-h3-provider.mjs";

function mp4Bytes(payload = "video") {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(24, 0);
  header.write("ftyp", 4, "ascii");
  header.write("isom", 8, "ascii");
  return Buffer.concat([header, Buffer.from(payload)]);
}

test("H3 remains opt-in unless explicitly forced or auto-enabled", () => {
  assert.equal(miniMaxH3AutoEnabled({}), false);
  assert.equal(miniMaxH3AutoEnabled({ MINIMAX_H3_AUTO: "true" }), true);
});

test("text-to-video defaults to 2K, five seconds, and orientation-aware ratios", () => {
  const landscape = buildMiniMaxH3Request("A cinematic reveal", {}, {});
  assert.equal(landscape.model, "MiniMax-H3");
  assert.equal(landscape.resolution, "2K");
  assert.equal(landscape.duration, 5);
  assert.equal(landscape.ratio, "16:9");
  assert.equal(buildMiniMaxH3Request("A vertical YouTube Short", {}, {}).ratio, "9:16");
  assert.equal(resolveMiniMaxH3Duration({ duration: 15 }, {}), 15);
  assert.equal(resolveMiniMaxH3Resolution({}, { MINIMAX_H3_RESOLUTION: "768P" }), "768P");
  assert.throws(() => resolveMiniMaxH3Duration({ duration: 16 }, {}), /4 to 15/);
  assert.throws(() => resolveMiniMaxH3Resolution({ resolution: "4K" }, {}), /768P, 2K/);
  assert.throws(() => resolveMiniMaxH3Ratio("x", { ratio: "adaptive" }, {}), /concrete ratio/);
});

test("first-frame, last-frame-only, and first-plus-last modes normalize ratio to adaptive", () => {
  const firstAndLast = buildMiniMaxH3Request(
    "Animate the transition",
    { ratio: "16:9" },
    {
      MINIMAX_H3_FIRST_FRAME: "https://example.com/first.png",
      MINIMAX_H3_LAST_FRAME: "https://example.com/last.png",
    },
  );
  assert.equal(firstAndLast.ratio, "adaptive");
  assert.deepEqual(
    firstAndLast.content.slice(1).map((item) => item.role),
    ["first_frame", "last_frame"],
  );

  const lastOnly = buildMiniMaxH3Request(
    "Arrive naturally at the ending frame",
    {},
    { MINIMAX_H3_LAST_FRAME: "https://example.com/last.png" },
  );
  assert.equal(lastOnly.ratio, "adaptive");
  assert.deepEqual(lastOnly.content.slice(1).map((item) => item.role), ["last_frame"]);
});

test("reference mode accepts arrays or JSON and uses official H3 roles", () => {
  const refs = buildMiniMaxH3Request(
    "Match the references",
    {
      ratio: "21:9",
      resolution: "768P",
      referenceImages: ["https://example.com/ref.png"],
      referenceVideos: ["https://example.com/ref.mp4"],
      referenceAudios: ["https://example.com/ref.wav"],
    },
    {},
  );
  assert.equal(refs.ratio, "21:9");
  assert.equal(refs.resolution, "768P");
  assert.deepEqual(
    refs.content.slice(1).map((item) => item.role),
    ["reference_image", "reference_video", "reference_audio"],
  );
});

test("invalid reference combinations and unsafe URLs fail before a paid task is created", () => {
  assert.throws(
    () =>
      buildMiniMaxH3Request("x", {}, {
        MINIMAX_H3_FIRST_FRAME: "https://example.com/first.png",
        MINIMAX_H3_REFERENCE_IMAGES_JSON: '["https://example.com/ref.png"]',
      }),
    /cannot be combined/,
  );
  assert.throws(
    () =>
      buildMiniMaxH3Request("x", {}, {
        MINIMAX_H3_REFERENCE_AUDIOS_JSON: '["https://example.com/ref.wav"]',
      }),
    /requires a reference image or reference video/,
  );
  assert.throws(
    () =>
      buildMiniMaxH3Request("x", {}, {
        MINIMAX_H3_FIRST_FRAME: "http://example.com/first.png",
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () =>
      buildMiniMaxH3Request("x", {}, {
        MINIMAX_H3_CALLBACK_URL: "https://user:pass@example.com/callback",
      }),
    /must not embed credentials/,
  );
});

test("provider writes a verified MP4 and records task provenance without assuming audio", async () => {
  let outputPath;
  try {
    const bytes = mp4Bytes("video-bytes");
    const result = await miniMaxH3Generate(
      "A vertical product reveal",
      { provider: "minimax", duration: 7 },
      {
        apiKey: "secret",
        runVideo: async (request) => {
          assert.equal(request.ratio, "9:16");
          assert.equal(request.duration, 7);
          return {
            taskId: "task-output",
            bytes,
            task: {
              duration: 7,
              resolution: "2K",
              ratio: "9:16",
              usage: { output_seconds: 7 },
              task_type: "text_to_video",
            },
          };
        },
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      },
    );
    outputPath = result.localPath;
    assert.equal(result.metadata.provider, "minimax.h3");
    assert.equal(result.metadata.provenance.task_id, "task-output");
    assert.equal(result.metadata.provenance.resumed, false);
    assert.equal(result.metadata.provenance.native_audio, "probe");
    assert.equal(existsSync(outputPath), true);
    assert.deepEqual(readFileSync(outputPath), bytes);
  } finally {
    if (outputPath) rmSync(outputPath, { force: true });
  }
});

test("an existing H3 task resumes without creating another paid task", async () => {
  let outputPath;
  let createCalled = false;
  let resumedTaskId = null;
  try {
    const result = await miniMaxH3Generate(
      "Resume the existing launch film",
      { provider: "minimax" },
      {
        env: {
          MINIMAX_API_KEY: "secret",
          MINIMAX_H3_RESUME_TASK_ID: "task-resume",
        },
        runVideo: async () => {
          createCalled = true;
          throw new Error("must not create");
        },
        resumeVideo: async (taskId) => {
          resumedTaskId = taskId;
          return {
            taskId,
            resumed: true,
            task: { duration: 5, resolution: "2K", ratio: "16:9" },
            bytes: mp4Bytes("resumed"),
          };
        },
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      },
    );
    outputPath = result.localPath;
    assert.equal(createCalled, false);
    assert.equal(resumedTaskId, "task-resume");
    assert.equal(result.metadata.provenance.task_id, "task-resume");
    assert.equal(result.metadata.provenance.resumed, true);
  } finally {
    if (outputPath) rmSync(outputPath, { force: true });
  }
});

test("invalid downloaded media preserves the paid task id", async () => {
  await assert.rejects(
    miniMaxH3Generate(
      "A launch film",
      { provider: "minimax" },
      {
        apiKey: "secret",
        runVideo: async () => ({
          taskId: "paid-task",
          task: { duration: 5 },
          bytes: Buffer.from("an HTML error page"),
        }),
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      },
    ),
    (error) => {
      assert.ok(error instanceof MiniMaxH3ApiError);
      assert.equal(error.taskId, "paid-task");
      assert.equal(error.code, "invalid_video_container");
      assert.match(error.message, /task_id: paid-task/);
      return true;
    },
  );
});

test("all failures from explicitly selected H3 are propagated to prevent ambiguous duplicate spend", async () => {
  const preTaskError = new MiniMaxH3ApiError("creation timed out", {
    code: "timeout",
    retryable: true,
  });
  await assert.rejects(
    miniMaxH3Generate(
      "A launch film",
      { provider: "minimax" },
      {
        apiKey: "secret",
        runVideo: async () => {
          throw preTaskError;
        },
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      },
    ),
    (received) => received === preTaskError,
  );
});

test("missing credentials produce a clean forced-provider miss before any task exists", async (t) => {
  const messages = [];
  t.mock.method(console, "error", (message) => messages.push(message));
  assert.equal(
    await miniMaxH3Generate("A launch film", { provider: "minimax" }, { env: {} }),
    null,
  );
  assert.ok(messages.some((message) => /MINIMAX_API_KEY/.test(message)));
});
