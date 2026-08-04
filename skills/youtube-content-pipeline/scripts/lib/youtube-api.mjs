import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
export const YOUTUBE_CAPTION_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

export class YouTubeApiError extends Error {
  constructor(message, { status = null, code = null, retryable = false, sessionUrl = null } = {}) {
    super(message);
    this.name = "YouTubeApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.sessionUrl = sessionUrl;
  }
}

function envValue(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function responseDetail(response) {
  const raw = await response.text().catch(() => "");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.error?.message || parsed?.error?.errors?.[0]?.reason || raw).slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}

async function parseJsonResponse(response, label) {
  try {
    return await response.json();
  } catch (error) {
    throw new YouTubeApiError(`${label} returned invalid JSON: ${error?.message || error}`, {
      status: response.status,
      code: "invalid_json",
    });
  }
}

export function youtubeCredentialStatus(env = process.env) {
  if (envValue(env, "YOUTUBE_ACCESS_TOKEN")) return { mode: "access_token", ready: true };
  const missing = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"].filter(
    (name) => !envValue(env, name),
  );
  return { mode: "refresh_token", ready: missing.length === 0, missing };
}

export async function getYouTubeAccessToken({
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  tokenEndpoint = GOOGLE_TOKEN_ENDPOINT,
} = {}) {
  const direct = envValue(env, "YOUTUBE_ACCESS_TOKEN");
  if (direct) return { accessToken: direct, source: "access_token" };
  const status = youtubeCredentialStatus(env);
  if (!status.ready) {
    throw new YouTubeApiError(
      `YouTube OAuth is not configured — missing ${status.missing.join(", ")}`,
      { code: "missing_credentials" },
    );
  }
  const form = new URLSearchParams({
    client_id: envValue(env, "YOUTUBE_CLIENT_ID"),
    client_secret: envValue(env, "YOUTUBE_CLIENT_SECRET"),
    refresh_token: envValue(env, "YOUTUBE_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  });
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) {
    throw new YouTubeApiError(`YouTube OAuth refresh failed: HTTP ${response.status} — ${await responseDetail(response)}`, {
      status: response.status,
      code: "oauth_refresh_failed",
      retryable: retryableStatus(response.status),
    });
  }
  const payload = await parseJsonResponse(response, "YouTube OAuth refresh");
  if (!payload?.access_token) {
    throw new YouTubeApiError("YouTube OAuth refresh returned no access_token", {
      code: "missing_access_token",
    });
  }
  return {
    accessToken: String(payload.access_token),
    source: "refresh_token",
    expiresIn: Number(payload.expires_in) || null,
  };
}

export function buildYouTubeVideoResource(plan, privacy = plan.video.privacy) {
  return {
    snippet: {
      title: plan.video.title,
      description: plan.video.description,
      tags: plan.video.tags,
      categoryId: plan.video.category_id,
      defaultLanguage: plan.video.language,
      defaultAudioLanguage: plan.video.language,
    },
    status: {
      privacyStatus: privacy,
      selfDeclaredMadeForKids: Boolean(plan.video.made_for_kids),
      containsSyntheticMedia: Boolean(plan.video.contains_synthetic_media),
    },
  };
}

export async function initiateYouTubeUpload(
  videoPath,
  resource,
  {
    accessToken,
    fetch: fetchImpl = globalThis.fetch,
    uploadBase = YOUTUBE_UPLOAD_BASE,
    mimeType = "video/mp4",
  } = {},
) {
  if (!accessToken) throw new YouTubeApiError("YouTube access token is required", { code: "missing_token" });
  const size = statSync(videoPath).size;
  if (!(size > 0)) throw new YouTubeApiError(`video is empty: ${videoPath}`, { code: "empty_video" });
  const response = await fetchImpl(
    `${uploadBase}/videos?uploadType=resumable&part=snippet%2Cstatus`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(size),
        "X-Upload-Content-Type": mimeType,
      },
      body: JSON.stringify(resource),
    },
  );
  if (!response.ok) {
    throw new YouTubeApiError(`YouTube upload session failed: HTTP ${response.status} — ${await responseDetail(response)}`, {
      status: response.status,
      code: "upload_session_failed",
      retryable: retryableStatus(response.status),
    });
  }
  const location = response.headers.get("location");
  if (!location) {
    throw new YouTubeApiError("YouTube upload session returned no Location header", {
      code: "missing_upload_location",
    });
  }
  return { sessionUrl: location, size, mimeType };
}

