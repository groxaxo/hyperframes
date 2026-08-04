// Shared Gemini Interactions API transport for media-use.
//
// Pure Node.js, dependency-free, and intentionally key-stateless: callers supply
// a key or it is read from GEMINI_API_KEY / GOOGLE_API_KEY for each request.
// Keys are sent only in the x-goog-api-key header and are never persisted.

export const GEMINI_INTERACTIONS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_FILES_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/files";
export const GEMINI_OMNI_VIDEO_MODEL = "gemini-omni-flash-preview";
export const GEMINI_FLASH_TTS_MODEL = "gemini-3.1-flash-tts-preview";
export const GEMINI_TTS_SAMPLE_RATE = 24_000;
export const GEMINI_TTS_CHANNELS = 1;
export const GEMINI_TTS_SAMPLE_WIDTH = 2;

export class GeminiApiError extends Error {
  constructor(message, { status = null, code = null, retryable = false } = {}) {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function geminiApiKey(env = process.env) {
  const value = env?.GEMINI_API_KEY || env?.GOOGLE_API_KEY;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function geminiAvailable(env = process.env) {
  return geminiApiKey(env) !== null;
}

export function geminiCredentialHint() {
  return "set $GEMINI_API_KEY (or $GOOGLE_API_KEY)";
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryDelayMs(response, attempt) {
  const retryAfter = response?.headers?.get?.("retry-after");
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(500 * 2 ** attempt, 4_000);
}

function stringifyApiDetail(raw) {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message || parsed?.message;
    if (message) return String(message).trim();
  } catch {
    // Non-JSON errors are returned by proxies and transient upstream failures.
  }
  return String(raw).trim().slice(0, 500);
}

async function defaultSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGeminiResource(
  url,
  {
    apiKey,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 120_000,
    retries = 2,
    sleep = defaultSleep,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new GeminiApiError("Gemini API transport unavailable: global fetch is missing", {
      code: "fetch_unavailable",
    });
  }

  let lastError;
  const maxAttempts = Math.max(1, Number(retries) + 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { "x-goog-api-key": apiKey },
        signal: controller.signal,
      });
      if (response.ok) return response;

      const raw = await response.text().catch(() => "");
      const detail = stringifyApiDetail(raw);
      const retryable = isRetryableStatus(response.status);
      const error = new GeminiApiError(
        `Gemini file request failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
        {
          status: response.status,
          code: "file_http_error",
          retryable,
        },
      );
      lastError = error;
      if (retryable && attempt + 1 < maxAttempts) {
        await sleep(retryDelayMs(response, attempt));
        continue;
      }
      throw error;
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      const normalized =
        error instanceof GeminiApiError
          ? error
          : new GeminiApiError(
              timedOut
                ? `Gemini file request timed out after ${timeoutMs}ms`
                : `Gemini file request failed: ${error?.message || error}`,
              {
                code: timedOut ? "file_timeout" : "file_network_error",
                retryable: true,
              },
            );
      lastError = normalized;
      if (normalized.retryable && attempt + 1 < maxAttempts) {
        await sleep(Math.min(500 * 2 ** attempt, 4_000));
        continue;
      }
      throw normalized;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function createGeminiInteraction(
  body,
  {
    apiKey,
    env = process.env,
    endpoint = GEMINI_INTERACTIONS_ENDPOINT,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 180_000,
    retries = 2,
    sleep = defaultSleep,
  } = {},
) {
  const key = apiKey || geminiApiKey(env);
  if (!key) {
    throw new GeminiApiError(`Gemini API key missing — ${geminiCredentialHint()}`, {
      code: "missing_api_key",
    });
  }
  if (typeof fetchImpl !== "function") {
    throw new GeminiApiError("Gemini API transport unavailable: global fetch is missing", {
      code: "fetch_unavailable",
    });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("Gemini interaction body must be an object");
  }

  let lastError;
  const maxAttempts = Math.max(1, Number(retries) + 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        const detail = stringifyApiDetail(raw);
        const retryable = isRetryableStatus(response.status);
        const error = new GeminiApiError(
          `Gemini interactions request failed: HTTP ${response.status}${
            detail ? ` — ${detail}` : ""
          }`,
          {
            status: response.status,
            code: "http_error",
            retryable,
          },
        );
        lastError = error;
        if (retryable && attempt + 1 < maxAttempts) {
          await sleep(retryDelayMs(response, attempt));
          continue;
        }
        throw error;
      }

      let interaction;
      try {
        interaction = await response.json();
      } catch (error) {
        throw new GeminiApiError(
          `Gemini interactions returned invalid JSON: ${error?.message || error}`,
          {
            code: "invalid_json",
          },
        );
      }
      if (!interaction || typeof interaction !== "object") {
        throw new GeminiApiError("Gemini interactions returned an empty response", {
          code: "empty_response",
        });
      }
      return interaction;
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      const normalized =
        error instanceof GeminiApiError
          ? error
          : new GeminiApiError(
              timedOut
                ? `Gemini interactions request timed out after ${timeoutMs}ms`
                : `Gemini interactions request failed: ${error?.message || error}`,
              {
                code: timedOut ? "timeout" : "network_error",
                retryable: true,
              },
            );
      lastError = normalized;
      if (normalized.retryable && attempt + 1 < maxAttempts) {
        await sleep(Math.min(500 * 2 ** attempt, 4_000));
        continue;
      }
      throw normalized;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function hasMediaPayload(block) {
  return (
    block &&
    typeof block === "object" &&
    ((typeof block.data === "string" && block.data.length > 0) ||
      (typeof block.uri === "string" && block.uri.length > 0))
  );
}

export function findGeminiMedia(interaction, type) {
  if (!interaction || typeof interaction !== "object") return null;
  const direct = interaction[`output_${type}`];
  if (hasMediaPayload(direct)) return direct;

  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const content = Array.isArray(steps[i]?.content) ? steps[i].content : [];
    for (let j = content.length - 1; j >= 0; j -= 1) {
      const block = content[j];
      if (block?.type === type && hasMediaPayload(block)) return block;
    }
  }
  return null;
}

export function decodeGeminiMedia(block, type = "media") {
  if (!block || typeof block.data !== "string" || !block.data.trim()) {
    const uriHint =
      typeof block?.uri === "string" && block.uri
        ? " (use readGeminiMedia to resolve URI-delivered output)"
        : "";
    throw new GeminiApiError(`Gemini returned no inline ${type} data${uriHint}`, {
      code: "missing_media_data",
    });
  }
  const compact = block.data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new GeminiApiError(`Gemini returned invalid base64 ${type} data`, {
      code: "invalid_media_data",
    });
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === 0) {
    throw new GeminiApiError(`Gemini returned empty ${type} data`, {
      code: "empty_media_data",
    });
  }
  return bytes;
}

export function geminiFileId(uri) {
  if (typeof uri !== "string" || !uri.trim()) {
    throw new GeminiApiError("Gemini returned an empty file URI", {
      code: "invalid_file_uri",
    });
  }
  const match = /(?:^|\/)files\/([^/:?]+)(?::download)?(?:[/?#:]|$)/.exec(uri.trim());
  const id = match?.[1];
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new GeminiApiError("Gemini returned an invalid file URI", {
      code: "invalid_file_uri",
    });
  }
  return id;
}

function fileStateName(info) {
  const state = info?.state;
  if (typeof state === "string") return state.toUpperCase();
  if (typeof state?.name === "string") return state.name.toUpperCase();
  return "UNKNOWN";
}

export async function downloadGeminiFile(
  uri,
  {
    apiKey,
    env = process.env,
    filesEndpoint = GEMINI_FILES_ENDPOINT,
    fetch: fetchImpl = globalThis.fetch,
    pollIntervalMs = 5_000,
    timeoutMs = 900_000,
    requestTimeoutMs = 120_000,
    retries = 2,
    sleep = defaultSleep,
  } = {},
) {
  const key = apiKey || geminiApiKey(env);
  if (!key) {
    throw new GeminiApiError(`Gemini API key missing — ${geminiCredentialHint()}`, {
      code: "missing_api_key",
    });
  }
  const fileId = geminiFileId(uri);
  const encodedId = encodeURIComponent(fileId);
  const statusUrl = `${filesEndpoint}/${encodedId}`;
  const downloadUrl = `${filesEndpoint}/${encodedId}:download?alt=media`;
  const startedAt = Date.now();

  while (true) {
    const statusResponse = await fetchGeminiResource(statusUrl, {
      apiKey: key,
      fetch: fetchImpl,
      timeoutMs: requestTimeoutMs,
      retries,
      sleep,
    });
    let info;
    try {
      info = await statusResponse.json();
    } catch (error) {
      throw new GeminiApiError(
        `Gemini file status returned invalid JSON: ${error?.message || error}`,
        { code: "invalid_file_status" },
      );
    }
    const state = fileStateName(info);
    if (state === "ACTIVE") break;
    if (state === "FAILED") {
      throw new GeminiApiError(`Gemini file ${fileId} entered FAILED state`, {
        code: "file_failed",
      });
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      throw new GeminiApiError(
        `Gemini file ${fileId} was not ACTIVE after ${timeoutMs}ms (last state: ${state})`,
        { code: "file_poll_timeout", retryable: true },
      );
    }
    await sleep(Math.min(Math.max(0, Number(pollIntervalMs) || 0), timeoutMs - elapsed));
  }

  const downloadResponse = await fetchGeminiResource(downloadUrl, {
    apiKey: key,
    fetch: fetchImpl,
    timeoutMs: requestTimeoutMs,
    retries,
    sleep,
  });
  const bytes = Buffer.from(await downloadResponse.arrayBuffer());
  if (bytes.length === 0) {
    throw new GeminiApiError("Gemini file download returned no bytes", {
      code: "empty_file_download",
    });
  }
  return bytes;
}

export async function readGeminiMedia(block, type = "media", options = {}) {
  if (typeof block?.data === "string" && block.data.trim()) {
    return decodeGeminiMedia(block, type);
  }
  if (typeof block?.uri === "string" && block.uri.trim()) {
    return downloadGeminiFile(block.uri, options);
  }
  return decodeGeminiMedia(block, type);
}

export function isWavBuffer(bytes) {
  return (
    Buffer.isBuffer(bytes) &&
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

export function pcm16leToWav(
  pcm,
  {
    sampleRate = GEMINI_TTS_SAMPLE_RATE,
    channels = GEMINI_TTS_CHANNELS,
    sampleWidth = GEMINI_TTS_SAMPLE_WIDTH,
  } = {},
) {
  const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  if (sampleWidth !== 2) throw new RangeError("PCM-to-WAV currently supports 16-bit samples only");
  if (bytes.length === 0 || bytes.length % (channels * sampleWidth) !== 0) {
    throw new RangeError("PCM byte length is not aligned to complete 16-bit audio frames");
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a positive integer");
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new RangeError("channels must be a positive integer");
  }

  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * sampleWidth;
  const blockAlign = channels * sampleWidth;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + bytes.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(sampleWidth * 8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}
