// PNG header helpers used by the local mask checks. No image decoding: only
// the IHDR chunk is read, so this stays dependency-free and fast.
import { openSync, readSync, closeSync } from "node:fs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const PNG_COLOR_TYPES = Object.freeze({
  0: "grayscale",
  2: "rgb",
  3: "palette",
  4: "grayscale+alpha",
  6: "rgba",
});

/**
 * Reads the PNG signature and IHDR of a file.
 * Returns `{ ok: false, reason }` for anything that is not a readable PNG.
 */
export function readPngHeader(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return { ok: false, reason: `cannot open file: ${error?.code || error?.message || error}` };
  }
  try {
    const header = Buffer.alloc(33);
    const read = readSync(fd, header, 0, header.length, 0);
    if (read < 33) return { ok: false, reason: "file is too short to be a PNG" };
    if (!header.subarray(0, 8).equals(PNG_SIGNATURE)) return { ok: false, reason: "not a PNG (missing PNG signature)" };
    const chunkLength = header.readUInt32BE(8);
    const chunkType = header.toString("latin1", 12, 16);
    if (chunkLength !== 13 || chunkType !== "IHDR") return { ok: false, reason: "PNG does not start with a valid IHDR chunk" };
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    const bitDepth = header[24];
    const colorType = header[25];
    const interlace = header[28];
    return {
      ok: true,
      width,
      height,
      bitDepth,
      colorType,
      colorTypeName: PNG_COLOR_TYPES[colorType] || `unknown(${colorType})`,
      interlace,
    };
  } catch (error) {
    return { ok: false, reason: `cannot read PNG header: ${error?.message || error}` };
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

/** Checks the mask rules the API states: RGBA PNG, same size as the first source image. */
export function checkMaskFile(maskPath, firstImage) {
  const header = readPngHeader(maskPath);
  if (!header.ok) {
    return {
      checked: "failed",
      reason: `mask must be a PNG: ${header.reason}`,
      next: "Export the mask as an RGBA PNG (transparent pixels mark the area to edit).",
    };
  }
  if (header.colorType !== 6) {
    return {
      checked: "failed",
      reason: `mask PNG has color type ${header.colorType} (${header.colorTypeName}); the API requires RGBA`,
      next: "Re-save the mask with an alpha channel (RGBA, 8-bit).",
    };
  }
  if (!firstImage || !firstImage.ok) {
    return {
      checked: "partial",
      width: header.width,
      height: header.height,
      reason: "mask is RGBA PNG; the first source image size could not be read, so the size match is unchecked",
    };
  }
  if (header.width !== firstImage.width || header.height !== firstImage.height) {
    return {
      checked: "failed",
      reason: `mask is ${header.width}x${header.height} but the first image is ${firstImage.width}x${firstImage.height}`,
      next: `Resize the mask to ${firstImage.width}x${firstImage.height} so it covers exactly the first source image.`,
    };
  }
  return { checked: "ok", width: header.width, height: header.height };
}

/** Sniffs the image type from magic bytes; returns a MIME type or null. */
export function sniffImageType(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" &&
    String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP"
  )
    return "image/webp";
  const head = Buffer.from(b.subarray(0, 6)).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  return null;
}
