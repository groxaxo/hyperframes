import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MINIMAX_CN_API,
  MINIMAX_GLOBAL_API,
  MiniMaxH3ApiError,
  createMiniMaxH3Task,
  downloadMiniMaxH3Video,
  minimaxApiBaseUrl,
  minimaxApiKey,
  resumeMiniMaxH3Video,
  runMiniMaxH3Video,
  waitForMiniMaxH3Task,
} from "./minimax-h3-api.mjs";

function response({ status = 200, json = {}, text = "", headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) || null },
    json: async () => json,
    text: async () => text || JSON.stringify(json),
    arrayBuffer: async () => {
      const bytes = Buffer.from(text || "video");
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

test("credentials and region aliases resolve without putting keys in URLs", () => {
  assert.equal(minimaxApiKey({ MINIMAX_API_KEY: " secret " }), "secret");
  assert.equal(minimaxApiKey({}), null);
  assert.equal(minimaxApiBaseUrl({ MINIMAX_API_HOST: "global" }), MINIMAX_GLOBAL_API);
  assert.equal(minimaxApiBaseUrl({ MINIMAX_API_HOST: "cn" }), MINIMAX_CN_API);
  assert.equal(
    minimaxApiBaseUrl({ MINIMAX_API_BASE_URL: "https://proxy.example/minimax/" }),
    "https://proxy.example/minimax",
  );
  assert.throws(
    () => minimaxApiBaseUrl({ MINIMAX_API_HOST: "https://user:pass@example.com" }),
    /must not embed credentials/,
  );
});

test("task creation uses the V2 endpoint, Bearer auth, and never retries POST", async () => {
  const calls = [];
  const taskId = await createMiniMaxH3Task(
    { model: "MiniMax-H3", content: [{ type: "text", text: "hello" }] },
    {
      apiKey: "secret",
      fetch: async (url, options) => {
        calls.push({ url, options });
        return response({ json: { task_id: "task-1" } });
      },
    },
  );
  assert.equal(taskId, "task-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.minimax.io/v2/video_generation");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
  assert.equal(JSON.parse(calls[0].options.body).model, "MiniMax-H3");
});

test("official error payload preserves type, request id, and HTTP status", async () => {
  await assert.rejects(
    createMiniMaxH3Task(
      { model: "MiniMax-H3", content: [{ type: "text", text: "hello" }] },
      {
        apiKey: "secret",
        fetch: async () =>
          response({
            status: 429,
            json: {
              type: "error",
              error: {
                type: "rate_limit_error",
                message: "rate limit, please retry later (1002)",
                http_code: "429",
              },
              request_id: "request-123",
            },
          }),
      },
    ),
    (error) => {
      assert.ok(error instanceof MiniMaxH3ApiError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "rate_limit_error");
      assert.equal(error.requestId, "request-123");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("polling follows the same task until it succeeds", async () => {
  const statuses = ["queued", "running", "succeeded"];
  const sleeps = [];
  let now = 0;
  const task = await waitForMiniMaxH3Task("task-2", {
    apiKey: "secret",
    pollIntervalMs: 10,
    timeoutMs: 1_000,
    retries: 0,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    now: () => now,
    fetch: async (url) => {
      assert.match(url, /\/v2\/query\/video_generation\/task-2$/);
      const status = statuses.shift();
      return response({
        json: {
          task: {
            id: "task-2",
            status,
            ...(status === "succeeded"
              ? { content: { url: "https://cdn.example/video.mp4" } }
              : {}),
          },
        },
      });
    },
  });
  assert.equal(task.status, "succeeded");
  assert.deepEqual(sleeps, [10, 10]);
});

test("terminal task errors preserve the paid task id", async () => {
  await assert.rejects(
    waitForMiniMaxH3Task("paid-task", {
      apiKey: "secret",
      retries: 0,
      fetch: async () =>
        response({
          json: {
            task: {
              id: "paid-task",
              status: "failed",
              error: { type: "content_policy_error", message: "sensitive input" },
            },
          },
        }),
    }),
    (error) => {
      assert.ok(error instanceof MiniMaxH3ApiError);
      assert.equal(error.taskId, "paid-task");
      assert.match(error.message, /content_policy_error/);
      return true;
    },
  );
});

test("download retries the same HTTPS result URL without regenerating", async () => {
  let calls = 0;
  const bytes = await downloadMiniMaxH3Video("https://cdn.example/video.mp4", {
    taskId: "task-3",
    retries: 1,
    sleep: async () => {},
    fetch: async () => {
      calls += 1;
      if (calls === 1) return response({ status: 500, text: "temporary" });
      return response({ status: 200, text: "mp4-bytes" });
    },
  });
  assert.equal(calls, 2);
  assert.equal(bytes.toString(), "mp4-bytes");
  await assert.rejects(
    downloadMiniMaxH3Video("http://cdn.example/video.mp4", { taskId: "task-3" }),
    /must be an HTTPS URL/,
  );
});

test("resuming a known task polls and downloads without calling create", async () => {
  const calls = [];
  const result = await resumeMiniMaxH3Video("task-resume", {
    apiKey: "secret",
    pollIntervalMs: 0,
    retries: 0,
    sleep: async () => {},
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET" });
      if (url.includes("/v2/query/video_generation/task-resume")) {
        return response({
          json: {
            task: {
              id: "task-resume",
              status: "succeeded",
              content: { url: "https://cdn.example/task-resume.mp4" },
            },
          },
        });
      }
      return response({ text: "resumed-video" });
    },
  });
  assert.equal(result.taskId, "task-resume");
  assert.equal(result.resumed, true);
  assert.equal(result.bytes.toString(), "resumed-video");
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("end-to-end runner creates once, polls, and downloads", async () => {
  const calls = [];
  const result = await runMiniMaxH3Video(
    {
      model: "MiniMax-H3",
      content: [{ type: "text", text: "hello" }],
      resolution: "2K",
      duration: 5,
      ratio: "16:9",
    },
    {
      apiKey: "secret",
      pollIntervalMs: 0,
      retries: 0,
      sleep: async () => {},
      fetch: async (url, options = {}) => {
        calls.push({ url, method: options.method || "GET" });
        if (url.endsWith("/v2/video_generation")) {
          return response({ json: { task_id: "task-4" } });
        }
        if (url.includes("/v2/query/video_generation/task-4")) {
          return response({
            json: {
              task: {
                id: "task-4",
                status: "succeeded",
                duration: 5,
                content: { url: "https://cdn.example/task-4.mp4" },
              },
            },
          });
        }
        return response({ text: "final-video" });
      },
    },
  );
  assert.equal(result.taskId, "task-4");
  assert.equal(result.resumed, false);
  assert.equal(result.bytes.toString(), "final-video");
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});
