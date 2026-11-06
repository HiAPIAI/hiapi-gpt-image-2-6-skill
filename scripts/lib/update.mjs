// Signed auto-update with soft/hard fallback.
//
// Design (see PLAN.md §3): the release manifest is signed offline with an
// Ed25519 key whose public half is hardcoded here. A compromise of the GitHub
// repository, the tag, or the raw CDN can therefore only produce a signature
// failure — never code execution. The public key is NOT overridable by the
// environment; tests inject a key through the options object instead.
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isDistributablePath,
  listDistributableFiles,
  readInstalledFileList,
  sha256Hex,
  verifyManifestSignature,
  writeInstallMarker,
} from "./dist.mjs";

export const SKILL_ID = "hiapi-gpt-image-2-6";

/**
 * Trusted signing keys. `id` is matched against `manifest.keyId`. This array is
 * a literal on purpose: rotating the key means shipping a signed release that
 * carries the new public key, never accepting one from the caller or the env.
 */
export const TRUSTED_KEYS = Object.freeze([
  Object.freeze({
    id: "hiapi-2026-11",
    publicKey: "MCowBQYDK2VwAyEAXe6I5A3kpbVIdMOhcF3yzC72uTHriZSwbWQLKGBxKdE=",
  }),
]);

export const DEFAULT_POLICY_URLS = Object.freeze([
  "https://raw.githubusercontent.com/HiAPIAI/hiapi-skills/main/skills.json",
  "https://raw.githubusercontent.com/HiAPIAI/hiapi-gpt-image-2-6-skill/main/update-policy.json",
]);

export const DEFAULT_RELEASE_BASE_URL =
  "https://raw.githubusercontent.com/HiAPIAI/hiapi-gpt-image-2-6-skill/v{version}";

export const POLICY_TIMEOUT_MS = 4000;
export const DOWNLOAD_TOTAL_BUDGET_MS = 30000;
export const MAX_RELEASE_FILE_BYTES = 5 * 1024 * 1024;
export const LOCK_STALE_MS = 5 * 60 * 1000;

export function parseVersion(value) {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/.exec(String(value ?? ""));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: `${match[1]}.${match[2]}.${match[3]}` };
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (x[key] !== y[key]) return x[key] > y[key] ? 1 : -1;
  }
  return 0;
}

export function sameMajor(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return !!x && !!y && x.major === y.major;
}

export function resolveCacheRoot(env = process.env) {
  const explicit = String(env.HIAPI_SKILL_CACHE_DIR || "").trim();
  if (explicit) return resolve(explicit);
  const xdg = String(env.XDG_CACHE_HOME || "").trim();
  if (xdg) return resolve(xdg, "hiapi-skills");
  return resolve(homedir(), ".cache", "hiapi-skills");
}

export function cacheDirFor(skillId, env = process.env) {
  return join(resolveCacheRoot(env), skillId);
}

export function isAutoUpdateDisabled(env = process.env, options = {}) {
  if (options.noAutoUpdate) return true;
  const flag = String(env.HIAPI_SKILL_AUTO_UPDATE ?? "").trim().toLowerCase();
  return ["off", "0", "false", "no", "disabled"].includes(flag);
}

export function isUpdateCheckSkipped(env = process.env) {
  return ["1", "true", "yes"].includes(String(env.HIAPI_SKIP_UPDATE_CHECK ?? "").trim().toLowerCase());
}

export function policyUrls(env = process.env) {
  const raw = String(env.HIAPI_SKILL_POLICY_URLS || "").trim();
  if (!raw) return [...DEFAULT_POLICY_URLS];
  const list = raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_POLICY_URLS];
}

export function releaseBaseUrl(version, env = process.env) {
  const template = String(env.HIAPI_SKILL_RELEASE_BASE_URL || "").trim() || DEFAULT_RELEASE_BASE_URL;
  const base = template.includes("{version}") ? template.replaceAll("{version}", version) : template;
  return base.replace(/\/+$/, "");
}

