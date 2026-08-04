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
} from "./minimax-h3-provider.mjs";

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
  assert.throws(() => resolveMiniMaxH3Duration({ duration: 16 }, {}), /4 to 15/);
  assert.throws(() => resolveMiniMaxH3Ratio("x", { ratio: "adaptive" }, {}), /concrete ratio/);
});

test("frame mode and reference mode use official H3 content roles", () => {
  const frame = buildMiniMaxH3Request(
    "Animate the transition",
    {},
    {
      MINIMAX_H3_FIRST_FRAME: "https://example.com/first.png",
      MINIMAX_H3_LAST_FRAME: "https://example.com/last.png",
    },
  );
  assert.equal(frame.ratio, "adaptive");
  assert.deepEqual(
    frame.content.slice(1).map((item) => item.role),
    ["first_frame", "last_frame"],
  );

  const refs = buildMiniMaxH3Request(
    "Match the references",
    {},
    {
      MINIMAX_H3_REFERENCE_IMAGES_JSON: '["https://example.com/ref.png"]',
      MINIMAX_H3_REFERENCE_VIDEOS_JSON: '["https://example.com/ref.mp4"]',
      MINIMAX_H3_REFERENCE_AUDIOS_JSON: '["https://example.com/ref.wav"]',
    },
  );
  assert.deepEqual(
    refs.content.slice(1).map((item) => item.role),
    ["reference_image", "reference_video", "reference_audio"],
  );
});

test("invalid reference combinations fail before a paid task is created", () => {
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
});

test("provider writes the downloaded MP4 and records task provenance", async () => {
  let outputPath;
  try {
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
            bytes: Buffer.from("video-bytes"),
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
    assert.equal(result.metadata.provenance.native_audio, true);
    assert.equal(existsSync(outputPath), true);
    assert.equal(readFileSync(outputPath, "utf8"), "video-bytes");
  } finally {
    if (outputPath) rmSync(outputPath, { force: true });
  }
});

test("a post-creation failure is propagated so the cascade cannot duplicate the paid task", async () => {
  const error = new MiniMaxH3ApiError("polling failed", { taskId: "paid-task" });
  await assert.rejects(
    miniMaxH3Generate(
      "A launch film",
      { provider: "minimax" },
      {
        apiKey: "secret",
        runVideo: async () => {
          throw error;
        },
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      },
    ),
    (received) => received === error,
  );
});

test("missing credentials produce a clean forced-provider miss", async (t) => {
  const messages = [];
  t.mock.method(console, "error", (message) => messages.push(message));
  assert.equal(
    await miniMaxH3Generate("A launch film", { provider: "minimax" }, { env: {} }),
    null,
  );
  assert.ok(messages.some((message) => /MINIMAX_API_KEY/.test(message)));
});
