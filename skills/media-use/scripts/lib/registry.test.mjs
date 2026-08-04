import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  getProviders,
  getProvider,
  listTypes,
  providerMatches,
  providerNamesFor,
  runProviders,
  runCapability,
} from "./registry.mjs";

test("listTypes exposes the v2 media types", () => {
  const types = listTypes();
  for (const t of [
    "bgm",
    "sfx",
    "image",
    "icon",
    "logo",
    "voice",
    "video",
    "brand",
    "grade",
    "lut",
  ]) {
    assert.ok(types.includes(t), `missing type: ${t}`);
  }
});

test("heygen provider is first for every catalog type it serves", () => {
  for (const t of ["bgm", "sfx", "image", "icon"]) {
    const first = getProviders(t)[0];
    assert.ok(first, `no enabled provider for ${t}`);
    assert.match(first.name, /^heygen/, `${t} first provider is ${first.name}`);
  }
});

test("sanctioned providers only", () => {
  const allowed =
    /^comfyui\.ltx23$|^gemini\.(?:omni|tts)$|^minimax\.h3$|^heygen|^bundled\.sfx$|^mflux\.local$|^kokoro\.local$|^ltx\.local$|^codex\.image_gen$|^design_spec$|^svgl$|^simple-icons$|^github\.avatar$|^favicon\.ddg$|^color_grade\.local$|^cube_lut\.local$/;
  for (const t of listTypes()) {
    for (const p of getProviders(t)) {
      assert.ok(allowed.test(p.name), `${t} lists unsanctioned provider: ${p.name}`);
    }
  }
});

test("image cascade: heygen catalog, then local mflux, then the codex upsell", () => {
  const ps = getProviders("image");
  assert.match(ps[0].name, /^heygen/, "heygen catalog first");
  const names = ps.map((p) => p.name);
  const mflux = ps.find((p) => p.name === "mflux.local");
  const codex = ps.find((p) => p.name === "codex.image_gen");
  assert.ok(mflux && typeof mflux.generate === "function", "local mflux registered");
  assert.ok(codex && typeof codex.generate === "function", "codex upsell registered");
  assert.ok(names.indexOf("mflux.local") < names.indexOf("codex.image_gen"), "local before codex");
  assert.ok(!mflux.network, "local mflux is kept under --local-only");
  assert.ok(codex.network, "codex is network (skipped under --local-only)");
});

test("voice cascade: Gemini first, then HeyGen, with Kokoro as local fallback", () => {
  const ps = getProviders("voice");
  assert.deepEqual(providerNamesFor("voice"), ["gemini.tts", "heygen.tts", "kokoro.local"]);
  assert.equal(providerMatches("voice", "gemini"), true);
  assert.ok(ps[0].network);
  assert.ok(ps[0].paid);
  assert.equal(ps[1].name, "heygen.tts");
  assert.equal(ps[2].name, "kokoro.local");
  assert.ok(!ps[2].network);
});

test("video cascade registers opt-in MiniMax H3 between Gemini and HeyGen", async () => {
  assert.deepEqual(providerNamesFor("video"), [
    "comfyui.ltx23",
    "gemini.omni",
    "minimax.h3",
    "heygen.video",
    "ltx.local",
  ]);
  assert.equal(providerMatches("video", "comfyui"), true);
  assert.equal(providerMatches("video", "gemini"), true);
  assert.equal(providerMatches("video", "minimax"), true);
  assert.equal(providerMatches("video", "ltx.local"), true);

  const ps = getProviders("video");
  assert.ok(ps[0].network);
  assert.ok(!ps[0].paid);
  assert.ok(ps[1].network && ps[1].paid);
  assert.equal(ps[2].name, "minimax.h3");
  assert.ok(ps[2].network && ps[2].paid);
  assert.ok(ps[3].network && ps[3].paid);
  assert.ok(!ps[4].network);
  assert.equal(await runCapability("video", "search", "x", {}), null);
});

