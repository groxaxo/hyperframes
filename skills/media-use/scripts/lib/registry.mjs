// Provider registry — the v2 contract.
//
// Each media type maps to an ORDERED list of provider entries. Providers are
// tried in order; the first to return a non-null result wins, which keeps
// resolution deterministic (same request -> same provider -> same file ->
// reproducible renders). A configured self-hosted ComfyUI LTX-2.3 workflow is
// preferred for video; cloud providers and the existing local CLI remain intact.
//
// An entry exposes any of three capability methods — search / generate /
// process — plus { name }. media-use holds no keys; each external service owns
// its auth and media-use reads credentials from its normal environment.
// Providers, by type:
//   - ComfyUI: self-hosted LTX-2.3 API workflows with synchronized audio/video
//   - Gemini: Omni Flash video with native audio and Gemini 3.1 Flash TTS
//   - heygen CLI: catalog + TTS + avatar video
//   - mflux: local FLUX-class image gen, spec-selected to the machine's RAM
//   - codex CLI: image gen on the user's ChatGPT sub
//   - Kokoro / LTX: local voice and video fallbacks
//
// Generation is self-hosted-first where configured, then cloud, then local CLI.
// `ctx.provider` forces one provider (e.g. "make a video with comfyui").

import { bgmProvider } from "./bgm-provider.mjs";
import { sfxProvider } from "./sfx-provider.mjs";
import { bundledSfxProvider } from "./bundled-sfx-provider.mjs";
import { imageProvider, iconProvider } from "./image-provider.mjs";
import { brandProvider } from "./brand-provider.mjs";
import {
  svglSearch,
  simpleIconsSearch,
  githubAvatarSearch,
  faviconSearch,
} from "./logo-provider.mjs";
import { geminiTtsGenerate } from "./gemini-tts-provider.mjs";
import { geminiVideoGenerate } from "./gemini-video-provider.mjs";
import { heygenTtsGenerate } from "./voice-provider.mjs";
import { heygenVideoGenerate } from "./heygen-video-provider.mjs";
import { ltx23ComfyUiGenerate } from "./ltx-comfyui-provider.mjs";
import { ltxVideoGenerate } from "./ltx-video-provider.mjs";
import { localTtsGenerate } from "./tts-local-provider.mjs";
import { codexImageGenerate } from "./codex-provider.mjs";
import { mfluxImageGenerate } from "./mflux-provider.mjs";

// Provider markers: `network` = uses HTTP or another remote transport and is
// skipped by the hard --local-only guard. Self-hosted ComfyUI is free and private,
// but still uses HTTP, so it is marked network; the direct local LTX CLI remains
// the zero-network fallback. `paid` = can consume metered credits.
const A = (name, caps) => ({ name, ...caps }); // local, free
const N = (name, caps) => ({ name, network: true, ...caps }); // network, free
const P = (name, caps) => ({ name, network: true, paid: true, ...caps }); // remote, paid

