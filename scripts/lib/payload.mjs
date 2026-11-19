// Payload construction and local validation.
//
// Every value is validated against the frozen public schema before any network
// call, and `quality`, `resolution` and `output_format` are always written into
// the payload explicitly (even when they equal the server default) so the
// estimate and the charged amount are computed from the same inputs.
import {
  ALL_MODEL_IDS,
  ASPECT_RATIOS,
  BACKGROUNDS,
  COMPLEXITIES,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_FRAME_COUNT,
  DEFAULT_FRAME_SIZE,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_QUALITY,
  DEFAULT_RESOLUTION,
  DEFAULT_TIMEOUT_MINUTES,
  FRAME_COUNT_MAX,
  FRAME_COUNT_MIN,
  FRAME_DURATION_MIN,
  FRAME_DURATION_STEP_MS,
  FRAME_SIZE_MULTIPLE,
  FAMILIES,
  GIF_768_MAX_FRAMES,
  GIF_SHEET_MAX_EDGE,
  GIF_SHEET_MAX_PIXELS,
  GIF_SHEET_MAX_RATIO,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_TO_IMAGE,
  LEGACY_2_5_MODELS,
  MAX_IMAGES,
  MODERATIONS,
  OUTPUT_COMPRESSION_MAX,
  OUTPUT_COMPRESSION_MIN,
  PROMPT_MAX,
  QUALITIES,
  RESOLUTIONS,
  SCHEMA_CONTRACT,
  SkillError,
  TEXT_OUTPUT_FORMATS,
  TEXT_TO_IMAGE,
} from "./contract.mjs";

const MODE_SUFFIX = new RegExp(`^/(${TEXT_TO_IMAGE}|${IMAGE_TO_IMAGE})$`);

export function modeOf(model) {
  if (!ALL_MODEL_IDS.includes(model)) return null;
  return model.endsWith(`/${IMAGE_TO_IMAGE}`) ? IMAGE_TO_IMAGE : TEXT_TO_IMAGE;
}

export function familyOf(model) {
  for (const [family, base] of Object.entries(FAMILIES)) {
    if (model.startsWith(`${base}/`)) return family;
  }
  return null;
}

/**
 * Maps a supplied model ID onto a 2.6 model. Legacy 2.5 IDs (and the family
 * `@pro` spellings) are translated and reported through `note`; anything else
 * is rejected with the accepted IDs.
 */
