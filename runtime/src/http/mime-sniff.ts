// MIME magic-byte sniffer (spec-26 §6).
//
// Clients can lie about Content-Type on upload — a malicious uploader could
// claim image/png while uploading a tiny .html file with embedded JS, hoping
// the runtime serves it inline. We never trust client-supplied Content-Type
// for stored files: this module inspects the first ~64 bytes and returns a
// confidence-checked MIME string. Unknown content falls through to a fully
// generic "application/octet-stream" which forces a download.
//
// We deliberately keep this small. Full content-type inference is a rabbit
// hole; for our use case we only need:
//   - Common image formats (preview inline)
//   - Common video/audio (preview inline)
//   - PDF (preview inline)
//   - ZIP family (explore inline)
//   - Everything else -> octet-stream (force download)

function startsWith(buf: Uint8Array, sig: number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false;
  }
  return true;
}

function startsWithAt(buf: Uint8Array, offset: number, sig: number[]): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

const FALLBACK = "application/octet-stream" as const;

/**
 * Inspect leading bytes and return the most specific MIME we can identify.
 * If nothing matches, returns "application/octet-stream" — caller MUST send
 * Content-Disposition: attachment for that mime to prevent rendering.
 */
export function sniffMime(buf: Uint8Array): string {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  // GIF87a / GIF89a
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return "image/gif";
  }
  // WEBP: RIFF....WEBP
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWithAt(buf, 8, [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp";
  }
  // BMP
  if (startsWith(buf, [0x42, 0x4d])) {
    return "image/bmp";
  }
  // ICO: 00 00 01 00
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00])) {
    return "image/x-icon";
  }
  // AVIF / HEIC / HEIF / MP4 / MOV — all ISO Base Media: bytes 4-7 are "ftyp"
  if (startsWithAt(buf, 4, [0x66, 0x74, 0x79, 0x70])) {
    // brand at bytes 8-11
    const brand = String.fromCharCode(
      buf[8] ?? 0,
      buf[9] ?? 0,
      buf[10] ?? 0,
      buf[11] ?? 0,
    );
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "hevx") return "image/heic";
    if (brand === "mif1" || brand === "heif") return "image/heif";
    if (brand === "qt  ") return "video/quicktime";
    // mp4 brands: isom, iso2, mp41, mp42, dash, avc1, MSNV
    return "video/mp4";
  }
  // WebM / Matroska: 1A 45 DF A3
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) {
    return "video/webm";
  }
  // OGG: OggS
  if (startsWith(buf, [0x4f, 0x67, 0x67, 0x53])) {
    // Could be audio/ogg or video/ogg — default to audio (more common for chat).
    return "audio/ogg";
  }
  // MP3: ID3 tag
  if (startsWith(buf, [0x49, 0x44, 0x33])) {
    return "audio/mpeg";
  }
  // MP3 frame sync: FF FB or FF F3 or FF F2
  if (buf[0] === 0xff && buf[1] !== undefined && (buf[1] & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  // FLAC: fLaC
  if (startsWith(buf, [0x66, 0x4c, 0x61, 0x43])) {
    return "audio/flac";
  }
  // WAV: RIFF....WAVE
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWithAt(buf, 8, [0x57, 0x41, 0x56, 0x45])) {
    return "audio/wav";
  }
  // PDF: %PDF-
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }
  // ZIP (and ZIP-based: docx, xlsx, jar, apk, epub, etc.)
  // PK\x03\x04 (normal), PK\x05\x06 (empty), PK\x07\x08 (spanned)
  if (
    startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buf, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(buf, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "application/zip";
  }
  // RAR
  if (startsWith(buf, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) {
    return "application/x-rar-compressed";
  }
  // 7z
  if (startsWith(buf, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    return "application/x-7z-compressed";
  }
  // GZIP
  if (startsWith(buf, [0x1f, 0x8b, 0x08])) {
    return "application/gzip";
  }
  // SVG starts with "<?xml" or "<svg" — sniffed conservatively as text/plain
  // (caller serves SVG with attachment disposition unless explicitly trusted).
  // We do NOT return "image/svg+xml" from sniff to avoid encouraging inline render.
  // Plain text (printable ASCII for first chunk)
  if (looksLikeText(buf)) {
    return "text/plain; charset=utf-8";
  }
  return FALLBACK;
}

function looksLikeText(buf: Uint8Array): boolean {
  // Conservative: require all bytes in first slice to be either common
  // whitespace (\t \n \r) or printable ASCII (0x20-0x7e). Reject any bytes
  // outside that range. This intentionally rejects UTF-8 with non-ASCII
  // bytes — we'd rather call those octet-stream than guess wrong.
  if (buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 512));
  for (const b of sample) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b >= 0x20 && b <= 0x7e) continue;
    return false;
  }
  return true;
}

/**
 * Pick a safe extension hint for a sniffed MIME, used when generating
 * server-side filenames. Returns empty string for unknown — caller falls
 * back to the client-provided extension AFTER sanitization.
 */
export function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/bmp": return "bmp";
    case "image/x-icon": return "ico";
    case "image/avif": return "avif";
    case "image/heic": return "heic";
    case "image/heif": return "heif";
    case "video/mp4": return "mp4";
    case "video/quicktime": return "mov";
    case "video/webm": return "webm";
    case "audio/mpeg": return "mp3";
    case "audio/ogg": return "ogg";
    case "audio/flac": return "flac";
    case "audio/wav": return "wav";
    case "application/pdf": return "pdf";
    case "application/zip": return "zip";
    case "application/x-rar-compressed": return "rar";
    case "application/x-7z-compressed": return "7z";
    case "application/gzip": return "gz";
    default: return "";
  }
}

/**
 * Set of MIMEs that are safe to send with `Content-Disposition: inline`.
 * Anything outside this set MUST be served as `attachment` to prevent
 * browsers from rendering arbitrary content in the runtime origin.
 */
export const INLINE_SAFE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/avif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/flac",
  "audio/wav",
  "application/pdf",
]);
