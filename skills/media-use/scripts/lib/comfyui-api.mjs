import { createWriteStream, writeFileSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { extname, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

export const DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188";
export const DEFAULT_COMFYUI_POLL_MS = 2_000;
export const DEFAULT_COMFYUI_TIMEOUT_MS = 1_800_000;

const VIDEO_EXTENSIONS = new Map([
  [".mp4", 100],
  [".webm", 90],
  [".mov", 80],
  [".mkv", 70],
  [".gif", 40],
]);

export class ComfyUiApiError extends Error {
  constructor(message, { status = null, code = null, retryable = false, detail = null } = {}) {
    super(message);
    this.name = "ComfyUiApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

export function normalizeComfyUiUrl(value = DEFAULT_COMFYUI_URL) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_COMFYUI_URL).trim());
  } catch {
    throw new ComfyUiApiError(`invalid ComfyUI URL: ${value}`, { code: "invalid_url" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ComfyUiApiError(
      `unsupported ComfyUI URL protocol "${url.protocol}" (expected http or https)`,
      { code: "invalid_url" },
    );
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function parseHeaderJson(raw) {
  if (!raw || !String(raw).trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ComfyUiApiError(`COMFYUI_HEADERS_JSON is invalid JSON: ${error.message}`, {
      code: "invalid_headers",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ComfyUiApiError("COMFYUI_HEADERS_JSON must be a JSON object", {
      code: "invalid_headers",
    });
  }
  const headers = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new ComfyUiApiError(`COMFYUI_HEADERS_JSON value for "${name}" must be a string`, {
        code: "invalid_headers",
      });
    }
    headers[name] = value;
  }
  return headers;
}

export function comfyUiHeaders(env = process.env, extra = {}) {
  const headers = {
    "Comfy-Usage-Source": "hyperframes-media-use",
    ...parseHeaderJson(env.COMFYUI_HEADERS_JSON),
  };
  const key = env.COMFYUI_API_KEY;
  if (typeof key === "string" && key.trim()) {
    const name = String(env.COMFYUI_API_KEY_HEADER || "Authorization").trim();
    if (!name) {
      throw new ComfyUiApiError("COMFYUI_API_KEY_HEADER must not be empty", {
        code: "invalid_headers",
      });
    }
    headers[name] =
      name.toLowerCase() === "authorization" && !/^\S+\s/.test(key.trim())
        ? `Bearer ${key.trim()}`
        : key.trim();
  }
  return { ...headers, ...extra };
}

function endpoint(baseUrl, path) {
  return `${normalizeComfyUiUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryDelay(attempt) {
  return Math.min(500 * 2 ** attempt, 4_000);
}

async function defaultSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function apiDetail(raw) {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    const error = parsed?.error;
    const primary =
      (typeof error === "string" && error) ||
      error?.message ||
      error?.details ||
      parsed?.message ||
      parsed?.detail;
    const nodeErrors = parsed?.node_errors;
    const nodeSummary =
      nodeErrors && typeof nodeErrors === "object" && Object.keys(nodeErrors).length
        ? ` node_errors=${JSON.stringify(nodeErrors).slice(0, 800)}`
        : "";
    if (primary) return `${String(primary).trim()}${nodeSummary}`;
    if (nodeSummary) return nodeSummary.trim();
  } catch {
    // Reverse proxies and transport failures may return plain text or HTML.
  }
  return String(raw).trim().replace(/\s+/g, " ").slice(0, 1_000);
}

async function request(
  path,
  {
    baseUrl = DEFAULT_COMFYUI_URL,
    env = process.env,
    method = "GET",
    body,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 120_000,
    retries = method === "GET" ? 2 : 0,
    sleep = defaultSleep,
    headers = {},
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new ComfyUiApiError("ComfyUI transport unavailable: global fetch is missing", {
      code: "fetch_unavailable",
    });
  }
  const url = endpoint(baseUrl, path);
  const maxAttempts = Math.max(1, Number(retries) + 1);
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: comfyUiHeaders(env, {
          ...(body !== undefined && { "Content-Type": "application/json" }),
          ...headers,
        }),
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (response.ok) return response;

      const raw = await response.text().catch(() => "");
      const detail = apiDetail(raw);
      const error = new ComfyUiApiError(
        `ComfyUI ${method} ${path} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
        {
          status: response.status,
          code: "http_error",
          retryable: isRetryableStatus(response.status),
          detail,
        },
      );
      lastError = error;
      if (error.retryable && attempt + 1 < maxAttempts) {
        await sleep(retryDelay(attempt));
        continue;
      }
      throw error;
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      const normalized =
        error instanceof ComfyUiApiError
          ? error
          : new ComfyUiApiError(
              timedOut
                ? `ComfyUI ${method} ${path} timed out after ${timeoutMs}ms`
                : `ComfyUI ${method} ${path} failed: ${error?.message || error}`,
              {
                code: timedOut ? "timeout" : "network_error",
                retryable: method === "GET",
              },
            );
      lastError = normalized;
      if (normalized.retryable && attempt + 1 < maxAttempts) {
        await sleep(retryDelay(attempt));
        continue;
      }
      throw normalized;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function requestJson(path, options) {
  const response = await request(path, options);
  try {
    return await response.json();
  } catch (error) {
    throw new ComfyUiApiError(`ComfyUI ${path} returned invalid JSON: ${error.message}`, {
      code: "invalid_json",
    });
  }
}

export async function queueComfyPrompt(
  prompt,
  {
    clientId = randomUUID(),
    extraData,
    ...options
  } = {},
) {
  if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) {
    throw new TypeError("ComfyUI prompt must be an API-format object");
  }
  const payload = await requestJson("/prompt", {
    ...options,
    method: "POST",
    retries: 0,
    body: {
      prompt,
      client_id: clientId,
      ...(extraData && { extra_data: extraData }),
    },
  });
  if (typeof payload?.prompt_id !== "string" || !payload.prompt_id) {
    throw new ComfyUiApiError("ComfyUI /prompt returned no prompt_id", {
      code: "missing_prompt_id",
      detail: payload,
    });
  }
  return { promptId: payload.prompt_id, clientId, response: payload };
}

function historyError(entry) {
  const status = entry?.status;
  const messages = Array.isArray(status?.messages) ? status.messages : [];
  const executionError = messages
    .map((message) => (Array.isArray(message) ? message[1] : message))
    .find((message) => message?.exception_message || message?.message || message?.error);
  return (
    executionError?.exception_message ||
    executionError?.message ||
    executionError?.error ||
    status?.status_str ||
    entry?.error ||
    "workflow execution failed"
  );
}

export async function interruptComfyPrompt(promptId, options = {}) {
  await request("/interrupt", {
    ...options,
    method: "POST",
    retries: 0,
    body: { prompt_id: promptId },
  });
}

export async function waitForComfyPrompt(
  promptId,
  {
    pollIntervalMs = DEFAULT_COMFYUI_POLL_MS,
    timeoutMs = DEFAULT_COMFYUI_TIMEOUT_MS,
    sleep = defaultSleep,
    now = Date.now,
    ...options
  } = {},
) {
  const startedAt = now();
  const interval = Math.max(0, Number(pollIntervalMs) || 0);

  while (true) {
    const history = await requestJson(`/history/${encodeURIComponent(promptId)}`, {
      ...options,
      method: "GET",
      sleep,
    });
    const entry = history?.[promptId];
    if (entry && typeof entry === "object") {
      const status = entry.status;
      if (status?.completed === true) {
        if (String(status.status_str || "").toLowerCase() === "success") return entry;
        throw new ComfyUiApiError(`ComfyUI workflow failed: ${historyError(entry)}`, {
          code: "execution_failed",
          detail: entry,
        });
      }
      // Older ComfyUI builds may return completed history without a status block.
      if (!status && entry.outputs && Object.keys(entry.outputs).length > 0) return entry;
    }

    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      await interruptComfyPrompt(promptId, { ...options, sleep }).catch(() => {});
      throw new ComfyUiApiError(
        `ComfyUI workflow ${promptId} did not finish after ${timeoutMs}ms`,
        { code: "execution_timeout", retryable: true },
      );
    }
    await sleep(Math.min(interval, Math.max(0, timeoutMs - elapsed)));
  }
}

function collectOutputCandidates(value, path = [], candidates = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return candidates;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectOutputCandidates(value[index], [...path, String(index)], candidates, seen);
    }
    return candidates;
  }

  if (typeof value.filename === "string" && value.filename.trim()) {
    const extension = extname(value.filename).toLowerCase();
    if (VIDEO_EXTENSIONS.has(extension)) {
      const pathText = path.join(".").toLowerCase();
      const contextBonus = /videos?|gifs?|files?|output/.test(pathText) ? 20 : 0;
      const typeBonus = value.type === "output" ? 5 : 0;
      candidates.push({
        filename: value.filename,
        subfolder: typeof value.subfolder === "string" ? value.subfolder : "",
        type: typeof value.type === "string" ? value.type : "output",
        extension,
        score: VIDEO_EXTENSIONS.get(extension) + contextBonus + typeBonus,
        path: path.join("."),
      });
    }
  }

  for (const [key, child] of Object.entries(value)) {
    collectOutputCandidates(child, [...path, key], candidates, seen);
  }
  return candidates;
}

