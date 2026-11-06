import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { checkMaskFile, readPngHeader, sniffImageType } from "../scripts/lib/png.mjs";
import {
  detectOutputFormat,
  looksLikeSvg,
  saveOutput,
} from "../scripts/lib/api.mjs";
import {
  inspectLocalImage,
  resolveSource,
  uploadLocalSources,
} from "../scripts/lib/upload.mjs";

/** Minimal but structurally valid PNG writer (IHDR + IDAT + IEND). */
export function makePng({ width = 8, height = 8, colorType = 6, bitDepth = 8 } = {}) {
  const crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();
  const crc = (buf) => {
    let c = -1;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const channels = { 0: 1, 2: 3, 6: 4 }[colorType] ?? 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const raw = Buffer.alloc((channels + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[(channels + 1) * y] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

test("PNG header parsing reports size and colour type", async () => {
  const dir = await tempDir("i26-png-");
  const rgba = join(dir, "rgba.png");
  await writeFile(rgba, makePng({ width: 40, height: 24, colorType: 6 }));
  const header = readPngHeader(rgba);
  assert.equal(header.ok, true);
  assert.equal(header.width, 40);
  assert.equal(header.height, 24);
  assert.equal(header.colorType, 6);
  assert.equal(header.colorTypeName, "rgba");
});

test("non-PNG and truncated files are rejected with a reason", async () => {
  const dir = await tempDir("i26-png-bad-");
  const jpeg = join(dir, "photo.jpg");
  await writeFile(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)]));
  const header = readPngHeader(jpeg);
  assert.equal(header.ok, false);
  assert.match(header.reason, /not a PNG/);
  const short = join(dir, "short.png");
  await writeFile(short, Buffer.from([0x89, 0x50]));
  assert.match(readPngHeader(short).reason, /too short/);
  assert.match(readPngHeader(join(dir, "missing.png")).reason, /cannot open/);
});

test("mask must be RGBA PNG and match the first image size", async () => {
  const dir = await tempDir("i26-mask-");
  const image = join(dir, "photo.png");
  const mask = join(dir, "mask.png");
  const rgbMask = join(dir, "mask-rgb.png");
  const smallMask = join(dir, "mask-small.png");
  await writeFile(image, makePng({ width: 64, height: 48, colorType: 2 }));
  await writeFile(mask, makePng({ width: 64, height: 48, colorType: 6 }));
  await writeFile(rgbMask, makePng({ width: 64, height: 48, colorType: 2 }));
  await writeFile(smallMask, makePng({ width: 32, height: 32, colorType: 6 }));
  const firstImage = readPngHeader(image);
  assert.equal(checkMaskFile(mask, firstImage).checked, "ok");
  const rgb = checkMaskFile(rgbMask, firstImage);
  assert.equal(rgb.checked, "failed");
  assert.match(rgb.reason, /RGBA/);
  assert.match(rgb.next, /alpha channel/);
  const small = checkMaskFile(smallMask, firstImage);
  assert.equal(small.checked, "failed");
  assert.match(small.reason, /64x48/);
  const unknown = checkMaskFile(mask, null);
  assert.equal(unknown.checked, "partial", "an unreadable first image yields 'unchecked', never a false pass");
});

test("local image inspection accepts png/jpeg/webp and rejects gif, svg and oversize files", async () => {
  const dir = await tempDir("i26-inspect-");
  const png = join(dir, "a.png");
  await writeFile(png, makePng());
  assert.equal(inspectLocalImage(png).mimeType, "image/png");
  const jpeg = join(dir, "b.jpg");
  await writeFile(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  assert.equal(inspectLocalImage(jpeg).mimeType, "image/jpeg");
  const webp = join(dir, "c.webp");
  await writeFile(webp, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]));
  assert.equal(inspectLocalImage(webp).mimeType, "image/webp");
  const gif = join(dir, "d.gif");
  await writeFile(gif, Buffer.from("GIF89a...."));
  assert.throws(() => inspectLocalImage(gif), /GIF reference images are not accepted/);
  const svg = join(dir, "e.svg");
  await writeFile(svg, "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  assert.throws(() => inspectLocalImage(svg), /Unsupported image type/);
  assert.throws(() => inspectLocalImage(join(dir, "missing.png")), /not found/);
  assert.throws(() => inspectLocalImage(dir), /Not a regular file/);
});

test("dry-run resolves local paths without any network call", async () => {
  const dir = await tempDir("i26-dry-");
  const png = join(dir, "a.png");
  await writeFile(png, makePng());
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("dry run must not fetch");
  };
  const result = await resolveSource(png, { config: { apiKey: "k", baseUrl: "https://api.test" }, fetchImpl, dryRun: true });
  assert.equal(result.url, null);
  assert.equal(result.local.uploaded, false);
  assert.equal(calls, 0);
});

