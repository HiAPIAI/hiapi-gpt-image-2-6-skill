import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createTask,
  extractImageUrl,
  extractTaskId,
  getTask,
  taskErrorMessage,
  waitForTask,
} from "../scripts/lib/api.mjs";
import { parseArgs } from "../scripts/lib/cli.mjs";

const config = { apiKey: "test-key", baseUrl: "https://api.test" };
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("every HTTP failure maps to a code and an actionable next step", () => {
  const cases = [
    [401, { message: "bad key" }, "UNAUTHORIZED", /HIAPI_API_KEY/],
    [403, { message: "forbidden" }, "UNAUTHORIZED", /HIAPI_API_KEY/],
    [402, { message: "insufficient quota" }, "INSUFFICIENT_QUOTA", /Top up|balance|dashboard/i],
    [429, { message: "slow down" }, "RATE_LIMITED", /same --idempotency-key/],
    [400, { message: "bad field", error_code: "INVALID_REQUEST" }, "INVALID_REQUEST", /--dry-run/],
    [500, { message: "boom" }, "HTTP_ERROR", /Retry once/],
  ];
  for (const [status, body, code, pattern] of cases) {
    const error = taskErrorMessage(status, body);
    assert.equal(error.code, code, `status ${status}`);
    assert.match(error.next, pattern, `status ${status}`);
    assert.ok(error.message.length > 0);
  }
});

test("PROMPT_TOO_LONG is recognised from the error code", () => {
  const error = taskErrorMessage(400, { error_code: "PROMPT_TOO_LONG", message: "too many tokens" });
  assert.equal(error.code, "PROMPT_TOO_LONG");
  assert.match(error.next, /Shorten the prompt/);
});

test("a network failure on create is reported as ambiguous and keeps the key", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNRESET");
  };
  await assert.rejects(
    createTask({ model: "m", input: { prompt: "p" } }, config, { idempotencyKey: "stable-key", fetchImpl }),
    (error) => {
      assert.equal(error.code, "NETWORK_AMBIGUOUS");
      assert.match(error.next, /--idempotency-key stable-key/);
      assert.match(error.next, /never a new key/);
      return true;
    },
  );
});

test("a create response without a task ID is ambiguous, never a silent success", async () => {
  await assert.rejects(
    createTask({ model: "m", input: { prompt: "p" } }, config, {
      idempotencyKey: "idem-x",
      fetchImpl: async () => json({ code: 200, data: {} }),
    }),
    (error) => {
      assert.equal(error.code, "NETWORK_AMBIGUOUS");
      assert.match(error.next, /idem-x/);
      return true;
    },
  );
});

test("idempotency keys are validated before any request", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return json({ data: { taskId: "t" } });
  };
  for (const key of ["   ", "bad\nkey", "x".repeat(256)]) {
    await assert.rejects(createTask({ model: "m", input: {} }, config, { idempotencyKey: key, fetchImpl }), /idempotency/i);
  }
  assert.equal(calls, 0);
  const ok = await createTask({ model: "m", input: {} }, config, { idempotencyKey: "ok-key", fetchImpl });
  assert.equal(ok.idempotencyKey, "ok-key");
  assert.equal(calls, 1);
});

test("task ID and image URL extraction accept the documented shapes", () => {
  assert.equal(extractTaskId({ data: { taskId: "a" } }), "a");
  assert.equal(extractTaskId({ data: { task_id: "b" } }), "b");
  assert.equal(extractTaskId({ taskId: "c" }), "c");
  assert.equal(extractTaskId({}), null);
  assert.equal(extractImageUrl({ data: { output: [{ type: "image", url: "https://cdn/x.png" }] } }), "https://cdn/x.png");
  assert.equal(extractImageUrl({ data: { output: [{ image_url: "https://cdn/y.png" }] } }), "https://cdn/y.png");
  assert.equal(
    extractImageUrl({
      data: {
        output: [
          { type: "video", url: "https://cdn/v.mp4" },
          { type: "thumbnail", url: "https://cdn/t.jpg" },
          { type: "image", imageUrl: "https://cdn/final.svg" },
        ],
      },
    }),
    "https://cdn/final.svg",
  );
  assert.equal(extractImageUrl({ data: { output: ["https://cdn/plain.png"] } }), "https://cdn/plain.png");
  assert.equal(extractImageUrl({ data: { output: [] } }), null);
  assert.equal(extractImageUrl({ data: { image_url: "https://cdn/top.png" } }), "https://cdn/top.png");
});

test("polling retries transient states and resolves on success", async () => {
  const statuses = ["queued", "handling", "archiving", "success"];
  let index = 0;
  const fetchImpl = async () =>
    json(
      statuses[index++] === "success"
        ? { data: { status: "success", output: [{ type: "image", url: "https://cdn/x.png" }] } }
        : { data: { status: statuses[index - 1] } },
    );
  const result = await waitForTask("t1", config, { fetchImpl, pollIntervalMs: 0, timeoutMinutes: 1 });
  assert.equal(result.imageUrl, "https://cdn/x.png");
  assert.equal(index, 4);
});

test("a failed task surfaces the reason and never retries", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return json({ data: { status: "fail", error: { message: "content policy" } } });
  };
  await assert.rejects(waitForTask("t2", config, { fetchImpl, pollIntervalMs: 0, timeoutMinutes: 1 }), (error) => {
    assert.equal(error.code, "TASK_FAILED");
    assert.match(error.message, /content policy/);
    return true;
  });
  assert.equal(calls, 1);
});

