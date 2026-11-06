// Argument parsing for the GPT Image 2.6 CLI. Values and flags live here so
// the entry point stays a thin dispatcher and the tests can exercise parsing
// without spawning a process.
export const VALUE_FLAGS = Object.freeze({
  "--prompt": "prompt",
  "--model": "model",
  "--family": "family",
  "--route": "route",
  "--resolution": "resolution",
  "--aspect-ratio": "aspectRatio",
  "--aspect": "aspectRatio",
  "--quality": "quality",
  "--background": "background",
  "--complexity": "complexity",
  "--moderation": "moderation",
  "--format": "outputFormat",
  "--output-format": "outputFormat",
  "--frame-size": "frameSize",
  "--frame-count": "frameCount",
  "--frame-duration-ms": "frameDurationMs",
  "--compression": "outputCompression",
  "--output-compression": "outputCompression",
  "--max-cost": "maxCost",
  "--idempotency-key": "idempotencyKey",
  "--resume-task-id": "resumeTaskId",
  "--output-dir": "outputDir",
  "--timeout-minutes": "timeoutMinutes",
  "--mask": "mask",
  "--markup": "markup",
});

export const REPEAT_FLAGS = Object.freeze({
  "--image": "images",
  "--image-url": "imageUrls",
});

export const BOOLEAN_FLAGS = Object.freeze({
  "--dry-run": ["dryRun", true],
  "--estimate": ["estimate", true],
  "--svg": ["svg", true],
  "--gif": ["gif", true],
  "--no-wait": ["wait", false],
  "--no-save": ["save", false],
  "--check-contract": ["checkContract", true],
  "--no-auto-update": ["noAutoUpdate", true],
  "--allow-major": ["allowMajor", true],
  "--update": ["update", true],
  "--version": ["version", true],
  "--help": ["help", true],
  "-h": ["help", true],
});

export function parseArgs(argv = []) {
  const options = { outputDir: "outputs", images: [], imageUrls: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (Object.hasOwn(BOOLEAN_FLAGS, arg)) {
      const [key, value] = BOOLEAN_FLAGS[arg];
      options[key] = value;
      continue;
    }
    if (Object.hasOwn(REPEAT_FLAGS, arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      options[REPEAT_FLAGS[arg]].push(value);
      continue;
    }
    if (Object.hasOwn(VALUE_FLAGS, arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      options[VALUE_FLAGS[arg]] = value;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    positional.push(arg);
  }
  if (positional.length) {
    if (positional.length > 1) {
      throw new Error(
        `Unexpected extra positional argument: ${positional[1]}. Quote the prompt so it is one argument.`,
      );
    }
    options.prompt ??= positional[0];
  }
  options.imageSources = [...options.imageUrls, ...options.images];
  if (options.mask != null) options.hasMaskOrMarkup = true;
  if (options.frameCount != null || options.frameSize != null || options.frameDurationMs != null) {
    options.frameOptionsUsed = true;
  }
  if (options.resumeTaskId && (options.dryRun || options.estimate || options.checkContract)) {
    throw new Error("--resume-task-id cannot be combined with preflight options.");
  }
  return options;
}

export function usage(version, context = {}) {
  const sourceLines = [];
  if (context.updatePolicy) {
    sourceLines.push(`Update policy: ${context.updatePolicy}`);
  }
  return `HiAPI GPT Image 2.6 — ${version}

Creates one image per task with GPT Image 2.6 Flare or Sunburst. Without reference
images the CLI uses gpt-image-2.6-<family>/text-to-image; with them it uses
.../image-to-image. --family defaults to flare. --route pro is accepted and ignored
because every 2.6 model takes --quality directly.

Preflight (no key, no charge):
  node scripts/hiapi-gpt-image-2-6.mjs "a lighthouse logo" --svg --quality low --dry-run --estimate

Create:
  node scripts/hiapi-gpt-image-2-6.mjs "a quiet alpine lake at dawn" --quality medium --resolution 2K

Edit with a local file and a mask:
  node scripts/hiapi-gpt-image-2-6.mjs "make the sky purple" --image ./photo.png --mask ./mask.png --dry-run

Recover without paying again:
  node scripts/hiapi-gpt-image-2-6.mjs --resume-task-id <task-id>

Prompt and schema: --prompt / positional (1–32000 chars), --family flare|sunburst,
--image <path|url> (repeatable, max 16), --mask <path|url>, --markup <path|url>,
--aspect-ratio <${context.aspectRatios || "auto|1:1|16:9|..."}>, --resolution <1K|2K|4K>,
--quality <low|medium|high|xhigh|max>, --format <png|jpeg|webp|gif|svg>, --svg, --gif,
--frame-size <WxH>, --frame-count <2-16>, --frame-duration-ms <>=20>, --background,
--complexity, --moderation, --compression <0-100> (jpeg/webp).

Money and safety: --dry-run, --estimate, --max-cost <usd>, --no-wait, --no-save,
--idempotency-key <key>, --timeout-minutes <n>, --output-dir <dir>.

Maintenance: --check-contract, --update, --allow-major, --no-auto-update, --version.
${sourceLines.length ? `\n${sourceLines.join("\n")}` : ""}`;
}
