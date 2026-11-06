// Distributable file set, release manifest, and Ed25519 signing.
//
// The same file-selection function is used by the installer, the release
// signer, and the updater. If those three ever disagree, an auto-update can
// delete or overwrite something the installer would never copy (or miss a
// file the installer copied), so they must share this module.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

// tests/, assets/ (README artwork) and .github/ are repository-only: the
// installed skill never needs them, and leaving them out keeps every update small.
export const DISTRIBUTABLE_EXCLUDED_DIRECTORIES = Object.freeze([".git", "node_modules", "outputs", "tests", "assets", ".github"]);
// Written by the release/install/update machinery itself; never shipped as
// content. `.hiapi-skill-installed.json` marks an installed copy.
export const DISTRIBUTABLE_EXCLUDED_FILES = Object.freeze([
  "release/manifest.json",
  "release/manifest.sig",
  ".hiapi-skill-installed.json",
]);

/**
 * True when a repository-relative POSIX path belongs to the distributable set.
 * Rejects absolute paths, `..` segments, and secrets (`.env`, `.env.*` except
 * `.env.example`).
 */
export function isDistributablePath(relPath) {
  if (typeof relPath !== "string" || !relPath) return false;
  const normalized = relPath.split(sep).join("/");
  if (normalized.startsWith("/")) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  if (segments.some((segment) => DISTRIBUTABLE_EXCLUDED_DIRECTORIES.includes(segment))) return false;
  if (DISTRIBUTABLE_EXCLUDED_FILES.includes(normalized)) return false;
  const base = segments[segments.length - 1];
  if (base === ".env") return false;
  if (base.startsWith(".env.") && base !== ".env.example") return false;
  return true;
}

function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (DISTRIBUTABLE_EXCLUDED_DIRECTORIES.includes(entry.name)) continue;
      walk(root, full, out);
    } else if (entry.isFile()) {
      const rel = relative(root, full).split(sep).join("/");
      if (isDistributablePath(rel)) out.push(rel);
    }
  }
  return out;
}

function gitTrackedFiles(root) {
  if (!existsSync(join(root, ".git"))) return null;
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return null;
  try {
    if (realpathSync(top.stdout.trim()) !== realpathSync(root)) return null;
  } catch {
    return null;
  }
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) return null;
  const files = String(listed.stdout || "")
    .split("\0")
    .filter(Boolean)
    .map((file) => file.split(sep).join("/"))
    .filter(isDistributablePath);
  // An empty listing means git knows nothing about this directory; walking is
  // safer than installing zero files.
  return files.length ? files : null;
}

/** Sorted repository-relative POSIX paths of every distributable file. */
export function listDistributableFiles(root) {
  const files = gitTrackedFiles(root) ?? walk(root);
  return [...new Set(files)].sort();
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
  return sha256Hex(readFileSync(path));
}

/** [{path, sha256, size}] for every distributable file under `root`. */
export function collectFileEntries(root) {
  return listDistributableFiles(root).map((path) => {
    const bytes = readFileSync(join(root, path));
    return { path, sha256: sha256Hex(bytes), size: bytes.length };
  });
}

/** Deterministic JSON: object keys sorted at every level, arrays keep order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildReleaseManifest({ skillId, version, keyId, createdAt, files }) {
  return {
    createdAt,
    files: [...files]
      .map((file) => ({ path: file.path, sha256: file.sha256, size: file.size }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    keyId,
    skillId,
    version,
  };
}

/**
 * Builds and signs the manifest for the files currently in `root`.
 * The signature covers the exact manifest bytes written to disk.
 */
export function signRelease({ root, skillId, version, keyId, createdAt, privateKeyBase64 }) {
  if (!privateKeyBase64) throw new Error("HIAPI_SKILL_SIGNING_KEY is required.");
  const files = collectFileEntries(root);
  const manifest = buildReleaseManifest({ skillId, version, keyId, createdAt, files });
  const bytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  const privateKey = createPrivateKey({
    key: Buffer.from(String(privateKeyBase64).trim(), "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, bytes, privateKey).toString("base64");
  return { manifest, manifestBytes: bytes, signature };
}

export function writeSignedRelease({ root, skillId, version, keyId, createdAt, privateKeyBase64 }) {
  const release = signRelease({ root, skillId, version, keyId, createdAt, privateKeyBase64 });
  const dir = join(root, "release");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), release.manifestBytes);
  writeFileSync(join(dir, "manifest.sig"), `${release.signature}\n`);
  return release;
}

export function verifyManifestSignature(manifestBytes, signatureBase64, publicKeyBase64) {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(String(publicKeyBase64).trim(), "base64"),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      manifestBytes,
      publicKey,
      Buffer.from(String(signatureBase64).trim(), "base64"),
    );
  } catch {
    return false;
  }
}

export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * File list recorded for an installed or released copy, used to decide which
 * old files an update may delete. Order: install marker, last release
 * manifest, then whatever is on disk.
 */
export function readInstalledFileList(root, skillId) {
  const marker = readJsonFile(join(root, ".hiapi-skill-installed.json"));
  if (marker && marker.skillId === skillId && Array.isArray(marker.files) && marker.files.length) {
    return marker.files.filter((file) => typeof file === "string");
  }
  const manifest = readJsonFile(join(root, "release", "manifest.json"));
  if (manifest && manifest.skillId === skillId && Array.isArray(manifest.files)) {
    return manifest.files
      .map((file) => file?.path)
      .filter((file) => typeof file === "string");
  }
  return listDistributableFiles(root);
}

export function writeInstallMarker(root, marker) {
  const path = join(root, ".hiapi-skill-installed.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`);
  return path;
}

export function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
