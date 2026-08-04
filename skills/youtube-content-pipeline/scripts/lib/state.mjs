import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PIPELINE_STATE_VERSION = 1;
export const STAGES = ["plan", "visuals", "audio", "compose", "render", "package", "publish"];

export function emptyState(planHash = null) {
  return {
    version: PIPELINE_STATE_VERSION,
    plan_hash: planHash,
    updated_at: new Date(0).toISOString(),
    stages: Object.fromEntries(STAGES.map((name) => [name, { status: "pending" }])),
    artifacts: {},
  };
}

export function readState(path, planHash = null) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || parsed.version !== PIPELINE_STATE_VERSION) return emptyState(planHash);
    const state = {
      ...emptyState(planHash),
      ...parsed,
      stages: { ...emptyState(planHash).stages, ...(parsed.stages || {}) },
      artifacts: parsed.artifacts && typeof parsed.artifacts === "object" ? parsed.artifacts : {},
    };
    if (planHash && state.plan_hash && state.plan_hash !== planHash) {
      return invalidateFrom(state, "visuals", planHash);
    }
    if (planHash) state.plan_hash = planHash;
    return state;
  } catch {
    return emptyState(planHash);
  }
}

export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const next = { ...state, updated_at: new Date().toISOString() };
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return next;
}

export function beginStage(state, name, inputHash = null) {
  if (!STAGES.includes(name)) throw new Error(`unknown pipeline stage: ${name}`);
  return {
    ...state,
    stages: {
      ...state.stages,
      [name]: {
        status: "running",
        started_at: new Date().toISOString(),
        input_hash: inputHash,
      },
    },
  };
}

export function completeStage(state, name, artifacts = {}, inputHash = null) {
  if (!STAGES.includes(name)) throw new Error(`unknown pipeline stage: ${name}`);
  return {
    ...state,
    stages: {
      ...state.stages,
      [name]: {
        status: "complete",
        completed_at: new Date().toISOString(),
        input_hash: inputHash,
      },
    },
    artifacts: { ...state.artifacts, ...artifacts },
  };
}

export function failStage(state, name, error) {
  if (!STAGES.includes(name)) throw new Error(`unknown pipeline stage: ${name}`);
  return {
    ...state,
    stages: {
      ...state.stages,
      [name]: {
        ...state.stages[name],
        status: "failed",
        failed_at: new Date().toISOString(),
        error: error?.message ? String(error.message) : String(error),
      },
    },
  };
}

export function invalidateFrom(state, stageName, planHash = state.plan_hash) {
  const index = STAGES.indexOf(stageName);
  if (index < 0) throw new Error(`unknown pipeline stage: ${stageName}`);
  const stages = { ...state.stages };
  for (const name of STAGES.slice(index)) stages[name] = { status: "pending" };
  return {
    ...state,
    plan_hash: planHash,
    stages,
    artifacts: index <= STAGES.indexOf("visuals") ? {} : state.artifacts,
  };
}

export function stageIsCurrent(state, name, inputHash = null) {
  const stage = state.stages?.[name];
  return stage?.status === "complete" && (!inputHash || stage.input_hash === inputHash);
}
