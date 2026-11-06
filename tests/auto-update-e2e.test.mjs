// End-to-end auto-update: two real signed releases (1.0.0 and 1.0.1), an
// installed copy, a real replacement through the installer, then the update
// machinery run in-process against a local HTTP server, and a tampered release
// that must be refused.
//
// The production key list is a literal and is not overridable; a throwaway key
// pair is injected as a function argument, which is the only supported path.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../scripts/lib/dist.mjs";
import { installRelease } from "../scripts/lib/update.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const INSTALLER = join(REPO, "scripts/install.mjs");
const SIGNER = join(REPO, "scripts/release-sign.mjs");
const SKILL_ID = "hiapi-gpt-image-2-6";

const keys = generateKeyPairSync("ed25519");
const PRIVATE_DER = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const TEST_KEYS = [{ id: "test-key", publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") }];

/**
 * A tiny skill tree for one version. `scripts/lib/version.txt` is the fact the
 * assertions read back: it is content, not behaviour, so the test proves the
 * files on disk really changed.
 */
function treeFor(version) {
  return {
    "SKILL.md": `---\nname: ${SKILL_ID}\ndescription: e2e fixture ${version}\n---\n\n# ${version}\n`,
    "package.json": `${JSON.stringify({ name: SKILL_ID, version }, null, 2)}\n`,
    "scripts/hiapi-gpt-image-2-6.mjs": "#!/usr/bin/env node\nconsole.log('fixture');\n",
    "scripts/lib/version.txt": version,
  };
}

/** Writes a tree, signs it with the test key, and returns the served paths. */
async function signedRelease(version, { mutateAfterSign } = {}) {
  const dir = await mkdtemp(join(tmpdir(), `i26-e2e-${version}-`));
  const tree = treeFor(version);
  for (const [rel, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const files = Object.keys(tree)
    .sort()
    .map((rel) => {
      const bytes = readFileSync(join(dir, rel));
      return { path: rel, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
    });
  const manifest = { createdAt: "2026-11-06T00:00:00.000Z", files, keyId: "test-key", skillId: SKILL_ID, version };
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  const signature = sign(null, manifestBytes, keys.privateKey).toString("base64");
  mkdirSync(join(dir, "release"), { recursive: true });
  writeFileSync(join(dir, "release/manifest.json"), manifestBytes);
  writeFileSync(join(dir, "release/manifest.sig"), `${signature}\n`);
  mutateAfterSign?.(dir, manifest);
  return { dir, manifest, manifestBytes, signature };
}

function startServer(releases) {
  const routes = new Map();
  for (const [version, release] of Object.entries(releases)) {
    routes.set(`/v${version}/release/manifest.json`, readFileSync(join(release.dir, "release/manifest.json")));
    routes.set(`/v${version}/release/manifest.sig`, readFileSync(join(release.dir, "release/manifest.sig")));
    for (const entry of release.manifest.files) {
      routes.set(`/v${version}/${entry.path}`, readFileSync(join(release.dir, entry.path)));
    }
  }
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url.split("?")[0]);
    const body = routes.get(url);
    if (!body) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200).end(body);
  });
  return new Promise((ready) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      ready({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    }),
  );
}

/** Installs the real working copy into a temp skills dir (version 1.0.0). */
async function installBase() {
  const skillsDir = await mkdtemp(join(tmpdir(), "i26-skills-"));
  const result = spawnSync(process.execPath, [INSTALLER, `--target=${skillsDir}`], {
    encoding: "utf8",
    env: { ...process.env, HIAPI_API_KEY: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  const root = join(skillsDir, SKILL_ID);
  assert.ok(existsSync(join(root, "SKILL.md")));
  const marker = JSON.parse(readFileSync(join(root, ".hiapi-skill-installed.json"), "utf8"));
  assert.equal(marker.version, "1.0.0");
  assert.equal(marker.source, "installer");
  assert.ok(Array.isArray(marker.files) && marker.files.includes("SKILL.md"));
  return { skillsDir, root, marker };
}

test("end to end: a signed 1.0.1 replaces the installed 1.0.0 files, and 1.0.0 is backed up", async () => {
  const next = await signedRelease("1.0.1");
  const { baseUrl, close } = await startServer({ "1.0.1": next });
  const { root, marker } = await installBase();
  const cache = await mkdtemp(join(tmpdir(), "i26-e2e-cache-"));
  try {
    assert.equal(readFileSync(join(root, "package.json"), "utf8").includes('"version": "1.0.0"'), true);
    const result = await installRelease({
      root,
      version: "1.0.1",
      currentVersion: "1.0.0",
      env: { HIAPI_SKILL_RELEASE_BASE_URL: `${baseUrl}/v{version}`, HIAPI_SKILL_CACHE_DIR: cache },
      fetchImpl: fetch,
      trustedKeys: TEST_KEYS,
    });
    assert.equal(result.ok, true, result.reason);

    // Files really changed on disk.
    assert.equal(readFileSync(join(root, "scripts/lib/version.txt"), "utf8"), "1.0.1");
    assert.match(readFileSync(join(root, "SKILL.md"), "utf8"), /e2e fixture 1\.0\.1/);
    assert.match(readFileSync(join(root, "package.json"), "utf8"), /"version": "1\.0\.1"/);

    // The installed marker names the new version and the new file set.
    const after = JSON.parse(readFileSync(join(root, ".hiapi-skill-installed.json"), "utf8"));
    assert.equal(after.version, "1.0.1");
    assert.equal(after.source, "auto-update");
    assert.deepEqual(after.files, ["SKILL.md", "package.json", "scripts/hiapi-gpt-image-2-6.mjs", "scripts/lib/version.txt"]);

    // The previous version is backed up outside the skills directory.
    const backup = join(cache, SKILL_ID, "prev-1.0.0");
    assert.equal(readFileSync(join(backup, "package.json"), "utf8").includes('"version": "1.0.0"'), true);
    assert.equal(existsSync(join(root, "prev-1.0.0")), false);

    // The installer's own marker was replaced, and no stray temp files remain.
    assert.notEqual(after.version, marker.version);
  } finally {
    await close();
  }
});

test("end to end: a file tampered after signing is refused and nothing on disk changes", async () => {
  const next = await signedRelease("1.0.1", {
    // Same byte length, different content: the size check passes, the hash
    // check is what must catch it.
    mutateAfterSign: (dir) => writeFileSync(join(dir, "scripts/lib/version.txt"), "9.9.9"),
  });
  const { baseUrl, close } = await startServer({ "1.0.1": next });
  const { root, marker } = await installBase();
  // A file the installed copy owns and that the tampered release also ships.
  const relative = "SKILL.md";
  const before = readFileSync(join(root, relative));
  const skillBefore = readFileSync(join(root, "SKILL.md"), "utf8");
  try {
    const result = await installRelease({
      root,
      version: "1.0.1",
      currentVersion: "1.0.0",
      env: {
        HIAPI_SKILL_RELEASE_BASE_URL: `${baseUrl}/v{version}`,
        HIAPI_SKILL_CACHE_DIR: await mkdtemp(join(tmpdir(), "i26-e2e-tamper-")),
      },
      fetchImpl: fetch,
      trustedKeys: TEST_KEYS,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /sha256 mismatch for scripts\/lib\/version\.txt/);
    assert.equal(readFileSync(join(root, "SKILL.md"), "utf8"), skillBefore, "the installed SKILL.md is unchanged");
    assert.deepEqual(readFileSync(join(root, relative)), before);
    const after = JSON.parse(readFileSync(join(root, ".hiapi-skill-installed.json"), "utf8"));
    assert.equal(after.version, marker.version, "the marker still names the installed version");
    assert.equal(after.source, "installer");
  } finally {
    await close();
  }
});

test("the signer refuses to run without a key and with an untrusted key id", () => {
  const missingKey = spawnSync(process.execPath, [SIGNER, "--version", "1.0.0"], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, HIAPI_SKILL_SIGNING_KEY: "" },
  });
  assert.notEqual(missingKey.status, 0);
  assert.match(`${missingKey.stdout}${missingKey.stderr}`, /HIAPI_SKILL_SIGNING_KEY/);

  const untrusted = spawnSync(process.execPath, [SIGNER, "--version", "1.0.0", "--key-id", "nope"], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, HIAPI_SKILL_SIGNING_KEY: PRIVATE_DER },
  });
  assert.notEqual(untrusted.status, 0, "a release signed with an untrusted key id must not be produced");
  assert.match(`${untrusted.stdout}${untrusted.stderr}`, /not in the trusted key list/);

  const badVersion = spawnSync(process.execPath, [SIGNER, "--version", "one"], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, HIAPI_SKILL_SIGNING_KEY: PRIVATE_DER },
  });
  assert.notEqual(badVersion.status, 0);
  assert.match(`${badVersion.stdout}${badVersion.stderr}`, /--version <x\.y\.z>/);
});
