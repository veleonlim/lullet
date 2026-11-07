import { describe, expect, it } from "vitest";
import { makeJpeg, makePng, makeWebp, pngChunk } from "@/test-support/images";
import { imageExtension, inspectImage, MAX_IMAGE_EDGE, sha256Hex, sniffImageType } from "./image";

const text = (value: string) => new TextEncoder().encode(value);
const contains = (haystack: Uint8Array, needle: string) =>
  new TextDecoder("latin1").decode(haystack).includes(needle);

describe("sniffImageType", () => {
  it("goes by the first bytes, not by any declared type", () => {
    expect(sniffImageType(makePng())).toBe("image/png");
    expect(sniffImageType(makeJpeg())).toBe("image/jpeg");
    expect(sniffImageType(makeWebp())).toBe("image/webp");
    expect(sniffImageType(text("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageType(text("GIF89a"))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});

describe("PNG", () => {
  it("reports the size and removes text, EXIF and time chunks", () => {
    const original = makePng({
      width: 120,
      height: 80,
      extraChunks: [
        pngChunk("tEXt", text("Author\0Mei")),
        pngChunk("eXIf", text("GPS 1.35 N")),
        pngChunk("tIME", new Uint8Array(7)),
        pngChunk("iTXt", text("XML:com.adobe.xmp\0<xmp/>")),
        pngChunk("sRGB", new Uint8Array(1)),
      ],
    });
    const result = inspectImage(original);
    if (!result.ok) throw new Error("expected ok");
    expect([result.type, result.width, result.height]).toEqual(["image/png", 120, 80]);
    expect(contains(result.clean, "tEXt")).toBe(false);
    expect(contains(result.clean, "eXIf")).toBe(false);
    expect(contains(result.clean, "tIME")).toBe(false);
    expect(contains(result.clean, "iTXt")).toBe(false);
    expect(contains(result.clean, "sRGB")).toBe(true);
    expect(contains(result.clean, "IDAT")).toBe(true);
    expect(result.clean.length).toBeLessThan(original.length);
  });

  it("keeps an already clean image byte for byte", () => {
    const original = makePng({ seed: 3 });
    const result = inspectImage(original);
    if (!result.ok) throw new Error("expected ok");
    expect(Array.from(result.clean)).toEqual(Array.from(original));
  });

  it("rejects a truncated PNG and one whose first chunk is not IHDR", () => {
    const original = makePng();
    expect(inspectImage(original.subarray(0, original.length - 20))).toEqual({
      ok: false,
      reason: "corrupt",
    });
    const wrongFirst = Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...pngChunk("IDAT", new Uint8Array(13)),
      ...pngChunk("IEND", new Uint8Array(0)),
    ]);
    expect(inspectImage(wrongFirst)).toEqual({ ok: false, reason: "corrupt" });
  });
});

describe("JPEG", () => {
  it("removes EXIF, comments and the multi picture block but keeps JFIF and the colour profile", () => {
    const original = makeJpeg({ width: 300, height: 200, metadata: true });
    expect(contains(original, "GPS")).toBe(true);
    const result = inspectImage(original);
    if (!result.ok) throw new Error("expected ok");
    expect([result.type, result.width, result.height]).toEqual(["image/jpeg", 300, 200]);
    expect(contains(result.clean, "GPS")).toBe(false);
    expect(contains(result.clean, "Exif")).toBe(false);
    expect(contains(result.clean, "shot on a phone")).toBe(false);
    expect(contains(result.clean, "MPF")).toBe(false);
    expect(contains(result.clean, "JFIF")).toBe(true);
    expect(contains(result.clean, "ICC_PROFILE")).toBe(true);
    // The scan data, including a stuffed 0xFF00 and a restart marker, is copied untouched.
    expect(Array.from(result.clean.subarray(result.clean.length - 11))).toEqual([
      0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x00, 0xff, 0xd9,
    ]);
  });

  it("rejects a JPEG that stops before its end marker or has a broken segment", () => {
    const original = makeJpeg();
    expect(inspectImage(original.subarray(0, original.length - 2))).toEqual({
      ok: false,
      reason: "corrupt",
    });
    const broken = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]);
    expect(inspectImage(broken)).toEqual({ ok: false, reason: "corrupt" });
    expect(inspectImage(Uint8Array.from([0xff, 0xd8, 0xff, 0x12, 0x00, 0x04, 0, 0, 0, 0]))).toEqual(
      {
        ok: false,
        reason: "corrupt",
      },
    );
  });
});

describe("WebP", () => {
  it("reads the size of every flavour", () => {
    for (const kind of ["lossy", "lossless", "extended"] as const) {
      const result = inspectImage(makeWebp({ kind, width: 300, height: 1500 }));
      if (!result.ok) throw new Error(`expected ok for ${kind}`);
      expect([result.type, result.width, result.height]).toEqual(["image/webp", 300, 1500]);
    }
  });

  it("removes the EXIF and XMP chunks and clears their flags", () => {
    const original = makeWebp({ metadata: true });
    expect(contains(original, "EXIF")).toBe(true);
    const result = inspectImage(original);
    if (!result.ok) throw new Error("expected ok");
    expect(contains(result.clean, "EXIF")).toBe(false);
    expect(contains(result.clean, "XMP ")).toBe(false);
    expect(result.clean[20]).toBe(0);
    // The RIFF size matches what is left, so the file still parses.
    const again = inspectImage(result.clean);
    expect(again.ok).toBe(true);
  });

  it("rejects a WebP whose chunks run past the declared size or that has no image data", () => {
    const original = makeWebp({ kind: "lossless" });
    expect(inspectImage(original.subarray(0, original.length - 4))).toEqual({
      ok: false,
      reason: "corrupt",
    });
    const empty = Uint8Array.from([
      ...text("RIFF"),
      12,
      0,
      0,
      0,
      ...text("WEBP"),
      ...text("JUNK"),
      4,
      0,
      0,
      0,
      1,
      2,
      3,
      4,
    ]);
    expect(inspectImage(empty)).toEqual({ ok: false, reason: "corrupt" });
  });
});

describe("size limits and other types", () => {
  it("refuses images that are too large or too small", () => {
    expect(inspectImage(makePng({ width: MAX_IMAGE_EDGE + 1, height: 20 }))).toEqual({
      ok: false,
      reason: "too_large_dimensions",
    });
    expect(inspectImage(makePng({ width: 4, height: 4 }))).toEqual({
      ok: false,
      reason: "too_small",
    });
  });

  it("refuses anything that is not PNG, JPEG or WebP", () => {
    expect(inspectImage(text("%PDF-1.7"))).toEqual({ ok: false, reason: "unsupported_type" });
    expect(inspectImage(new Uint8Array(0))).toEqual({ ok: false, reason: "unsupported_type" });
  });
});

describe("helpers", () => {
  it("hashes with SHA-256 in lowercase hex", async () => {
    expect(await sha256Hex(text("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("names the file extension from the type", () => {
    expect(imageExtension("image/png")).toBe("png");
    expect(imageExtension("image/jpeg")).toBe("jpg");
    expect(imageExtension("image/webp")).toBe("webp");
  });
});
