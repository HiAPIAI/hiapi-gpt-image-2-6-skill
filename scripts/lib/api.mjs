// HTTP: task creation, polling, download, and public contract reads.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ALL_MODEL_IDS,
  ALL_OF_CONSTRAINTS,
  DEFAULT_BASE_URL,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_FRAME_COUNT,
  DEFAULT_FRAME_DURATION_MS,
  DEFAULT_SITE_URL,
  DEFAULT_TIMEOUT_MINUTES,
  HIAPI_API_KEYS_URL,
  HIAPI_DASHBOARD_URL,
  HIAPI_PRICING_URL,
  IMAGE_TO_IMAGE,
  POLL_INTERVAL_MS,
  SCHEMA_CONTRACT,
  SkillError,
  TEXT_TO_IMAGE,
  errorCodeOf,
  errorSummary,
} from "./contract.mjs";
import { sniffImageType } from "./png.mjs";

export function resolveConfig(env = process.env) {
  const apiKey = String(env.HIAPI_API_KEY || "").trim();
  if (!apiKey) {
    throw new SkillError("HIAPI_API_KEY is required to create or recover a task.", {
      code: "NO_API_KEY",
      next: `Create a key at ${HIAPI_API_KEYS_URL}, then: export HIAPI_API_KEY="..."`,
    });
  }
  const baseUrl = String(env.HIAPI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new SkillError("HIAPI_BASE_URL must start with http:// or https://.", { code: "INVALID_REQUEST" });
  }
  return { apiKey, baseUrl };
}

export function siteUrl(env = process.env) {
  return String(env.HIAPI_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, "");
}

async function fetchBounded(fetchImpl, url, options = {}, timeoutMs = 15000, as = "text") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (as === "bytes") {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { response, bytes };
    }
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonOrText(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

export function taskErrorMessage(status, body) {
  const summary = errorSummary(body);
  const code = errorCodeOf(body);
  if (status === 401 || status === 403) {
    return new SkillError(`HiAPI rejected the key (HTTP ${status}): ${summary}`, {
      code: "UNAUTHORIZED",
      next: `Check HIAPI_API_KEY at ${HIAPI_API_KEYS_URL}.`,
    });
  }
  if (status === 402 || /insufficient_quota|balance|credit|quota/i.test(`${code} ${summary}`)) {
    return new SkillError(`HiAPI refused the request for quota (HTTP ${status}): ${summary}`, {
      code: "INSUFFICIENT_QUOTA",
      next: `Top up at ${HIAPI_DASHBOARD_URL} and check prices at ${HIAPI_PRICING_URL}.`,
    });
  }
  if (status === 429) {
    return new SkillError(`HiAPI rate-limited the request (HTTP 429): ${summary}`, {
      code: "RATE_LIMITED",
      next: "Wait a few seconds and retry with the same --idempotency-key; do not create a second task with a new key.",
    });
  }
  if (code === "PROMPT_TOO_LONG" || /PROMPT_TOO_LONG/i.test(summary)) {
    return new SkillError(`Prompt rejected as too long: ${summary}`, {
      code: "PROMPT_TOO_LONG",
      next: "Shorten the prompt (the text-to-image route also has an internal token cap) and retry with a new task.",
    });
  }
  if (status === 400 || code === "INVALID_REQUEST") {
    return new SkillError(`HiAPI rejected the request (HTTP ${status}): ${summary}`, {
      code: "INVALID_REQUEST",
      next: "Run the same command with --dry-run and compare the payload with the current schema: npm run check:contract.",
    });
  }
  return new SkillError(`HiAPI request failed with HTTP ${status}: ${summary}`, {
    code: code || "HTTP_ERROR",
    next: "Retry once; if it persists, run with --dry-run --estimate and check https://hiapi.ai/docs/.",
  });
}

export async function createTask(payload, config, options = {}) {
  const key = String(options.idempotencyKey || randomUUID()).trim();
  if (!key || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new SkillError("--idempotency-key must be non-empty and contain no control characters.", {
      code: "INVALID_REQUEST",
    });
  }
  if (Buffer.byteLength(key, "utf8") > 255) {
    throw new SkillError("--idempotency-key must be at most 255 UTF-8 bytes.", { code: "INVALID_REQUEST" });
  }
  let result;
  try {
    result = await fetchBounded(
      options.fetchImpl || fetch,
      `${config.baseUrl}/v1/tasks`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(payload),
      },
      options.requestTimeoutMs || 60000,
    );
  } catch (error) {
    throw new SkillError(`Network request failed: ${error?.message || error}`, {
      code: "NETWORK_AMBIGUOUS",
      next: `Acceptance is unknown. Retry with the same key: --idempotency-key ${key} (never a new key).`,
    });
  }
  const body = parseJsonOrText(result.text);
  if (!result.response.ok) throw taskErrorMessage(result.response.status, body);
  const taskId = extractTaskId(body);
  if (!taskId) {
    throw new SkillError("HiAPI response did not return a task ID; acceptance is unknown.", {
      code: "NETWORK_AMBIGUOUS",
      next: `Reuse the same key: --idempotency-key ${key}, or list tasks in the console at ${HIAPI_DASHBOARD_URL}.`,
    });
  }
  return { taskId, idempotencyKey: key, response: body, replayed: Boolean(body?.replay) };
}

