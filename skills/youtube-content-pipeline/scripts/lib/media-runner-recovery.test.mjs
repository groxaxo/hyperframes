import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateVisuals, PipelineCommandError } from "./media-runner.mjs";

function h3Plan() {
  return {
    video: { width: 1920, height: 1080, format: "long" },
    production: {
      provider_policy: "minimax",
      max_concurrency: 1,
    },
    scenes: [
      {
        id: "continuity",
        role: "broll",
        provider: "minimax",
        fallback_provider: null,
        duration_s: 8,
        visual_prompt: "A continuous customer journey",
        negative_prompt: "identity drift",
        native_audio: "duck",
        narration: "A continuity line.",
      },
    ],
  };
}

test("a timed-out paid H3 task is checkpointed and resumed on the next run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-h3-resume-"));
  let calls = 0;
  try {
    await assert.rejects(
      generateVisuals(h3Plan(), {
        projectDir: dir,
        runJson: async () => {
          calls += 1;
          throw new PipelineCommandError("poll timeout [task_id: task-123]", {
            code: "poll_timeout",
            retryable: true,
            taskId: "task-123",
          });
        },
      }),
      /poll timeout/,
    );
    const pending = JSON.parse(
      readFileSync(join(dir, ".youtube-pipeline/scenes.json"), "utf8"),
    ).scenes.continuity;
    assert.equal(pending.status, "pending_remote");
    assert.equal(pending.task_id, "task-123");

    const resumed = await generateVisuals(h3Plan(), {
      projectDir: dir,
      runJson: async (_script, _args, options) => {
        calls += 1;
        assert.equal(options.env.MINIMAX_H3_RESUME_TASK_ID, "task-123");
        mkdirSync(join(dir, "assets/video"), { recursive: true });
        writeFileSync(join(dir, "assets/video/continuity.mp4"), "video");
        return {
          path: "assets/video/continuity.mp4",
          duration: 8,
          provenance: {
            provider: "minimax.h3",
            task_id: "task-123",
            resumed: true,
            native_audio: "probe",
          },
        };
      },
    });
    assert.equal(calls, 2);
    assert.equal(resumed.generated[0].status, "complete");
    assert.equal(resumed.generated[0].provenance.resumed, true);
    // H3's API does not guarantee an audio stream; unverified source audio is
    // muted rather than being mounted into the final mix optimistically.
    assert.equal(resumed.generated[0].native_audio, "mute");
    assert.equal(resumed.generated[0].native_audio_requested, "duck");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a terminal H3 failure is not automatically resubmitted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-h3-terminal-"));
  let calls = 0;
  try {
    await assert.rejects(
      generateVisuals(h3Plan(), {
        projectDir: dir,
        runJson: async () => {
          calls += 1;
          throw new PipelineCommandError("task failed [task_id: task-failed]", {
            code: "failed",
            taskId: "task-failed",
          });
        },
      }),
      /task failed/,
    );
    await assert.rejects(
      generateVisuals(h3Plan(), {
        projectDir: dir,
        runJson: async () => {
          calls += 1;
          throw new Error("must not resubmit");
        },
      }),
      /terminal MiniMax task failure/,
    );
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