function uploadedOffset(response) {
  const range = response.headers.get("range");
  const match = /bytes=0-(\d+)/i.exec(range || "");
  return match ? Number(match[1]) + 1 : 0;
}

export async function queryYouTubeUploadOffset(
  sessionUrl,
  size,
  {
    accessToken,
    fetch: fetchImpl = globalThis.fetch,
  } = {},
) {
  const response = await fetchImpl(sessionUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Length": "0",
      "Content-Range": `bytes */${size}`,
    },
  });
  if (response.status === 308) return { complete: false, offset: uploadedOffset(response) };
  if (response.ok) return { complete: true, resource: await parseJsonResponse(response, "YouTube upload status") };
  throw new YouTubeApiError(`YouTube upload status failed: HTTP ${response.status} — ${await responseDetail(response)}`, {
    status: response.status,
    code: "upload_status_failed",
    retryable: retryableStatus(response.status),
    sessionUrl,
  });
}

function delayMs(attempt) {
  return Math.min(1_000 * 2 ** attempt, 16_000);
}

async function defaultSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function uploadYouTubeVideo(
  videoPath,
  session,
  {
    accessToken,
    fetch: fetchImpl = globalThis.fetch,
    retries = 5,
    sleep = defaultSleep,
    startOffset = 0,
  } = {},
) {
  const { sessionUrl, size, mimeType = "video/mp4" } = session;
  let offset = Math.max(0, Number(startOffset) || 0);
  let attempt = 0;
  while (offset < size) {
    const end = size - 1;
    const stream = createReadStream(videoPath, { start: offset, end });
    try {
      const response = await fetchImpl(sessionUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": mimeType,
          "Content-Length": String(size - offset),
          "Content-Range": `bytes ${offset}-${end}/${size}`,
        },
        body: stream,
        duplex: "half",
      });
      if (response.status === 308) {
        const nextOffset = uploadedOffset(response);
        if (nextOffset > offset) {
          offset = nextOffset;
          attempt = 0;
          continue;
        }
        if (attempt >= retries) {
          throw new YouTubeApiError(
            `YouTube upload made no progress after ${retries + 1} attempt(s)`,
            { code: "upload_stalled", retryable: true, sessionUrl },
          );
        }
      }
      if (response.ok) {
        const resource = await parseJsonResponse(response, "YouTube video upload");
        if (!resource?.id) {
          throw new YouTubeApiError("YouTube video upload returned no video id", {
            code: "missing_video_id",
            sessionUrl,
          });
        }
        return { resource, videoId: String(resource.id), sessionUrl };
      }
      const error = new YouTubeApiError(
        `YouTube video upload failed: HTTP ${response.status} — ${await responseDetail(response)}`,
        {
          status: response.status,
          code: "video_upload_failed",
          retryable: retryableStatus(response.status),
          sessionUrl,
        },
      );
      if (!error.retryable || attempt >= retries) throw error;
    } catch (error) {
      if (error instanceof YouTubeApiError && !error.retryable) throw error;
      if (attempt >= retries) {
        throw error instanceof YouTubeApiError
          ? error
          : new YouTubeApiError(`YouTube video upload network failure: ${error?.message || error}`, {
              code: "upload_network_error",
              retryable: true,
              sessionUrl,
            });
      }
    } finally {
      stream.destroy();
    }

    await sleep(delayMs(attempt));
    attempt += 1;
    const status = await queryYouTubeUploadOffset(sessionUrl, size, {
      accessToken,
      fetch: fetchImpl,
    });
    if (status.complete) {
      if (!status.resource?.id) throw new YouTubeApiError("Completed YouTube upload has no video id");
      return { resource: status.resource, videoId: String(status.resource.id), sessionUrl };
    }
    offset = status.offset;
  }
  throw new YouTubeApiError("YouTube upload ended without a completed resource", {
    code: "incomplete_upload",
    sessionUrl,
  });
}

function imageMime(path) {
  return extname(path).toLowerCase() === ".jpg" || extname(path).toLowerCase() === ".jpeg"
    ? "image/jpeg"
    : "image/png";
}