export function extractTaskId(body) {
  return body?.data?.taskId || body?.data?.task_id || body?.taskId || body?.task_id || null;
}

export function extractStatus(body) {
  return String(body?.data?.status ?? body?.status ?? "").toLowerCase();
}

function outputItems(body) {
  const output = body?.data?.output ?? body?.output;
  if (Array.isArray(output)) return output;
  return output ? [output] : [];
}

/**
 * Picks the image URL from a finished task. Entries with an explicit non-image
 * `type` are skipped; `url`, `image_url` and `imageUrl` are all accepted.
 */
export function extractImageUrl(body) {
  for (const item of outputItems(body)) {
    if (typeof item === "string") {
      if (/^https?:\/\//.test(item) || /^data:image\//.test(item)) return item;
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (item.type && String(item.type).toLowerCase() !== "image") continue;
    const url = item.url || item.image_url || item.imageUrl;
    if (url && (/^https?:\/\//.test(url) || /^data:image\//.test(url))) return url;
  }
  const fallback = body?.data?.image_url || body?.image_url || null;
  return fallback && /^https?:\/\//.test(fallback) ? fallback : null;
}

const TERMINAL_FAILURES = new Set(["failed", "fail", "error", "cancelled", "canceled"]);
export const SUCCESS_STATES = new Set(["success", "succeeded", "completed", "complete"]);

export function isTerminalFailure(status) {
  return TERMINAL_FAILURES.has(String(status || "").toLowerCase());
}

export async function getTask(taskId, config, options = {}) {
  let result;
  try {
    result = await fetchBounded(
      options.fetchImpl || fetch,
      `${config.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" } },
      options.requestTimeoutMs || 20000,
    );
  } catch (error) {
    throw new SkillError(`Network request failed while polling: ${error?.message || error}`, {
      code: "NETWORK",
      next: `Resume later with --resume-task-id ${taskId}; the task keeps running server-side.`,
    });
  }
  const body = parseJsonOrText(result.text);
  if (!result.response.ok) {
    const error = taskErrorMessage(result.response.status, body);
    error.httpStatus = result.response.status;
    throw error;
  }
  return body;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Polls until success, terminal failure, or timeout. Transient HTTP errors
 * back off exponentially; a timeout carries the resume command as `next`.
 */
export async function waitForTask(taskId, config, options = {}) {
  const timeoutMinutes = Number(options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new SkillError("timeoutMinutes must be a positive finite number.", { code: "INVALID_REQUEST" });
  }
  const deadline = Date.now() + timeoutMinutes * 60000;
  const interval = Number(options.pollIntervalMs ?? POLL_INTERVAL_MS);
  let failures = 0;
  const hints = [];
  while (Date.now() < deadline) {
    let body;
    try {
      body = await getTask(taskId, config, options);
      failures = 0;
    } catch (error) {
      const transient =
        [429, 500, 502, 503, 504].includes(error.httpStatus) || error.code === "NETWORK" || error.code === "RATE_LIMITED";
      if (!transient) throw error;
      failures += 1;
      await sleep(Math.min(interval * 2 ** Math.min(failures, 4), 30000));
      continue;
    }
    const status = extractStatus(body);
    if (SUCCESS_STATES.has(status)) {
      const url = extractImageUrl(body);
      if (!url) {
        throw new SkillError(`Task ${taskId} succeeded but returned no image output.`, {
          code: "NO_OUTPUT",
          next: `Inspect the task at ${HIAPI_DASHBOARD_URL}; if the output shape is unexpected, report it at https://github.com/HiAPIAI/hiapi-gpt-image-2-6-skill/issues.`,
        });
      }
      return { response: body, imageUrl: url, status, hints };
    }
    if (isTerminalFailure(status)) {
      throw new SkillError(`Image generation failed (${status}): ${errorSummary(body)}`, {
        code: "TASK_FAILED",
        next: "Read the task detail for the reason, adjust the prompt or inputs, then submit a new task with a new key.",
      });
    }
    const progress = body?.data?.progress ?? body?.progress;
    if (typeof progress === "string" && progress && !hints.includes(progress)) hints.push(progress);
    await sleep(interval);
  }
  const wantsSvg = options.expectFormat === "svg";
  throw new SkillError(`Task ${taskId} did not finish within ${timeoutMinutes} minutes.`, {
    code: "TIMEOUT",
    next:
      `The task usually keeps running server-side. Resume without paying again: ` +
      `--resume-task-id ${taskId}` +
      (wantsSvg ? " (SVG usually finishes within a minute, occasionally a few minutes)." : "."),
  });
}

function isoStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

/** Accepts png/jpeg/webp/gif/svg bytes; returns `{ ext, mime }` or null. */
export function detectOutputFormat(bytes, contentType) {
  const mime = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  const sniffed = sniffImageType(bytes);
  if (sniffed === "image/png" && (mime === "image/png" || mime === "" || mime === "application/octet-stream")) {
    return { ext: ".png", mime: "image/png" };
  }
  if (sniffed === "image/jpeg" && (mime === "image/jpeg" || mime === "image/jpg" || mime === "" || mime === "application/octet-stream")) {
    return { ext: ".jpg", mime: "image/jpeg" };
  }
  if (sniffed === "image/webp" && (mime === "image/webp" || mime === "" || mime === "application/octet-stream")) {
    return { ext: ".webp", mime: "image/webp" };
  }
  if (sniffed === "image/gif" && (mime === "image/gif" || mime === "" || mime === "application/octet-stream")) {
    return { ext: ".gif", mime: "image/gif" };
  }
  const text = Buffer.from(bytes).toString("utf8");
  if (looksLikeSvg(text) && ["image/svg+xml", "text/plain", "text/xml", "application/xml", "text/html", "application/octet-stream", ""].includes(mime)) {
    return { ext: ".svg", mime: "image/svg+xml" };
  }
  return null;
}

/**
 * True when the text starts with `<svg` after removing a BOM, whitespace, an
 * XML declaration, a doctype and comments. Anything else is not SVG.
 */
export function looksLikeSvg(text) {
  let body = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < 8; i++) {
    const before = body;
    body = body.replace(/^\s+/, "");
    body = body.replace(/^<\?xml[\s\S]*?\?>/i, "");
    body = body.replace(/^<!DOCTYPE[^>]*>/i, "");
    body = body.replace(/^<!--[\s\S]*?-->/, "");
    if (body === before) break;
  }
  // Matches `<svg>`, `<svg/>` and `<svg attr=...>`; never `<svgx`.
  return /^<svg[\s/>]/i.test(body);
}

