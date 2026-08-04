export const MINIMAX_H3_MODEL = "MiniMax-H3";
export const MINIMAX_GLOBAL_API = "https://api.minimax.io";
export const MINIMAX_CN_API = "https://api.minimaxi.com";
export const MINIMAX_H3_DEFAULT_TIMEOUT_MS = 1_800_000;
export const MINIMAX_H3_MIN_POLL_MS = 10_000;

export class MiniMaxH3ApiError extends Error {
  constructor(
    message,
    { status = null, code = null, retryable = false, taskId = null } = {},
  ) {
    super(message);
    this.name = "MiniMaxH3ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.taskId = taskId;
  }
}

export function minimaxApiKey(env = process.env) {
  const value = env?.MINIMAX_API_KEY;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function minimaxApiBaseUrl(env = process.env) {
  const configured = env?.MINIMAX_API_HOST || env?.MINIMAX_API_BASE_URL || "global";
  const value = String(configured).trim();
  if (!value || value.toLowerCase() === "global") return MINIMAX_GLOBAL_API;
  if (value.toLowerCase() === "cn" || value.toLowerCase() === "china") return MINIMAX_CN_API;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MiniMaxH3ApiError(`invalid MiniMax API host: ${value}`, {
      code: "invalid_api_host",
    });
  }
  if (url.protocol !== "https:") {
    throw new MiniMaxH3ApiError("MiniMax API host must use HTTPS", {
      code: "invalid_api_host",
    });
  }
  if (url.username || url.password) {
    throw new MiniMaxH3ApiError("MiniMax API host must not embed credentials", {
      code: "invalid_api_host",
    });
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function miniMaxH3CreateUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/$/, "")}/v2/video_generation`;
}

export function miniMaxH3TaskUrl(baseUrl, taskId) {
  return `${String(baseUrl).replace(/\/$/, "")}/v2/query/video_generation/${encodeURIComponent(taskId)}`;
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryDelayMs(response, attempt) {
  const raw = response?.headers?.get?.("retry-after");
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  return Math.min(1_000 * 2 ** attempt, 10_000);
}

function apiDetail(raw) {
  if (!raw) return { message: "", code: null };
  try {
    const parsed = JSON.parse(raw);
    const base = parsed?.base_resp;
    return {
      message: String(
        parsed?.error?.message ||
          parsed?.message ||
          base?.status_msg ||
          raw,
      ).trim(),
      code: parsed?.error?.code || base?.status_code || null,
    };
  } catch {
    return { message: String(raw).trim().slice(0, 500), code: null };
  }
}

async function defaultSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(
  url,
  {
    method = "GET",
    body,
    apiKey,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 120_000,
    retries = 0,
    sleep = defaultSleep,
    taskId = null,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new MiniMaxH3ApiError("MiniMax API transport unavailable: global fetch is missing", {
      code: "fetch_unavailable",
      taskId,
    });
  }
  const attempts = Math.max(1, Number(retries) + 1);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        const detail = apiDetail(raw);
        const error = new MiniMaxH3ApiError(
          `MiniMax H3 request failed: HTTP ${response.status}${detail.message ? ` — ${detail.message}` : ""}`,
          {
            status: response.status,
            code: detail.code || "http_error",
            retryable: retryableStatus(response.status),
            taskId,
          },
        );
        lastError = error;
        if (error.retryable && attempt + 1 < attempts) {
          await sleep(retryDelayMs(response, attempt));
          continue;
        }
        throw error;
      }

      let data;
      try {
        data = await response.json();
      } catch (error) {
        throw new MiniMaxH3ApiError(
          `MiniMax H3 returned invalid JSON: ${error?.message || error}`,
          { code: "invalid_json", taskId },
        );
      }
      if (data?.base_resp?.status_code && data.base_resp.status_code !== 0) {
        throw new MiniMaxH3ApiError(
          `MiniMax H3 API error ${data.base_resp.status_code}: ${data.base_resp.status_msg || "unknown error"}`,
          {
            status: 200,
            code: data.base_resp.status_code,
            retryable: [1000, 1001, 1024, 1033].includes(Number(data.base_resp.status_code)),
            taskId,
          },
        );
      }
      return data;
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      const normalized =
        error instanceof MiniMaxH3ApiError
          ? error
          : new MiniMaxH3ApiError(
              timedOut
                ? `MiniMax H3 request timed out after ${timeoutMs}ms`
                : `MiniMax H3 request failed: ${error?.message || error}`,
              {
                code: timedOut ? "timeout" : "network_error",
                retryable: true,
                taskId,
              },
            );
      lastError = normalized;
      if (normalized.retryable && attempt + 1 < attempts) {
        await sleep(Math.min(1_000 * 2 ** attempt, 10_000));
        continue;
      }
      throw normalized;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function createMiniMaxH3Task(
  request,
  {
    apiKey,
    env = process.env,
    baseUrl = minimaxApiBaseUrl(env),
    fetch,
    timeoutMs = 120_000,
  } = {},
) {
  const key = apiKey || minimaxApiKey(env);
  if (!key) {
    throw new MiniMaxH3ApiError("MiniMax API key missing — set $MINIMAX_API_KEY", {
      code: "missing_api_key",
    });
  }
  const payload = await requestJson(miniMaxH3CreateUrl(baseUrl), {
    method: "POST",
    body: request,
    apiKey: key,
    fetch,
    timeoutMs,
    retries: 0,
  });
  const taskId = payload?.task_id;
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw new MiniMaxH3ApiError("MiniMax H3 creation returned no task_id", {
      code: "missing_task_id",
    });
  }
  return taskId.trim();
}

export async function queryMiniMaxH3Task(
  taskId,
  {
    apiKey,
    env = process.env,
    baseUrl = minimaxApiBaseUrl(env),
    fetch,
    timeoutMs = 120_000,
    retries = 3,
    sleep = defaultSleep,
  } = {},
) {
  const key = apiKey || minimaxApiKey(env);
  if (!key) {
    throw new MiniMaxH3ApiError("MiniMax API key missing — set $MINIMAX_API_KEY", {
      code: "missing_api_key",
      taskId,
    });
  }
  const payload = await requestJson(miniMaxH3TaskUrl(baseUrl, taskId), {
    apiKey: key,
    fetch,
    timeoutMs,
    retries,
    sleep,
    taskId,
  });
  const task = payload?.task;
  if (!task || typeof task !== "object") {
    throw new MiniMaxH3ApiError("MiniMax H3 task query returned no task object", {
      code: "missing_task",
      taskId,
    });
  }
  return task;
}

export function miniMaxH3FailureReason(task) {
  const code = task?.error?.code ? String(task.error.code).trim() : "";
  const message = task?.error?.message ? String(task.error.message).trim() : "";
  if (code && message) return `${code}: ${message}`;
  return message || code || "unknown task failure";
}

export async function waitForMiniMaxH3Task(
  taskId,
  {
    apiKey,
    env = process.env,
    baseUrl = minimaxApiBaseUrl(env),
    fetch,
    pollIntervalMs = MINIMAX_H3_MIN_POLL_MS,
    timeoutMs = MINIMAX_H3_DEFAULT_TIMEOUT_MS,
    requestTimeoutMs = 120_000,
    retries = 3,
    sleep = defaultSleep,
    now = Date.now,
  } = {},
) {
  const interval = Math.max(0, Number(pollIntervalMs) || 0);
  const started = now();
  while (true) {
    const task = await queryMiniMaxH3Task(taskId, {
      apiKey,
      env,
      baseUrl,
      fetch,
      timeoutMs: requestTimeoutMs,
      retries,
      sleep,
    });
    const status = String(task.status || "").toLowerCase();
    if (status === "succeeded") {
      if (!task?.content?.url) {
        throw new MiniMaxH3ApiError("MiniMax H3 task succeeded without content.url", {
          code: "missing_result_url",
          taskId,
        });
      }
      return task;
    }
    if (["failed", "cancelled", "expired"].includes(status)) {
      throw new MiniMaxH3ApiError(
        `MiniMax H3 task ${status}: ${miniMaxH3FailureReason(task)}`,
        { code: status, taskId },
      );
    }
    if (!["queued", "running"].includes(status)) {
      throw new MiniMaxH3ApiError(`MiniMax H3 returned unknown task status: ${status || "empty"}`, {
        code: "unknown_status",
        taskId,
      });
    }
    const elapsed = now() - started;
    if (elapsed >= timeoutMs) {
      throw new MiniMaxH3ApiError(
        `MiniMax H3 task ${taskId} did not finish within ${timeoutMs}ms; it may still complete remotely`,
        { code: "poll_timeout", retryable: true, taskId },
      );
    }
    await sleep(Math.min(interval, Math.max(0, timeoutMs - elapsed)));
  }
}

export async function downloadMiniMaxH3Video(
  url,
  {
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 180_000,
    retries = 3,
    sleep = defaultSleep,
    taskId = null,
  } = {},
) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new MiniMaxH3ApiError("MiniMax H3 returned an invalid result URL", {
      code: "invalid_result_url",
      taskId,
    });
  }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new MiniMaxH3ApiError("MiniMax H3 result URL must be an HTTP(S) URL without credentials", {
      code: "invalid_result_url",
      taskId,
    });
  }
  if (typeof fetchImpl !== "function") {
    throw new MiniMaxH3ApiError("MiniMax H3 download transport unavailable", {
      code: "fetch_unavailable",
      taskId,
    });
  }
  const attempts = Math.max(1, Number(retries) + 1);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(parsed.toString(), { signal: controller.signal });
      if (!response.ok) {
        const error = new MiniMaxH3ApiError(
          `MiniMax H3 video download failed: HTTP ${response.status}`,
          {
            status: response.status,
            code: "download_http_error",
            retryable: retryableStatus(response.status),
            taskId,
          },
        );
        lastError = error;
        if (error.retryable && attempt + 1 < attempts) {
          await sleep(retryDelayMs(response, attempt));
          continue;
        }
        throw error;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) {
        throw new MiniMaxH3ApiError("MiniMax H3 video download returned no bytes", {
          code: "empty_download",
          taskId,
        });
      }
      return bytes;
    } catch (error) {
      const normalized =
        error instanceof MiniMaxH3ApiError
          ? error
          : new MiniMaxH3ApiError(
              error?.name === "AbortError"
                ? `MiniMax H3 video download timed out after ${timeoutMs}ms`
                : `MiniMax H3 video download failed: ${error?.message || error}`,
              { code: "download_network_error", retryable: true, taskId },
            );
      lastError = normalized;
      if (normalized.retryable && attempt + 1 < attempts) {
        await sleep(Math.min(1_000 * 2 ** attempt, 10_000));
        continue;
      }
      throw normalized;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function runMiniMaxH3Video(request, options = {}) {
  const taskId = await createMiniMaxH3Task(request, options);
  try {
    const task = await waitForMiniMaxH3Task(taskId, options);
    const bytes = await downloadMiniMaxH3Video(task.content.url, {
      ...options,
      taskId,
    });
    return { taskId, task, bytes };
  } catch (error) {
    if (error instanceof MiniMaxH3ApiError && !error.taskId) error.taskId = taskId;
    throw error;
  }
}
