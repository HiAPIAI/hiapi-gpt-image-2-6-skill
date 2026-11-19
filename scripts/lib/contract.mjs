// Public contract for GPT Image 2.6 (frozen 2026-11-06 from api.hiapi.ai).
// Every constant here mirrors a live public schema or pricing row; the
// contract check compares them and fails loudly when they drift.

export const SKILL_ID = "hiapi-gpt-image-2-6";
export const SKILL_VERSION = "1.0.2";

export const FAMILIES = Object.freeze({
  flare: "gpt-image-2.6-flare",
  sunburst: "gpt-image-2.6-sunburst",
});
export const TEXT_TO_IMAGE = "text-to-image";
export const IMAGE_TO_IMAGE = "image-to-image";
export const MODE_MODELS = Object.freeze({
  flareTextToImage: "gpt-image-2.6-flare/text-to-image",
  flareImageToImage: "gpt-image-2.6-flare/image-to-image",
  sunburstTextToImage: "gpt-image-2.6-sunburst/text-to-image",
  sunburstImageToImage: "gpt-image-2.6-sunburst/image-to-image",
});
export const ALL_MODEL_IDS = Object.freeze(Object.values(MODE_MODELS));

// GPT Image 2.5 IDs map onto their 2.6 equivalent (same family, same mode).
// `@pro` has no mode of its own: the mode follows whether reference images are
// supplied, because every 2.6 model accepts `quality` directly.
export const LEGACY_2_5_MODELS = Object.freeze({
  "gpt-image-2.5-flare/text-to-image": "gpt-image-2.6-flare/text-to-image",
  "gpt-image-2.5-flare/image-to-image": "gpt-image-2.6-flare/image-to-image",
  "gpt-image-2.5-sunburst/text-to-image": "gpt-image-2.6-sunburst/text-to-image",
  "gpt-image-2.5-sunburst/image-to-image": "gpt-image-2.6-sunburst/image-to-image",
  "gpt-image-2.5-flare@pro": "gpt-image-2.6-flare",
  "gpt-image-2.5-sunburst@pro": "gpt-image-2.6-sunburst",
});

export const DEFAULT_BASE_URL = "https://api.hiapi.ai";
export const DEFAULT_SITE_URL = "https://api.hiapi.ai";
export const HIAPI_API_KEYS_URL = "https://console.hiapi.ai/en/dashboard/api-keys";
export const HIAPI_DASHBOARD_URL = "https://console.hiapi.ai/en/dashboard";
export const HIAPI_PRICING_URL = "https://hiapi.ai/en/pricing";
export const HIAPI_DOCS_URL = "https://hiapi.ai/docs/";
export const MODEL_PAGE_URL_PREFIX = "https://hiapi.ai/en/models/";
export const MODEL_PAGE_URL_PREFIX_ZH = "https://hiapi.ai/zh/models/";

export const ASPECT_RATIOS = Object.freeze([
  "auto",
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "5:4",
  "4:5",
  "16:9",
  "9:16",
  "2:1",
  "1:2",
  "21:9",
  "9:21",
  "3:1",
  "1:3",
]);
export const QUALITIES = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
export const RESOLUTIONS = Object.freeze(["1K", "2K", "4K"]);
export const BACKGROUNDS = Object.freeze(["auto", "opaque", "transparent"]);
export const COMPLEXITIES = Object.freeze(["low", "medium", "high"]);
export const MODERATIONS = Object.freeze(["auto", "low"]);
export const TEXT_OUTPUT_FORMATS = Object.freeze(["png", "jpeg", "webp", "gif", "svg"]);
export const IMAGE_OUTPUT_FORMATS = Object.freeze(["png", "jpeg", "webp"]);
export const DEFAULT_QUALITY = "high";
export const DEFAULT_RESOLUTION = "1K";
export const DEFAULT_ASPECT_RATIO = "auto";
export const DEFAULT_OUTPUT_FORMAT = "png";
export const DEFAULT_FRAME_SIZE = "512x512";
// GIF frame defaults applied upstream when the fields are omitted. The public
// schema states them only in the field descriptions ("Omitted uses 9" /
// "Omitted uses 200"): the `default` keys were removed on 2026-11-11 so that
// clients filling schema defaults do not send GIF-only fields with png output.
// Used locally for sheet-size estimates only; never sent unless the user asks.
export const DEFAULT_FRAME_COUNT = 9;
export const DEFAULT_FRAME_DURATION_MS = 200;
export const FRAME_COUNT_MIN = 2;
export const FRAME_COUNT_MAX = 16;
export const FRAME_DURATION_MIN = 20;
export const FRAME_SIZE_MULTIPLE = 16;
export const FRAME_DURATION_STEP_MS = 10;
export const PROMPT_MAX = 32000;
export const MAX_IMAGES = 16;
export const OUTPUT_COMPRESSION_MIN = 0;
export const OUTPUT_COMPRESSION_MAX = 100;