export async function setYouTubeThumbnail(
  videoId,
  thumbnailPath,
  {
    accessToken,
    fetch: fetchImpl = globalThis.fetch,
    uploadBase = YOUTUBE_UPLOAD_BASE,
  } = {},
) {
  const bytes = readFileSync(thumbnailPath);
  const response = await fetchImpl(
    `${uploadBase}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": imageMime(thumbnailPath),
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    },
  );
  if (!response.ok) {
    throw new YouTubeApiError(`YouTube thumbnail upload failed: HTTP ${response.status} — ${await responseDetail(response)}`, {
      status: response.status,
      code: "thumbnail_upload_failed",
      retryable: retryableStatus(response.status),
    });
  }
  return parseJsonResponse(response, "YouTube thumbnail upload");
}

export function buildCaptionMultipart(videoId, captionPath, language, name = "English") {
  const boundary = `youtube-caption-${Date.now().toString(36)}-${process.pid}`;
  const metadata = JSON.stringify({
    snippet: {
      videoId,
      language,
      name,
      isDraft: false,
    },
  });
  const caption = readFileSync(captionPath);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat([head, caption, tail]), metadata: JSON.parse(metadata) };
}

export async function insertYouTubeCaptions(
  videoId,
  captionPath,
  language,
  {
    accessToken,
    fetch: fetchImpl = globalThis.fetch,
    uploadBase = YOUTUBE_UPLOAD_BASE,
    name = "English",
  } = {},
) {
  const multipart = buildCaptionMultipart(videoId, captionPath, language, name);
  const response = await fetchImpl(`${uploadBase}/captions?part=snippet&uploadType=multipart`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${multipart.boundary}`,
      "Content-Length": String(multipart.body.length),
    },
    body: multipart.body,
  });
  if (!response.ok) {
    throw new YouTubeApiError(`YouTube caption upload failed: HTTP ${response.status} — ${await responseDetail(response)}`, {
      status: response.status,
      code: "caption_upload_failed",
      retryable: retryableStatus(response.status),
    });
  }
  return parseJsonResponse(response, "YouTube caption upload");
}

function packageFiles(packageDir) {
  return {
    video: join(packageDir, "video.mp4"),
    thumbnail: join(packageDir, "thumbnail.jpg"),
    captions: join(packageDir, "captions.srt"),
    metadata: join(packageDir, "metadata.json"),
  };
}

function assertPackage(files) {
  for (const [name, path] of Object.entries(files)) {
    if (!existsSync(path)) throw new YouTubeApiError(`YouTube package is missing ${name}: ${path}`);
    if (statSync(path).size === 0) throw new YouTubeApiError(`YouTube package ${name} is empty: ${path}`);
  }
}

export async function publishYouTubePackage(
  plan,
  packageDir,
  {
    privacy = "private",
    dryRun = false,
    env = process.env,
    fetch: fetchImpl = globalThis.fetch,
    sessionUrl = null,
    sleep = defaultSleep,
  } = {},
) {
  const files = packageFiles(packageDir);
  assertPackage(files);
  const resource = buildYouTubeVideoResource(plan, privacy);
  const preview = {
    dry_run: Boolean(dryRun),
    files: Object.fromEntries(Object.entries(files).map(([key, path]) => [key, basename(path)])),
    resource,
  };
  if (dryRun) return preview;

  const token = await getYouTubeAccessToken({ env, fetch: fetchImpl });
  const session = sessionUrl
    ? { sessionUrl, size: statSync(files.video).size, mimeType: "video/mp4" }
    : await initiateYouTubeUpload(files.video, resource, {
        accessToken: token.accessToken,
        fetch: fetchImpl,
      });
  const uploaded = await uploadYouTubeVideo(files.video, session, {
    accessToken: token.accessToken,
    fetch: fetchImpl,
    sleep,
  });
  const thumbnail = await setYouTubeThumbnail(uploaded.videoId, files.thumbnail, {
    accessToken: token.accessToken,
    fetch: fetchImpl,
  });
  const captions = await insertYouTubeCaptions(
    uploaded.videoId,
    files.captions,
    plan.video.language,
    {
      accessToken: token.accessToken,
      fetch: fetchImpl,
      name: plan.video.language,
    },
  );
  const receipt = {
    ...preview,
    dry_run: false,
    video_id: uploaded.videoId,
    watch_url: `https://www.youtube.com/watch?v=${uploaded.videoId}`,
    privacy,
    oauth_source: token.source,
    upload_session: uploaded.sessionUrl,
    thumbnail_set: Boolean(thumbnail),
    caption_id: captions?.id || null,
    published_at: new Date().toISOString(),
  };
  writeFileSync(join(packageDir, "publish-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  return receipt;
}
