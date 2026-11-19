import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ALL_MODEL_IDS,
  ASPECT_RATIOS,
  MAX_IMAGES,
  PROMPT_MAX,
  SKILL_VERSION,
} from "../scripts/lib/contract.mjs";
import {
  aspectRatioToFrameSize,
  buildPayload,
  estimateGifSheet,
  normalizeFrameCount,
  normalizeFrameDurationMs,
  normalizeFrameSize,
  normalizeModelInput,
  normalizePrompt,
  normalizeQuality,
  normalizeResolution,
  normalizeSourceEntry,
  resolveModel,
} from "../scripts/lib/payload.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/schemas-2026-11-06.json", import.meta.url), "utf8"));
const schemas = fixtures.schemas;
const pricingFixture = JSON.parse(readFileSync(new URL("./fixtures/pricing-2026-11-06.json", import.meta.url), "utf8"));

/** Validates a built payload against the captured public schema. */
function validateAgainstSchema(payload) {
  const schema = schemas[payload.model];
  assert.ok(schema, `no captured schema for ${payload.model}`);
  const props = schema.properties;
  const input = payload.input;
  for (const [key, value] of Object.entries(input)) {
    const spec = props[key];
    assert.ok(spec, `${payload.model}: unexpected property ${key}`);
    if (spec.enum) assert.ok(spec.enum.includes(value), `${key}=${value} not in schema enum`);
    if (spec.type === "string" && spec.maxLength) assert.ok(String(value).length <= spec.maxLength, `${key} too long`);
    if (spec.type === "string" && spec.minLength) assert.ok(String(value).length >= spec.minLength, `${key} too short`);
    if (spec.type === "integer") {
      if (spec.minimum !== undefined) assert.ok(Number.isInteger(value) && value >= spec.minimum, `${key} below minimum`);
      if (spec.maximum !== undefined) assert.ok(value <= spec.maximum, `${key} above maximum`);
    }
    if (spec.type === "array") {
      assert.ok(Array.isArray(value), `${key} must be an array`);
      if (spec.minItems !== undefined) assert.ok(value.length >= spec.minItems, `${key} below minItems`);
      if (spec.maxItems !== undefined) assert.ok(value.length <= spec.maxItems, `${key} above maxItems`);
    }
    if (spec.pattern) assert.ok(new RegExp(spec.pattern).test(String(value)), `${key} does not match ${spec.pattern}`);
  }
  for (const key of schema.required) {
    // `model` sits at the top level of the request envelope, not inside input.
    if (key === "model") {
      assert.equal(payload.model, input.model ?? payload.model, "model must match the wrapped schema");
      assert.ok(payload.model, "model missing");
      continue;
    }
    assert.ok(key in input, `required ${key} missing`);
  }
  // allOf checks, applied literally from the captured schema.
  for (const rule of schema.allOf) {
    const ifPart = rule.if || {};
    const applies = (() => {
      for (const key of ifPart.required || []) if (!(key in input)) return false;
      for (const [key, condition] of Object.entries(ifPart.properties || {})) {
        if (!(key in input)) return false;
        if (condition.enum && !condition.enum.includes(input[key])) return false;
      }
      return true;
    })();
    if (!applies) continue;
    const then = rule.then || {};
    for (const key of then.required || []) if (!(key in input)) throw new Error(`allOf requires ${key}`);
    for (const [key, condition] of Object.entries(then.properties || {})) {
      if (!(key in input)) continue;
      if (condition.enum && !condition.enum.includes(input[key])) throw new Error(`allOf: ${key}=${input[key]} not allowed`);
    }
    if (then.not?.required) {
      for (const key of then.not.required) assert.ok(!(key in input), `allOf: ${key} is forbidden here`);
    }
  }
  return true;
}

