// Local reference files → public URLs through POST /v1/uploads.
//
// Uploads are cached by content hash so retrying the same idempotency key
// resends exactly the same payload. The cache entry also records the uploaded
// object's expiry, so a stale URL is never reused.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import {
  SkillError,
  TASK_INPUT_IMAGE_TYPES,
  UPLOAD_IMAGE_TYPES,
  UPLOAD_MAX_IMAGE_BYTES,
  UPLOAD_PATH,
} from "./contract.mjs";
import { sniffImageType } from "./png.mjs";
import { cacheDirFor } from "./update.mjs";

export const UPLOAD_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // uploaded objects live 24h

export function uploadCacheDir(env = process.env) {
  const dir = `${cacheDirFor("hiapi-gpt-image-2-6", env)}/uploads`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Validates a local file before upload: it must exist, be a regular file, be
 * a PNG/JPEG/WebP image, and be under the API's image size limit.
 */
export function inspectLocalImage(path) {
  const absolute = resolve(path);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new SkillError(`Local image not found: ${path}`, {
      code: "FILE_NOT_FOUND",
      next: "Check the path; relative paths resolve from the current directory.",
    });
  }
  if (!stats.isFile()) {
    throw new SkillError(`Not a regular file: ${path}`, {
      code: "FILE_NOT_FOUND",
      next: "Pass a file path, not a directory.",
    });
  }
  if (stats.size === 0) {
    throw new SkillError(`File is empty: ${path}`, { code: "INVALID_REQUEST", next: "Re-export the image and retry." });
  }
  if (stats.size > UPLOAD_MAX_IMAGE_BYTES) {
    throw new SkillError(
      `${path} is ${(stats.size / 1048576).toFixed(1)} MB; the upload limit is ${UPLOAD_MAX_IMAGE_BYTES / 1048576} MB.`,
      {
        code: "FILE_TOO_LARGE",
        next: "Downscale or re-encode the image below 10 MB, or host it yourself and pass --image-url <https URL>.",
      },
    );
  }
  const head = readFileSync(absolute).subarray(0, 64);
  const mime = sniffImageType(head);
  if (!mime || !UPLOAD_IMAGE_TYPES.includes(mime)) {
    throw new SkillError(`Unsupported image type for ${path}: ${mime || "unknown"}.`, {
      code: "INVALID_REQUEST",
      next: `Reference images must be PNG, JPEG or WebP (${TASK_INPUT_IMAGE_TYPES.join("/")}).`,
    });
  }
  if (mime === "image/gif") {
    throw new SkillError(`GIF reference images are not accepted: ${path}`, {
      code: "INVALID_REQUEST",
      next: "Convert the frame to PNG/JPEG/WebP first.",
    });
  }
  return { path: absolute, size: stats.size, mimeType: mime };
}

function cacheKeyFor(inspected) {
  return sha256Bytes(readFileSync(inspected.path));
}

function readCache(file) {
  try {
    const entry = JSON.parse(readFileSync(file, "utf8"));
    if (!entry?.url || !entry?.uploadedAt) return null;
    if (Date.now() - Number(entry.uploadedAt) > UPLOAD_CACHE_TTL_MS) return null;
    if (entry.expiresAt && Number(entry.expiresAt) * 1000 - 60000 < Date.now()) return null;
    return entry;
  } catch {
    return null;
  }
}