export function normalizeModelInput(value, { hasImages = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new SkillError("Model ID must not be empty.");
  if (ALL_MODEL_IDS.includes(raw)) return { model: raw, note: null };

  const legacyMode = LEGACY_2_5_MODELS[raw];
  if (legacyMode) {
    const mapped = legacyMode.endsWith(`/`) || !legacyMode.includes("/") ? `${legacyMode}/${hasImages ? IMAGE_TO_IMAGE : TEXT_TO_IMAGE}` : legacyMode;
    return {
      model: mapped,
      note: `Mapped ${raw} to ${mapped}: GPT Image 2.6 has one model per family and takes quality directly, so the 2.5 @pro route no longer exists.`,
    };
  }
  // Family-only spellings such as `gpt-image-2.6-flare` are accepted as sugar
  // for the mode that matches the inputs.
  for (const [family, base] of Object.entries(FAMILIES)) {
    if (raw === base) {
      const mapped = `${base}/${hasImages ? IMAGE_TO_IMAGE : TEXT_TO_IMAGE}`;
      return { model: mapped, note: `Expanded ${raw} to ${mapped} (mode chosen from the reference images).` };
    }
  }
  if (raw.endsWith("@pro")) {
    const base = raw.slice(0, -"@pro".length);
    if (Object.values(FAMILIES).includes(base)) {
      const mapped = `${base}/${hasImages ? IMAGE_TO_IMAGE : TEXT_TO_IMAGE}`;
      return {
        model: mapped,
        note: `GPT Image 2.6 has no @pro route: every 2.6 model takes quality directly. Mapped ${raw} to ${mapped}.`,
      };
    }
  }
  throw new SkillError(
    `Unsupported model ID "${raw}". GPT Image 2.6 accepts: ${ALL_MODEL_IDS.join(", ")}.`,
    { code: "INVALID_REQUEST", next: `Use --family flare|sunburst (default flare) and let the CLI pick the mode, or pass one of the four 2.6 IDs above.` },
  );
}

/**
 * Chooses the model ID for this request: an explicit --model wins (and must
 * agree with --family), otherwise --family plus the presence of reference
 * images decide. `--route pro` is accepted but ignored.
 */
export function resolveModel(options = {}, hasImages = false) {
  const family = options.family == null ? null : normalizeFamily(options.family);
  const explicit = options.model ?? options.modelId;
  if (explicit != null) {
    const { model, note } = normalizeModelInput(explicit, { hasImages });
    const mode = modeOf(model);
    if (hasImages && mode === TEXT_TO_IMAGE) {
      throw new SkillError(
        `${model} does not accept image_urls; the CLI selects the image-to-image model when reference images are present.`,
        { code: "INVALID_REQUEST", next: `Drop --model or use ${model.replace(MODE_SUFFIX, `/${IMAGE_TO_IMAGE}`)}.` },
      );
    }
    if (!hasImages && mode === IMAGE_TO_IMAGE) {
      throw new SkillError(
        `${model} requires 1–16 reference images; add --image/--image-url or use the text-to-image model.`,
        { code: "INVALID_REQUEST", next: `Add at least one --image <path> or --image-url <url>, or use ${model.replace(MODE_SUFFIX, `/${TEXT_TO_IMAGE}`)}.` },
      );
    }
    if (family && familyOf(model) !== family) {
      throw new SkillError(`--family ${family} conflicts with --model ${model}.`, {
        code: "INVALID_REQUEST",
        next: `Remove --family or use the ${family} model.`,
      });
    }
    return { model, note, family: familyOf(model) };
  }
  const resolvedFamily = family || "flare";
  const base = FAMILIES[resolvedFamily];
  const model = `${base}/${hasImages ? IMAGE_TO_IMAGE : TEXT_TO_IMAGE}`;
  const note = options.route
    ? "GPT Image 2.6 prices quality per model, so --route pro is ignored; use --quality instead."
    : null;
  return { model, note, family: resolvedFamily };
}

export function normalizeFamily(value = "flare") {
  const v = String(value).trim().toLowerCase();
  if (!Object.hasOwn(FAMILIES, v)) {
    throw new SkillError(`Unsupported family "${value}". Use flare or sunburst.`, {
      code: "INVALID_REQUEST",
      next: "Run with --family flare (faster iteration) or --family sunburst (more consistent multi-round edits at medium quality and above).",
    });
  }
  return v;
}

function enumValue(value, fallback, allowed, label, hint) {
  if (value == null || value === "") return fallback;
  const v = String(value).trim().toLowerCase();
  const match = allowed.find((item) => item.toLowerCase() === v);
  if (!match) {
    throw new SkillError(`Unsupported ${label} "${value}". Use one of: ${allowed.join(", ")}.`, {
      code: "INVALID_REQUEST",
      next: hint,
    });
  }
  return match;
}

export function normalizeQuality(value) {
  return enumValue(value, DEFAULT_QUALITY, QUALITIES, "quality", "Example: --quality medium. Omitted uses high.");
}

export function normalizeResolution(value) {
  const v = String(value ?? DEFAULT_RESOLUTION).trim().toUpperCase();
  if (!RESOLUTIONS.includes(v)) {
    throw new SkillError(`Unsupported resolution "${value}". Use one of: ${RESOLUTIONS.join(", ")}.`, {
      code: "INVALID_REQUEST",
      next: "Example: --resolution 2K. Omitted uses 1K.",
    });
  }
  return v;
}

export function normalizeAspectRatio(value) {
  if (value == null || value === "") return null;
  const v = String(value).trim().toLowerCase();
  if (!ASPECT_RATIOS.includes(v)) {
    throw new SkillError(`Unsupported aspect ratio "${value}". Use one of: ${ASPECT_RATIOS.join(", ")}.`, {
      code: "INVALID_REQUEST",
      next: "Example: --aspect-ratio 16:9. Omitted uses auto.",
    });
  }
  return v;
}

export function normalizeBackground(value) {
  return enumValue(value, null, BACKGROUNDS, "background", "Use auto, opaque, or transparent.");
}

export function normalizeComplexity(value) {
  return enumValue(value, null, COMPLEXITIES, "complexity", "Use low for focused edits, high for dense text and complex layouts.");
}

export function normalizeModeration(value) {
  return enumValue(value, null, MODERATIONS, "moderation", "Use auto or low (the default).");
}

export function normalizePrompt(value) {
  const prompt = String(value ?? "").trim();
  if (!prompt) {
    throw new SkillError("A non-empty prompt is required.", {
      code: "INVALID_REQUEST",
      next: 'Pass the prompt as the first positional argument or with --prompt "...".',
    });
  }
  if (prompt.length > PROMPT_MAX) {
    throw new SkillError(`prompt must be at most ${PROMPT_MAX} characters (got ${prompt.length}).`, {
      code: "PROMPT_TOO_LONG",
      next: `Shorten the prompt to ${PROMPT_MAX} characters or fewer; the limit is counted after trimming surrounding whitespace.`,
    });
  }
  return prompt;
}

export function normalizeOutputFormat(value, mode) {
  const allowed = mode === TEXT_TO_IMAGE ? TEXT_OUTPUT_FORMATS : IMAGE_OUTPUT_FORMATS;
  const fallback = mode === TEXT_TO_IMAGE ? DEFAULT_OUTPUT_FORMAT : DEFAULT_OUTPUT_FORMAT;
  if (value == null || value === "") return fallback;
  const v = String(value).trim().toLowerCase();
  if (!allowed.includes(v)) {
    throw new SkillError(
      `Output format "${value}" is not available for ${mode}. Accepted: ${allowed.join(", ")}.`,
      {
        code: "INVALID_REQUEST",
        next:
          mode === IMAGE_TO_IMAGE
            ? "svg and gif are text-to-image only; drop the reference images or use png/jpeg/webp."
            : `Use one of ${allowed.join(", ")}.`,
      },
    );
  }
  return v;
}

function normalizeUrlEntry(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new SkillError(`${label} entries must not be empty.`, { code: "INVALID_REQUEST" });
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SkillError(`${label} must be a public HTTP(S) URL or a local file path.`, {
      code: "INVALID_REQUEST",
      next: "Local paths are uploaded to /v1/uploads first; pass an absolute or relative file path, or a public https URL.",
    });
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new SkillError(`${label} entries must be public HTTP(S) URLs without embedded credentials.`, {
      code: "INVALID_REQUEST",
    });
  }
  return raw;
}