async function fetchText(url, { fetchImpl = fetch, timeoutMs = POLICY_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// Release files may be binary (PNG and other assets), so they are hashed as raw
// bytes; decoding them as UTF-8 text would corrupt them.
async function fetchBytes(url, { fetchImpl = fetch, timeoutMs = POLICY_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { ok: response.ok, status: response.status, bytes };
  } finally {
    clearTimeout(timer);
  }
}

function extractPolicy(body) {
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body.skills)) {
    const entry = body.skills.find((item) => item && item.id === SKILL_ID);
    if (!entry) return null;
    return { entry, policy: entry.updatePolicy || entry };
  }
  if (body.id === SKILL_ID) return { entry: body, policy: body.updatePolicy || body };
  return null;
}

/**
 * Reads the update policy once: central directory first, repository fallback
 * second, each with a short timeout. Returns an `unverified` result when every
 * source fails so a policy outage never becomes a generation outage.
 */
export async function readUpdatePolicy(options = {}) {
  const env = options.env || process.env;
  const urls = options.policyUrls || policyUrls(env);
  const failures = [];
  for (const url of urls) {
    try {
      const response = await fetchText(url, {
        fetchImpl: options.fetchImpl || fetch,
        timeoutMs: options.policyTimeoutMs || POLICY_TIMEOUT_MS,
      });
      if (!response.ok) {
        failures.push(`${url} -> HTTP ${response.status}`);
        continue;
      }
      let body;
      try {
        body = JSON.parse(response.text);
      } catch {
        failures.push(`${url} -> invalid JSON`);
        continue;
      }
      const found = extractPolicy(body);
      if (!found) {
        failures.push(`${url} -> no ${SKILL_ID} entry`);
        continue;
      }
      const policy = found.policy || {};
      return {
        ok: true,
        source: url,
        version: found.entry.version ?? policy.version ?? policy.latestVersion,
        latestVersion: policy.latestVersion,
        minimumVersion: policy.minimumVersion,
        updateCommand: policy.updateCommand,
        notice: policy.notice,
        requiredNotice: policy.requiredNotice,
      };
    } catch (error) {
      failures.push(`${url} -> ${error?.name === "AbortError" ? "timeout" : error?.message || error}`);
    }
  }
  return { ok: false, unverified: true, failures };
}

/**
 * Pure evaluation of a policy against the installed version.
 * status: current | available | required | major | unverified
 */
export function evaluatePolicy(policy, currentVersion, options = {}) {
  if (!policy || !policy.ok) {
    return {
      status: "unverified",
      currentVersion,
      message:
        "Could not verify the latest skill version; continuing with local validation." +
        (options.updateCommand ? ` Update: ${options.updateCommand}` : ""),
      failures: policy?.failures || [],
    };
  }
  const latest = policy.latestVersion || policy.version || currentVersion;
  const minimum = policy.minimumVersion || currentVersion;
  const result = {
    status: "current",
    currentVersion,
    latestVersion: latest,
    minimumVersion: minimum,
    policySource: policy.source,
    notice: policy.notice,
    requiredNotice: policy.requiredNotice,
    updateCommand: policy.updateCommand || options.updateCommand,
  };
  if (compareVersions(currentVersion, minimum) < 0) {
    return {
      ...result,
      status: "required",
      message: `${policy.requiredNotice || "This skill version is incompatible."} Update now: ${result.updateCommand || "see README"}`,
    };
  }
  if (compareVersions(currentVersion, latest) < 0) {
    if (!sameMajor(currentVersion, latest)) {
      return {
        ...result,
        status: "major",
        message: `A new major version (${latest}) is available; this copy stays on ${currentVersion}. Install it with --update --allow-major when ready.`,
      };
    }
    return {
      ...result,
      status: "available",
      message: `${policy.notice || "A newer skill version is available."} Update: ${result.updateCommand || "see README"}`,
    };
  }
  return result;
}

