import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_POLICY_URLS,
  POLICY_TIMEOUT_MS,
  TRUSTED_KEYS,
  cacheDirFor,
  compareVersions,
  describeLocalInstall,
  evaluatePolicy,
  installRelease,
  isAutoUpdateDisabled,
  parseVersion,
  readUpdatePolicy,
  releaseBaseUrl,
  runUpdateCheck,
  sameMajor,
} from "../scripts/lib/update.mjs";
import {
  buildReleaseManifest,
  canonicalJson,
  isDistributablePath,
  listDistributableFiles,
  signRelease,
  verifyManifestSignature,
} from "../scripts/lib/dist.mjs";

const SKILL_ID = "hiapi-gpt-image-2-6";

// A throwaway key pair for the tests. The production key is a literal in the
// runtime; these keys are injected only through function arguments.
const testKeys = generateKeyPairSync("ed25519");
const TEST_PUBLIC_DER = testKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const TEST_PRIVATE_DER = testKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const TEST_KEY_ID = "test-key-2026";
const TEST_KEYS = [{ id: TEST_KEY_ID, publicKey: TEST_PUBLIC_DER }];

async function makeTree(files) {
  const root = await mkdtemp(join(tmpdir(), "i26-tree-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

/**
 * Signs a release for `files` and returns an in-memory CDN that serves it under
 * https://cdn.test/<version>/. `mutate` may rewrite the served bytes after
 * signing (tampering, forged signature, wrong skillId ...).
 */
async function publishRelease({ version = "1.0.1", files, keyId = TEST_KEY_ID, mutate } = {}) {
  const source = await makeTree(files);
  const release = signRelease({
    root: source,
    skillId: SKILL_ID,
    version,
    keyId,
    createdAt: "2026-11-06T00:00:00.000Z",
    privateKeyBase64: TEST_PRIVATE_DER,
  });
  const served = new Map();
  for (const [rel, content] of Object.entries(files)) served.set(`/${version}/${rel}`, Buffer.from(content));
  let manifestBytes = release.manifestBytes;
  let signature = release.signature;
  const overrides = mutate?.({ served, manifest: release.manifest, manifestBytes, signature }) || {};
  if (overrides.manifestBytes) manifestBytes = overrides.manifestBytes;
  if (overrides.signature) signature = overrides.signature;
  served.set(`/${version}/release/manifest.json`, manifestBytes);
  served.set(`/${version}/release/manifest.sig`, Buffer.from(signature));
  const fetchImpl = async (url) => {
    const text = String(url);
    if (!text.startsWith("https://cdn.test/")) return new Response("no route", { status: 404 });
    const body = served.get(text.slice("https://cdn.test".length));
    if (!body) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  };
  return {
    manifest: release.manifest,
    manifestBytes,
    signature,
    served,
    env: { HIAPI_SKILL_RELEASE_BASE_URL: "https://cdn.test/{version}" },
    fetchImpl,
  };
}

function installWith(release, { root, version = "1.0.1", currentVersion = "1.0.0", cacheDir, env = {} }) {
  return installRelease({
    root,
    version,
    currentVersion,
    env: { ...release.env, ...(cacheDir ? { HIAPI_SKILL_CACHE_DIR: cacheDir } : {}), ...env },
    fetchImpl: release.fetchImpl,
    trustedKeys: TEST_KEYS,
  });
}

const policyFetch = (fetchImpl, policy) => async (url, options) =>
  String(url).includes("/skills.json") || String(url).includes("update-policy.json")
    ? new Response(JSON.stringify({ skills: [{ id: SKILL_ID, updatePolicy: policy }] }), { status: 200 })
    : fetchImpl(url, options);

function checkWith(release, { root, currentVersion = "1.0.0", policy, env = {}, allowMajor = false, cacheDir } = {}) {
  return runUpdateCheck({
    root,
    currentVersion,
    allowMajor,
    env: { ...release.env, ...(cacheDir ? { HIAPI_SKILL_CACHE_DIR: cacheDir } : {}), ...env },
    fetchImpl: policyFetch(release.fetchImpl, policy || { latestVersion: "1.0.1", minimumVersion: "1.0.0", updateCommand: "cmd" }),
    trustedKeys: TEST_KEYS,
  });
}

test("versions parse, compare and group by major", () => {
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, text: "1.2.3" });
  assert.equal(parseVersion("nope"), null);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(sameMajor("1.0.0", "1.9.9"), true);
  assert.equal(sameMajor("1.0.0", "2.0.0"), false);
});

test("policy evaluation: current, available, required, major, unverified", () => {
  const policy = { ok: true, source: "x", latestVersion: "1.2.0", minimumVersion: "1.0.1", updateCommand: "cmd" };
  assert.equal(evaluatePolicy(policy, "1.2.0").status, "current");
  assert.equal(evaluatePolicy(policy, "1.1.0").status, "available");
  assert.equal(evaluatePolicy(policy, "1.0.0").status, "required");
  const major = evaluatePolicy({ ...policy, latestVersion: "2.0.0", minimumVersion: "1.0.0" }, "1.5.0");
  assert.equal(major.status, "major");
  assert.match(major.message, /--update --allow-major/);
  const unverified = evaluatePolicy({ ok: false, failures: ["x"] }, "1.0.0");
  assert.equal(unverified.status, "unverified");
  assert.match(unverified.message, /Could not verify/);
});

test("the hard-required message names the exact update command", () => {
  const result = evaluatePolicy(
    {
      ok: true,
      latestVersion: "1.4.0",
      minimumVersion: "1.3.0",
      requiredNotice: "Unsafe copy.",
      updateCommand: "npx -y github:HiAPIAI/hiapi-gpt-image-2-6-skill -y",
    },
    "1.0.0",
  );
  assert.match(result.message, /Unsafe copy\./);
  assert.match(result.message, /npx -y github:HiAPIAI\/hiapi-gpt-image-2-6-skill -y/);
});

test("policy sources are read in order and the first hit wins", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("hiapi-skills")) return new Response("missing", { status: 404 });
    return new Response(
      JSON.stringify({ id: SKILL_ID, version: "1.1.0", updatePolicy: { latestVersion: "1.1.0", minimumVersion: "1.0.0" } }),
    );
  };
  const policy = await readUpdatePolicy({ fetchImpl, env: {} });
  assert.equal(policy.ok, true);
  assert.match(policy.source, /update-policy\.json/);
  assert.deepEqual(calls, [...DEFAULT_POLICY_URLS]);
});

