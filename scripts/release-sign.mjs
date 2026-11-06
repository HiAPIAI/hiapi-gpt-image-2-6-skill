#!/usr/bin/env node
// Release signer. Reads HIAPI_SKILL_SIGNING_KEY (PKCS8 DER, base64), signs the
// canonical manifest of every distributable file, and writes
// release/manifest.json + release/manifest.sig.
//
//   node scripts/release-sign.mjs --version 1.0.0            # sign
//   node scripts/release-sign.mjs --verify                   # verify in place
//   node scripts/release-sign.mjs --verify-signature <b64>   # check a given sig
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TRUSTED_KEYS, parseVersion } from "./lib/update.mjs";
import { readJsonFile, signRelease, verifyManifestSignature, writeSignedRelease } from "./lib/dist.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const SKILL_ID = "hiapi-gpt-image-2-6";
const KEY_ID = process.env.HIAPI_SKILL_KEY_ID || "hiapi-2026-11";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (args.includes("--help") || !args.length) {
  process.stdout.write(`Release signer for ${SKILL_ID}

  node scripts/release-sign.mjs --version <x.y.z> [--key-id <id>]
  node scripts/release-sign.mjs --verify

Signing needs HIAPI_SKILL_SIGNING_KEY (PKCS8 DER base64, Ed25519). The private
key never belongs in this repository; pass it from the keychain, for example:

  HIAPI_SKILL_SIGNING_KEY="$(security find-generic-password -s hiapi-skill-release-ed25519 -w)" \\
    node scripts/release-sign.mjs --version 1.0.0
`);
  process.exit(args.includes("--help") ? 0 : 2);
}

if (args.includes("--verify")) {
  const manifestPath = join(ROOT, "release", "manifest.json");
  const signaturePath = join(ROOT, "release", "manifest.sig");
  let manifestBytes;
  let signature;
  try {
    manifestBytes = readFileSync(manifestPath);
    signature = readFileSync(signaturePath, "utf8");
  } catch {
    fail("release/manifest.json or release/manifest.sig is missing. Sign a release first.");
  }
  const manifest = readJsonFile(manifestPath);
  const key = TRUSTED_KEYS.find((item) => item.id === manifest?.keyId);
  if (!key) fail(`manifest keyId ${JSON.stringify(manifest?.keyId)} is not a trusted key`);
  if (!verifyManifestSignature(manifestBytes, signature, key.publicKey)) fail("signature verification FAILED");
  process.stdout.write(
    `${JSON.stringify({ ok: true, skillId: manifest.skillId, version: manifest.version, keyId: manifest.keyId, files: manifest.files.length, createdAt: manifest.createdAt }, null, 2)}\n`,
  );
  process.exit(0);
}

const version = value("--version");
if (!version || !parseVersion(version)) fail("--version <x.y.z> is required.");
const keyId = value("--key-id") || KEY_ID;
if (!TRUSTED_KEYS.some((item) => item.id === keyId)) {
  fail(`key id ${keyId} is not in the trusted key list; a release signed with it would be rejected by every client.`);
}
if (!process.env.HIAPI_SKILL_SIGNING_KEY) fail("HIAPI_SKILL_SIGNING_KEY (PKCS8 DER base64) is required to sign.");

const createdAt = new Date().toISOString();
const release = writeSignedRelease({
  root: ROOT,
  skillId: SKILL_ID,
  version: parseVersion(version).text,
  keyId,
  createdAt,
  privateKeyBase64: process.env.HIAPI_SKILL_SIGNING_KEY,
});
const preview = signRelease({
  root: ROOT,
  skillId: SKILL_ID,
  version: parseVersion(version).text,
  keyId,
  createdAt,
  privateKeyBase64: process.env.HIAPI_SKILL_SIGNING_KEY,
});
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      wrote: ["release/manifest.json", "release/manifest.sig"],
      skillId: SKILL_ID,
      version: preview.manifest.version,
      keyId,
      files: preview.manifest.files.length,
      createdAt,
      manifestSha256: (await import("node:crypto")).createHash("sha256").update(release.manifestBytes).digest("hex"),
    },
    null,
    2,
  )}\n`,
);