export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? "").trim());
}

/**
 * Accepts a public URL or a local file path. Local paths are only checked for
 * shape here; the upload step (or the dry-run inspector) performs the file
 * checks, because a dry run must not require the network.
 */
export function normalizeSourceEntry(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new SkillError(`${label} must not be empty.`, { code: "INVALID_REQUEST" });
  if (isHttpUrl(raw)) return normalizeUrlEntry(raw, label);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (scheme) {
    throw new SkillError(`${label} must be a public HTTP(S) URL or a local file path (got a ${scheme[1]}: URI).`, {
      code: "INVALID_REQUEST",
      next:
        scheme[1].toLowerCase() === "data"
          ? "Save the image to a file and pass its path (it is uploaded to /v1/uploads), or host it and pass the https URL."
          : "Other schemes (file:, asset:, blob:) are not accepted; use https:// or a local file path.",
    });
  }
  return raw;
}

export function normalizeImageSources(value, { label = "image_urls", max = MAX_IMAGES } = {}) {
  if (value == null) return [];
  const list = (Array.isArray(value) ? value : [value]).map((item) => String(item ?? "").trim()).filter(Boolean);
  if (list.length > max) {
    throw new SkillError(`At most ${max} reference images are supported (got ${list.length}).`, {
      code: "INVALID_REQUEST",
      next: `Send at most ${max} --image/--image-url values.`,
    });
  }
  return list;
}

export function normalizeImageUrls(value, { label = "image_urls", max = MAX_IMAGES } = {}) {
  if (Array.isArray(value) && value.length === 0) {
    throw new SkillError(`${label} must be omitted for text-to-image; an empty array is invalid.`, {
      code: "INVALID_REQUEST",
    });
  }
  return normalizeImageSources(value, { label, max }).map((entry) => normalizeUrlEntry(entry, label));
}

/** Aspect-ratio name → { width, height } with the short edge on 512. */
export function aspectRatioToFrameSize(ratio, shortEdge = 512) {
  const match = /^(\d+):(\d+)$/.exec(String(ratio || ""));
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!w || !h) return null;
  const roundEdge = (value) => {
    // Nearest multiple of 16, never below one step.
    return Math.max(FRAME_SIZE_MULTIPLE, Math.round(value / FRAME_SIZE_MULTIPLE) * FRAME_SIZE_MULTIPLE);
  };
  const short = roundEdge(shortEdge);
  const longValue = (Math.max(w, h) / Math.min(w, h)) * short;
  const long = roundEdge(longValue);
  return w >= h ? { width: long, height: short } : { width: short, height: long };
}