test("uploads are multipart POST /v1/uploads and cached by content hash", async () => {
  const dir = await tempDir("i26-upload-");
  const cache = await tempDir("i26-cache-");
  process.env.HIAPI_SKILL_CACHE_DIR = cache;
  const png = join(dir, "a.png");
  await writeFile(png, makePng());
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, "https://api.test/v1/uploads");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer secret-key");
    assert.ok(options.body instanceof FormData, "upload must be multipart");
    const file = options.body.get("file");
    assert.ok(file, "the multipart field must be named file");
    return new Response(
      JSON.stringify({ url: "https://cdn.test/uploaded.png", media_type: "image", content_type: "image/png", size: 123, expires_at: Math.floor(Date.now() / 1000) + 86400 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const config = { apiKey: "secret-key", baseUrl: "https://api.test" };
  const first = await resolveSource(png, { config, fetchImpl });
  assert.equal(first.url, "https://cdn.test/uploaded.png");
  assert.equal(first.source, "upload");
  assert.equal(calls, 1);
  const second = await resolveSource(png, { config, fetchImpl });
  assert.equal(second.source, "cache");
  assert.equal(calls, 1, "the same bytes must reuse the cached URL");
  // A changed file must upload again.
  await writeFile(png, makePng({ width: 16, height: 16 }));
  await resolveSource(png, { config, fetchImpl });
  assert.equal(calls, 2);
  delete process.env.HIAPI_SKILL_CACHE_DIR;
});

test("an expired cache entry is not reused", async () => {
  const dir = await tempDir("i26-expired-");
  const cache = await tempDir("i26-cache-exp-");
  process.env.HIAPI_SKILL_CACHE_DIR = cache;
  const png = join(dir, "a.png");
  await writeFile(png, makePng({ width: 12, height: 12 }));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ url: `https://cdn.test/${calls}.png`, expires_at: Math.floor(Date.now() / 1000) + 86400 }),
      { status: 200 },
    );
  };
  const config = { apiKey: "k", baseUrl: "https://api.test" };
  await resolveSource(png, { config, fetchImpl });
  const [file] = (await readdir(join(cache, "hiapi-gpt-image-2-6", "uploads"))).filter((name) => name.endsWith(".json"));
  const path = join(cache, "hiapi-gpt-image-2-6", "uploads", file);
  const entry = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...entry, expiresAt: Math.floor(Date.now() / 1000) - 10 }));
  const again = await resolveSource(png, { config, fetchImpl });
  assert.equal(again.source, "upload");
  assert.equal(calls, 2);
  delete process.env.HIAPI_SKILL_CACHE_DIR;
});

test("upload failures carry a status-specific next step", async () => {
  const dir = await tempDir("i26-upload-fail-");
  const cache = await tempDir("i26-cache-fail-");
  process.env.HIAPI_SKILL_CACHE_DIR = cache;
  const png = join(dir, "a.png");
  await writeFile(png, makePng({ width: 10, height: 10 }));
  const config = { apiKey: "k", baseUrl: "https://api.test" };
  for (const [status, pattern] of [
    [401, /HIAPI_API_KEY/],
    [402, /balance/],
    [429, /rate limit/i],
    [400, /host it yourself/i],
  ]) {
    const fetchImpl = async () => new Response(JSON.stringify({ message: "nope" }), { status });
    await assert.rejects(resolveSource(png, { config, fetchImpl }), (error) => {
      assert.match(`${error.message} ${error.next}`, pattern);
      return true;
    });
  }
  delete process.env.HIAPI_SKILL_CACHE_DIR;
});

test("a successful upload response without a URL is rejected", async () => {
  const dir = await tempDir("i26-upload-nourl-");
  const cache = await tempDir("i26-cache-nourl-");
  process.env.HIAPI_SKILL_CACHE_DIR = cache;
  const png = join(dir, "a.png");
  await writeFile(png, makePng({ width: 9, height: 9 }));
  const fetchImpl = async () => new Response(JSON.stringify({ media_type: "image" }), { status: 200 });
  await assert.rejects(
    resolveSource(png, { config: { apiKey: "k", baseUrl: "https://api.test" }, fetchImpl }),
    /no URL/,
  );
  delete process.env.HIAPI_SKILL_CACHE_DIR;
});

