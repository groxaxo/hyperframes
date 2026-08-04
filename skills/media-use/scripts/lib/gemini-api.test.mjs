import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  GEMINI_INTERACTIONS_ENDPOINT,
  createGeminiInteraction,
  decodeGeminiMedia,
  geminiFileId,
  findGeminiMedia,
  geminiApiKey,
  isWavBuffer,
  readGeminiMedia,
  pcm16leToWav,
} from "./gemini-api.mjs";

test("geminiApiKey prefers GEMINI_API_KEY and supports GOOGLE_API_KEY", () => {
  assert.equal(
    geminiApiKey({ GEMINI_API_KEY: " gemini-key ", GOOGLE_API_KEY: "google-key" }),
    "gemini-key",
  );
  assert.equal(geminiApiKey({ GOOGLE_API_KEY: " google-key " }), "google-key");
  assert.equal(geminiApiKey({ GEMINI_API_KEY: "   " }), null);
});

test("findGeminiMedia supports convenience outputs and model-output steps", () => {
  const direct = { data: Buffer.from("video").toString("base64"), mime_type: "video/mp4" };
  assert.equal(findGeminiMedia({ output_video: direct }, "video"), direct);

  const nested = { type: "audio", data: Buffer.from("pcm").toString("base64") };
  assert.equal(
    findGeminiMedia(
      {
        steps: [
          { type: "user_input", content: [{ type: "text", text: "hello" }] },
          { type: "model_output", content: [{ type: "text", text: "x" }, nested] },
        ],
      },
      "audio",
    ),
    nested,
  );
});

test("decodeGeminiMedia rejects missing data and decodes base64 bytes", () => {
  const bytes = decodeGeminiMedia({ data: Buffer.from("mp4").toString("base64") }, "video");
  assert.equal(bytes.toString(), "mp4");
  assert.throws(() => decodeGeminiMedia({ uri: "files/123" }, "video"), /no inline video data/);
  assert.throws(() => decodeGeminiMedia({ data: "%" }, "audio"), /invalid base64 audio/);
});

test("geminiFileId accepts canonical file URIs and rejects malformed IDs", () => {
  assert.equal(geminiFileId("files/video-123"), "video-123");
  assert.equal(
    geminiFileId(
      "https://generativelanguage.googleapis.com/v1beta/files/video_123:download?alt=media",
    ),
    "video_123",
  );
  assert.throws(() => geminiFileId("https://example.com/not-a-file"), /invalid file URI/);
});

test("readGeminiMedia polls URI delivery until ACTIVE and downloads the video", async () => {
  const calls = [];
  const sleeps = [];
  const video = Buffer.from("uri-delivered-video");
  const responses = [
    { ok: true, json: async () => ({ state: "PROCESSING" }) },
    { ok: true, json: async () => ({ state: "ACTIVE" }) },
    {
      ok: true,
      arrayBuffer: async () =>
        video.buffer.slice(video.byteOffset, video.byteOffset + video.byteLength),
    },
  ];
  const bytes = await readGeminiMedia(
    {
      uri: "https://generativelanguage.googleapis.com/v1beta/files/video-123:download?alt=media",
    },
    "video",
    {
      apiKey: "secret",
      retries: 0,
      pollIntervalMs: 1,
      sleep: async (ms) => sleeps.push(ms),
      fetch: async (url, options) => {
        calls.push({ url, options });
        return responses.shift();
      },
    },
  );

  assert.deepEqual(bytes, video);
  assert.equal(calls.length, 3);
  assert.equal(
    calls[0].url,
    "https://generativelanguage.googleapis.com/v1beta/files/video-123",
  );
  assert.equal(calls[0].options.headers["x-goog-api-key"], "secret");
  assert.equal(
    calls[2].url,
    "https://generativelanguage.googleapis.com/v1beta/files/video-123:download?alt=media",
  );
  assert.deepEqual(sleeps, [1]);
});

test("pcm16leToWav writes a valid 24 kHz mono PCM WAV header", () => {
  const pcm = Buffer.from([0, 0, 1, 0, 255, 255, 0, 0]);
  const wav = pcm16leToWav(pcm);
  assert.equal(isWavBuffer(wav), true);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("createGeminiInteraction sends the key in a header and retries transient failures", async () => {
  const calls = [];
  const sleeps = [];
  const responses = [
    {
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: { message: "temporary overload" } }),
    },
    {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ id: "interaction-1", output_video: { data: "eA==" } }),
    },
  ];
  const body = { model: "m", input: "prompt" };
  const result = await createGeminiInteraction(body, {
    apiKey: "secret",
    retries: 1,
    sleep: async (ms) => sleeps.push(ms),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
  });

  assert.equal(result.id, "interaction-1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, GEMINI_INTERACTIONS_ENDPOINT);
  assert.equal(calls[0].options.headers["x-goog-api-key"], "secret");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), body);
  assert.equal(sleeps.length, 1);
});

test("createGeminiInteraction fails clearly without a key", async () => {
  await assert.rejects(
    createGeminiInteraction({ model: "m", input: "x" }, { env: {}, retries: 0 }),
    /Gemini API key missing/,
  );
});
