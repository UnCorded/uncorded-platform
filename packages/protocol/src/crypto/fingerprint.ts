// Public-key fingerprint: 8-byte truncation of SHA-256(pubkey) rendered in
// base32, dash-grouped.
//
// NOTE: This helper was introduced for the Registered Terminals (Terminal
// Anywhere) feature, which was removed in commit 95dec38. Its former consumers
// (apps/cli and runtime/src/terminals) no longer exist. It is retained as a
// standalone protocol crypto primitive (still exported from @uncorded/protocol)
// and is not currently wired to any shipping feature. The empty-pubkey
// placeholder is kept for callers that pass an intentionally empty key.

const BASE32_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PLACEHOLDER = "0000-0000-0000";

function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_CHARSET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_CHARSET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

export async function derive(pubkey: Uint8Array): Promise<string> {
  if (pubkey.length === 0) return PLACEHOLDER;
  const buf = new ArrayBuffer(pubkey.byteLength);
  new Uint8Array(buf).set(pubkey);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  const truncated = new Uint8Array(hashBuf, 0, 8);
  const b32 = toBase32(truncated);
  const groups: string[] = [];
  for (let i = 0; i < b32.length; i += 4) groups.push(b32.slice(i, i + 4));
  return groups.join("-");
}

export const FINGERPRINT_PLACEHOLDER = PLACEHOLDER;
