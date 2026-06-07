import { describe, expect, test } from "bun:test";
import { sniffMime, extensionForMime, INLINE_SAFE_MIMES } from "./mime-sniff";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF87 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00]);
const GIF89 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00]);
const WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45,
]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
]);
const MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x20,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
]);
const QT = new Uint8Array([
  0x00, 0x00, 0x00, 0x14,
  0x66, 0x74, 0x79, 0x70,
  0x71, 0x74, 0x20, 0x20,
]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
const TXT = new Uint8Array(new TextEncoder().encode("Hello, world!\nThis is plain text."));
const RANDOM_BIN = new Uint8Array([0xfa, 0xce, 0xb0, 0x0c, 0x12, 0x34, 0x56, 0x78]);

describe("mime sniff", () => {
  test("identifies PNG", () => expect(sniffMime(PNG)).toBe("image/png"));
  test("identifies JPEG", () => expect(sniffMime(JPG)).toBe("image/jpeg"));
  test("identifies GIF87a", () => expect(sniffMime(GIF87)).toBe("image/gif"));
  test("identifies GIF89a", () => expect(sniffMime(GIF89)).toBe("image/gif"));
  test("identifies PDF", () => expect(sniffMime(PDF)).toBe("application/pdf"));
  test("identifies ZIP", () => expect(sniffMime(ZIP)).toBe("application/zip"));
  test("identifies MP3 with ID3", () => expect(sniffMime(MP3)).toBe("audio/mpeg"));
  test("identifies WAV", () => expect(sniffMime(WAV)).toBe("audio/wav"));
  test("identifies WEBP", () => expect(sniffMime(WEBP)).toBe("image/webp"));
  test("identifies MP4", () => expect(sniffMime(MP4)).toBe("video/mp4"));
  test("identifies QuickTime", () => expect(sniffMime(QT)).toBe("video/quicktime"));
  test("identifies WebM", () => expect(sniffMime(WEBM)).toBe("video/webm"));
  test("identifies plain text", () => expect(sniffMime(TXT)).toBe("text/plain; charset=utf-8"));
  test("falls back to octet-stream for unknown bytes", () =>
    expect(sniffMime(RANDOM_BIN)).toBe("application/octet-stream"));
  test("empty buffer returns octet-stream", () =>
    expect(sniffMime(new Uint8Array(0))).toBe("application/octet-stream"));
});

describe("extensionForMime", () => {
  test("png → png", () => expect(extensionForMime("image/png")).toBe("png"));
  test("jpeg → jpg", () => expect(extensionForMime("image/jpeg")).toBe("jpg"));
  test("zip → zip", () => expect(extensionForMime("application/zip")).toBe("zip"));
  test("pdf → pdf", () => expect(extensionForMime("application/pdf")).toBe("pdf"));
  test("octet-stream → empty", () =>
    expect(extensionForMime("application/octet-stream")).toBe(""));
  test("unknown → empty", () => expect(extensionForMime("nonsense/foo")).toBe(""));
});

describe("INLINE_SAFE_MIMES", () => {
  test("includes common images and PDF", () => {
    expect(INLINE_SAFE_MIMES.has("image/png")).toBe(true);
    expect(INLINE_SAFE_MIMES.has("image/jpeg")).toBe(true);
    expect(INLINE_SAFE_MIMES.has("application/pdf")).toBe(true);
    expect(INLINE_SAFE_MIMES.has("video/mp4")).toBe(true);
  });
  test("excludes svg, html, zip, octet-stream", () => {
    expect(INLINE_SAFE_MIMES.has("image/svg+xml")).toBe(false);
    expect(INLINE_SAFE_MIMES.has("text/html")).toBe(false);
    expect(INLINE_SAFE_MIMES.has("application/zip")).toBe(false);
    expect(INLINE_SAFE_MIMES.has("application/octet-stream")).toBe(false);
  });
});