export function normalizeFrameSize(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  const match = /^(\d+)x(\d+)$/.exec(raw);
  if (!match) {
    throw new SkillError(`Unsupported frame size "${value}". Use WIDTHxHEIGHT such as 512x512, or auto.`, {
      code: "INVALID_REQUEST",
      next: "Aspect-ratio names are not accepted for frame_size; the CLI converts --aspect-ratio automatically with --gif.",
    });
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  for (const [label, edge] of [["width", width], ["height", height]]) {
    if (!Number.isInteger(edge) || edge <= 0) {
      throw new SkillError(`frame_size ${label} must be a positive integer.`, { code: "INVALID_REQUEST" });
    }
  }
  if (width % FRAME_SIZE_MULTIPLE || height % FRAME_SIZE_MULTIPLE) {
    const snapped = { width: Math.round(width / FRAME_SIZE_MULTIPLE) * FRAME_SIZE_MULTIPLE, height: Math.round(height / FRAME_SIZE_MULTIPLE) * FRAME_SIZE_MULTIPLE };
    throw new SkillError(
      `frame_size ${width}x${height} is invalid: both edges must be multiples of ${FRAME_SIZE_MULTIPLE}.`,
      {
        code: "INVALID_REQUEST",
        next: `Use ${snapped.width}x${snapped.height} instead.`,
      },
    );
  }
  return `${width}x${height}`;
}

export function normalizeFrameCount(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < FRAME_COUNT_MIN || n > FRAME_COUNT_MAX) {
    throw new SkillError(`frame_count must be an integer between ${FRAME_COUNT_MIN} and ${FRAME_COUNT_MAX}.`, {
      code: "INVALID_REQUEST",
      next: `Example: --frame-count 9. Omitted uses 9.`,
    });
  }
  return n;
}

export function normalizeFrameDurationMs(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < FRAME_DURATION_MIN) {
    throw new SkillError(`frame_duration_ms must be an integer of at least ${FRAME_DURATION_MIN}.`, {
      code: "INVALID_REQUEST",
      next: "Example: --frame-duration-ms 200.",
    });
  }
  // The API rounds to 10 ms steps; do it here so the payload shows the billed value.
  return Math.round(n / FRAME_DURATION_STEP_MS) * FRAME_DURATION_STEP_MS;
}

export function normalizeOutputCompression(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < OUTPUT_COMPRESSION_MIN || n > OUTPUT_COMPRESSION_MAX) {
    throw new SkillError(`output_compression must be an integer between ${OUTPUT_COMPRESSION_MIN} and ${OUTPUT_COMPRESSION_MAX}.`, {
      code: "INVALID_REQUEST",
      next: "Example: --compression 80.",
    });
  }
  return n;
}

/**
 * Contact-sheet estimate for a GIF: frames are tiled into one sheet. The rule
 * below is inferred from the `frame_size` description; it is used to WARN
 * only, because the service rejects an oversized sheet at submission without
 * charging and the exact tiling is not public.
 */
export function estimateGifSheet(frameSize, frameCount) {
  const match = /^(\d+)x(\d+)$/.exec(String(frameSize || DEFAULT_FRAME_SIZE));
  if (!match) return null;
  const frameWidth = Number(match[1]);
  const frameHeight = Number(match[2]);
  const count = Number(frameCount || 0);
  if (!frameWidth || !frameHeight || !count) return null;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const sheetWidth = cols * frameWidth;
  const sheetHeight = rows * frameHeight;
  const pixels = sheetWidth * sheetHeight;
  const ratio = Math.max(sheetWidth / sheetHeight, sheetHeight / sheetWidth);
  const warnings = [];
  if (sheetWidth > GIF_SHEET_MAX_EDGE || sheetHeight > GIF_SHEET_MAX_EDGE) {
    warnings.push(`estimated sheet ${sheetWidth}x${sheetHeight} exceeds the ${GIF_SHEET_MAX_EDGE}px edge limit`);
  }
  if (pixels > GIF_SHEET_MAX_PIXELS) {
    warnings.push(`estimated sheet has ${pixels} pixels, above the ${GIF_SHEET_MAX_PIXELS} limit`);
  }
  if (ratio > GIF_SHEET_MAX_RATIO) {
    warnings.push(`estimated sheet aspect ratio ${ratio.toFixed(2)}:1 is above ${GIF_SHEET_MAX_RATIO}:1`);
  }
  return { cols, rows, frameWidth, frameHeight, sheetWidth, sheetHeight, pixels, ratio, warnings };
}