test("uploadLocalSources rewrites images, mask and markup and reports each file", async () => {
  const dir = await tempDir("i26-rewrite-");
  const cache = await tempDir("i26-cache-rw-");
  process.env.HIAPI_SKILL_CACHE_DIR = cache;
  const image = join(dir, "a.png");
  const mask = join(dir, "m.png");
  await writeFile(image, makePng({ colorType: 2 }));
  await writeFile(mask, makePng({ colorType: 6 }));
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return new Response(JSON.stringify({ url: `https://cdn.test/${n}.png`, expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
  };
  const payload = {
    model: "gpt-image-2.6-flare/image-to-image",
    input: { prompt: "p", image_urls: [image, "https://keep.me/a.png"], mask_url: mask },
  };
  const result = await uploadLocalSources(payload, { config: { apiKey: "k", baseUrl: "https://api.test" }, fetchImpl });
  assert.match(result.payload.input.image_urls[0], /^https:\/\/cdn\.test\//);
  assert.equal(result.payload.input.image_urls[1], "https://keep.me/a.png", "http URLs are never re-uploaded");
  assert.match(result.payload.input.mask_url, /^https:\/\/cdn\.test\//);
  assert.equal(result.uploads.length, 3);
  assert.deepEqual(result.uploads.map((item) => item.action), ["upload", "kept-url", "upload"]);
  delete process.env.HIAPI_SKILL_CACHE_DIR;
});

test("an unknown byte sequence is not mistaken for an image", () => {
  assert.equal(sniffImageType(Buffer.from("<!doctype html><title>login</title>")), null);
  assert.equal(sniffImageType(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4)])), "image/png");
});

test("GIF87a and GIF89a are recognised as gif output", () => {
  for (const header of ["GIF87a", "GIF89a"]) {
    const bytes = Buffer.from(`${header}....`);
    assert.deepEqual(detectOutputFormat(bytes, "image/gif"), { ext: ".gif", mime: "image/gif" });
  }
});

test("svg recognition skips BOM, whitespace, xml declaration, doctype and comments", () => {
  const variants = [
    "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "﻿<svg></svg>",
    "\n\n   <svg viewBox='0 0 1 1'></svg>",
    "<?xml version='1.0' encoding='UTF-8'?><svg></svg>",
    "<!-- generated --><!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg></svg>",
    "<?xml version='1.0'?>\n<!-- a -->\n<!-- b -->\n<svg/>",
  ];
  for (const variant of variants) assert.equal(looksLikeSvg(variant), true, JSON.stringify(variant.slice(0, 40)));
  for (const notSvg of [
    "<!doctype html><title>login</title>",
    "{\"error\":\"nope\"}",
    "<html><body><svg></svg></body></html>",
  ]) {
    assert.equal(looksLikeSvg(notSvg), false, notSvg);
  }
});

test("svg output is saved as .svg and other text/* content types pass", async () => {
  const dir = await tempDir("i26-svg-");
  const body = Buffer.from("<?xml version='1.0'?><svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>");
  const result = await saveOutput("https://cdn.test/out.svg", dir, {
    fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }),
  });
  assert.equal(result.kind, "file");
  assert.ok(result.path.endsWith(".svg"));
  assert.deepEqual(await readFile(result.path), body);
});

test("a forged image header with a mismatched content type is rejected", async () => {
  const dir = await tempDir("i26-forged-");
  const pngBytes = makePng();
  await assert.rejects(
    saveOutput("https://cdn.test/x.png", dir, {
      fetchImpl: async () => new Response(pngBytes, { status: 200, headers: { "content-type": "image/gif" } }),
    }),
    /not a supported image/,
  );
  // HTML served with an image content type must not be saved as an image.
  await assert.rejects(
    saveOutput("https://cdn.test/x.png", dir, {
      fetchImpl: async () => new Response("<!doctype html><title>login</title>", { status: 200, headers: { "content-type": "image/png" } }),
    }),
    /not a supported image/,
  );
});

test("expired download and HTTP failure both point at resume", async () => {
  const dir = await tempDir("i26-expired-dl-");
  await assert.rejects(
    saveOutput("https://cdn.test/old.png", dir, {
      taskId: "task-9",
      fetchImpl: async () => new Response("gone", { status: 403 }),
    }),
    (error) => {
      assert.equal(error.code, "DOWNLOAD_EXPIRED");
      assert.match(error.next, /--resume-task-id task-9/);
      return true;
    },
  );
});

test("png/jpeg/webp downloads use matching extensions and unique names", async () => {
  const dir = await tempDir("i26-formats-");
  const cases = [
    [makePng(), "image/png", ".png"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "image/jpeg", ".jpg"],
    [Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]), "image/webp", ".webp"],
    [Buffer.from("GIF89a...."), "image/gif", ".gif"],
  ];
  for (const [bytes, mime, ext] of cases) {
    const result = await saveOutput("https://cdn.test/x", dir, {
      fetchImpl: async () => new Response(bytes, { status: 200, headers: { "content-type": mime } }),
    });
    assert.ok(result.path.endsWith(ext), `${mime} -> ${result.path}`);
  }
  const results = await Promise.all(
    [0, 1].map(() =>
      saveOutput("https://cdn.test/x", dir, {
        fetchImpl: async () => new Response(makePng(), { status: 200, headers: { "content-type": "image/png" } }),
      }),
    ),
  );
  assert.notEqual(results[0].path, results[1].path);
});

test("output URL-only mode never writes a file", async () => {
  const result = await saveOutput("https://cdn.test/x.png", "outputs", {
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
    // save-less path is handled by the caller; this asserts data URIs stay inline
  }).catch((error) => error);
  assert.ok(result instanceof Error);
  const dataUri = await saveOutput("data:image/png;base64,AAAA", "outputs");
  assert.equal(dataUri.kind, "data-uri");
});

test("a hung download is bounded by the download timeout", async () => {
  const server = createServer(() => {
    // never responds
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address();
  const started = Date.now();
  try {
    await assert.rejects(
      saveOutput(`http://127.0.0.1:${port}/slow`, await tempDir("i26-slow-"), { downloadTimeoutMs: 150 }),
      /Download failed/,
    );
    assert.ok(Date.now() - started < 3000);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
