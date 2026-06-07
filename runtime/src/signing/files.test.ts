import { describe, expect, test } from "bun:test";
import { signFilePath, verifyFileSig, formatSignedFileUrl } from "./files";

describe("file URL signing", () => {
  test("round-trip: sign then verify succeeds", () => {
    const path = "/files/text-channels/abc.png";
    const userId = "user-123";
    const sig = signFilePath(path, userId);

    const q = new URLSearchParams({ t: sig.t, exp: String(sig.exp), u: sig.u });
    const result = verifyFileSig(path, q);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe(userId);
    }
  });

  test("verify rejects missing params", () => {
    const result = verifyFileSig("/files/x/y.png", new URLSearchParams());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  test("verify rejects tampered signature", () => {
    const path = "/files/x/y.png";
    const sig = signFilePath(path, "u1");
    // Tamper the FIRST char with a guaranteed-different value. Replacing the
    // last char with a fixed "A" is flaky: a 32-byte HMAC's final base64url
    // symbol only encodes 4 aligned bits (~1/16 of values is "A"), so when the
    // signature already ends in "A" the "tampered" token is byte-identical to
    // the original and verify wrongly succeeds. exp is time-based, so sig.t
    // varies per run — that intermittently reddened this test. The first char is
    // a full 6-bit symbol; swapping A↔B always yields a different, same-length
    // token that still decodes cleanly → bad-signature.
    const tamperedT = (sig.t[0] === "A" ? "B" : "A") + sig.t.slice(1);
    const q = new URLSearchParams({ t: tamperedT, exp: String(sig.exp), u: sig.u });
    const result = verifyFileSig(path, q);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad-signature");
  });

  test("verify rejects path mismatch (same sig, different path)", () => {
    const sig = signFilePath("/files/a/b.png", "u1");
    const q = new URLSearchParams({ t: sig.t, exp: String(sig.exp), u: sig.u });
    const result = verifyFileSig("/files/a/different.png", q);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad-signature");
  });

  test("verify rejects user_id binding mismatch", () => {
    const sig = signFilePath("/files/a/b.png", "u1");
    // attacker swaps in a different user id
    const q = new URLSearchParams({ t: sig.t, exp: String(sig.exp), u: "u2" });
    const result = verifyFileSig("/files/a/b.png", q);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad-signature");
  });

  test("verify rejects expired signature", () => {
    const path = "/files/x/y.png";
    // Sign with negative TTL → expired immediately.
    const sig = signFilePath(path, "u1", -10);
    const q = new URLSearchParams({ t: sig.t, exp: String(sig.exp), u: sig.u });
    const result = verifyFileSig(path, q);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  test("verify rejects malformed exp", () => {
    const sig = signFilePath("/files/x/y.png", "u1");
    const q = new URLSearchParams({ t: sig.t, exp: "not-a-number", u: sig.u });
    const result = verifyFileSig("/files/x/y.png", q);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  test("verify rejects malformed signature (bad base64)", () => {
    const sig = signFilePath("/files/x/y.png", "u1");
    // "@" is not in the base64url alphabet — decoding succeeds but length
    // differs from expected, surfacing as bad-signature.
    const q = new URLSearchParams({ t: "@@@", exp: String(sig.exp), u: sig.u });
    const result = verifyFileSig("/files/x/y.png", q);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["bad-signature", "malformed"]).toContain(result.reason);
  });

  test("formatSignedFileUrl shape", () => {
    const path = "/files/text-channels/abc.png";
    const sig = signFilePath(path, "user-123");
    const url = formatSignedFileUrl(path, sig);
    expect(url.startsWith(path + "?")).toBe(true);
    expect(url).toContain("t=");
    expect(url).toContain("exp=");
    expect(url).toContain("u=user-123");
  });
});