export async function saveOutput(imageUrl, outputDir = "outputs", options = {}) {
  if (!imageUrl) return null;
  if (/^data:image\//.test(imageUrl)) return { kind: "data-uri", value: imageUrl };
  if (!/^https?:\/\//.test(imageUrl)) return { kind: "url", value: imageUrl };
  let result;
  try {
    result = await fetchBounded(
      options.fetchImpl || fetch,
      imageUrl,
      {},
      options.downloadTimeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS,
      "bytes",
    );
  } catch (error) {
    throw new SkillError(`Download failed: ${error?.message || error}`, {
      code: "DOWNLOAD_FAILED",
      next: `Output URLs expire. Re-download without paying again: --resume-task-id ${options.taskId || "<task-id>"}`,
    });
  }
  if (!result.response.ok) {
    throw new SkillError(`Download failed with HTTP ${result.response.status}.`, {
      code: "DOWNLOAD_EXPIRED",
      next: `The output URL likely expired. Resume the task: --resume-task-id ${options.taskId || "<task-id>"}`,
    });
  }
  const detected = detectOutputFormat(result.bytes, result.response.headers.get("content-type"));
  if (!detected) {
    throw new SkillError(
      `Downloaded output is not a supported image (content-type ${result.response.headers.get("content-type") || "unknown"}).`,
      {
        code: "OUTPUT_INVALID",
        next: `Do not use this file. Resume the task and download again: --resume-task-id ${options.taskId || "<task-id>"}`,
      },
    );
  }
  const dir = resolve(outputDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `gpt-image-2-6-${isoStamp()}-${randomUUID()}${detected.ext}`);
  await writeFile(path, result.bytes);
  return { kind: "file", path, value: path, sourceUrl: imageUrl, mimeType: detected.mime, bytes: result.bytes.length };
}

/** Reads one public model schema (no key required). */
export async function fetchModelSchema(model, options = {}) {
  const url = `${siteUrl(options.env)}/api/models/content?name=${encodeURIComponent(model)}`;
  let result;
  try {
    result = await fetchBounded(options.fetchImpl || fetch, url, { headers: { Accept: "application/json" } }, 15000, "text");
  } catch (error) {
    throw new SkillError(`Schema request failed for ${model}: ${error?.message || error}`, { code: "CONTRACT_UNAVAILABLE" });
  }
  if (!result.response.ok) {
    throw new SkillError(`Schema request failed for ${model}: HTTP ${result.response.status}`, { code: "CONTRACT_UNAVAILABLE" });
  }
  const body = parseJsonOrText(result.text);
  const schema = body?.data?.input_schema;
  if (!schema) throw new SkillError(`Schema response for ${model} had no input_schema.`, { code: "CONTRACT_UNAVAILABLE" });
  return schema;
}

function normalizeAllOf(schema) {
  const rules = [];
  for (const rule of Array.isArray(schema?.allOf) ? schema.allOf : []) {
    const ifPart = rule?.if || {};
    const thenPart = rule?.then || {};
    const ifRequired = Array.isArray(ifPart.required) ? ifPart.required : [];
    const thenRequired = Array.isArray(thenPart.required) ? thenPart.required : [];
    const requiredSuffix = thenRequired.length ? ` (required)` : "";
    const parts = [];
    for (const key of ifRequired) {
      const enumValue = ifPart.properties?.[key]?.enum;
      if (enumValue) parts.push(`${key}=${enumValue.join("|")}`);
      else parts.push(key);
    }
    for (const [key, condition] of Object.entries(ifPart.properties || {})) {
      if (ifRequired.includes(key)) continue;
      if (condition?.enum) parts.push(`${key}=${condition.enum.join("|")}`);
    }
    const thenParts = [];
    for (const [key, condition] of Object.entries(thenPart.properties || {})) {
      if (condition?.enum) thenParts.push(`${key} in [${condition.enum.join(",")}]`);
      else if (condition?.type) thenParts.push(`${key} must be ${condition.type}`);
    }
    if (thenPart.not?.required?.length) {
      rules.push(`${parts.join(" and ")} then not ${thenPart.not.required.join(",")}`);
      continue;
    }
    rules.push(`${parts.join(" and ")} then ${thenParts.join(" and ") || "..."}${requiredSuffix}`);
  }
  return rules;
}

/**
 * Compares the four live public schemas and the pricing-row structure with the
 * constants in this package. Amounts are never compared.
 */
export async function checkLiveContract(options = {}) {
  const checks = [];
  for (const model of ALL_MODEL_IDS) {
    const entry = { model, ok: true, problems: [] };
    let schema;
    try {
      schema = await fetchModelSchema(model, options);
    } catch (error) {
      entry.ok = false;
      entry.problems.push(error?.message || String(error));
      checks.push(entry);
      continue;
    }
    const mode = model.endsWith(`/${IMAGE_TO_IMAGE}`) ? IMAGE_TO_IMAGE : TEXT_TO_IMAGE;
    // SCHEMA_CONTRACT keys mirror the schema vocabulary with underscores.
    const contractKey = mode.replaceAll("-", "_");
    const expected = SCHEMA_CONTRACT[contractKey];
    const props = schema.properties || {};
    const problem = (message) => {
      entry.ok = false;
      entry.problems.push(message);
    };
    const actualProps = Object.keys(props).sort();
    const expectedProps = [...expected.properties].sort();
    if (JSON.stringify(actualProps) !== JSON.stringify(expectedProps)) {
      problem(`property set changed: missing ${expectedProps.filter((p) => !actualProps.includes(p)).join(",") || "none"}; new ${actualProps.filter((p) => !expectedProps.includes(p)).join(",") || "none"}`);
    }
    const actualRequired = [...(schema.required || [])].sort();
    const expectedRequired = [...expected.required].sort();
    if (JSON.stringify(actualRequired) !== JSON.stringify(expectedRequired)) {
      problem(`required set changed: ${JSON.stringify(actualRequired)} != ${JSON.stringify(expectedRequired)}`);
    }
    if (!props.model?.enum?.includes(model)) problem(`model enum does not contain ${model}`);
    if (schema.additionalProperties !== false) problem("additionalProperties is no longer false");
    const cmp = (key, label, expectedValue) => {
      const actual = props[key]?.[label];
      if (JSON.stringify(actual) !== JSON.stringify(expectedValue)) {
        problem(`${key}.${label} = ${JSON.stringify(actual)}, expected ${JSON.stringify(expectedValue)}`);
      }
    };
    cmp("prompt", "minLength", SCHEMA_CONTRACT.prompt.minLength);
    cmp("prompt", "maxLength", SCHEMA_CONTRACT.prompt.maxLength);
    cmp("quality", "enum", SCHEMA_CONTRACT.quality.enum);
    cmp("quality", "default", SCHEMA_CONTRACT.quality.default);
    cmp("resolution", "enum", SCHEMA_CONTRACT.resolution.enum);
    cmp("resolution", "default", SCHEMA_CONTRACT.resolution.default);
    cmp("aspect_ratio", "enum", SCHEMA_CONTRACT.aspect_ratio.enum);
    cmp("aspect_ratio", "default", SCHEMA_CONTRACT.aspect_ratio.default);
    cmp("background", "enum", SCHEMA_CONTRACT.background.enum);
    cmp("complexity", "enum", SCHEMA_CONTRACT.complexity.enum);
    cmp("moderation", "enum", SCHEMA_CONTRACT.moderation.enum);
    cmp("output_compression", "minimum", SCHEMA_CONTRACT.output_compression.minimum);
    cmp("output_compression", "maximum", SCHEMA_CONTRACT.output_compression.maximum);
    cmp("output_format", "enum", expected.output_format.enum);
    cmp("output_format", "default", expected.output_format.default);
    if (mode === TEXT_TO_IMAGE) {
      cmp("frame_count", "minimum", SCHEMA_CONTRACT.text_to_image.frame_count.minimum);
      cmp("frame_count", "maximum", SCHEMA_CONTRACT.text_to_image.frame_count.maximum);
      // No schema default on purpose (removed 2026-11-11); the local estimate
      // constants are checked against the descriptions instead.
      cmp("frame_count", "default", undefined);
      if (!String(props.frame_count?.description || "").includes(`Omitted uses ${DEFAULT_FRAME_COUNT}.`)) {
        problem(`frame_count.description no longer says "Omitted uses ${DEFAULT_FRAME_COUNT}."`);
      }
      cmp("frame_duration_ms", "minimum", SCHEMA_CONTRACT.text_to_image.frame_duration_ms.minimum);
      cmp("frame_duration_ms", "default", undefined);
      if (!String(props.frame_duration_ms?.description || "").includes(`Omitted uses ${DEFAULT_FRAME_DURATION_MS}.`)) {
        problem(`frame_duration_ms.description no longer says "Omitted uses ${DEFAULT_FRAME_DURATION_MS}."`);
      }
      cmp("frame_size", "pattern", SCHEMA_CONTRACT.text_to_image.frame_size.pattern);
    } else {
      cmp("image_urls", "minItems", SCHEMA_CONTRACT.image_to_image.image_urls.minItems);
      cmp("image_urls", "maxItems", SCHEMA_CONTRACT.image_to_image.image_urls.maxItems);
    }
    const expectedAllOf = [...(ALL_OF_CONSTRAINTS[contractKey] || [])].sort();
    const actualAllOf = normalizeAllOf(schema).sort();
    if (JSON.stringify(actualAllOf) !== JSON.stringify(expectedAllOf)) {
      problem(
        `allOf constraints changed:\n      expected: ${expectedAllOf.join("\n                | ")}\n      actual:   ${actualAllOf.join("\n                | ")}`,
      );
    }
    entry.properties = actualProps;
    entry.required = actualRequired;
    entry.allOf = actualAllOf;
    checks.push(entry);
  }

  // Pricing structure (never amounts).
  const pricing = { ok: true, problems: [], models: {} };
  try {
    const rows = await fetchPricingRowsForContract(options);
    for (const model of ALL_MODEL_IDS) {
      const row = rows.find((entry) => entry?.model_name === model);
      if (!row) {
        pricing.ok = false;
        pricing.problems.push(`no pricing row for ${model}`);
        continue;
      }
      const policies = Array.isArray(row.policies) ? row.policies : [];
      const modes = { quality: new Set(), resolution: new Set(), output_format: new Set() };
      for (const policy of policies) {
        const rule = policy?.rule || {};
        if (rule.quality?.match) modes.quality.add(String(rule.quality.match));
        const res = rule.resolution?.match;
        if (Array.isArray(res)) res.forEach((item) => modes.resolution.add(String(item)));
        else if (res != null) modes.resolution.add(String(res));
        if (rule.output_format?.match) modes.output_format.add(String(rule.output_format.match));
      }
      const modelInfo = {
        policies: policies.length,
        qualities: [...modes.quality].sort(),
        resolutions: [...modes.resolution].sort(),
        formats: [...modes.output_format].sort(),
        addons: Array.isArray(row.addons) ? row.addons.length : 0,
      };
      pricing.models[model] = modelInfo;
      const needFormatRows = model.endsWith(`/${TEXT_TO_IMAGE}`);
      if (needFormatRows) {
        for (const format of ["svg", "gif"]) {
          if (!modes.output_format.has(format)) {
            pricing.ok = false;
            pricing.problems.push(`${model} lost its ${format} pricing rows`);
          }
        }
      } else {
        const hasAddon = (row.addons || []).some((addon) => addon?.path === "image_urls" && addon?.type === "array_length");
        if (!hasAddon) {
          pricing.ok = false;
          pricing.problems.push(`${model} lost its image_urls reference-image addon`);
        }
      }
      const expectedQualities = SCHEMA_CONTRACT.quality.enum;
      if (JSON.stringify(modelInfo.qualities) !== JSON.stringify([...expectedQualities].sort())) {
        pricing.ok = false;
        pricing.problems.push(`${model} quality coverage changed: ${JSON.stringify(modelInfo.qualities)}`);
      }
    }
  } catch (error) {
    pricing.ok = false;
    pricing.problems.push(error?.message || String(error));
  }

  const promotions = { ok: true, problems: [], count: 0 };
  try {
    const result = await fetchPromotionsForContract(options);
    promotions.count = Array.isArray(result) ? result.length : 0;
    if (!Array.isArray(result)) {
      promotions.ok = false;
      promotions.problems.push("promotions payload had no data array");
    }
  } catch (error) {
    promotions.ok = false;
    promotions.problems.push(error?.message || String(error));
  }

  return {
    ok: checks.every((entry) => entry.ok) && pricing.ok && promotions.ok,
    checkedAt: new Date().toISOString(),
    site: siteUrl(options.env),
    checks,
    pricing,
    promotions,
  };
}

async function fetchPricingRowsForContract(options = {}) {
  const url = `${siteUrl(options.env)}/api/pricing`;
  const result = await fetchBounded(options.fetchImpl || fetch, url, { headers: { Accept: "application/json" } }, 20000, "text");
  if (!result.response.ok) throw new SkillError(`Pricing request failed: HTTP ${result.response.status}`, { code: "CONTRACT_UNAVAILABLE" });
  const body = parseJsonOrText(result.text);
  if (!Array.isArray(body?.data)) throw new SkillError("Pricing payload had no data array.", { code: "CONTRACT_UNAVAILABLE" });
  return body.data;
}

async function fetchPromotionsForContract(options = {}) {
  const url = `${siteUrl(options.env)}/api/promotions`;
  const result = await fetchBounded(options.fetchImpl || fetch, url, { headers: { Accept: "application/json" } }, 20000, "text");
  if (!result.response.ok) throw new SkillError(`Promotions request failed: HTTP ${result.response.status}`, { code: "CONTRACT_UNAVAILABLE" });
  const body = parseJsonOrText(result.text);
  return Array.isArray(body?.data) ? body.data : null;
}