test("a success without an image output is an error, not a null output", async () => {
  await assert.rejects(
    waitForTask("t3", config, {
      fetchImpl: async () => json({ data: { status: "success", output: [] } }),
      pollIntervalMs: 0,
      timeoutMinutes: 1,
    }),
    (error) => {
      assert.equal(error.code, "NO_OUTPUT");
      return true;
    },
  );
});

test("transient HTTP errors back off and recover", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) return json({ message: "busy" }, 503);
    return json({ data: { status: "success", output: [{ type: "image", url: "https://cdn/late.png" }] } });
  };
  const result = await waitForTask("t4", config, { fetchImpl, pollIntervalMs: 1, timeoutMinutes: 1 });
  assert.equal(result.imageUrl, "https://cdn/late.png");
  assert.equal(calls, 3);
});

test("a permanent polling error stops immediately", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return json({ message: "invalid key" }, 401);
  };
  await assert.rejects(waitForTask("t5", config, { fetchImpl, pollIntervalMs: 1, timeoutMinutes: 1 }), /rejected the key/);
  assert.equal(calls, 1);
});

test("timeout carries the resume command and mentions svg timing", async () => {
  await assert.rejects(
    waitForTask("t6", config, {
      fetchImpl: async () => json({ data: { status: "handling" } }),
      pollIntervalMs: 5,
      timeoutMinutes: 0.00005,
      expectFormat: "svg",
    }),
    (error) => {
      assert.equal(error.code, "TIMEOUT");
      assert.match(error.next, /--resume-task-id t6/);
      assert.match(error.next, /SVG usually finishes within a minute/);
      return true;
    },
  );
});

test("a hung poll request is bounded by the request timeout", async () => {
  const fetchImpl = async (_url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  await assert.rejects(
    getTask("t7", config, { fetchImpl, requestTimeoutMs: 60 }),
    /Network request failed while polling/,
  );
});

test("CLI parsing covers every documented flag", async () => {
  const options = parseArgs([
    "--prompt", "a cat",
    "--family", "sunburst",
    "--image", "./a.png",
    "--image-url", "https://x/b.png",
    "--mask", "./m.png",
    "--aspect-ratio", "16:9",
    "--resolution", "2K",
    "--quality", "low",
    "--format", "webp",
    "--compression", "70",
    "--background", "opaque",
    "--complexity", "high",
    "--moderation", "auto",
    "--dry-run",
    "--estimate",
    "--max-cost", "0.2",
    "--idempotency-key", "k1",
    "--output-dir", "out",
    "--timeout-minutes", "10",
    "--no-auto-update",
  ]);
  assert.equal(options.prompt, "a cat");
  assert.equal(options.family, "sunburst");
  assert.deepEqual(options.imageSources, ["https://x/b.png", "./a.png"], "image-url and image both reach the payload");
  assert.equal(options.mask, "./m.png");
  assert.equal(options.aspectRatio, "16:9");
  assert.equal(options.resolution, "2K");
  assert.equal(options.quality, "low");
  assert.equal(options.outputFormat, "webp");
  assert.equal(options.outputCompression, "70");
  assert.equal(options.background, "opaque");
  assert.equal(options.complexity, "high");
  assert.equal(options.moderation, "auto");
  assert.equal(options.dryRun, true);
  assert.equal(options.estimate, true);
  assert.equal(options.maxCost, "0.2");
  assert.equal(options.idempotencyKey, "k1");
  assert.equal(options.outputDir, "out");
  assert.equal(options.timeoutMinutes, "10");
  assert.equal(options.noAutoUpdate, true);
});

test("aliases and boolean flags parse to the same option", () => {
  assert.equal(parseArgs(["--aspect", "1:1"]).aspectRatio, "1:1");
  assert.equal(parseArgs(["--output-format", "png"]).outputFormat, "png");
  assert.equal(parseArgs(["--output-compression", "50"]).outputCompression, "50");
  assert.equal(parseArgs(["--gif"]).gif, true);
  assert.equal(parseArgs(["--svg"]).svg, true);
  assert.equal(parseArgs(["--no-wait"]).wait, false);
  assert.equal(parseArgs(["--no-save"]).save, false);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--version"]).version, true);
  assert.equal(parseArgs(["--update"]).update, true);
  assert.equal(parseArgs(["--allow-major"]).allowMajor, true);
});

test("a positional prompt works, extra positionals and unknown flags are rejected", () => {
  assert.equal(parseArgs(["a gentle lake"]).prompt, "a gentle lake");
  assert.throws(() => parseArgs(["one", "two"]), /Unexpected extra positional/);
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
  for (const flag of ["--prompt", "--image", "--image-url", "--model", "--mask", "--resume-task-id"]) {
    assert.throws(() => parseArgs([flag, "--dry-run"]), /requires a value/);
  }
});

test("resume cannot be combined with preflight", () => {
  assert.throws(() => parseArgs(["--resume-task-id", "t", "--dry-run"]), /cannot be combined/);
  assert.throws(() => parseArgs(["--resume-task-id", "t", "--estimate"]), /cannot be combined/);
});

test("runtime source contains no key printing and no real API key", async () => {
  const runtime = await readFile(new URL("../scripts/hiapi-gpt-image-2-6.mjs", import.meta.url), "utf8");
  const lib = await readFile(new URL("../scripts/lib/api.mjs", import.meta.url), "utf8");
  for (const text of [runtime, lib]) {
    assert.doesNotMatch(text, /console\.log\([^)]*apiKey/, "the key must never be printed");
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{10,}/, "no hardcoded key material");
  }
});
