/**
 * Looking at an uploaded image without decoding it: what it really is (by its first bytes,
 * never by the name or declared type), how big it is, and a copy with every piece of
 * metadata removed (EXIF with GPS and camera details, XMP, text chunks, comments).
 *
 * Nothing is re-encoded, so the pixels stay exactly as uploaded and the work is a few byte
 * copies. Anything that does not parse cleanly is rejected rather than passed on.
 */

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** Claude reads images up to 8000 px on a side. */
export const MAX_IMAGE_EDGE = 8000;
const MIN_IMAGE_EDGE = 16;

export type ImageFailure = "unsupported_type" | "corrupt" | "too_large_dimensions" | "too_small";

export type InspectedImage =
  | {
      readonly ok: true;
      readonly type: ImageType;
      readonly width: number;
      readonly height: number;
      /** The same image without metadata. */
      readonly clean: Uint8Array;
    }
  | { readonly ok: false; readonly reason: ImageFailure };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** PNG chunks that are needed to draw the picture (or describe its colours). Everything else goes. */
const PNG_KEEP = new Set([
  "IHDR",
  "PLTE",
  "tRNS",
  "IDAT",
  "IEND",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "sBIT",
]);

class Corrupt extends Error {}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let text = "";
  for (let i = start; i < start + length; i += 1) text += String.fromCharCode(bytes[i] ?? 0);
  return text;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The type the first bytes announce, or null. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  return null;
}

interface Parsed {
  readonly width: number;
  readonly height: number;
  readonly clean: Uint8Array;
}

function parsePng(bytes: Uint8Array): Parsed {
  const data = view(bytes);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = data.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Corrupt("chunk past the end");
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw new Corrupt("IHDR must come first");
      width = data.getUint32(offset + 8);
      height = data.getUint32(offset + 12);
      sawHeader = true;
    }
    if (PNG_KEEP.has(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawHeader || !sawEnd) throw new Corrupt("PNG is incomplete");
  return { width, height, clean: concat(parts) };
}

/** JPEG segments that carry the picture or its colour handling. The rest (EXIF, XMP, comments) is dropped. */
function keepJpegSegment(marker: number, bytes: Uint8Array, start: number): boolean {
  if (marker === 0xe0) return true; // JFIF
  if (marker === 0xee) return true; // Adobe colour transform (needed to draw CMYK/YCCK)
  if (marker === 0xe2) return ascii(bytes, start + 4, 11) === "ICC_PROFILE"; // colour profile, not MPF
  if (marker >= 0xe1 && marker <= 0xef) return false; // APP1 EXIF/XMP and the other APPn
  return marker !== 0xfe; // COM
}

function parseJpeg(bytes: Uint8Array): Parsed {
  const data = view(bytes);
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawEnd = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Corrupt("expected a marker");
    let marker = bytes[offset + 1] ?? 0;
    // Fill bytes: any number of 0xFF may precede a marker.
    while (marker === 0xff) {
      offset += 1;
      marker = bytes[offset + 1] ?? 0;
    }
    if (marker === 0xd9) {
      parts.push(bytes.subarray(offset, offset + 2));
      sawEnd = true;
      offset += 2;
      break;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      // Standalone markers (RSTn, TEM, SOI) carry no length.
      parts.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) throw new Corrupt("truncated segment");
    const length = data.getUint16(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) throw new Corrupt("segment past the end");

    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (length < 8) throw new Corrupt("short frame header");
      height = data.getUint16(offset + 5);
      width = data.getUint16(offset + 7);
      sawFrame = true;
    }
    if (keepJpegSegment(marker, bytes, offset)) parts.push(bytes.subarray(offset, end));
    offset = end;

    if (marker === 0xda) {
      // Start of scan: entropy coded data runs until the next real marker.
      const scanStart = offset;
      while (offset < bytes.length) {
        if (bytes[offset] === 0xff) {
          const next = bytes[offset + 1] ?? 0;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
        }
        offset += 1;
      }
      parts.push(bytes.subarray(scanStart, offset));
    }
  }
  if (!sawFrame || !sawEnd) throw new Corrupt("JPEG is incomplete");
  return { width, height, clean: concat(parts) };
}

