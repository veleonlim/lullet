import { crc32, deflateSync } from "node:zlib";

/**
 * Tiny hand-built images for tests. PNGs are real (a browser can draw them); the JPEG and
 * WebP builders only produce the container structure the metadata stripper reads.
 */

function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function join(...parts: readonly (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
  const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of arrays) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = join(text(type), data);
  return join(u32be(data.length), body, u32be(crc32(body)));
}

export interface PngOptions {
  readonly width?: number;
  readonly height?: number;
  /** Changes the pixels, so two images with different seeds have different hashes. */
  readonly seed?: number;
  /** Extra chunks inserted before IDAT, e.g. a tEXt chunk carrying metadata. */
  readonly extraChunks?: readonly Uint8Array[];
}

/** A real, decodable RGB PNG. */
export function makePng(options: PngOptions = {}): Uint8Array {
  const width = options.width ?? 64;
  const height = options.height ?? 64;
  const seed = options.seed ?? 0;
  const row = width * 3 + 1;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * row + 1 + x * 3;
      raw[at] = (x * 4 + seed) & 0xff;
      raw[at + 1] = (y * 4 + seed * 7) & 0xff;
      raw[at + 2] = (seed * 31) & 0xff;
    }
  }
  const header = join(u32be(width), u32be(height), [8, 2, 0, 0, 0]);
  return join(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk("IHDR", header),
    ...(options.extraChunks ?? []),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  );
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return join([0xff, marker, length >> 8, length & 0xff], payload);
}

export interface JpegOptions {
  readonly width?: number;
  readonly height?: number;
  readonly seed?: number;
  /** Add EXIF (APP1), an ICC profile (APP2) and a comment: everything a camera or editor leaves behind. */
  readonly metadata?: boolean;
}

/** A JPEG with the right segment structure (not decodable). */
export function makeJpeg(options: JpegOptions = {}): Uint8Array {
  const width = options.width ?? 64;
  const height = options.height ?? 64;
  const metadata = options.metadata ?? false;
  return join(
    [0xff, 0xd8],
    jpegSegment(0xe0, text("JFIF\0\u0001\u0001\0\0\u0001\0\u0001\0\0")),
    metadata ? jpegSegment(0xe1, text("Exif\0\0GPS 1.3521 N 103.8198 E")) : new Uint8Array(0),
    metadata ? jpegSegment(0xe2, text("ICC_PROFILE\0\u0001\u0001profile")) : new Uint8Array(0),
    metadata ? jpegSegment(0xe2, text("MPF\0multi picture")) : new Uint8Array(0),
    metadata ? jpegSegment(0xfe, text("shot on a phone")) : new Uint8Array(0),
    jpegSegment(0xdb, new Uint8Array(65)),
    jpegSegment(
      0xc0,
      join([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]),
    ),
    jpegSegment(0xc4, new Uint8Array(17)),
    jpegSegment(0xda, join([1, 1, 0, 0, 63, 0])),
    // Entropy coded data with a stuffed 0xFF00, a restart marker and the seed as content.
    [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, (options.seed ?? 0) & 0x7f],
    [0xff, 0xd9],
  );
}

function riffChunk(type: string, data: Uint8Array): Uint8Array {
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, data.length, true);
  return join(text(type), size, data, data.length % 2 === 1 ? [0] : []);
}

export interface WebpOptions {
  readonly width?: number;
  readonly height?: number;
  readonly metadata?: boolean;
  /** "lossy" (VP8), "lossless" (VP8L) or "extended" (VP8X wrapping a lossless frame). */
  readonly kind?: "lossy" | "lossless" | "extended";
}

/** A WebP with the right chunk structure (not decodable). */
export function makeWebp(options: WebpOptions = {}): Uint8Array {
  const width = options.width ?? 64;
  const height = options.height ?? 64;
  const kind = options.kind ?? "extended";
  const metadata = options.metadata ?? false;

  const lossless = (): Uint8Array => {
    const w = width - 1;
    const h = height - 1;
    return riffChunk(
      "VP8L",
      Uint8Array.from([
        0x2f,
        w & 0xff,
        ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
        (h >> 2) & 0xff,
        (h >> 10) & 0x0f,
        0,
        0,
      ]),
    );
  };
  const lossy = (): Uint8Array =>
    riffChunk(
      "VP8 ",
      Uint8Array.from([
        0,
        0,
        0,
        0x9d,
        0x01,
        0x2a,
        width & 0xff,
        width >> 8,
        height & 0xff,
        height >> 8,
        0,
        0,
      ]),
    );

  let body: Uint8Array;
  if (kind === "lossy") body = lossy();
  else if (kind === "lossless") body = lossless();
  else {
    const flags = metadata ? 0b0000_1100 : 0;
    const w = width - 1;
    const h = height - 1;
    body = join(
      riffChunk(
        "VP8X",
        Uint8Array.from([
          flags,
          0,
          0,
          0,
          w & 0xff,
          (w >> 8) & 0xff,
          (w >> 16) & 0xff,
          h & 0xff,
          (h >> 8) & 0xff,
          (h >> 16) & 0xff,
        ]),
      ),
      lossless(),
    );
  }
  const extras =
    metadata && kind === "extended"
      ? join(riffChunk("EXIF", text("Exif GPS")), riffChunk("XMP ", text("<xmp/>")))
      : new Uint8Array(0);
  const payload = join(text("WEBP"), body, extras);
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, payload.length, true);
  return join(text("RIFF"), size, payload);
}