// Every network provider is skipped by --local-only.
const REGISTRY = {
  bgm: [N("heygen.audio.sounds", { search: bgmProvider.search })],
  sfx: [
    N("heygen.audio.sounds", { search: sfxProvider.search }),
    A("bundled.sfx", { search: bundledSfxProvider.search }),
  ],
  image: [
    N("heygen.asset.search", { search: imageProvider.search }),
    // Catalog miss -> generate. Local first (best FLUX-class model the machine's
    // RAM can run, spec-selected; free, private, kept under --local-only), then
    // the codex CLI on the user's ChatGPT sub as the better-quality upsell and
    // the fallback when no local model fits.
    A("mflux.local", { generate: mfluxImageGenerate }),
    N("codex.image_gen", { generate: codexImageGenerate }),
  ],
  icon: [N("heygen.asset.search", { search: iconProvider.search })],
  logo: [
    // Official brand marks. Tiers verified by a 54-brand stress test (100%
    // cascade hit); HeyGen asset search is deliberately absent — it returns
    // generic look-alike icons for brand queries. All free, all network →
    // --local-only leaves only the cache rungs.
    N("svgl", { search: svglSearch }),
    N("simple-icons", { search: simpleIconsSearch }),
    N("github.avatar", { search: githubAvatarSearch }),
    N("favicon.ddg", { search: faviconSearch }),
  ],
  voice: [
    // Gemini 3.1 Flash TTS is preferred when GEMINI_API_KEY / GOOGLE_API_KEY is
    // configured. The provider returns null without a key, allowing the existing
    // HeyGen path and private Kokoro fallback to continue unchanged.
    P("gemini.tts", { generate: geminiTtsGenerate }),
    P("heygen.tts", { generate: heygenTtsGenerate }),
    A("kokoro.local", { generate: localTtsGenerate }),
  ],
  video: [
    // A configured API-format LTX-2.3 workflow runs on the user's own ComfyUI
    // first. It returns null when unconfigured, so existing installations retain
    // Gemini → HeyGen → local LTX behavior with no extra network probe.
    N("comfyui.ltx23", { generate: ltx23ComfyUiGenerate }),
    P("gemini.omni", { generate: geminiVideoGenerate }),
    P("heygen.video", { generate: heygenVideoGenerate }),
    A("ltx.local", { generate: ltxVideoGenerate }),
  ],
  brand: [
    // Local design spec, not heygen — reads frame.md / design.md tokens.
    A("design_spec", { search: brandProvider.search }),
  ],
  grade: [
    // Local deterministic cascade handled by resolve.mjs so grade records can
    // carry an inline block as well as an optional frozen .cube file.
    A("color_grade.local", { search: async () => null, generate: async () => null }),
  ],
  lut: [
    // Lower-level local LUT generation/freezing path handled by resolve.mjs.
    A("cube_lut.local", { search: async () => null, generate: async () => null }),
  ],
};

function listFor(type) {
  const list = REGISTRY[type];
  if (!list) throw new Error(`unknown media type: ${type}`);
  return list;
}

/** Ordered providers for a type. */
export function getProviders(type) {
  return listFor(type);
}

/** All declared media types. */
export function listTypes() {
  return Object.keys(REGISTRY);
}

/** Provider names available for a type, in cascade order (for --provider validation). */
export function providerNamesFor(type) {
  return listFor(type).map((p) => p.name);
}

/**
 * Does an override token (full name like "comfyui.ltx23" or a prefix like
 * "comfyui") match any provider declared for the type? Same match rule as
 * runProviders, so validation and dispatch never disagree.
 */
export function providerMatches(type, want) {
  return providerNamesFor(type).some((n) => n === want || n.startsWith(`${want}.`));
}

/**
 * Back-compat shim for the v1 single-provider API. Returns the first declared
 * provider for the type (tagged with `type`); throws for an unknown type.
 * Kept for v1 callers only — new code should use getProviders/runCapability.
 */
export function getProvider(type) {
  const first = listFor(type)[0] || {};
  return { ...first, type };
}

/**
 * Run a capability across an explicit ordered provider list. Tries each in
 * order, returns the first non-null result, skips providers that don't expose
 * the capability. Pure over its input — the unit-testable core of the cascade.
 *
 * Offline guard: every `network` provider is skipped when `ctx.localOnly` is
 * set — unconditionally, even under a `ctx.provider` override. ComfyUI uses
 * HTTP, so `--local-only` selects the direct local LTX CLI instead.
 * Provider override: `ctx.provider` (a full name like "comfyui.ltx23" or a
 * prefix like "comfyui") pins resolution to matching providers only.
 */
export async function runProviders(providers, capability, intent, ctx) {
  const want = ctx?.provider;
  for (const p of providers) {
    if (want && p.name !== want && !p.name.startsWith(`${want}.`)) continue;
    if (p.network && ctx?.localOnly) continue; // --local-only wins over every HTTP provider
    const fn = p[capability];
    if (typeof fn !== "function") continue;
    const res = await fn(intent, ctx);
    if (res) return res;
  }
  return null;
}

/** Run a capability over the providers for a type (deterministic order). */
export async function runCapability(type, capability, intent, ctx) {
  return runProviders(getProviders(type), capability, intent, ctx);
}