async function postUpload(config, inspected, fetchImpl = fetch) {
  const bytes = readFileSync(inspected.path);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: inspected.mimeType }),
    basename(inspected.path).replace(/[^\w.\-]+/g, "_").slice(0, 120) || "image",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}${UPLOAD_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    throw new SkillError(`Upload failed for ${inspected.path}: ${error?.message || error}`, {
      code: "NETWORK",
      next: "Check connectivity and retry with the same command; uploads are not charged.",
    });
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  const text = await response.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message = String(body?.message || body?.error?.message || body || `HTTP ${response.status}`);
    const next =
      response.status === 401 || response.status === 403
        ? "Check HIAPI_API_KEY at https://console.hiapi.ai/en/dashboard/api-keys?utm_source=skill&utm_medium=agent&utm_campaign=hiapi-gpt-image-2-6."
        : response.status === 402
          ? "Check the account balance at https://console.hiapi.ai/en/dashboard?utm_source=skill&utm_medium=agent&utm_campaign=hiapi-gpt-image-2-6."
          : response.status === 429
            ? "Upload rate limit or daily quota reached; wait and retry, or host the image yourself and pass --image-url."
            : "Re-export the image and retry, or host it yourself and pass --image-url <https URL>.";
    throw new SkillError(`Upload failed for ${inspected.path}: HTTP ${response.status} ${message}`, {
      code: response.status === 402 ? "INSUFFICIENT_QUOTA" : "UPLOAD_FAILED",
      next,
    });
  }
  const url = body?.url || body?.data?.url;
  if (!url || !/^https?:\/\//.test(String(url))) {
    throw new SkillError(`Upload response for ${inspected.path} has no URL.`, {
      code: "UPLOAD_FAILED",
      next: "Host the image yourself and pass --image-url <https URL>.",
    });
  }
  return {
    url: String(url),
    expiresAt: Number(body?.expires_at || body?.data?.expires_at) || null,
    size: Number(body?.size) || inspected.size,
    contentType: body?.content_type || inspected.mimeType,
  };
}

/**
 * Turns one local path or URL into an uploadable URL.
 * `dryRun` performs the local checks only and never touches the network.
 */
export async function resolveSource(source, { config, fetchImpl = fetch, dryRun = false, env = process.env } = {}) {
  if (/^https?:\/\//i.test(source)) return { url: source, source: "url", local: null };
  const inspected = inspectLocalImage(source);
  if (dryRun) return { url: null, source: "local-file", local: { ...inspected, uploaded: false } };
  const dir = uploadCacheDir(env);
  const key = cacheKeyFor(inspected);
  const cacheFile = resolve(dir, `${key}.json`);
  const cached = existsSync(cacheFile) ? readCache(cacheFile) : null;
  if (cached) return { url: cached.url, source: "cache", local: { ...inspected, uploaded: true, cacheHit: true } };
  const uploaded = await postUpload(config, inspected, fetchImpl);
  writeFileSync(
    cacheFile,
    `${JSON.stringify({ ...uploaded, sha256: key, path: inspected.path, uploadedAt: Date.now() }, null, 2)}\n`,
  );
  // Keep the cache small: drop entries older than the TTL on every write.
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const full = resolve(dir, name);
    try {
      if (Date.now() - statSync(full).mtimeMs > 7 * 24 * 60 * 60 * 1000) writeFileSync(full, "");
    } catch {}
  }
  return { url: uploaded.url, source: "upload", local: { ...inspected, uploaded: true, cacheHit: false } };
}

/**
 * Uploads every local source (and the mask/markup) and rewrites the payload.
 * Returns the rewritten payload plus a per-file report.
 */
export async function uploadLocalSources(payload, options = {}) {
  const report = [];
  const next = JSON.parse(JSON.stringify(payload));
  const urls = next.input?.image_urls;
  if (Array.isArray(urls)) {
    const replaced = [];
    for (const entry of urls) {
      if (/^https?:\/\//i.test(entry)) {
        replaced.push(entry);
        report.push({ kind: "image", source: entry, action: "kept-url" });
        continue;
      }
      const result = await resolveSource(entry, options);
      if (!result.url) {
        throw new SkillError("internal: local source was not uploaded", { code: "INTERNAL" });
      }
      replaced.push(result.url);
      report.push({ kind: "image", source: entry, action: result.source, url: result.url, bytes: result.local?.size });
    }
    next.input.image_urls = replaced;
  }
  for (const field of ["mask_url", "markup_url"]) {
    const value = next.input?.[field];
    if (!value || /^https?:\/\//i.test(value)) continue;
    const result = await resolveSource(value, options);
    if (!result.url) throw new SkillError("internal: local source was not uploaded", { code: "INTERNAL" });
    next.input[field] = result.url;
    report.push({ kind: field.replace(/_url$/, ""), source: value, action: result.source, url: result.url });
  }
  return { payload: next, uploads: report };
}
