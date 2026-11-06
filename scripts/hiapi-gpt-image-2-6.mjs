#!/usr/bin/env node
// Entry point: argument dispatch, update gate, preflight, create, recover.
//
// stdout carries JSON only; every human hint goes to stderr. Every JSON object
// (success or failure) carries a `next` field with the literal next command.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  HIAPI_DOCS_URL,
  HIAPI_PRICING_URL,
  SKILL_ID,
  SKILL_VERSION,
  SkillError,
} from "./lib/contract.mjs";
import { BOOLEAN_FLAGS, parseArgs, usage } from "./lib/cli.mjs";
import {
  buildPayload,
  redactPayload,
  timeoutMinutesOf,
} from "./lib/payload.mjs";
import { checkMaskFile, readPngHeader } from "./lib/png.mjs";
import { enforceMaxCost, estimatePayload } from "./lib/pricing.mjs";
import { inspectLocalImage, resolveSource, uploadLocalSources } from "./lib/upload.mjs";
import {
  checkLiveContract,
  createTask,
  resolveConfig,
  saveOutput,
  waitForTask,
} from "./lib/api.mjs";
import {
  describeLocalInstall,
  evaluatePolicy,
  readUpdatePolicy,
  reexecWithUpdatedSkill,
  runUpdateCheck,
  sameMajor,
} from "./lib/update.mjs";

export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = fileURLToPath(import.meta.url);

