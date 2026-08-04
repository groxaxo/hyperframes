import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ComfyUiApiError,
  comfyUiHeaders,
  downloadComfyOutput,
  executeComfyWorkflow,
  findComfyVideoOutput,
  normalizeComfyUiUrl,
  queueComfyPrompt,
  waitForComfyPrompt,
} from "./comfyui-api.mjs";

function jsonResponse(value, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value),
    headers: { get: () => null },
  };
}

test("normalizeComfyUiUrl accepts HTTP(S), preserves a path prefix, and strips query data", () => {
  assert.equal(normalizeComfyUiUrl("http://127.0.0.1:8188/"), "http://127.0.0.1:8188");
  assert.equal(
    normalizeComfyUiUrl("https://render.example.test/comfy/?token=secret#x"),
    "https://render.example.test/comfy",
  );
  assert.throws(() => normalizeComfyUiUrl("file:///tmp/comfy"), /expected http or https/);
});

test("comfyUiHeaders supports bearer auth and explicit reverse-proxy headers", () => {
  const headers = comfyUiHeaders({
    COMFYUI_API_KEY: "secret",
    COMFYUI_HEADERS_JSON: JSON.stringify({ "CF-Access-Client-Id": "client" }),
  });
  assert.equal(headers.Authorization, "Bearer secret");
  assert.equal(headers["CF-Access-Client-Id"], "client");
  assert.equal(headers["Comfy-Usage-Source"], "hyperframes-media-use");
  assert.throws(
    () => comfyUiHeaders({ COMFYUI_HEADERS_JSON: JSON.stringify({ bad: 12 }) }),
    /must be a string/,
  );
});

test("queueComfyPrompt posts API-format JSON without putting credentials in the URL", async () => {
  const calls = [];
  const prompt = { "1": { class_type: "SaveVideo", inputs: {} } };
  const result = await queueComfyPrompt(prompt, {
    baseUrl: "https://render.example.test/comfy",
    env: { COMFYUI_API_KEY: "secret" },
    clientId: "client-123",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ prompt_id: "prompt-123", number: 7, node_errors: {} });
    },
  });

  assert.equal(result.promptId, "prompt-123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://render.example.test/comfy/prompt");
  assert.equal(calls[0].url.includes("secret"), false);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    prompt,
    client_id: "client-123",
  });
});

test("queueComfyPrompt surfaces ComfyUI node validation errors", async () => {
  await assert.rejects(
    queueComfyPrompt(
      { "1": { class_type: "MissingNode", inputs: {} } },
      {
        fetch: async () =>
          jsonResponse(
            {
              error: { message: "Prompt outputs failed validation" },
              node_errors: { "1": { errors: [{ message: "MissingNode not found" }] } },
            },
            { ok: false, status: 400 },
          ),
      },
    ),
    (error) => {
      assert.ok(error instanceof ComfyUiApiError);
      assert.match(error.message, /Prompt outputs failed validation/);
      assert.match(error.message, /node_errors/);
      return true;
    },
  );
});

test("waitForComfyPrompt polls until the prompt completes successfully", async () => {
  const calls = [];
  const responses = [
    jsonResponse({}),
    jsonResponse({
      "prompt-1": {
        status: { completed: true, status_str: "success", messages: [] },
        outputs: { "9": { videos: [{ filename: "final.mp4", type: "output" }] } },
      },
    }),
  ];
  let now = 0;
  const result = await waitForComfyPrompt("prompt-1", {
    fetch: async (url) => {
      calls.push(url);
      return responses.shift();
    },
    pollIntervalMs: 10,
    timeoutMs: 100,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  assert.equal(result.status.status_str, "success");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.endsWith("/history/prompt-1")));
});

test("waitForComfyPrompt interrupts the exact prompt when the deadline expires", async () => {
  const calls = [];
  let now = 0;
  await assert.rejects(
    waitForComfyPrompt("prompt-timeout", {
      fetch: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/interrupt")) return { ok: true, status: 200 };
        now = 100;
        return jsonResponse({});
      },
      timeoutMs: 50,
      pollIntervalMs: 1,
      now: () => now,
      sleep: async () => {},
    }),
    /did not finish after 50ms/,
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith("/interrupt"));
  assert.deepEqual(JSON.parse(calls[1].options.body), { prompt_id: "prompt-timeout" });
});

test("findComfyVideoOutput prefers an MP4 even when ComfyUI reports it under gifs", () => {
  const selected = findComfyVideoOutput({
    outputs: {
      "1": { images: [{ filename: "preview.gif", type: "temp" }] },
      "2": {
        gifs: [
          {
            filename: "ltx/final_00001-audio.mp4",
            subfolder: "",
            type: "output",
          },
        ],
      },
    },
  });
  assert.equal(selected.filename, "ltx/final_00001-audio.mp4");
  assert.equal(selected.extension, ".mp4");
  assert.match(selected.path, /2\.gifs\.0/);
});

test("downloadComfyOutput writes the returned bytes and encodes output fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comfy-output-"));
  const outputPath = join(dir, "video.mp4");
  const bytes = Buffer.from("mock mp4 bytes");
  const calls = [];
  try {
    await downloadComfyOutput(
      { filename: "final 1.mp4", subfolder: "ltx clips", type: "output" },
      outputPath,
      {
        baseUrl: "http://127.0.0.1:8188",
        fetch: async (url) => {
          calls.push(url);
          return {
            ok: true,
            status: 200,
            body: null,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          };
        },
      },
    );
    assert.deepEqual(readFileSync(outputPath), bytes);
    assert.match(calls[0], /filename=final\+1\.mp4/);
    assert.match(calls[0], /subfolder=ltx\+clips/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadComfyOutput rejects and removes an empty streamed response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comfy-empty-stream-"));
  const outputPath = join(dir, "empty.mp4");
  try {
    await assert.rejects(
      downloadComfyOutput(
        { filename: "empty.mp4", type: "output" },
        outputPath,
        {
          fetch: async () => ({
            ok: true,
            status: 200,
            body: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
          }),
        },
      ),
      /empty file/,
    );
    assert.equal(existsSync(outputPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeComfyWorkflow queues, polls, selects, and downloads one final video", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comfy-execute-"));
  const bytes = Buffer.from("complete mp4");
  const outputPath = join(dir, "complete.mp4");
  const calls = [];
  try {
    const result = await executeComfyWorkflow(
      { "1": { class_type: "SaveVideo", inputs: { filename_prefix: "x" } } },
      {
        clientId: "client",
        outputPath,
        pollIntervalMs: 0,
        fetch: async (url) => {
          calls.push(url);
          if (url.endsWith("/prompt")) return jsonResponse({ prompt_id: "job-1" });
          if (url.endsWith("/history/job-1")) {
            return jsonResponse({
              "job-1": {
                status: { completed: true, status_str: "success" },
                outputs: { "1": { videos: [{ filename: "complete.mp4" }] } },
              },
            });
          }
          return {
            ok: true,
            status: 200,
            body: null,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          };
        },
      },
    );
    assert.equal(result.promptId, "job-1");
    assert.equal(result.file.filename, "complete.mp4");
    assert.deepEqual(readFileSync(outputPath), bytes);
    assert.equal(calls.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