test("a central entry without this skill falls through to the repository policy", async () => {
  const fetchImpl = async (url) =>
    String(url).includes("hiapi-skills")
      ? new Response(JSON.stringify({ skills: [{ id: "someone-else", updatePolicy: { latestVersion: "9.0.0" } }] }))
      : new Response(JSON.stringify({ id: SKILL_ID, updatePolicy: { latestVersion: "1.2.0", minimumVersion: "1.0.0" } }));
  const policy = await readUpdatePolicy({ fetchImpl, env: {} });
  assert.equal(policy.ok, true);
  assert.equal(policy.latestVersion, "1.2.0");
});

test("two failing policy sources yield unverified, not an exception", async () => {
  const policy = await readUpdatePolicy({
    fetchImpl: async () => {
      throw new Error("offline");
    },
    env: {},
  });
  assert.equal(policy.ok, false);
  assert.equal(policy.failures.length, 2);
});

test("a policy endpoint that never ends is bounded by the per-source timeout", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address();
  try {
    const started = Date.now();
    const policy = await readUpdatePolicy({
      env: {},
      policyUrls: [`http://127.0.0.1:${port}/a`, `http://127.0.0.1:${port}/b`],
      policyTimeoutMs: 100,
    });
    assert.equal(policy.ok, false);
    assert.ok(Date.now() - started < 3000);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("the default policy timeout is short enough not to block generation", () => {
  assert.ok(POLICY_TIMEOUT_MS <= 4000);
});

test("TRUSTED_KEYS is a frozen literal the environment cannot steer", () => {
  assert.ok(Object.isFrozen(TRUSTED_KEYS));
  assert.equal(TRUSTED_KEYS[0].id, "hiapi-2026-11");
  assert.ok(TRUSTED_KEYS[0].publicKey.startsWith("MCowBQYDK2Vw"));
  const source = readFileSync(new URL("../scripts/lib/update.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /HIAPI_SKILL_PUBLIC_KEY|HIAPI_SKILL_TRUSTED/i);
});

test("distributable file selection excludes secrets, vcs, outputs and release artifacts", () => {
  for (const good of ["SKILL.md", "scripts/a.mjs", ".env.example", "references/api.md", "agents/openai.yaml"]) {
    assert.equal(isDistributablePath(good), true, good);
  }
  for (const bad of [
    ".env",
    ".env.local",
    ".env.production",
    "outputs/x.png",
    ".git/config",
    "node_modules/x/y.js",
    "release/manifest.json",
    "release/manifest.sig",
    ".hiapi-skill-installed.json",
    "../escape",
    "/etc/passwd",
    "a/../b",
    "a//b",
  ]) {
    assert.equal(isDistributablePath(bad), false, bad);
  }
});

test("canonical JSON sorts keys at every level and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
});

test("a signature verifies only with the matching public key", () => {
  const other = generateKeyPairSync("ed25519");
  const manifest = buildReleaseManifest({
    skillId: SKILL_ID,
    version: "1.0.0",
    keyId: TEST_KEY_ID,
    createdAt: "2026-11-06T00:00:00.000Z",
    files: [{ sha256: "a".repeat(64), path: "SKILL.md", size: 10 }],
  });
  const bytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  const signature = sign(null, bytes, testKeys.privateKey).toString("base64");
  assert.equal(verifyManifestSignature(bytes, signature, TEST_PUBLIC_DER), true);
  assert.equal(
    verifyManifestSignature(bytes, signature, other.publicKey.export({ format: "der", type: "spki" }).toString("base64")),
    false,
  );
  assert.equal(verifyManifestSignature(Buffer.from("tampered"), signature, TEST_PUBLIC_DER), false);
  assert.equal(verifyManifestSignature(bytes, "not-base64", TEST_PUBLIC_DER), false);
  assert.equal(verify(null, bytes, testKeys.publicKey, Buffer.from(signature, "base64")), true);
});

test("installRelease replaces the file set, backs up the old version, and never deletes user files", async () => {
  const root = await makeTree({
    "SKILL.md": "v1",
    "scripts/old.mjs": "old",
    "scripts/stay.mjs": "stay-v1",
    "outputs/user-image.png": "keep me",
    ".env": "SECRET=1",
  });
  const cache = await mkdtemp(join(tmpdir(), "i26-cache-"));
  const release = await publishRelease({
    files: { "SKILL.md": "v101", "scripts/stay.mjs": "stay-v101", "scripts/new.mjs": "new" },
  });
  const result = await installWith(release, { root, cacheDir: cache });
  assert.equal(result.ok, true, result.reason);
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v101");
  assert.equal(readFileSync(join(root, "scripts/stay.mjs"), "utf8"), "stay-v101");
  assert.equal(readFileSync(join(root, "scripts/new.mjs"), "utf8"), "new");
  assert.equal(existsSync(join(root, "scripts/old.mjs")), false, "a file the previous release owned is removed");
  assert.equal(readFileSync(join(root, "outputs/user-image.png"), "utf8"), "keep me", "user files are never deleted");
  assert.equal(readFileSync(join(root, ".env"), "utf8"), "SECRET=1", "secrets are never deleted");
  const marker = JSON.parse(readFileSync(join(root, ".hiapi-skill-installed.json"), "utf8"));
  assert.equal(marker.version, "1.0.1");
  assert.equal(marker.source, "auto-update");
  assert.deepEqual(marker.files, ["SKILL.md", "scripts/new.mjs", "scripts/stay.mjs"]);
  const backup = join(cache, SKILL_ID, "prev-1.0.0");
  assert.equal(readFileSync(join(backup, "SKILL.md"), "utf8"), "v1", "the previous files are backed up");
  assert.equal(existsSync(join(root, "prev-1.0.0")), false, "the backup never lives inside the skills tree");
});

test("a tampered file is rejected before anything is written", async () => {
  const root = await makeTree({ "SKILL.md": "v1", "scripts/a.mjs": "a" });
  const release = await publishRelease({
    files: { "SKILL.md": "v101", "scripts/a.mjs": "a101" },
    mutate: ({ served }) => void served.set("/1.0.1/SKILL.md", Buffer.from("evil")),
  });
  const result = await installWith(release, { root, cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /sha256 mismatch for SKILL\.md/);
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v1");
  assert.equal(existsSync(join(root, ".hiapi-skill-installed.json")), false);
});

test("a forged signature is refused even when every file hash would match", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const attacker = generateKeyPairSync("ed25519");
  const release = await publishRelease({
    files: { "SKILL.md": "v101" },
    mutate: ({ manifestBytes }) => ({ signature: sign(null, manifestBytes, attacker.privateKey).toString("base64") }),
  });
  const result = await installWith(release, { root, cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /signature verification failed/);
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v1");
});

test("a manifest modified after signing fails verification", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const release = await publishRelease({
    files: { "SKILL.md": "v101" },
    mutate: ({ manifestBytes }) => ({ manifestBytes: Buffer.concat([manifestBytes, Buffer.from(" ")]) }),
  });
  const result = await installWith(release, { root, cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /signature verification failed/);
});

test("a manifest for another skill or another version is refused", async () => {
  for (const [mutate, pattern] of [
    [
      ({ manifest }) => {
        const other = { ...manifest, skillId: "some-other-skill" };
        const bytes = Buffer.from(`${canonicalJson(other)}\n`);
        return { manifestBytes: bytes, signature: sign(null, bytes, testKeys.privateKey).toString("base64") };
      },
      /skillId/,
    ],
    [
      ({ manifest }) => {
        const other = { ...manifest, version: "1.0.2" };
        const bytes = Buffer.from(`${canonicalJson(other)}\n`);
        return { manifestBytes: bytes, signature: sign(null, bytes, testKeys.privateKey).toString("base64") };
      },
      /does not match the published/,
    ],
  ]) {
    const root = await makeTree({ "SKILL.md": "v1" });
    const release = await publishRelease({ files: { "SKILL.md": "v101" }, mutate });
    const result = await installWith(release, { root, cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
    assert.equal(result.ok, false);
    assert.match(result.reason, pattern);
  }
});

test("an unknown signing key id is refused", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const release = await publishRelease({ files: { "SKILL.md": "v101" }, keyId: "unknown-key" });
  const result = await installWith(release, { root, cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown key/);
});

test("path traversal and non-distributable paths in a correctly signed manifest are refused", async () => {
  for (const badPath of ["../evil.mjs", "/etc/passwd", "scripts/../../evil.mjs", "outputs/x.png"]) {
    const root = await makeTree({ "SKILL.md": "v1" });
    const release = await publishRelease({
      files: { "SKILL.md": "v101" },
      mutate: ({ manifest }) => {
        const evil = {
          ...manifest,
          files: [...manifest.files, { path: badPath, sha256: createHash("sha256").update("evil").digest("hex"), size: 4 }],
        };
        const bytes = Buffer.from(`${canonicalJson(evil)}\n`);
        return { manifestBytes: bytes, signature: sign(null, bytes, testKeys.privateKey).toString("base64") };
      },
    });
    const result = await installWith(release, { root, cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
    assert.equal(result.ok, false, badPath);
    assert.match(result.reason, /escapes the skill directory|not distributable/, badPath);
    assert.equal(existsSync(join(root, "..", "evil.mjs")), false);
  }
});

test("a size mismatch is refused", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const release = await publishRelease({
    files: { "SKILL.md": "v101" },
    mutate: ({ served }) => void served.set("/1.0.1/SKILL.md", Buffer.from("much longer than the signed size")),
  });
  const result = await installWith(release, { root, cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /size mismatch/);
});

test("a write failure mid-install rolls every file back", async () => {
  const root = await makeTree({ "SKILL.md": "v1", "scripts/a.mjs": "a-v1" });
  // A directory where the release wants a file makes the rename fail.
  mkdirSync(join(root, "scripts/z.mjs"), { recursive: true });
  writeFileSync(join(root, "scripts/z.mjs/blocker"), "x");
  // Sorted order: SKILL.md, scripts/a.mjs, scripts/m.mjs, then scripts/z.mjs
  // (the directory that makes the rename fail).
  const release = await publishRelease({
    files: { "SKILL.md": "v101", "scripts/a.mjs": "a-v101", "scripts/m.mjs": "m-new", "scripts/z.mjs": "z" },
  });
  const result = await installWith(release, { root, cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /update failed/);
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v1", "SKILL.md was rolled back");
  assert.equal(readFileSync(join(root, "scripts/a.mjs"), "utf8"), "a-v1", "scripts/a.mjs was rolled back");
  assert.equal(existsSync(join(root, "scripts/m.mjs")), false, "a file written before the failure is removed on rollback");
  assert.equal(existsSync(join(root, ".hiapi-skill-installed.json")), false);
});

test("only files listed by the previous release are deleted", async () => {
  const root = await makeTree({ "SKILL.md": "v1", "notes.txt": "user note", "scripts/gone.mjs": "gone" });
  writeFileSync(
    join(root, ".hiapi-skill-installed.json"),
    JSON.stringify({ skillId: SKILL_ID, version: "1.0.0", source: "installer", files: ["SKILL.md", "scripts/gone.mjs"] }),
  );
  const release = await publishRelease({ files: { "SKILL.md": "v101" } });
  const result = await installWith(release, { root, cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
  assert.equal(result.ok, true, result.reason);
  assert.equal(existsSync(join(root, "scripts/gone.mjs")), false);
  assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "user note");
});

test("concurrent updates are serialised by the lock", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const cache = await mkdtemp(join(tmpdir(), "i26-cache-"));
  mkdirSync(join(cache, SKILL_ID), { recursive: true });
  writeFileSync(join(cache, SKILL_ID, "update.lock"), "held\n");
  const release = await publishRelease({ files: { "SKILL.md": "v101" } });
  const result = await installWith(release, { root, cacheDir: cache });
  assert.equal(result.ok, false);
  assert.match(result.reason, /already running/);
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v1");
});

test("a stale lock is taken over and released", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const cache = await mkdtemp(join(tmpdir(), "i26-cache-"));
  mkdirSync(join(cache, SKILL_ID), { recursive: true });
  const lock = join(cache, SKILL_ID, "update.lock");
  writeFileSync(lock, "old\n");
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(lock, old, old);
  const release = await publishRelease({ files: { "SKILL.md": "v101" } });
  const result = await installWith(release, { root, cacheDir: cache });
  assert.equal(result.ok, true, result.reason);
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v101");
  assert.equal(existsSync(lock), false);
});

test("the download budget stops a slow release", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const release = await publishRelease({ files: { "SKILL.md": "v101" } });
  const slow = async (url) => {
    await new Promise((done) => setTimeout(done, 30));
    return release.fetchImpl(url);
  };
  const result = await installRelease({
    root,
    version: "1.0.1",
    currentVersion: "1.0.0",
    env: { ...release.env, HIAPI_SKILL_UPDATE_DOWNLOAD_BUDGET_MS: "1", HIAPI_SKILL_CACHE_DIR: await mkdtemp(join(tmpdir(), "i26-cache-")) },
    fetchImpl: slow,
    trustedKeys: TEST_KEYS,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /budget|timeout|failed/i);
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v1");
});

test("auto-update is skipped when disabled, in CI, as a re-exec child, in a git checkout, or read-only", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const release = await publishRelease({ files: { "SKILL.md": "v101" } });
  const cacheDir = await mkdtemp(join(tmpdir(), "i26-cache-"));
  assert.equal(isAutoUpdateDisabled({ HIAPI_SKILL_AUTO_UPDATE: "off" }), true);
  assert.equal(isAutoUpdateDisabled({ HIAPI_SKILL_AUTO_UPDATE: "0" }), true);
  assert.equal(isAutoUpdateDisabled({ HIAPI_SKILL_AUTO_UPDATE: "FALSE" }), true);
  assert.equal(isAutoUpdateDisabled({}), false);
  for (const [env, reason] of [
    [{ HIAPI_SKILL_AUTO_UPDATE: "off" }, /auto-update is off/],
    [{ CI: "true" }, /CI environment/],
    [{ HIAPI_SKILL_REEXEC: "1" }, /re-executed/],
  ]) {
    const result = await checkWith(release, { root, env, cacheDir });
    assert.equal(result.update.status, "skipped");
    assert.match(result.update.reason, reason);
    assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v1");
  }
  mkdirSync(join(root, ".git"));
  const git = await checkWith(release, { root, cacheDir });
  assert.match(git.update.reason, /git checkout/);
  await rm(join(root, ".git"), { recursive: true, force: true });
  chmodSync(root, 0o555);
  try {
    const readOnly = await checkWith(release, { root, cacheDir });
    if (process.getuid?.() === 0) assert.ok(true, "root writes anyway");
    else assert.match(readOnly.update.reason, /not writable/);
  } finally {
    chmodSync(root, 0o755);
  }
});

test("--no-auto-update skips even with a writable directory", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const release = await publishRelease({ files: { "SKILL.md": "v101" } });
  const result = await runUpdateCheck({
    root,
    currentVersion: "1.0.0",
    noAutoUpdate: true,
    env: { ...release.env, HIAPI_SKILL_CACHE_DIR: await mkdtemp(join(tmpdir(), "i26-cache-")) },
    fetchImpl: policyFetch(release.fetchImpl, { latestVersion: "1.0.1", minimumVersion: "1.0.0" }),
  });
  assert.equal(result.update.status, "skipped");
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v1");
});

test("a successful soft update reports the version change and takes effect on the next run", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const release = await publishRelease({ files: { "SKILL.md": "v101" } });
  const result = await checkWith(release, { root, cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
  assert.equal(result.check.status, "available");
  assert.equal(result.update.status, "updated");
  assert.equal(result.update.toVersion, "1.0.1");
  assert.match(result.update.message, /Auto-updated hiapi-gpt-image-2-6 1\.0\.0 → 1\.0\.1 \(signature verified\)/);
  assert.match(result.update.message, /next run/);
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v101");
});

test("a failed automatic update degrades to a notice and leaves the copy alone", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const release = await publishRelease({
    files: { "SKILL.md": "v101" },
    mutate: ({ served }) => void served.set("/1.0.1/SKILL.md", Buffer.from("evil")),
  });
  const result = await checkWith(release, { root, cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
  assert.equal(result.update.status, "failed");
  assert.match(result.update.reason, /sha256 mismatch/);
  assert.match(result.update.message, /Update:/);
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v1");
});

test("a hard requirement inside 1.x self-heals by updating and re-executing", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const release = await publishRelease({ version: "1.3.0", files: { "SKILL.md": "v13" } });
  const result = await checkWith(release, {
    root,
    cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")),
    policy: { latestVersion: "1.3.0", minimumVersion: "1.2.0", requiredNotice: "unsafe" },
  });
  assert.equal(result.check.status, "required");
  assert.equal(result.update.status, "updated");
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v13");
});

test("a hard requirement across a major boundary needs --allow-major", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const release = await publishRelease({ version: "2.0.0", files: { "SKILL.md": "v2" } });
  const result = await checkWith(release, {
    root,
    cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")),
    policy: { latestVersion: "2.0.0", minimumVersion: "2.0.0", requiredNotice: "unsafe" },
  });
  assert.equal(result.check.status, "required");
  assert.equal(result.update.status, "skipped");
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v1");
});

test("a major version is only a notice unless allowMajor is set", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const release = await publishRelease({ version: "2.0.0", files: { "SKILL.md": "v2" } });
  const cacheDir = await mkdtemp(join(tmpdir(), "i26-cache-"));
  const policy = { latestVersion: "2.0.0", minimumVersion: "1.0.0" };
  const blocked = await checkWith(release, { root, cacheDir, policy });
  assert.equal(blocked.check.status, "major");
  assert.equal(blocked.update.status, "skipped");
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v1");
  const allowed = await checkWith(release, { root, cacheDir, allowMajor: true, policy });
  assert.equal(allowed.update.status, "updated");
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v2");
});

test("a downgrade is never installed", async () => {
  const root = await makeTree({ "SKILL.md": "v2" });
  const release = await publishRelease({ files: { "SKILL.md": "v101" } });
  const result = await checkWith(release, { root, currentVersion: "1.2.0", cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
  assert.equal(result.check.status, "current");
  assert.equal(result.update, null);
  assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), "v2");
});

test("every policy source being down still yields a usable check", async () => {
  const result = await runUpdateCheck({
    root: await makeTree({ "SKILL.md": "v1" }),
    currentVersion: "1.0.0",
    env: { HIAPI_SKILL_CACHE_DIR: await mkdtemp(join(tmpdir(), "i26-cache-")) },
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(result.check.status, "unverified");
  assert.equal(result.update, null);
});

test("HIAPI_SKIP_UPDATE_CHECK=1 skips the check without any request", async () => {
  let calls = 0;
  const result = await runUpdateCheck({
    root: await makeTree({ "SKILL.md": "v1" }),
    currentVersion: "1.0.0",
    env: { HIAPI_SKIP_UPDATE_CHECK: "1" },
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}");
    },
  });
  assert.equal(result.check.status, "unverified");
  assert.equal(calls, 0);
  assert.equal(result.update, null);
});

test("cache and release URLs are derived without trusting the caller", () => {
  assert.match(cacheDirFor(SKILL_ID, { HIAPI_SKILL_CACHE_DIR: "/tmp/x" }), /^\/tmp\/x\/hiapi-gpt-image-2-6$/);
  assert.match(cacheDirFor(SKILL_ID, { XDG_CACHE_HOME: "/tmp/xdg" }), /^\/tmp\/xdg\/hiapi-skills\/hiapi-gpt-image-2-6$/);
  assert.match(cacheDirFor(SKILL_ID, {}), /\.cache\/hiapi-skills\/hiapi-gpt-image-2-6$/);
  assert.equal(releaseBaseUrl("1.0.1", {}), "https://raw.githubusercontent.com/HiAPIAI/hiapi-gpt-image-2-6-skill/v1.0.1");
  assert.equal(
    releaseBaseUrl("1.0.1", { HIAPI_SKILL_RELEASE_BASE_URL: "http://127.0.0.1:9/{version}/" }),
    "http://127.0.0.1:9/1.0.1",
  );
});

test("local install description is offline and reports every maintenance fact", async () => {
  const root = await makeTree({ "SKILL.md": "v1", "scripts/a.mjs": "a" });
  writeFileSync(join(root, ".hiapi-skill-installed.json"), JSON.stringify({ version: "1.0.1", source: "installer", keyId: TEST_KEY_ID }));
  const described = describeLocalInstall(root, { version: "1.0.0", env: {} });
  assert.equal(described.version, "1.0.0");
  assert.equal(described.installedMarker.version, "1.0.1");
  assert.equal(described.gitManaged, false);
  assert.equal(described.autoUpdate, true);
  assert.equal(described.distributableFiles, 2);
  assert.equal(describeLocalInstall(root, { version: "1.0.0", env: { HIAPI_SKILL_AUTO_UPDATE: "off" } }).autoUpdate, false);
});

test("listDistributableFiles walks a plain directory and skips excluded entries", async () => {
  const root = await makeTree({
    "SKILL.md": "x",
    ".env": "secret",
    ".env.example": "template",
    "outputs/a.png": "img",
    "release/manifest.json": "{}",
    "release/manifest.sig": "sig",
    ".hiapi-skill-installed.json": "{}",
    "scripts/lib/a.mjs": "a",
  });
  assert.deepEqual(listDistributableFiles(root), [".env.example", "SKILL.md", "scripts/lib/a.mjs"]);
});

test("installRelease refuses a version whose manifest is missing", async () => {
  const root = await makeTree({ "SKILL.md": "v1" });
  const release = await publishRelease({ files: { "SKILL.md": "v101" } });
  const result = await installWith(release, { root, version: "9.9.9", cacheDir: await mkdtemp(join(tmpdir(), "i26-cache-")) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /HTTP 404/);
});