test("version and schema snapshot agree that fixtures are current", () => {
  assert.equal(SKILL_VERSION, "1.0.2");
  assert.equal(Object.keys(schemas).length, 4);
  assert.equal(pricingFixture.rows.length, 4);
  assert.match(fixtures._capturedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test("default payload is text-to-image with explicit quality, resolution and format", () => {
  const built = buildPayload({ prompt: "a quiet alpine lake at dawn" });
  assert.equal(built.payload.model, "gpt-image-2.6-flare/text-to-image");
  assert.deepEqual(built.payload.input, {
    prompt: "a quiet alpine lake at dawn",
    aspect_ratio: "auto",
    quality: "high",
    resolution: "1K",
    output_format: "png",
  });
  validateAgainstSchema(built.payload);
});

test("reference images switch to image-to-image and keep every explicit default", () => {
  const built = buildPayload({
    prompt: "make the sky purple",
    imageSources: ["https://example.com/a.png"],
  });
  assert.equal(built.payload.model, "gpt-image-2.6-flare/image-to-image");
  assert.deepEqual(built.payload.input.image_urls, ["https://example.com/a.png"]);
  assert.equal(built.payload.input.quality, "high");
  validateAgainstSchema(built.payload);
  assert.equal(built.referenceImages, 1);
  assert.deepEqual(built.localSources, []);
});

test("every quality, resolution and aspect ratio combination validates against the schema", () => {
  for (const model of ADVANCED_MODELS()) {
    for (const quality of ["low", "medium", "high", "xhigh", "max"]) {
      for (const resolution of ["1K", "2K", "4K"]) {
        for (const aspect of ASPECT_RATIOS) {
          const options = { prompt: "p", model, quality, resolution, aspectRatio: aspect };
          if (model.endsWith("/image-to-image")) options.imageSources = ["https://example.com/a.png"];
          const built = buildPayload(options);
          validateAgainstSchema(built.payload);
        }
      }
    }
  }
});

function ADVANCED_MODELS() {
  return ALL_MODEL_IDS;
}

test("svg and gif are text-to-image only", () => {
  for (const flag of ["svg", "gif"]) {
    assert.throws(
      () => buildPayload({ prompt: "p", imageSources: ["https://x/a.png"], [flag]: true }),
      /text-to-image only/,
    );
    assert.throws(
      () => buildPayload({ prompt: "p", imageSources: ["https://x/a.png"], outputFormat: flag }),
      /text-to-image only/,
    );
  }
});

test("schema defaults are written explicitly so estimate and charge agree", () => {
  const built = buildPayload({ prompt: "p", quality: "low" });
  assert.equal(built.payload.input.quality, "low");
  assert.equal(built.payload.input.resolution, "1K", "resolution must not rely on the server default");
  assert.equal(built.payload.input.output_format, "png", "format must not rely on the server default");
});

test("prompt limits: 32000 accepted, 32001 rejected, trimming before counting", () => {
  assert.equal(PROMPT_MAX, 32000);
  const max = "x".repeat(PROMPT_MAX);
  assert.equal(normalizePrompt(max).length, PROMPT_MAX);
  assert.equal(normalizePrompt(`  ${max}\n`), max);
  assert.throws(() => normalizePrompt(`${max}x`), /at most 32000/);
  assert.throws(() => normalizePrompt("   "), /non-empty prompt/);
  // Astral characters count as two UTF-16 units, matching JavaScript length.
  assert.throws(() => normalizePrompt("😀".repeat(16001)), /at most 32000/);
});

test("mask and markup are mutually exclusive and image-to-image only", () => {
  assert.throws(
    () => buildPayload({ prompt: "p", imageSources: ["https://x/a.png"], mask: "https://x/m.png", markup: "https://x/u.png" }),
    /cannot be combined/,
  );
  assert.throws(() => buildPayload({ prompt: "p", mask: "https://x/m.png" }), /image-to-image only/);
  const built = buildPayload({ prompt: "p", imageSources: ["https://x/a.png"], mask: "https://x/m.png" });
  assert.equal(built.payload.input.mask_url, "https://x/m.png");
  validateAgainstSchema(built.payload);
  const markup = buildPayload({ prompt: "p", imageSources: ["https://x/a.png"], markup: "/tmp/u.png" });
  assert.equal(markup.payload.input.markup_url, "/tmp/u.png");
});

test("background, compression and format cross-field rules", () => {
  assert.throws(
    () => buildPayload({ prompt: "p", background: "transparent", outputFormat: "jpeg" }),
    /transparent background requires png or webp/,
  );
  validateAgainstSchema(buildPayload({ prompt: "p", background: "transparent" }).payload);
  assert.throws(
    () => buildPayload({ prompt: "p", outputFormat: "gif", outputCompression: 50 }),
    /output_compression requires jpeg or webp/,
  );
  const jpeg = buildPayload({ prompt: "p", outputFormat: "jpeg", outputCompression: 80 });
  assert.equal(jpeg.payload.input.output_compression, 80);
  validateAgainstSchema(jpeg.payload);
  assert.throws(() => buildPayload({ prompt: "p", outputCompression: 101 }), /between 0 and 100/);
  assert.throws(() => buildPayload({ prompt: "p", outputCompression: "half" }), /between 0 and 100/);
});

test("image_urls count is bounded at 16", () => {
  const urls = (n) => Array.from({ length: n }, (_, i) => `https://x/${i}.png`);
  assert.equal(buildPayload({ prompt: "p", imageSources: urls(MAX_IMAGES) }).payload.input.image_urls.length, MAX_IMAGES);
  assert.throws(() => buildPayload({ prompt: "p", imageSources: urls(17) }), /At most 16/);
  validateAgainstSchema(buildPayload({ prompt: "p", imageSources: urls(16) }).payload);
});

test("frame fields require gif output and give the fix in the message", () => {
  for (const options of [{ frameSize: "512x512" }, { frameCount: 9 }, { frameDurationMs: 200 }]) {
    const flag = Object.keys(options)[0];
    assert.throws(() => buildPayload({ prompt: "p", ...options }), /only applies to GIF output/);
  }
  const gif = buildPayload({ prompt: "p", gif: true, frameCount: 12, frameDurationMs: 150 });
  assert.equal(gif.payload.input.frame_count, 12);
  assert.equal(gif.payload.input.frame_duration_ms, 150);
  validateAgainstSchema(gif.payload);
});

test("gif converts a non-auto aspect ratio into frame_size and omits aspect_ratio", () => {
  const built = buildPayload({ prompt: "bouncing ball", gif: true, aspectRatio: "16:9" });
  assert.equal(built.payload.input.frame_size, "912x512");
  assert.ok(!("aspect_ratio" in built.payload.input), "aspect_ratio must be omitted for GIF");
  assert.match(built.adjustments[0], /aspect_ratio 16:9 . frame_size 912x512/);
  validateAgainstSchema(built.payload);
  for (const [ratio, expected] of [
    ["1:1", "512x512"],
    ["9:16", "512x912"],
    ["4:3", "688x512"],
    ["3:2", "768x512"],
    ["1:3", "512x1536"],
  ]) {
    assert.equal(aspectRatioToFrameSize(ratio).width + "x" + aspectRatioToFrameSize(ratio).height, expected, ratio);
  }
});

test("gif keeps aspect_ratio unset when auto, and accepts an explicit frame_size", () => {
  const auto = buildPayload({ prompt: "p", gif: true, aspectRatio: "auto" });
  assert.equal(auto.payload.input.frame_size, "512x512");
  assert.ok(!("aspect_ratio" in auto.payload.input));
  const explicit = buildPayload({ prompt: "p", gif: true, frameSize: "768x432" });
  assert.equal(explicit.payload.input.frame_size, "768x432");
  assert.throws(() => buildPayload({ prompt: "p", gif: true, frameSize: "500x500" }), /multiples of 16/);
});

test("gif frame_size='auto' resolves to the documented default", () => {
  const built = buildPayload({ prompt: "p", gif: true, frameSize: "auto" });
  assert.equal(built.payload.input.frame_size, "512x512");
  assert.match(built.adjustments.join(" "), /auto . 512x512/);
});

test("conflicting aspect ratio and frame size is refused with both shapes shown", () => {
  assert.throws(
    () => buildPayload({ prompt: "p", gif: true, aspectRatio: "16:9", frameSize: "512x512" }),
    /cannot both shape a GIF/,
  );
});

test("gif contact-sheet warnings are advisory, not blocking", () => {
  const huge = estimateGifSheet("3840x3840", 16);
  assert.ok(huge.warnings.length >= 1);
  const built = buildPayload({ prompt: "p", gif: true, frameSize: "3840x3840", frameCount: 16 });
  assert.ok(built.warnings.some((w) => /contact sheet may be rejected/.test(w)));
  assert.ok(built.payload.input.frame_size, "a warned payload is still built");
  const small = buildPayload({ prompt: "p", gif: true, frameCount: 9 });
  assert.deepEqual(small.warnings, []);
});

test("frame count and duration bounds follow the schema", () => {
  assert.throws(() => normalizeFrameCount(1), /between 2 and 16/);
  assert.throws(() => normalizeFrameCount(17), /between 2 and 16/);
  assert.throws(() => normalizeFrameCount(4.5), /integer/);
  assert.equal(normalizeFrameCount(2), 2);
  assert.throws(() => normalizeFrameDurationMs(19), /at least 20/);
  assert.equal(normalizeFrameDurationMs(23), 20, "the API rounds to 10 ms steps");
  assert.equal(normalizeFrameDurationMs(200), 200);
});

test("frame_size must be a multiple of 16 and not an aspect-ratio name", () => {
  assert.equal(normalizeFrameSize("512x512"), "512x512");
  assert.throws(() => normalizeFrameSize("16:9"), /WIDTHxHEIGHT/);
  assert.throws(() => normalizeFrameSize("100x100"), /multiples of 16/);
});

test("model resolution: family and images choose the mode; 2.5 IDs are mapped", () => {
  assert.equal(resolveModel({}, false).model, "gpt-image-2.6-flare/text-to-image");
  assert.equal(resolveModel({}, true).model, "gpt-image-2.6-flare/image-to-image");
  assert.equal(resolveModel({ family: "sunburst" }, false).model, "gpt-image-2.6-sunburst/text-to-image");
  assert.equal(resolveModel({ family: "SUNBURST" }, true).model, "gpt-image-2.6-sunburst/image-to-image");
  assert.throws(() => resolveModel({ family: "nova" }, false), /Unsupported family/);
});

test("all six 2.5 IDs map to the matching 2.6 model with a note", () => {
  const cases = [
    ["gpt-image-2.5-flare/text-to-image", false, "gpt-image-2.6-flare/text-to-image"],
    ["gpt-image-2.5-flare/image-to-image", true, "gpt-image-2.6-flare/image-to-image"],
    ["gpt-image-2.5-sunburst/text-to-image", false, "gpt-image-2.6-sunburst/text-to-image"],
    ["gpt-image-2.5-sunburst/image-to-image", true, "gpt-image-2.6-sunburst/image-to-image"],
    ["gpt-image-2.5-flare@pro", false, "gpt-image-2.6-flare/text-to-image"],
    ["gpt-image-2.5-flare@pro", true, "gpt-image-2.6-flare/image-to-image"],
    ["gpt-image-2.5-sunburst@pro", false, "gpt-image-2.6-sunburst/text-to-image"],
    ["gpt-image-2.5-sunburst@pro", true, "gpt-image-2.6-sunburst/image-to-image"],
  ];
  for (const [legacy, hasImages, expected] of cases) {
    const result = normalizeModelInput(legacy, { hasImages });
    assert.equal(result.model, expected, legacy);
    assert.match(result.note, /2\.6|@pro/, legacy);
  }
});

test("family-only and @pro spellings expand, other IDs are rejected with the list", () => {
  assert.equal(normalizeModelInput("gpt-image-2.6-flare", { hasImages: true }).model, "gpt-image-2.6-flare/image-to-image");
  assert.equal(normalizeModelInput("gpt-image-2.6-sunburst@pro", {}).model, "gpt-image-2.6-sunburst/text-to-image");
  for (const bad of ["gpt-image-2.5-flare", "gpt-image-2.0", "dall-e-3", "gpt-image-2.6-nova/text-to-image"]) {
    assert.throws(() => normalizeModelInput(bad), /Unsupported model ID/);
  }
});

test("explicit model must agree with family and with the presence of images", () => {
  assert.throws(
    () => buildPayload({ prompt: "p", model: "gpt-image-2.6-flare/text-to-image", imageSources: ["https://x/a.png"] }),
    /does not accept image_urls/,
  );
  assert.throws(
    () => buildPayload({ prompt: "p", model: "gpt-image-2.6-flare/image-to-image" }),
    /requires 1–16 reference images/,
  );
  assert.throws(
    () => buildPayload({ prompt: "p", model: "gpt-image-2.6-sunburst/text-to-image", family: "flare" }),
    /conflicts with --model/,
  );
});

test("--route pro is accepted but does not change the model", () => {
  const built = buildPayload({ prompt: "p", route: "pro", quality: "low" });
  assert.equal(built.payload.model, "gpt-image-2.6-flare/text-to-image");
  assert.equal(built.payload.input.quality, "low");
  assert.match(built.notes.join(" "), /--route pro is ignored/);
});

test("enums reject unknown values and name the accepted set", () => {
  assert.throws(() => normalizeQuality("ultra"), /Use one of: low, medium, high, xhigh, max/);
  assert.throws(() => normalizeResolution("8K"), /Use one of: 1K, 2K, 4K/);
  assert.throws(() => buildPayload({ prompt: "p", aspectRatio: "2.5:1" }), /Unsupported aspect ratio/);
  assert.throws(() => buildPayload({ prompt: "p", complexity: "extreme" }), /Unsupported complexity/);
  assert.throws(() => buildPayload({ prompt: "p", moderation: "strict" }), /Unsupported moderation/);
  assert.throws(() => buildPayload({ prompt: "p", background: "translucent" }), /Unsupported background/);
});

test("local sources are accepted by shape and deferred to the upload step", () => {
  assert.equal(normalizeSourceEntry("./photo.png", "image_urls"), "./photo.png");
  assert.equal(normalizeSourceEntry("https://x/a.png", "image_urls"), "https://x/a.png");
  for (const bad of ["file:///tmp/a.png", "data:image/png;base64,AA", "asset://x"]) {
    assert.throws(() => normalizeSourceEntry(bad, "image_urls"), /HTTP\(S\) URL or a local file path/);
  }
  assert.throws(() => normalizeSourceEntry("https://user:pw@x/a.png", "image_urls"), /credentials/);
  const built = buildPayload({ prompt: "p", imageSources: ["./photo.png", "https://x/b.png"] });
  assert.deepEqual(built.localSources, ["./photo.png"]);
});

test("a local mask or markup is uploaded even when every reference image is a URL", () => {
  const masked = buildPayload({ prompt: "p", imageSources: ["https://x/a.png"], mask: "./mask.png" });
  assert.deepEqual(masked.localSources, ["./mask.png"]);
  const marked = buildPayload({ prompt: "p", imageSources: ["https://x/a.png"], markup: "./notes.png" });
  assert.deepEqual(marked.localSources, ["./notes.png"]);
  const remote = buildPayload({ prompt: "p", imageSources: ["https://x/a.png"], mask: "https://x/m.png" });
  assert.deepEqual(remote.localSources, []);
});

test("--svg and --gif conflict with a contradictory explicit format", () => {
  assert.throws(() => buildPayload({ prompt: "p", svg: true, outputFormat: "png" }), /conflicts with --output-format/);
  assert.throws(() => buildPayload({ prompt: "p", gif: true, svg: true }), /conflicts/);
});