test("sfx cascade retains the bundled local fallback", () => {
  const ps = getProviders("sfx");
  assert.equal(ps[0].name, "heygen.audio.sounds");
  assert.equal(ps[1].name, "bundled.sfx");
  assert.ok(!ps[1].network);
});

test("ctx.provider forces one generator", async () => {
  const providers = [
    { name: "heygen.asset.search", network: true, search: async () => null },
    { name: "mflux.local", generate: async () => ({ hit: "local" }) },
    { name: "codex.image_gen", network: true, generate: async () => ({ hit: "codex" }) },
  ];
  assert.deepEqual(await runProviders(providers, "generate", "x", {}), { hit: "local" });
  assert.deepEqual(await runProviders(providers, "generate", "x", { provider: "codex" }), {
    hit: "codex",
  });
  assert.equal(
    await runProviders(providers, "generate", "x", { provider: "codex", localOnly: true }),
    null,
  );
  assert.deepEqual(
    await runProviders(providers, "generate", "x", { provider: "mflux", localOnly: true }),
    { hit: "local" },
  );
});

test("provider prefix pins MiniMax without invoking neighboring paid providers", async () => {
  const calls = [];
  const providers = [
    {
      name: "gemini.omni",
      network: true,
      paid: true,
      generate: async () => {
        calls.push("gemini");
        return { hit: "gemini" };
      },
    },
    {
      name: "minimax.h3",
      network: true,
      paid: true,
      generate: async () => {
        calls.push("minimax");
        return { hit: "minimax" };
      },
    },
    {
      name: "heygen.video",
      network: true,
      paid: true,
      generate: async () => {
        calls.push("heygen");
        return { hit: "heygen" };
      },
    },
  ];
  assert.deepEqual(
    await runProviders(providers, "generate", "x", { provider: "minimax" }),
    { hit: "minimax" },
  );
  assert.deepEqual(calls, ["minimax"]);
});

test("--local-only skips every HTTP provider", async () => {
  let remoteRan = false;
  const providers = [
    {
      name: "minimax.h3",
      network: true,
      generate: async () => {
        remoteRan = true;
        return { hit: "remote" };
      },
    },
    { name: "ltx.local", generate: async () => ({ hit: "local" }) },
  ];
  assert.deepEqual(await runProviders(providers, "generate", "x", { localOnly: true }), {
    hit: "local",
  });
  assert.equal(remoteRan, false);
});

test("getProvider returns the first provider with its type, throws for unknown", () => {
  const p = getProvider("bgm");
  assert.equal(p.type, "bgm");
  assert.equal(typeof p.search, "function");
  assert.throws(() => getProvider("unknown_type"), /unknown media type/);
});

test("getProviders throws for unknown type", () => {
  assert.throws(() => getProviders("nope"), /unknown media type/);
});

test("runProviders calls providers in order and returns the first non-null", async () => {
  const calls = [];
  const providers = [
    { name: "a", search: async () => { calls.push("a"); return null; } },
    { name: "b", search: async () => { calls.push("b"); return { hit: "b" }; } },
    { name: "c", search: async () => { calls.push("c"); return { hit: "c" }; } },
  ];
  assert.deepEqual(await runProviders(providers, "search", "x", {}), { hit: "b" });
  assert.deepEqual(calls, ["a", "b"]);
});

test("runProviders skips missing capabilities and returns null on misses", async () => {
  assert.deepEqual(
    await runProviders(
      [{ name: "a" }, { name: "b", search: async () => ({ hit: "b" }) }],
      "search",
      "x",
      {},
    ),
    { hit: "b" },
  );
  assert.equal(
    await runProviders([{ name: "a", search: async () => null }], "search", "x", {}),
    null,
  );
});

test("unfilled process capability is graceful", async () => {
  assert.equal(await runCapability("bgm", "process", "x", {}), null);
});