function uint24(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
}

function webpSize(
  type: string,
  bytes: Uint8Array,
  start: number,
  length: number,
): { width: number; height: number } | undefined {
  if (type === "VP8X" && length >= 10) {
    return { width: uint24(bytes, start + 4) + 1, height: uint24(bytes, start + 7) + 1 };
  }
  if (type === "VP8L" && length >= 5 && bytes[start] === 0x2f) {
    const b1 = bytes[start + 1] ?? 0;
    const b2 = bytes[start + 2] ?? 0;
    const b3 = bytes[start + 3] ?? 0;
    const b4 = bytes[start + 4] ?? 0;
    return {
      width: (b1 | ((b2 & 0x3f) << 8)) + 1,
      height: ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) + 1,
    };
  }
  if (type === "VP8 " && length >= 10 && startsWith(bytes, [0x9d, 0x01, 0x2a], start + 3)) {
    return {
      width: ((bytes[start + 6] ?? 0) | ((bytes[start + 7] ?? 0) << 8)) & 0x3fff,
      height: ((bytes[start + 8] ?? 0) | ((bytes[start + 9] ?? 0) << 8)) & 0x3fff,
    };
  }
  return undefined;
}

function parseWebp(bytes: Uint8Array): Parsed {
  const data = view(bytes);
  const declared = data.getUint32(4, true) + 8;
  if (declared > bytes.length || declared < 20) throw new Corrupt("RIFF size is wrong");
  const chunks: Uint8Array[] = [];
  let offset = 12;
  let size: { width: number; height: number } | undefined;
  while (offset + 8 <= declared) {
    const type = ascii(bytes, offset, 4);
    const length = data.getUint32(offset + 4, true);
    const padded = length + (length % 2);
    const end = offset + 8 + padded;
    if (end > declared) throw new Corrupt("chunk past the end");
    size ??= webpSize(type, bytes, offset + 8, length);
    if (type !== "EXIF" && type !== "XMP ") {
      let chunk = bytes.subarray(offset, end);
      if (type === "VP8X" && length >= 1) {
        chunk = Uint8Array.from(chunk);
        // Clear the "has EXIF" (bit 3) and "has XMP" (bit 2) flags to match the removed chunks.
        chunk[8] = (chunk[8] ?? 0) & ~0b0000_1100;
      }
      chunks.push(chunk);
    }
    offset = end;
  }
  if (!size) throw new Corrupt("no image data");
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(bytes.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return { ...size, clean: concat([header, body]) };
}

/**
 * Checks that `bytes` is a PNG, JPEG or WebP of a sensible size and returns a metadata-free copy.
 * It never throws for bad input.
 */
export function inspectImage(bytes: Uint8Array): InspectedImage {
  const type = sniffImageType(bytes);
  if (!type) return { ok: false, reason: "unsupported_type" };
  let parsed: Parsed;
  try {
    parsed =
      type === "image/png"
        ? parsePng(bytes)
        : type === "image/jpeg"
          ? parseJpeg(bytes)
          : parseWebp(bytes);
  } catch (error) {
    if (error instanceof Corrupt || error instanceof RangeError)
      return { ok: false, reason: "corrupt" };
    throw error;
  }
  const { width, height, clean } = parsed;
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    return { ok: false, reason: "too_large_dimensions" };
  }
  if (width < MIN_IMAGE_EDGE || height < MIN_IMAGE_EDGE) return { ok: false, reason: "too_small" };
  return { ok: true, type, width, height, clean };
}

export function imageExtension(type: ImageType): string {
  return type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : "webp";
}

/** Lowercase hex SHA-256 of the bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
