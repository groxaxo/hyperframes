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
//   - MiniMax: H3 2K multimodal video, opt-in unless explicitly selected
//   - heygen CLI: catalog + TTS + avatar video
//   - mflux: local FLUX-class image gen, spec-selected to the machine's RAM
//   - codex CLI: image gen on the user's ChatGPT sub
//   - Kokoro / LTX: local voice and video fallbacks
//
// Generation is self-hosted-first where configured, then cloud, then local CLI.
// `ctx.provider` forces one provider (e.g. "make a video with minimax").

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
import { miniMaxH3Generate } from "./minimax-h3-provider.mjs";
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
    A("mflux.local", { generate: mfluxImageGenerate }),
    N("codex.image_gen", { generate: codexImageGenerate }),
  ],
  icon: [N("heygen.asset.search", { search: iconProvider.search })],
  logo: [
    N("svgl", { search: svglSearch }),
    N("simple-icons", { search: simpleIconsSearch }),
    N("github.avatar", { search: githubAvatarSearch }),
    N("favicon.ddg", { search: faviconSearch }),
  ],
  voice: [
    P("gemini.tts", { generate: geminiTtsGenerate }),
    P("heygen.tts", { generate: heygenTtsGenerate }),
    A("kokoro.local", { generate: localTtsGenerate }),
  ],
  video: [
    // Self-hosted LTX remains first when configured. Gemini preserves the
    // established general cloud default. MiniMax H3 is registered next but its
    // provider returns null unless explicitly forced or MINIMAX_H3_AUTO=1,
    // preventing an API key from causing an unrequested paid generation.
    N("comfyui.ltx23", { generate: ltx23ComfyUiGenerate }),
    P("gemini.omni", { generate: geminiVideoGenerate }),
    P("minimax.h3", { generate: miniMaxH3Generate }),
    P("heygen.video", { generate: heygenVideoGenerate }),
    A("ltx.local", { generate: ltxVideoGenerate }),
  ],
  brand: [
    A("design_spec", { search: brandProvider.search }),
  ],
  grade: [
    A("color_grade.local", { search: async () => null, generate: async () => null }),
  ],
  lut: [
    A("cube_lut.local", { search: async () => null, generate: async () => null }),
  ],
};

function listFor(type) {
  const list = REGISTRY[type];
  if (!list) throw new Error(`unknown media type: ${type}`);
  return list;
}

export function getProviders(type) {
  return listFor(type);
}

export function listTypes() {
  return Object.keys(REGISTRY);
}

export function providerNamesFor(type) {
  return listFor(type).map((p) => p.name);
}

export function providerMatches(type, want) {
  return providerNamesFor(type).some((n) => n === want || n.startsWith(`${want}.`));
}

export function getProvider(type) {
  const first = listFor(type)[0] || {};
  return { ...first, type };
}

export async function runProviders(providers, capability, intent, ctx) {
  const want = ctx?.provider;
  for (const p of providers) {
    if (want && p.name !== want && !p.name.startsWith(`${want}.`)) continue;
    if (p.network && ctx?.localOnly) continue;
    const fn = p[capability];
    if (typeof fn !== "function") continue;
    const res = await fn(intent, ctx);
    if (res) return res;
  }
  return null;
}

export async function runCapability(type, capability, intent, ctx) {
  return runProviders(getProviders(type), capability, intent, ctx);
}