function directoryWritable(path) {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { error: "release manifest is not valid JSON" };
  }
  if (!manifest || typeof manifest !== "object") return { error: "release manifest is not an object" };
  if (manifest.skillId !== SKILL_ID) return { error: `release manifest skillId ${JSON.stringify(manifest.skillId)} does not match ${SKILL_ID}` };
  if (!parseVersion(manifest.version)) return { error: `release manifest version ${JSON.stringify(manifest.version)} is not semver` };
  if (!Array.isArray(manifest.files) || !manifest.files.length) return { error: "release manifest lists no files" };
  const seen = new Set();
  const files = [];
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string") return { error: "release manifest has a file entry without a path" };
    const path = entry.path.split(sep).join("/");
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").some((part) => part === "..")) {
      return { error: `release manifest path escapes the skill directory: ${path}` };
    }
    if (!isDistributablePath(path)) return { error: `release manifest path is not distributable: ${path}` };
    if (seen.has(path)) return { error: `release manifest lists ${path} twice` };
    seen.add(path);
    if (!/^[0-9a-f]{64}$/.test(String(entry.sha256 || ""))) return { error: `release manifest has an invalid sha256 for ${path}` };
    if (!Number.isInteger(entry.size) || entry.size < 0 || entry.size > MAX_RELEASE_FILE_BYTES) {
      return { error: `release manifest has an invalid size for ${path}` };
    }
    files.push({ path, sha256: entry.sha256, size: entry.size });
  }
  return { manifest: { ...manifest, files } };
}

function acquireLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const stale = () => {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age <= LOCK_STALE_MS) return false;
      rmSync(lockPath, { force: true });
      return true;
    } catch {
      return true;
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      return { ok: true, lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") return { ok: false, reason: `cannot create update lock: ${error?.message || error}` };
      if (!stale()) return { ok: false, reason: "another update is already running" };
    }
  }
  return { ok: false, reason: "another update is already running" };
}

function releaseLock(lockPath) {
  try {
    rmSync(lockPath, { force: true });
  } catch {}
}