function out(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function hint(message) {
  if (message) process.stderr.write(`${message}\n`);
}

function failure(error) {
  const payload = {
    ok: false,
    error: error?.message || String(error),
  };
  if (error?.code) payload.code = error.code;
  payload.next =
    error?.next ||
    `Run with --help for usage, or re-check the payload with --dry-run --estimate. Docs: ${HIAPI_DOCS_URL}`;
  out(payload);
  process.exitCode = 1;
}

function isPreflight(options) {
  return Boolean(options.dryRun || options.estimate);
}

/**
 * Prints local checks for reference files without touching the network:
 * existence, type, size for every image; PNG + RGBA + size match for the mask.
 */
function inspectLocalSources(options) {
  const locals = [];
  const checked = [];
  const images = options.imageSources || [];
  for (const source of images) {
    if (/^https?:\/\//i.test(source)) {
      checked.push({ kind: "image", source, status: "url" });
      continue;
    }
    const info = inspectLocalImage(source);
    locals.push(info.path);
    checked.push({
      kind: "image",
      source,
      status: "local-ok",
      bytes: info.size,
      mimeType: info.mimeType,
      upload: "deferred to create (dry-run uploads nothing)",
    });
  }
  const maskPath = options.mask && !/^https?:\/\//i.test(options.mask) ? options.mask : null;
  if (maskPath) {
    const firstLocalImage = (options.imageSources || []).find((source) => !/^https?:\/\//i.test(source));
    const firstHeader = firstLocalImage ? readPngHeader(firstLocalImage) : null;
    const mask = checkMaskFile(maskPath, firstHeader);
    checked.push({ kind: "mask", source: maskPath, status: mask.checked, reason: mask.reason, width: mask.width, height: mask.height });
    if (mask.checked === "failed") {
      throw new SkillError(`Local mask check failed: ${mask.reason}`, { code: "MASK_INVALID", next: mask.next });
    }
  } else if (options.mask) {
    checked.push({ kind: "mask", source: options.mask, status: "unchecked", reason: "remote mask URL; the API validates it" });
  }
  if (options.markup) {
    checked.push({
      kind: "markup",
      source: options.markup,
      status: /^https?:\/\//i.test(options.markup) ? "unchecked" : "local-ok",
    });
  }
  return { checked, locals };
}

async function runPreflight(options) {
  const { payload, mode, family, notes, adjustments, warnings, referenceImages } = buildPayload(options);
  const localReport = inspectLocalSources(options);
  const estimate = options.estimate ? await estimatePayload(payload) : null;
  const gate = estimate ? enforceMaxCost(estimate, options.maxCost) : { allowed: true };
  const result = {
    ok: true,
    paidTaskCreated: false,
    skill: { id: SKILL_ID, version: SKILL_VERSION },
    model: payload.model,
    family,
    mode,
    payload: redactPayload(payload),
    referenceImages,
    localFiles: localReport.checked,
    adjustments,
    warnings,
    notes,
    estimate,
    maxCost: options.maxCost == null ? null : Number(options.maxCost),
    wouldBeBlocked: !gate.allowed,
  };
  if (gate.allowed) {
    result.next = options.estimate
      ? "Review the payload and estimate, then run the same command without --dry-run/--estimate to create the paid task."
      : "Review the payload, then run the same command without --dry-run to create the paid task.";
  } else {
    result.next = gate.reason;
    result.blockedReason = gate.reason;
    result.howToFix = gate.next;
  }
  for (const warning of warnings) hint(`warning: ${warning}`);
  for (const note of notes) hint(note);
  out(result);
  if (!gate.allowed) process.exitCode = 3;
}

async function runCreate(options) {
  const built = buildPayload(options);
  const config = resolveConfig();
  const timeoutMinutes = timeoutMinutesOf(options.timeoutMinutes);
  const estimate = await estimatePayload(built.payload);
  const gate = enforceMaxCost(estimate, options.maxCost);
  if (!gate.allowed) {
    out({
      ok: false,
      paidTaskCreated: false,
      code: "MAX_COST_EXCEEDED",
      error: gate.reason,
      estimate,
      next: gate.next,
    });
    process.exitCode = 3;
    return;
  }
  for (const note of built.notes) hint(note);
  for (const warning of built.warnings) hint(`warning: ${warning}`);

  // Upload local files only now: preflight never touches the network for files,
  // and the upload cache keeps a retry's payload byte-identical.
  let payload = built.payload;
  let uploads = [];
  if (built.localSources.length) {
    hint(`Uploading ${built.localSources.length} local file(s) to /v1/uploads …`);
    const uploaded = await uploadLocalSources(built.payload, { config });
    payload = uploaded.payload;
    uploads = uploaded.uploads;
  }
  const idempotencyKey = options.idempotencyKey || undefined;
  const created = await createTask(payload, config, { idempotencyKey });
  hint(`HiAPI idempotency key: ${created.idempotencyKey}`);
  hint(`HiAPI task created: ${created.taskId}`);
  const base = {
    ok: true,
    skill: { id: SKILL_ID, version: SKILL_VERSION },
    taskId: created.taskId,
    idempotencyKey: created.idempotencyKey,
    model: payload.model,
    mode: built.mode,
    family: built.family,
    payload: redactPayload(payload),
    uploads,
    adjustments: built.adjustments,
    warnings: built.warnings,
    notes: built.notes,
    estimate,
  };
  if (options.wait === false) {
    out({
      ...base,
      status: "submitted",
      next: `Wait for it without paying again: node scripts/hiapi-gpt-image-2-6.mjs --resume-task-id ${created.taskId}`,
    });
    return;
  }
  const finished = await waitForTask(created.taskId, config, {
    timeoutMinutes,
    expectFormat: payload.input.output_format,
  });
  const output =
    options.save === false
      ? { kind: "url", value: finished.imageUrl }
      : await saveOutput(finished.imageUrl, options.outputDir, { taskId: created.taskId });
  out({
    ...base,
    status: "success",
    output,
    next:
      payload.input.output_format === "svg"
        ? "Open the .svg to confirm it renders as vector art, then use it. To change it, edit the prompt and create a new task."
        : options.save === false
          ? "The URL is temporary; download it yourself before it expires."
          : "Check the file, then use it. Keep the task ID for re-downloads (resume) and the key for auditing.",
  });
}

async function runResume(options) {
  const config = resolveConfig();
  const taskId = String(options.resumeTaskId).trim();
  if (!taskId) throw new SkillError("--resume-task-id requires a task ID.", { code: "INVALID_REQUEST" });
  const timeoutMinutes = timeoutMinutesOf(options.timeoutMinutes);
  hint(`Resuming HiAPI task: ${taskId} (no new task is created)`);
  const finished = await waitForTask(taskId, config, { timeoutMinutes });
  const output =
    options.save === false
      ? { kind: "url", value: finished.imageUrl }
      : await saveOutput(finished.imageUrl, options.outputDir, { taskId });
  out({
    ok: true,
    skill: { id: SKILL_ID, version: SKILL_VERSION },
    taskId,
    status: "success",
    output,
    next: options.save === false ? "The URL is temporary; download it yourself before it expires." : "Check the file, then use it.",
  });
}

/**
 * Update gate for one run.
 *
 * `hardBlock` is true when this copy is below the policy minimum AND the update
 * could not be applied; then only paid creation is refused.
 */
async function updateGate(options) {
  const env = process.env;
  const result = await runUpdateCheck({
    env,
    root: SKILL_ROOT,
    currentVersion: SKILL_VERSION,
    noAutoUpdate: options.noAutoUpdate,
    allowMajor: options.allowMajor,
    force: options.update,
  });
  let { check, update } = result;
  if (check.status === "required" && !update?.attempted) {
    // A hard requirement across a major boundary is installed only with
    // explicit consent: --update --allow-major.
    if (check.latestVersion && !sameMajor(SKILL_VERSION, check.latestVersion)) {
      update = {
        attempted: false,
        status: "skipped",
        reason: "the required version is a new major; run --update --allow-major",
      };
    }
  }
  const hardBlock = check.status === "required" && update?.status !== "updated";
  if (update?.status === "updated") {
    hint(update.message);
  } else if (update?.status === "failed") {
    hint(`Auto-update failed: ${update.reason}. Continuing with ${SKILL_VERSION}.`);
  } else if (check.status === "available" && update?.status === "skipped" && check.message) {
    hint(check.message);
  } else if (check.status === "unverified") {
    hint("Version freshness was not verified; continuing with local validation.");
  }
  return { check, update, hardBlock };
}

async function runManualUpdate(options) {
  const env = process.env;
  const result = await runUpdateCheck({
    env,
    root: SKILL_ROOT,
    currentVersion: SKILL_VERSION,
    noAutoUpdate: false,
    allowMajor: options.allowMajor,
    force: true,
  });
  const { check, update } = result;
  const payload = {
    ok: update?.status === "updated" || ["current", "available", "major"].includes(check.status),
    skill: { id: SKILL_ID, version: SKILL_VERSION },
    check,
    update,
  };
  if (update?.status === "updated") {
    payload.next = `Restart the agent session (or re-read SKILL.md) so the new code is loaded; run --version to confirm ${update.toVersion}.`;
  } else if (check.status === "current") {
    payload.next = "Already on the latest published version. Nothing to do.";
  } else if (check.status === "major") {
    payload.next = `This is a new major version (${check.latestVersion}). Re-run with --update --allow-major to install it.`;
  } else if (update?.status === "skipped") {
    payload.next = `Update skipped: ${update.reason}. Re-run when that condition clears.`;
  } else if (update?.status === "failed") {
    payload.next = `Update failed: ${update.reason}. The installed copy is unchanged. Retry later or install manually: ${check.updateCommand || "see README"}.`;
  } else {
    payload.next = "No update was applied.";
  }
  if (!payload.ok) process.exitCode = 1;
  out(payload);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    // --help prints text, not JSON: it is documentation, not a result.
    process.stdout.write(`${usage(SKILL_VERSION, { aspectRatios: "auto|1:1|3:2|2:3|4:3|3:4|5:4|4:5|16:9|9:16|2:1|1:2|21:9|9:21|3:1|1:3" })}\n`);
    return;
  }
  if (options.version) {
    out({ ok: true, ...describeLocalInstall(SKILL_ROOT, { version: SKILL_VERSION }) });
    return;
  }
  if (options.checkContract) {
    const contract = await checkLiveContract();
    out(contract);
    if (!contract.ok) process.exitCode = 2;
    return;
  }
  if (options.update) {
    await runManualUpdate(options);
    return;
  }

  const gate = await updateGate(options);

  if (gate.hardBlock && !isPreflight(options) && !options.resumeTaskId) {
    out({
      ok: false,
      code: "SKILL_UPDATE_REQUIRED",
      error: gate.check.message,
      upgrade: { currentVersion: SKILL_VERSION, latestVersion: gate.check.latestVersion, update: gate.update },
      next:
        `This copy must be updated before creating new paid tasks. Run: ${gate.check.updateCommand || "npx -y github:HiAPIAI/hiapi-gpt-image-2-6-skill -y"}. ` +
        "Preflight (--dry-run/--estimate) and --resume-task-id still work.",
    });
    process.exitCode = 4;
    return;
  }

  if (gate.hardBlock) {
    hint(`This skill version (${SKILL_VERSION}) is below the required minimum; only preflight and recovery are available. ${gate.check.message}`);
  }

  if (isPreflight(options)) {
    await runPreflight(options);
    return;
  }
  if (options.resumeTaskId) {
    await runResume(options);
    return;
  }

  // After a successful hard update, run the same command on the new code so a
  // hard requirement is invisible to the caller (marked to prevent a loop).
  if (gate.update?.status === "updated" && gate.check.status === "required") {
    hint(`Hard upgrade installed ${gate.update.toVersion}; re-running this command on the new version.`);
    const child = reexecWithUpdatedSkill(ENTRY, process.argv.slice(2), (code) => {
      process.exitCode = code;
    });
    void child;
    return;
  }

  await runCreate(options);
}

main().catch(failure);
