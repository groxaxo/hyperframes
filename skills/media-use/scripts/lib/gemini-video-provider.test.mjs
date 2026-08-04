import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { GEMINI_OMNI_VIDEO_MODEL } from "./gemini-api.mjs";
import {
  geminiVideoGenerate,
  resolveGeminiVideoAspectRatio,
} from "./gemini-video-provider.mjs";

test("resolveGeminiVideoAspectRatio honors explicit config and infers vertical social prompts", () => {
  assert.equal(resolveGeminiVideoAspectRatio("A landscape product shot", {}, {}), "16:9");
  assert.equal(resolveGeminiVideoAspectRatio("A vertical Instagram Reel", {}, {}), "9:16");
  assert.equal(
    resolveGeminiVideoAspectRatio("anything", {}, { GEMINI_VIDEO_ASPECT_RATIO: "9:16" }),
    "9:16",
  );
  assert.throws(
    () =>
      resolveGeminiVideoAspectRatio("anything", {}, { GEMINI_VIDEO_ASPECT_RATIO: "1:1" }),
    /expected 16:9 or 9:16/,
  );
});

test("geminiVideoGenerate writes Omni's MP4 and returns resolver metadata", async () => {
  const video = Buffer.from("tiny omni mp4 fixture");
  let request;
  let outputPath;
  try {
    const result = await geminiVideoGenerate(
      "A vertical cinematic product reveal for Instagram Reels",
      { provider: "gemini" },
      {
        apiKey: "test-key",
        createInteraction: async (body, options) => {
          request = { body, options };
          return {
            output_video: {
              data: video.toString("base64"),
              mime_type: "video/mp4",
            },
          };
        },
      },
    );
    outputPath = result?.localPath;

    assert.ok(result);
    assert.equal(request.body.model, GEMINI_OMNI_VIDEO_MODEL);
    assert.deepEqual(request.body.response_format, {
      type: "video",
      aspect_ratio: "9:16",
    });
    assert.equal(request.body.background, false);
    assert.equal(request.body.store, false);
    assert.equal(request.body.stream, false);
    assert.equal(request.options.apiKey, "test-key");
    assert.equal(result.ext, ".mp4");
    assert.equal(result.metadata.provider, "gemini.omni");
    assert.equal(result.metadata.provenance.native_audio, true);
    assert.equal(result.metadata.provenance.aspect_ratio, "9:16");
    assert.equal(existsSync(result.localPath), true);
    assert.deepEqual(readFileSync(result.localPath), video);
  } finally {
    if (outputPath) rmSync(outputPath, { force: true });
  }
});

test("geminiVideoGenerate falls through when no key exists and explains forced use", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(message));
  const result = await geminiVideoGenerate("A launch clip", { provider: "gemini" }, { env: {} });
  assert.equal(result, null);
  assert.ok(errors.some((line) => /GEMINI_API_KEY/.test(line)));
});

test("geminiVideoGenerate returns null rather than registering an empty response", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(message));
  const result = await geminiVideoGenerate(
    "A launch clip",
    { provider: "gemini" },
    {
      apiKey: "test-key",
      createInteraction: async () => ({ id: "empty" }),
    },
  );
  assert.equal(result, null);
  assert.ok(errors.some((line) => /no video output/.test(line)));
});