// GIF contact-sheet limits, as stated by the public `frame_size` description.
// These are used for a warning only: the service rejects an oversized sheet at
// submission without charging, so the client must not hard-block on a guess.
export const GIF_SHEET_MAX_EDGE = 3840;
export const GIF_SHEET_MAX_PIXELS = 8294400;
export const GIF_SHEET_MAX_RATIO = 3;
export const GIF_768_MAX_FRAMES = 12;

// Upload path: POST /v1/uploads (multipart field `file`).
export const UPLOAD_PATH = "/v1/uploads";
export const UPLOAD_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // common.PlaygroundUploadMaxImageBytes
export const UPLOAD_IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const TASK_INPUT_IMAGE_TYPES = Object.freeze(["png", "jpeg", "webp"]);

export const REFERENCE_IMAGE_ADDON_USD = 0.012;

export const POLL_INTERVAL_MS = 3000;
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;
export const UPDATE_COMMAND = "npx -y github:HiAPIAI/hiapi-gpt-image-2-6-skill -y";

/** Public shape of each model's `input_schema`, mirrored from the live API. */
export const SCHEMA_CONTRACT = Object.freeze({
  prompt: { type: "string", minLength: 1, maxLength: PROMPT_MAX },
  quality: { enum: QUALITIES, default: DEFAULT_QUALITY },
  resolution: { enum: RESOLUTIONS, default: DEFAULT_RESOLUTION },
  aspect_ratio: { enum: ASPECT_RATIOS, default: DEFAULT_ASPECT_RATIO },
  background: { enum: BACKGROUNDS },
  complexity: { enum: COMPLEXITIES },
  moderation: { enum: MODERATIONS },
  output_compression: { type: "integer", minimum: OUTPUT_COMPRESSION_MIN, maximum: OUTPUT_COMPRESSION_MAX },
  text_to_image: {
    properties: [
      "aspect_ratio",
      "background",
      "complexity",
      "frame_count",
      "frame_duration_ms",
      "frame_size",
      "model",
      "moderation",
      "output_compression",
      "output_format",
      "prompt",
      "quality",
      "resolution",
    ],
    required: ["prompt", "model"],
    output_format: { enum: TEXT_OUTPUT_FORMATS, default: DEFAULT_OUTPUT_FORMAT },
    frame_size: { pattern: "^(auto|[0-9]+x[0-9]+)$" },
    frame_count: { type: "integer", minimum: FRAME_COUNT_MIN, maximum: FRAME_COUNT_MAX },
    frame_duration_ms: { type: "integer", minimum: FRAME_DURATION_MIN },
  },
  image_to_image: {
    properties: [
      "aspect_ratio",
      "background",
      "complexity",
      "image_urls",
      "markup_url",
      "mask_url",
      "model",
      "moderation",
      "output_compression",
      "output_format",
      "prompt",
      "quality",
      "resolution",
    ],
    required: ["prompt", "image_urls", "model"],
    output_format: { enum: IMAGE_OUTPUT_FORMATS, default: DEFAULT_OUTPUT_FORMAT },
    image_urls: { type: "array", minItems: 1, maxItems: MAX_IMAGES },
  },
});

/**
 * Cross-field (`allOf`) constraints, normalized to stable strings so the
 * contract check can compare the live schema's rule set with this one.
 */
export const ALL_OF_CONSTRAINTS = Object.freeze({
  text_to_image: Object.freeze([
    "background=transparent then output_format in [png,webp]",
    "frame_count then output_format in [gif] (required)",
    "frame_duration_ms then output_format in [gif] (required)",
    "frame_size then output_format in [gif] (required)",
    "output_compression then output_format in [jpeg,webp] (required)",
    "output_format=gif and aspect_ratio then aspect_ratio in [auto]",
  ]),
  image_to_image: Object.freeze([
    "background=transparent then output_format in [png,webp]",
    "mask_url then not markup_url",
    "output_compression then output_format in [jpeg,webp] (required)",
  ]),
});

export class SkillError extends Error {
  constructor(message, { code, next } = {}) {
    super(message);
    this.name = "SkillError";
    if (code) this.code = code;
    if (next) this.next = next;
  }
}

export function errorSummary(body) {
  return String(
    body?.error?.message ||
      body?.data?.error?.message ||
      body?.message ||
      body?.data?.message ||
      (typeof body === "string" ? body : body ? JSON.stringify(body) : "") ||
      "Unknown error",
  ).slice(0, 600);
}

export function errorCodeOf(body) {
  const code =
    body?.error_code ||
    body?.data?.error_code ||
    body?.error?.code ||
    body?.data?.error?.code ||
    body?.code;
  return typeof code === "string" ? code : undefined;
}

export function compareVersions(a, b) {
  const parse = (value) => String(value ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}