export function findComfyVideoOutput(historyEntry) {
  const candidates = collectOutputCandidates(historyEntry?.outputs || historyEntry);
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (!candidates.length) {
    throw new ComfyUiApiError(
      "ComfyUI workflow completed but history contained no MP4/WebM/MOV/MKV/GIF output",
      { code: "missing_video_output" },
    );
  }
  return candidates[0];
}

async function writeResponse(response, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  if (response.body?.getReader && typeof Readable.fromWeb === "function") {
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath));
      if ((await stat(outputPath)).size === 0) {
        throw new ComfyUiApiError("ComfyUI /view returned an empty file", {
          code: "empty_output",
        });
      }
      return;
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => {});
      throw error;
    }
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    throw new ComfyUiApiError("ComfyUI /view returned an empty file", {
      code: "empty_output",
    });
  }
  writeFileSync(outputPath, bytes);
}

export async function downloadComfyOutput(file, outputPath, options = {}) {
  if (!file || typeof file.filename !== "string" || !file.filename) {
    throw new TypeError("ComfyUI output file reference is missing filename");
  }
  const params = new URLSearchParams({
    filename: file.filename,
    type: file.type || "output",
  });
  if (file.subfolder) params.set("subfolder", file.subfolder);
  const response = await request(`/view?${params.toString()}`, {
    ...options,
    method: "GET",
  });
  await writeResponse(response, outputPath);
  return outputPath;
}

export async function executeComfyWorkflow(
  prompt,
  {
    outputPath,
    pollIntervalMs = DEFAULT_COMFYUI_POLL_MS,
    timeoutMs = DEFAULT_COMFYUI_TIMEOUT_MS,
    ...options
  } = {},
) {
  const queued = await queueComfyPrompt(prompt, options);
  const history = await waitForComfyPrompt(queued.promptId, {
    ...options,
    pollIntervalMs,
    timeoutMs,
  });
  const file = findComfyVideoOutput(history);
  const destination =
    typeof outputPath === "function" ? outputPath(file, queued.promptId) : outputPath;
  if (!destination) {
    throw new ComfyUiApiError("ComfyUI outputPath is required", {
      code: "missing_output_path",
    });
  }
  await downloadComfyOutput(file, destination, options);
  return {
    promptId: queued.promptId,
    clientId: queued.clientId,
    history,
    file,
    outputPath: destination,
  };
}