/**
 * Builds the request body plus the notes the CLI prints.
 *
 * Always-written fields: quality, resolution, output_format. Writing them
 * explicitly keeps the estimate and the charge on the same pricing row even if
 * the server default ever changes.
 */
export function buildPayload(options = {}) {
  const prompt = normalizePrompt(options.prompt);
  const imageSources = normalizeImageSources(
    options.imageSources ?? options.imageUrls ?? options.image_urls,
  );
  const hasImages = imageSources.length > 0;
  const resolved = resolveModel(options, hasImages);
  const mode = modeOf(resolved.model);
  const adjustments = [];
  const warnings = [];
  const notes = [];
  if (resolved.note) notes.push(resolved.note);

  const quality = normalizeQuality(options.quality);
  const resolution = normalizeResolution(options.resolution);

  let outputFormat = options.outputFormat ?? options.output_format;
  if (options.gif) {
    if (outputFormat && String(outputFormat).toLowerCase() !== "gif") {
      throw new SkillError(`--gif conflicts with --output-format ${outputFormat}.`, {
        code: "INVALID_REQUEST",
        next: "Use --gif alone, or drop --gif and pass --output-format yourself.",
      });
    }
    outputFormat = "gif";
  }
  if (options.svg) {
    if (outputFormat && String(outputFormat).toLowerCase() !== "svg") {
      throw new SkillError(`--svg conflicts with --output-format ${outputFormat}.`, {
        code: "INVALID_REQUEST",
        next: "Use --svg alone, or drop --svg and pass --output-format yourself.",
      });
    }
    outputFormat = "svg";
  }
  if (mode === IMAGE_TO_IMAGE && ["svg", "gif"].includes(String(outputFormat ?? "").toLowerCase())) {
    throw new SkillError(
      `svg is text-to-image only; ${resolved.model} cannot output svg or gif.`,
      {
        code: "INVALID_REQUEST",
        next: "Drop --image/--image-url to use --svg or --gif, or keep the edit and use --format png|jpeg|webp.",
      },
    );
  }
  const format = normalizeOutputFormat(outputFormat, mode);

  const frameOptionsGiven =
    options.frameSize != null || options.frameCount != null || options.frameDurationMs != null;
  if (frameOptionsGiven && format !== "gif") {
    const flag =
      options.frameSize != null
        ? "--frame-size"
        : options.frameCount != null
          ? "--frame-count"
          : "--frame-duration-ms";
    throw new SkillError(`${flag} only applies to GIF output.`, {
      code: "INVALID_REQUEST",
      next: `Add --gif to the command, or remove ${flag}.`,
    });
  }
  if (mode === IMAGE_TO_IMAGE && (options.gif || options.svg)) {
    throw new SkillError("svg and gif are text-to-image only.", {
      code: "INVALID_REQUEST",
      next: "Drop --image/--image-url to use svg or gif, or keep the edit and use png/jpeg/webp.",
    });
  }

  const input = { prompt };
  if (hasImages) input.image_urls = imageSources;

  let aspectRatio = normalizeAspectRatio(options.aspectRatio ?? options.aspect_ratio);
  let frameSize = null;
  if (format === "gif") {
    // GIF carries its shape in frame_size; aspect_ratio must stay unset or auto.
    const explicitFrameSize = normalizeFrameSize(options.frameSize);
    if (aspectRatio && aspectRatio !== "auto") {
      const converted = aspectRatioToFrameSize(aspectRatio);
      if (explicitFrameSize !== "auto") {
        throw new SkillError(
          `--aspect-ratio ${aspectRatio} and --frame-size ${explicitFrameSize} cannot both shape a GIF.`,
          {
            code: "INVALID_REQUEST",
            next: `Pass only one of them; --aspect-ratio ${aspectRatio} would become --frame-size ${converted.width}x${converted.height}.`,
          },
        );
      }
      frameSize = `${converted.width}x${converted.height}`;
      adjustments.push(
        `aspect_ratio ${aspectRatio} → frame_size ${frameSize}: GIFs take their shape from frame_size, so aspect_ratio is omitted.`,
      );
      aspectRatio = null;
    } else {
      frameSize = explicitFrameSize === "auto" ? "auto" : explicitFrameSize;
      if (explicitFrameSize === "auto") {
        adjustments.push(`frame_size auto → ${DEFAULT_FRAME_SIZE} (the service default).`);
        frameSize = DEFAULT_FRAME_SIZE;
      }
      aspectRatio = null;
    }
    const frameCount = normalizeFrameCount(options.frameCount);
    const frameDurationMs = normalizeFrameDurationMs(options.frameDurationMs);
    input.frame_size = frameSize;
    if (frameCount != null) input.frame_count = frameCount;
    if (frameDurationMs != null) input.frame_duration_ms = frameDurationMs;
    const sheet = estimateGifSheet(frameSize, frameCount ?? DEFAULT_FRAME_COUNT);
    if (sheet?.warnings.length) {
      warnings.push(
        `GIF contact sheet may be rejected: ${sheet.warnings.join("; ")}. The service refuses an oversized sheet at submission without charging.`,
      );
    }
    if (sheet) {
      const edge = Math.max(sheet.frameWidth, sheet.frameHeight);
      if (edge >= 768 && (frameCount ?? DEFAULT_FRAME_COUNT) > GIF_768_MAX_FRAMES) {
        warnings.push(`${edge}px frames support at most ${GIF_768_MAX_FRAMES} frames.`);
      }
    }
  } else {
    input.aspect_ratio = aspectRatio || DEFAULT_ASPECT_RATIO;
  }

  input.quality = quality;
  input.resolution = resolution;
  input.output_format = format;

  const background = normalizeBackground(options.background);
  if (background) input.background = background;
  const complexity = normalizeComplexity(options.complexity);
  if (complexity) input.complexity = complexity;
  const moderation = normalizeModeration(options.moderation);
  if (moderation) input.moderation = moderation;
  const compression = normalizeOutputCompression(
    options.outputCompression ?? options.output_compression,
  );
  if (compression != null) {
    if (!["jpeg", "webp"].includes(format)) {
      throw new SkillError(`output_compression requires jpeg or webp output (got ${format}).`, {
        code: "INVALID_REQUEST",
        next: `Use --format jpeg or --format webp together with --compression, or drop --compression.`,
      });
    }
    input.output_compression = compression;
  }
  if (background === "transparent" && !["png", "webp"].includes(format)) {
    throw new SkillError(`transparent background requires png or webp output (got ${format}).`, {
      code: "INVALID_REQUEST",
      next: `Add --format png or --format webp, or drop --background transparent.`,
    });
  }
  if (mode === IMAGE_TO_IMAGE) {
    const mask = options.mask == null ? null : String(options.mask).trim();
    const markup = options.markup == null ? null : String(options.markup).trim();
    if (mask && markup) {
      throw new SkillError("mask_url and markup_url cannot be combined.", {
        code: "INVALID_REQUEST",
        next: "Pass only --mask (transparent pixels mark the area to edit) or only --markup (an annotation hint).",
      });
    }
    if (mask) input.mask_url = normalizeSourceEntry(mask, "mask_url");
    if (markup) input.markup_url = normalizeSourceEntry(markup, "markup_url");
  } else if (options.mask != null || options.markup != null) {
    throw new SkillError("--mask and --markup are image-to-image only.", {
      code: "INVALID_REQUEST",
      next: "Add at least one --image/--image-url so the CLI selects the image-to-image model, or remove --mask/--markup.",
    });
  }

  return {
    payload: { model: resolved.model, input },
    mode,
    family: resolved.family,
    notes,
    adjustments,
    warnings,
    referenceImages: hasImages ? imageSources.length : 0,
    // Sources that are local paths and therefore need an upload before create
    // (reference images plus a local mask/markup).
    localSources: [...imageSources, input.mask_url, input.markup_url]
      .filter((entry) => entry != null && !isHttpUrl(entry)),
  };
}

export function redactPayload(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  for (const key of ["image_urls"]) {
    if (Array.isArray(clone.input?.[key])) clone.input[key] = clone.input[key].map(() => "[reference-image]");
  }
  for (const key of ["mask_url", "markup_url"]) {
    if (clone.input?.[key]) clone.input[key] = "[reference-image]";
  }
  return clone;
}

export function timeoutMinutesOf(value) {
  const minutes = value == null ? DEFAULT_TIMEOUT_MINUTES : Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new SkillError("timeoutMinutes must be a positive finite number.", {
      code: "INVALID_REQUEST",
      next: "Example: --timeout-minutes 30.",
    });
  }
  return minutes;
}
