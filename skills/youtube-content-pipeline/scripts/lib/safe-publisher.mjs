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
  YOUTUBE_UPLOAD_BASE,
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
    if (!nonEmpty(path))
      throw new YouTubeApiError(`YouTube package ${name} is missing or empty: ${path}`);
  }
}

function captionsContainCues(path) {
  try {
    return /\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/.test(
      readFileSync(path, "utf8"),
    );
  } catch {
    return false;
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

async function responseJson(response, label) {
  try {
    return await response.json();
  } catch (error) {
    throw new YouTubeApiError(`${label} returned invalid JSON: ${error?.message || error}`, {
      status: response.status,
      code: "invalid_json",
    });
  }
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
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
          retryable: retryableStatus(response.status),
        },
      );
    }
    const payload = await responseJson(response, "YouTube caption lookup");
    const match = (payload?.items || []).find((item) => {
      const snippet = item?.snippet || {};
      return snippet.language === language && String(snippet.name || "") === String(name || "");
    });
    if (match) return match;
    pageToken = payload?.nextPageToken || null;
  } while (pageToken);
  return null;
}

export async function updateYouTubeVideoResource(
  videoId,
  resource,
  {
    accessToken,
    fetch: fetchImpl = globalThis.fetch,
    apiBase = YOUTUBE_API_BASE,
  } = {},
) {
  const response = await fetchImpl(
    `${apiBase}/videos?part=snippet%2Cstatus`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ id: videoId, ...resource }),
    },
  );
  if (!response.ok) {
    throw new YouTubeApiError(
      `YouTube metadata update failed: HTTP ${response.status} — ${await responseDetail(response)}`,
      {
        status: response.status,
        code: "metadata_update_failed",
        retryable: retryableStatus(response.status),
      },
    );
  }
  return responseJson(response, "YouTube metadata update");
}