function backupCurrent(root, backupDir, files) {
  for (const path of files) {
    const source = join(root, path);
    if (!existsSync(source)) continue;
    const target = join(backupDir, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function restoreBackup(root, backupDir, backedUp, written) {
  for (const path of written) {
    if (!backedUp.includes(path)) rmSync(join(root, path), { force: true });
  }
  for (const path of backedUp) {
    const source = join(backupDir, path);
    if (!existsSync(source)) continue;
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

async function downloadRelease({ version, currentVersion, skillId, fetchImpl, deadline, env, trustedKeys }) {
  const base = releaseBaseUrl(version, env);
  const remaining = () => Math.max(0, deadline - Date.now());
  const manifestResponse = await fetchBytes(`${base}/release/manifest.json`, {
    fetchImpl,
    timeoutMs: Math.max(1, Math.min(remaining(), 10000)),
  });
  if (!manifestResponse.ok) return { error: `release manifest download failed with HTTP ${manifestResponse.status}` };
  const signatureResponse = await fetchText(`${base}/release/manifest.sig`, {
    fetchImpl,
    timeoutMs: Math.max(1, Math.min(remaining(), 10000)),
  });
  if (!signatureResponse.ok) return { error: `release signature download failed with HTTP ${signatureResponse.status}` };

  const manifestBytes = manifestResponse.bytes;
  const parsed = parseManifest(manifestBytes);
  if (parsed.error) return { error: parsed.error };
  const manifest = parsed.manifest;
  if (manifest.version !== version) {
    return { error: `release manifest version ${manifest.version} does not match the published ${version}` };
  }
  // Never install an older or equal release, even when it is validly signed:
  // an old signed release may carry a fixed bug or vulnerability.
  if (currentVersion && compareVersions(manifest.version, currentVersion) <= 0) {
    return { error: `release ${manifest.version} is not newer than the installed ${currentVersion}` };
  }
  // Test injection is a function argument only. The environment cannot add a
  // key: an attacker who controls env vars must not be able to authorise their
  // own release.
  const keys = trustedKeys || TRUSTED_KEYS;
  const key = keys.find((item) => item.id === manifest.keyId);
  if (!key) return { error: `release manifest is signed with an unknown key ${JSON.stringify(manifest.keyId)}` };
  if (!verifyManifestSignature(manifestBytes, signatureResponse.text, key.publicKey)) {
    return { error: "release signature verification failed" };
  }
  const files = [];
  for (const entry of manifest.files) {
    if (remaining() <= 0) return { error: "release download exceeded the 30s budget" };
    const url = `${base}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
    let response;
    try {
      response = await fetchBytes(url, { fetchImpl, timeoutMs: Math.max(1, Math.min(remaining(), 10000)) });
    } catch (error) {
      return { error: `download failed for ${entry.path}: ${error?.message || error}` };
    }
    if (!response.ok) return { error: `download failed for ${entry.path}: HTTP ${response.status}` };
    const bytes = response.bytes;
    if (bytes.length !== entry.size) return { error: `size mismatch for ${entry.path} (expected ${entry.size}, got ${bytes.length})` };
    if (sha256Hex(bytes) !== entry.sha256) return { error: `sha256 mismatch for ${entry.path}` };
    files.push({ path: entry.path, sha256: entry.sha256, size: entry.size, bytes });
  }
  return { manifest, files };
}

/**
 * Downloads, verifies, and installs a signed release.
 * Everything is verified before the first byte touches the skill directory;
 * any write failure rolls the directory back to the backup.
 */
export async function installRelease({
  root,
  version,
  currentVersion,
  fetchImpl = fetch,
  env = process.env,
  skillId = SKILL_ID,
  now = () => new Date(),
  trustedKeys,
}) {
  const cacheDir = cacheDirFor(skillId, env);
  const deadline = Date.now() + (Number(env.HIAPI_SKILL_UPDATE_DOWNLOAD_BUDGET_MS) || DOWNLOAD_TOTAL_BUDGET_MS);
  const downloaded = await downloadRelease({ version, currentVersion, skillId, fetchImpl, deadline, env, trustedKeys });
  if (downloaded.error) return { ok: false, reason: downloaded.error };

  const lock = acquireLock(join(cacheDir, "update.lock"));
  if (!lock.ok) return { ok: false, reason: lock.reason };

  const staging = join(cacheDir, `staging-${process.pid}-${randomUUID()}`);
  const backupDir = join(cacheDir, `prev-${currentVersion || "unknown"}`);
  const previousFiles = readInstalledFileList(root, skillId);
  const written = [];
  let committed = false;
  try {
    mkdirSync(staging, { recursive: true });
    for (const file of downloaded.files) {
      const target = join(staging, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
    rmSync(backupDir, { recursive: true, force: true });
    mkdirSync(backupDir, { recursive: true });
    backupCurrent(root, backupDir, previousFiles.filter((path) => isDistributablePath(path)));

    const nextPaths = new Set(downloaded.files.map((file) => file.path));
    for (const file of downloaded.files) {
      const target = join(root, file.path);
      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.hiapi-update-${process.pid}`;
      copyFileSync(join(staging, file.path), temp);
      renameSync(temp, target);
      written.push(file.path);
    }
    // Only files the previous release (or installer) listed may be deleted;
    // user files such as outputs/ or .env are never touched.
    for (const path of previousFiles) {
      if (nextPaths.has(path)) continue;
      if (!isDistributablePath(path)) continue;
      rmSync(join(root, path), { force: true });
    }
    writeInstallMarker(root, {
      skillId,
      version: downloaded.manifest.version,
      keyId: downloaded.manifest.keyId,
      source: "auto-update",
      updatedAt: now().toISOString(),
      files: [...nextPaths].sort(),
    });
    committed = true;
    return {
      ok: true,
      fromVersion: currentVersion,
      toVersion: downloaded.manifest.version,
      files: downloaded.files.length,
      backupDir,
    };
  } catch (error) {
    if (!committed) restoreBackup(root, backupDir, previousFiles.filter((path) => isDistributablePath(path)), written);
    return { ok: false, reason: `update failed: ${error?.message || error}` };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    releaseLock(lock.lockPath);
  }
}

/**
 * Full update decision for one run.
 *
 * Returns `{ check, update }` where `check` is the evaluated policy and
 * `update` describes what the automatic path did (or why it did nothing).
 */
export async function runUpdateCheck(options = {}) {
  const env = options.env || process.env;
  const currentVersion = options.currentVersion;
  const root = options.root;
  const updateCommand = options.updateCommand;
  if (isUpdateCheckSkipped(env) && !options.force) {
    return {
      check: {
        status: "unverified",
        currentVersion,
        message: "Version verification is disabled by HIAPI_SKIP_UPDATE_CHECK.",
      },
      update: null,
    };
  }
  const policy = await readUpdatePolicy({ env, fetchImpl: options.fetchImpl, policyUrls: options.policyUrls, policyTimeoutMs: options.policyTimeoutMs });
  const check = evaluatePolicy(policy, currentVersion, { updateCommand });
  if (!["available", "required", "major"].includes(check.status)) return { check, update: null };

  const allowMajor = !!options.allowMajor;
  // A new major is a notice in both the soft and the hard path: installing it
  // changes the CLI contract and always needs an explicit --allow-major.
  if (!allowMajor && !sameMajor(currentVersion, check.latestVersion)) {
    return {
      check,
      update: {
        attempted: false,
        status: "skipped",
        reason: `major version ${check.latestVersion} requires --update --allow-major`,
      },
    };
  }
  const skip = (reason) => ({ check, update: { attempted: false, status: "skipped", reason } });
  // A policy can say "required" while naming a latest version that is not newer
  // than this copy (misconfiguration or tampering). Never downgrade.
  if (compareVersions(check.latestVersion, currentVersion) <= 0) return skip(`policy latest ${check.latestVersion} is not newer than ${currentVersion}`);
  if (!options.force && isAutoUpdateDisabled(env, { noAutoUpdate: options.noAutoUpdate })) return skip("auto-update is off");
  if (String(env.CI || "").toLowerCase() === "true") return skip("CI environment");
  if (String(env.HIAPI_SKILL_REEXEC || "") === "1") return skip("re-executed child process");
  if (existsSync(join(root, ".git"))) return skip("skill directory is a git checkout; run git pull instead");
  if (!directoryWritable(root)) return skip("skill directory is not writable");

  const result = await installRelease({
    root,
    version: check.latestVersion,
    currentVersion,
    fetchImpl: options.fetchImpl,
    env,
    now: options.now,
    trustedKeys: options.trustedKeys,
  });
  if (!result.ok) {
    return { check, update: { attempted: true, status: "failed", reason: result.reason, message: check.message } };
  }
  return {
    check,
    update: {
      attempted: true,
      status: "updated",
      fromVersion: currentVersion,
      toVersion: result.toVersion,
      files: result.files,
      backupDir: result.backupDir,
      message: `Auto-updated ${SKILL_ID} ${currentVersion} → ${result.toVersion} (signature verified). Takes effect on the next run; re-read SKILL.md if your agent cached it.`,
    },
  };
}

/**
 * Hard upgrade path: install the new release and re-execute this CLI with the
 * same arguments so the user never has to run anything by hand. The child is
 * marked with HIAPI_SKILL_REEXEC=1 so it cannot update again in a loop.
 */
export function reexecWithUpdatedSkill(entryPath, argv, exitWith = (code) => process.exit(code), env = process.env) {
  const child = spawnSync(process.execPath, [entryPath, ...argv], {
    stdio: "inherit",
    env: { ...env, HIAPI_SKILL_REEXEC: "1" },
  });
  exitWith(child.status ?? 1);
  return child;
}

/** Local, offline description of the installed copy for --version. */
export function describeLocalInstall(root, { version, env = process.env } = {}) {
  let marker = null;
  try {
    marker = JSON.parse(readFileSync(join(root, ".hiapi-skill-installed.json"), "utf8"));
  } catch {}
  let gitManaged = false;
  try {
    gitManaged = statSync(join(root, ".git")).isDirectory();
  } catch {}
  return {
    skillId: SKILL_ID,
    version,
    installedMarker: marker ? { version: marker.version, source: marker.source, keyId: marker.keyId } : null,
    gitManaged,
    autoUpdate: !isAutoUpdateDisabled(env),
    updateCheckSkipped: isUpdateCheckSkipped(env),
    root,
    cacheDir: cacheDirFor(SKILL_ID, env),
    distributableFiles: listDistributableFiles(root).length,
  };
}
