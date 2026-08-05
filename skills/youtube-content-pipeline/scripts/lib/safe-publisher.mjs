import {
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  YOUTUBE_API_BASE,
  YouTubeApiError,
  buildYouTubeVideoResource,
  getYouTubeAccessToken,
  initiateYouTubeUpload,
  insertYouTubeCaptions,
  queryYouTubeUploadOffset,
  setYouTubeThumbnail,
  uploadYouTubeVideo,
} from "./youtube-api.mjs";

function nonEmpty(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
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
    if (!nonEmpty(path)) throw new YouTubeApiError(`YouTube package ${name} is missing or empty: ${path}`);
  }
}

function readReceipt(path) {
  if (!nonEmpty(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeReceiptAtomic(path, receipt) {
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

async function responseDetail(response) {
  const raw = await response.text().catch(() => "");
  if (!raw) return "";
  try {
    const payload = JSON.parse(raw);
    return String(payload?.error?.message || payload?.error?.errors?.[0]?.reason || raw).slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}

export async function findYouTubeCaption(
  videoId,
  language,
  name,
  {
    accessToken,
    fetch: fetchImpl = globalThis.fetch,
    apiBase = YOUTUBE_API_BASE,
  } = {},
) {
  let pageToken = null;
  do {
    const url = new URL(`${apiBase}/captions`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("videoId", videoId);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new YouTubeApiError(
        `YouTube caption lookup failed: HTTP ${response.status} — ${await responseDetail(response)}`,
        {
          status: response.status,
          code: "caption_lookup_failed",
          retryable: response.status === 429 || response.status >= 500,
        },
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new YouTubeApiError(`YouTube caption lookup returned invalid JSON: ${error?.message || error}`, {
        status: response.status,
        code: "caption_lookup_invalid_json",
      });
    }
    const match = (payload?.items || []).find((item) => {
      const snippet = item?.snippet || {};
      return snippet.language === language && String(snippet.name || "") === String(name || "");
    });
    if (match) return match;
    pageToken = payload?.nextPageToken || null;
  } while (pageToken);
  return null;
}

function checkpointError(error, checkpoint, stage) {
  const wrapped = error instanceof YouTubeApiError
    ? error
    : new YouTubeApiError(`${stage} failed: ${error?.message || error}`, {
        code: `${stage}_failed`,
        retryable: true,
      });
  wrapped.videoId = checkpoint.video_id || wrapped.videoId || null;
  wrapped.sessionUrl = checkpoint.upload_session || wrapped.sessionUrl || null;
  wrapped.publishStage = stage;
  wrapped.checkpoint = checkpoint;
  return wrapped;
}

function setUploadedVideo(checkpoint, resource, sessionUrl) {
  const videoId = resource?.id;
  if (!videoId) {
    throw new YouTubeApiError("Completed YouTube upload has no video id", {
      code: "missing_video_id",
      sessionUrl,
    });
  }
  checkpoint.video_id = String(videoId);
  checkpoint.watch_url = `https://www.youtube.com/watch?v=${videoId}`;
  checkpoint.upload_session = sessionUrl;
  checkpoint.video_upload_complete = true;
}

export async function publishYouTubePackageSafely(
  plan,
  packageDir,
  {
    privacy = "private",
    dryRun = false,
    env = process.env,
    fetch: fetchImpl = globalThis.fetch,
    sleep,
    publishFingerprint = null,
    resume = {},
    onCheckpoint = async () => {},
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

  const receiptPath = join(packageDir, "publish-receipt.json");
  const previous = readReceipt(receiptPath);
  const previousMatches = Boolean(
    previous && publishFingerprint && previous.publish_fingerprint === publishFingerprint,
  );
  const checkpoint = {
    ...preview,
    dry_run: false,
    publish_fingerprint: publishFingerprint,
    privacy,
    upload_session: resume.sessionUrl || (previousMatches ? previous.upload_session : null) || null,
    video_id: resume.videoId || (previousMatches ? previous.video_id : null) || null,
    watch_url: null,
    video_upload_complete: Boolean(resume.videoId || (previousMatches && previous.video_upload_complete)),
    thumbnail_set: Boolean(resume.thumbnailSet || (previousMatches && previous.thumbnail_set)),
    caption_id: resume.captionId || (previousMatches ? previous.caption_id : null) || null,
    publish_complete: false,
    updated_at: new Date().toISOString(),
  };
  if (checkpoint.video_id) {
    checkpoint.watch_url = `https://www.youtube.com/watch?v=${checkpoint.video_id}`;
  }

  const persist = async (stage) => {
    checkpoint.updated_at = new Date().toISOString();
    checkpoint.stage = stage;
    writeReceiptAtomic(receiptPath, checkpoint);
    await onCheckpoint({ ...checkpoint });
  };

  const token = await getYouTubeAccessToken({ env, fetch: fetchImpl });
  checkpoint.oauth_source = token.source;

  if (!checkpoint.video_id) {
    let session;
    let startOffset = 0;
    if (checkpoint.upload_session) {
      session = {
        sessionUrl: checkpoint.upload_session,
        size: statSync(files.video).size,
        mimeType: "video/mp4",
      };
      try {
        const status = await queryYouTubeUploadOffset(session.sessionUrl, session.size, {
          accessToken: token.accessToken,
          fetch: fetchImpl,
        });
        if (status.complete) {
          setUploadedVideo(checkpoint, status.resource, session.sessionUrl);
          await persist("video_recovered_from_session");
        } else {
          startOffset = status.offset;
          await persist("upload_session_resumed");
        }
      } catch (error) {
        await persist("upload_session_recovery_failed");
        throw checkpointError(error, checkpoint, "upload_session_recovery");
      }
    } else {
      session = await initiateYouTubeUpload(files.video, resource, {
        accessToken: token.accessToken,
        fetch: fetchImpl,
      });
      checkpoint.upload_session = session.sessionUrl;
      await persist("upload_session_created");
    }

    if (!checkpoint.video_id) {
      try {
        const uploaded = await uploadYouTubeVideo(files.video, session, {
          accessToken: token.accessToken,
          fetch: fetchImpl,
          startOffset,
          ...(sleep ? { sleep } : {}),
        });
        setUploadedVideo(checkpoint, uploaded.resource, uploaded.sessionUrl);
        await persist("video_uploaded");
      } catch (error) {
        await persist("video_upload_failed");
        throw checkpointError(error, checkpoint, "video_upload");
      }
    }
  }

  if (!checkpoint.thumbnail_set) {
    try {
      await setYouTubeThumbnail(checkpoint.video_id, files.thumbnail, {
        accessToken: token.accessToken,
        fetch: fetchImpl,
      });
      checkpoint.thumbnail_set = true;
      await persist("thumbnail_set");
    } catch (error) {
      await persist("thumbnail_failed");
      throw checkpointError(error, checkpoint, "thumbnail");
    }
  }

  if (!checkpoint.caption_id) {
    const captionName = plan.video.language;
    try {
      const existing = await findYouTubeCaption(
        checkpoint.video_id,
        plan.video.language,
        captionName,
        { accessToken: token.accessToken, fetch: fetchImpl },
      );
      if (existing?.id) {
        checkpoint.caption_id = String(existing.id);
      } else {
        const captions = await insertYouTubeCaptions(
          checkpoint.video_id,
          files.captions,
          plan.video.language,
          {
            accessToken: token.accessToken,
            fetch: fetchImpl,
            name: captionName,
          },
        );
        if (!captions?.id) {
          throw new YouTubeApiError("YouTube caption insertion returned no caption id", {
            code: "missing_caption_id",
          });
        }
        checkpoint.caption_id = String(captions.id);
      }
      await persist("captions_set");
    } catch (error) {
      await persist("captions_failed");
      throw checkpointError(error, checkpoint, "captions");
    }
  }

  checkpoint.publish_complete = true;
  checkpoint.published_at = previousMatches && previous?.published_at
    ? previous.published_at
    : new Date().toISOString();
  await persist("complete");
  return checkpoint;
}