function buildCaptionUpdateMultipart(videoId, captionId, captionPath, language, name) {
  const boundary = `youtube-caption-update-${Date.now().toString(36)}-${process.pid}`;
  const metadata = JSON.stringify({
    id: captionId,
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
  return { boundary, body: Buffer.concat([head, caption, tail]) };
}

export async function updateYouTubeCaption(
  videoId,
  captionId,
  captionPath,
  language,
  {
    accessToken,
    fetch: fetchImpl = globalThis.fetch,
    uploadBase = YOUTUBE_UPLOAD_BASE,
    name = language,
  } = {},
) {
  const multipart = buildCaptionUpdateMultipart(
    videoId,
    captionId,
    captionPath,
    language,
    name,
  );
  const response = await fetchImpl(
    `${uploadBase}/captions?part=snippet&uploadType=multipart`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${multipart.boundary}`,
        "Content-Length": String(multipart.body.length),
      },
      body: multipart.body,
    },
  );
  if (!response.ok) {
    throw new YouTubeApiError(
      `YouTube caption update failed: HTTP ${response.status} — ${await responseDetail(response)}`,
      {
        status: response.status,
        code: "caption_update_failed",
        retryable: retryableStatus(response.status),
      },
    );
  }
  return responseJson(response, "YouTube caption update");
}

export async function deleteYouTubeCaption(
  captionId,
  {
    accessToken,
    fetch: fetchImpl = globalThis.fetch,
    apiBase = YOUTUBE_API_BASE,
  } = {},
) {
  const response = await fetchImpl(
    `${apiBase}/captions?id=${encodeURIComponent(captionId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!response.ok) {
    throw new YouTubeApiError(
      `YouTube caption deletion failed: HTTP ${response.status} — ${await responseDetail(response)}`,
      {
        status: response.status,
        code: "caption_delete_failed",
        retryable: retryableStatus(response.status),
      },
    );
  }
  return true;
}

function checkpointError(error, checkpoint, stage) {
  const wrapped =
    error instanceof YouTubeApiError
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
  checkpoint.metadata_set = true;
}

function normalizeFingerprints(assetFingerprints, publishFingerprint) {
  const fallback = publishFingerprint || null;
  return {
    video: assetFingerprints?.video || fallback,
    metadata: assetFingerprints?.metadata || fallback,
    thumbnail: assetFingerprints?.thumbnail || fallback,
    captions: assetFingerprints?.captions || fallback,
  };
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
    assetFingerprints = null,
    resume = {},
    onCheckpoint = async () => {},
  } = {},
) {
  const files = packageFiles(packageDir);
  assertPackage(files);
  const hasCaptionCues = captionsContainCues(files.captions);
  const fingerprints = normalizeFingerprints(assetFingerprints, publishFingerprint);
  const resource = buildYouTubeVideoResource(plan, privacy);
  const preview = {
    dry_run: Boolean(dryRun),
    files: Object.fromEntries(Object.entries(files).map(([key, path]) => [key, basename(path)])),
    resource,
    captions_will_upload: hasCaptionCues,
    asset_fingerprints: fingerprints,
  };
  if (dryRun) return preview;

  const receiptPath = join(packageDir, "publish-receipt.json");
  const previous = readReceipt(receiptPath);
  const legacyMatch = Boolean(
    previous && publishFingerprint && previous.publish_fingerprint === publishFingerprint,
  );
  const sameVideo = Boolean(
    previous &&
      fingerprints.video &&
      (previous.video_fingerprint === fingerprints.video ||
        (!previous.video_fingerprint && legacyMatch)),
  );
  const resumeMatches = Boolean(
    resume.videoId &&
      (!resume.videoFingerprint || resume.videoFingerprint === fingerprints.video),
  );
  const previousVideoId = sameVideo ? previous.video_id : null;
  const videoId = resumeMatches ? resume.videoId : previousVideoId;
  const knownCaptionId =
    (resumeMatches ? resume.captionId : null) ||
    (sameVideo ? previous.caption_id : null) ||
    null;
  const metadataCurrent = Boolean(
    videoId &&
      ((resumeMatches && resume.metadataSet && resume.metadataFingerprint === fingerprints.metadata) ||
        (sameVideo &&
          previous.metadata_set &&
          previous.metadata_fingerprint === fingerprints.metadata &&
          previous.privacy === privacy)),
  );
  const thumbnailCurrent = Boolean(
    videoId &&
      ((resumeMatches && resume.thumbnailSet && resume.thumbnailFingerprint === fingerprints.thumbnail) ||
        (sameVideo &&
          previous.thumbnail_set &&
          previous.thumbnail_fingerprint === fingerprints.thumbnail)),
  );
  const captionsCurrent = Boolean(
    videoId &&
      hasCaptionCues &&
      ((resumeMatches && resume.captionId && resume.captionFingerprint === fingerprints.captions) ||
        (sameVideo &&
          previous.caption_id &&
          previous.caption_fingerprint === fingerprints.captions)),
  );
  const captionSkipCurrent = Boolean(
    videoId &&
      !hasCaptionCues &&
      ((resumeMatches && resume.captionsSkipped && resume.captionFingerprint === fingerprints.captions) ||
        (sameVideo &&
          previous.captions_skipped &&
          previous.caption_fingerprint === fingerprints.captions)),
  );

  const checkpoint = {
    ...preview,
    dry_run: false,
    publish_fingerprint: publishFingerprint,
    video_fingerprint: fingerprints.video,
    metadata_fingerprint: fingerprints.metadata,
    thumbnail_fingerprint: fingerprints.thumbnail,
    caption_fingerprint: fingerprints.captions,
    privacy,
    upload_session:
      (resumeMatches ? resume.sessionUrl : null) ||
      (sameVideo ? previous.upload_session : null) ||
      null,
    video_id: videoId || null,
    watch_url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
    video_upload_complete: Boolean(videoId),
    metadata_set: metadataCurrent,
    thumbnail_set: thumbnailCurrent,
    caption_id: captionsCurrent ? knownCaptionId : null,
    captions_skipped: captionSkipCurrent,
    publish_complete: false,
    updated_at: new Date().toISOString(),
  };

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

  if (!checkpoint.metadata_set) {
    try {
      await updateYouTubeVideoResource(checkpoint.video_id, resource, {
        accessToken: token.accessToken,
        fetch: fetchImpl,
      });
      checkpoint.metadata_set = true;
      await persist("metadata_set");
    } catch (error) {
      await persist("metadata_failed");
      throw checkpointError(error, checkpoint, "metadata");
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

  if (!hasCaptionCues) {
    try {
      const existing =
        knownCaptionId ||
        (await findYouTubeCaption(
          checkpoint.video_id,
          plan.video.language,
          plan.video.language,
          { accessToken: token.accessToken, fetch: fetchImpl },
        ))?.id ||
        null;
      if (existing) {
        await deleteYouTubeCaption(existing, {
          accessToken: token.accessToken,
          fetch: fetchImpl,
        });
      }
      checkpoint.caption_id = null;
      checkpoint.captions_skipped = true;
      await persist("captions_skipped");
    } catch (error) {
      await persist("captions_delete_failed");
      throw checkpointError(error, checkpoint, "captions_delete");
    }
  } else if (!checkpoint.caption_id) {
    const captionName = plan.video.language;
    try {
      const existing =
        knownCaptionId ||
        (await findYouTubeCaption(
          checkpoint.video_id,
          plan.video.language,
          captionName,
          { accessToken: token.accessToken, fetch: fetchImpl },
        ))?.id ||
        null;
      const captions = existing
        ? await updateYouTubeCaption(
            checkpoint.video_id,
            existing,
            files.captions,
            plan.video.language,
            {
              accessToken: token.accessToken,
              fetch: fetchImpl,
              name: captionName,
            },
          )
        : await insertYouTubeCaptions(
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
        throw new YouTubeApiError("YouTube caption write returned no caption id", {
          code: "missing_caption_id",
        });
      }
      checkpoint.caption_id = String(captions.id);
      checkpoint.captions_skipped = false;
      await persist(existing ? "captions_updated" : "captions_set");
    } catch (error) {
      await persist("captions_failed");
      throw checkpointError(error, checkpoint, "captions");
    }
  }

  checkpoint.publish_complete = true;
  checkpoint.published_at =
    sameVideo && previous?.published_at
      ? previous.published_at
      : new Date().toISOString();
  await persist("complete");
  return checkpoint;
}
