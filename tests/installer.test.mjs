import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, lstatSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const INSTALLER = join(REPO, "scripts/install.mjs");
const SKILL_ID = "hiapi-gpt-image-2-6";

function runInstaller(args, env = {}) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: "utf8",
    env: { ...process.env, HIAPI_API_KEY: "", ...env },
  });
}

test("--help documents every install mode and exits zero", () => {
  const result = runInstaller(["--help"]);
  assert.equal(result.status, 0);
  for (const marker of ["--target", "--codex", "--claude", "-y", "AGENT_SKILLS_DIR"]) {
    assert.match(result.stdout, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("installing into an explicit target copies the distributable set only", async () => {
  const target = await mkdtemp(join(tmpdir(), "i26-inst-"));
  const result = runInstaller([`--target=${target}`]);
  assert.equal(result.status, 0, result.stderr);
  const destination = join(target, SKILL_ID);
  for (const file of ["SKILL.md", "package.json", "scripts/hiapi-gpt-image-2-6.mjs", "scripts/install.mjs", "references/api.md"]) {
    assert.ok(existsSync(join(destination, file)), file);
  }
  for (const absent of [".git", "outputs", "node_modules", ".env"]) {
    assert.equal(existsSync(join(destination, absent)), false, absent);
  }
  const marker = JSON.parse(readFileSync(join(destination, ".hiapi-skill-installed.json"), "utf8"));
  assert.equal(marker.skillId, SKILL_ID);
  assert.equal(marker.source, "installer");
  assert.ok(marker.files.includes("SKILL.md"));
  assert.ok(!marker.files.includes(".env"));
  assert.match(result.stdout, /HIAPI_API_KEY is not set/);
  assert.match(result.stdout, /Automatic updates are ON/);
});

test("the API key value is never printed; only its presence is reported", async () => {
  const target = await mkdtemp(join(tmpdir(), "i26-inst-key-"));
  const result = runInstaller([`--target=${target}`], { HIAPI_API_KEY: "secret-value-that-must-not-leak" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /HIAPI_API_KEY is set/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-value-that-must-not-leak/);
});

test("auto-update being off is reported at install time", async () => {
  const target = await mkdtemp(join(tmpdir(), "i26-inst-off-"));
  const result = runInstaller([`--target=${target}`], { HIAPI_SKILL_AUTO_UPDATE: "off" });
  assert.match(result.stdout, /Automatic updates are OFF/);
});

test("reinstalling replaces the same skill", async () => {
  const target = await mkdtemp(join(tmpdir(), "i26-inst-again-"));
  assert.equal(runInstaller([`--target=${target}`]).status, 0);
  const destination = join(target, SKILL_ID);
  writeFileSync(join(destination, "stale-file.txt"), "from an older copy");
  const again = runInstaller([`--target=${target}`]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Replacing the existing/);
  assert.equal(existsSync(join(destination, "stale-file.txt")), false, "a stale file from the old copy is gone");
  assert.ok(existsSync(join(destination, "SKILL.md")));
});

test("a destination holding a different skill is refused", async () => {
  const target = await mkdtemp(join(tmpdir(), "i26-inst-other-"));
  const destination = join(target, SKILL_ID);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "SKILL.md"), "---\nname: some-other-skill\n---\n");
  const result = runInstaller([`--target=${target}`]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /not hiapi-gpt-image-2-6/);
  assert.equal(readFileSync(join(destination, "SKILL.md"), "utf8").includes("some-other-skill"), true, "the other skill is untouched");
});

test("a symlinked destination is refused", async () => {
  const target = await mkdtemp(join(tmpdir(), "i26-inst-link-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "i26-linked-"));
  symlinkSync(elsewhere, join(target, SKILL_ID));
  const result = runInstaller([`--target=${target}`]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /symlink/);
});

test("AGENT_SKILLS_DIR is honoured as a target", async () => {
  const target = await mkdtemp(join(tmpdir(), "i26-inst-env-"));
  const result = runInstaller([], { AGENT_SKILLS_DIR: target });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(target, SKILL_ID, "SKILL.md")));
});

test("an unknown installer flag fails instead of silently installing elsewhere", async () => {
  const target = await mkdtemp(join(tmpdir(), "i26-inst-bad-"));
  const result = runInstaller([`--target=${target}`, "--nonsense"]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Unknown installer flag/);
  assert.equal(existsSync(join(target, SKILL_ID)), false);
});

test("the installer never writes into its own source directory", () => {
  const result = runInstaller([`--target=${join(REPO, "..")}`]);
  // The source is .../skills/<skill>; installing into .../skills is legitimate,
  // but installing into the skill's own parent must not create a nested copy of
  // the source inside itself.
  const nested = join(REPO, SKILL_ID);
  assert.equal(existsSync(nested), false, "no nested copy inside the source tree");
  void result;
});

test("the installer works without git available on PATH", async () => {
  const target = await mkdtemp(join(tmpdir(), "i26-inst-nogit-"));
  const result = spawnSync(process.execPath, [INSTALLER, `--target=${target}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin", HIAPI_API_KEY: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(target, SKILL_ID, "SKILL.md")));
});

test("every installed file is a regular file, not a link", async () => {
  const target = await mkdtemp(join(tmpdir(), "i26-inst-reg-"));
  assert.equal(runInstaller([`--target=${target}`]).status, 0);
  const destination = join(target, SKILL_ID);
  for (const rel of ["SKILL.md", "package.json", "scripts/install.mjs"]) {
    assert.equal(lstatSync(join(destination, rel)).isFile(), true, rel);
  }
});
