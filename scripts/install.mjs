#!/usr/bin/env node
// Installer. Copies the distributable file set into an agent skills directory.
// Works straight from a git clone or from `npx -y github:HiAPIAI/hiapi-gpt-image-2-6-skill`
// (no git command is required), and never touches a destination that is not
// this skill.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listDistributableFiles, writeInstallMarker } from "./lib/dist.mjs";

const SKILL_ID = "hiapi-gpt-image-2-6";
const SKILL_FOLDER = "hiapi-gpt-image-2-6";
const DISPLAY_NAME = "HiAPI GPT Image 2.6 Skill";
const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

const help = `HiAPI GPT Image 2.6 — installer

  npx -y github:HiAPIAI/hiapi-gpt-image-2-6-skill -y
  node scripts/install.mjs --target=/path/to/skills
  node scripts/install.mjs --codex          # ~/.codex/skills
  node scripts/install.mjs --claude         # ~/.claude/skills

Flags: -y/--yes install to every detected agent directory without asking;
--target=<dir> or --skills-dir=<dir> pick one directory; AGENT_SKILLS_DIR does
the same. An existing copy of this same skill is replaced; any other directory
is refused. Set HIAPI_API_KEY afterwards to create tasks.
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const argValue = (name) => {
  const prefix = `--${name}=`;
  const inline = argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).replace(/^~(?=$|\/)/, homedir());
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) {
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) return next.replace(/^~(?=$|\/)/, homedir());
  }
  return null;
};

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(help);
  process.exit(0);
}
// Validate unknown flags up front so a typo cannot silently install somewhere
// unexpected. -y/--yes are installer-only.
const INSTALLER_ONLY = new Set(["-y", "--yes", "--codex", "--claude", "--target", "--skills-dir", "--force", "--help", "-h"]);
const targetArgs = [argValue("target"), argValue("skills-dir")].filter(Boolean);
for (const arg of argv) {
  if (INSTALLER_ONLY.has(arg)) continue;
  if (arg.startsWith("--target=") || arg.startsWith("--skills-dir=")) continue;
  if (arg.startsWith("-")) fail(`Unknown installer flag: ${arg}\n\n${help}`);
}

const assumeYes = argv.includes("-y") || argv.includes("--yes") || !process.stdin.isTTY;
const explicitTarget = targetArgs[0] || process.env.AGENT_SKILLS_DIR || null;

function detectTargets() {
  const found = [];
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  if (existsSync(codexHome)) found.push({ label: "Codex", dir: join(codexHome, "skills") });
  const claudeHome = join(homedir(), ".claude");
  if (existsSync(claudeHome)) found.push({ label: "Claude Code", dir: join(claudeHome, "skills") });
  return found;
}

function expandTargets() {
  if (explicitTarget) return [{ label: "explicit target", dir: resolve(explicitTarget) }];
  if (argv.includes("--codex") && argv.includes("--claude")) return detectTargets();
  if (argv.includes("--codex")) {
    return [{ label: "Codex", dir: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills") }];
  }
  if (argv.includes("--claude")) return [{ label: "Claude Code", dir: join(homedir(), ".claude", "skills") }];
  const detected = detectTargets();
  if (!detected.length) {
    fail(`No agent skills directory found (looked for ~/.codex and ~/.claude).\nPass --target=<dir>, --codex, or --claude.\n\n${help}`);
  }
  // Non-interactive or -y: install everywhere that exists. Interactively we do
  // the same, because asking would hang an agent that runs this through a pipe.
  return detected;
}

function assertNotSymlink(path, label) {
  try {
    if (lstatSync(path).isSymbolicLink()) fail(`${label} must not be a symlink: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function existingSkillName(destination) {
  const skillPath = join(destination, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  const text = readFileSync(skillPath, "utf8");
  const match = /^---[\s\S]*?^name:\s*(\S+)\s*$/m.exec(text);
  return match ? match[1] : null;
}

function installTo(target) {
  const destination = join(target.dir, SKILL_FOLDER);
  if (resolve(destination) === SOURCE) fail("The install destination is this source directory; choose another --target.");
  assertNotSymlink(target.dir, "Install target directory");
  const existing = existsSync(destination) ? statSync(destination) : null;
  if (existing) {
    assertNotSymlink(destination, "Install destination");
    if (!existing.isDirectory()) fail(`Install destination exists and is not a directory: ${destination}`);
    const name = existingSkillName(destination);
    if (name !== SKILL_ID) {
      fail(
        `${destination} already exists but is not ${SKILL_ID} (SKILL.md name: ${JSON.stringify(name)}). Refusing to replace it.`,
      );
    }
    process.stdout.write(`[${DISPLAY_NAME}] Replacing the existing ${SKILL_ID} copy at ${destination}\n`);
    rmSync(destination, { recursive: true, force: true });
  }
  mkdirSync(destination, { recursive: true });
  const files = listDistributableFiles(SOURCE);
  if (!files.length) fail("No distributable files found in the package; is the checkout complete?");
  for (const rel of files) {
    const from = join(SOURCE, rel);
    const to = join(destination, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  writeInstallMarker(destination, {
    skillId: SKILL_ID,
    version: JSON.parse(readFileSync(join(SOURCE, "package.json"), "utf8")).version,
    source: "installer",
    installedAt: new Date().toISOString(),
    files,
  });
  process.stdout.write(`[${DISPLAY_NAME}] Installed ${files.length} files to ${destination}\n`);
  return destination;
}

const installed = expandTargets().map(installTo);

const keySet = Boolean(String(process.env.HIAPI_API_KEY || "").trim());
process.stdout.write(
  keySet
    ? `[${DISPLAY_NAME}] HIAPI_API_KEY is set.\n`
    : `[${DISPLAY_NAME}] HIAPI_API_KEY is not set yet. Create one at https://console.hiapi.ai/en/dashboard/api-keys?utm_source=skill&utm_medium=agent&utm_campaign=hiapi-gpt-image-2-6, then export HIAPI_API_KEY="..."\n`,
);
const autoUpdateOff = ["off", "0", "false", "no", "disabled"].includes(
  String(process.env.HIAPI_SKILL_AUTO_UPDATE || "").trim().toLowerCase(),
);
process.stdout.write(
  autoUpdateOff
    ? `[${DISPLAY_NAME}] Automatic updates are OFF (HIAPI_SKILL_AUTO_UPDATE); run --update by hand.\n`
    : `[${DISPLAY_NAME}] Automatic updates are ON: signed releases within 1.x install themselves on the next run. Turn off with HIAPI_SKILL_AUTO_UPDATE=off.\n`,
);
process.stdout.write(`[${DISPLAY_NAME}] Done${installed.length > 1 ? "" : ""}. Restart the agent if it caches skills.\n`);
