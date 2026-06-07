import { describe, test, expect } from "bun:test";
import { isAllowedPostLoginRedirect } from "./post-login";

describe("isAllowedPostLoginRedirect", () => {
  test("accepts uncorded.app apex over https", () => {
    expect(isAllowedPostLoginRedirect("https://uncorded.app")).toBe(true);
    expect(isAllowedPostLoginRedirect("https://uncorded.app/")).toBe(true);
    expect(isAllowedPostLoginRedirect("https://uncorded.app/auth")).toBe(true);
  });

  test("accepts *.uncorded.app subdomains over https", () => {
    expect(isAllowedPostLoginRedirect("https://app.uncorded.app")).toBe(true);
    expect(isAllowedPostLoginRedirect("https://central.uncorded.app/")).toBe(true);
  });

  test("accepts localhost (any port) and 127.0.0.1 over http for dev", () => {
    expect(isAllowedPostLoginRedirect("http://localhost:5174")).toBe(true);
    expect(isAllowedPostLoginRedirect("http://localhost:3000/")).toBe(true);
    expect(isAllowedPostLoginRedirect("http://127.0.0.1:5174")).toBe(true);
  });

  test("rejects http on uncorded.app — production must be https", () => {
    expect(isAllowedPostLoginRedirect("http://uncorded.app")).toBe(false);
    expect(isAllowedPostLoginRedirect("http://app.uncorded.app")).toBe(false);
  });

  test("rejects https on localhost — dev runs over http", () => {
    expect(isAllowedPostLoginRedirect("https://localhost:5174")).toBe(false);
  });

  test("rejects arbitrary hosts", () => {
    expect(isAllowedPostLoginRedirect("https://attacker.com")).toBe(false);
    expect(isAllowedPostLoginRedirect("https://evil.example/")).toBe(false);
  });

  test("rejects look-alike hosts that merely contain the allowed suffix", () => {
    // The allowlist must be host-suffix anchored, not substring — `uncorded.app.attacker.com`
    // ends with `.attacker.com`, but a naive `.includes("uncorded.app")` would let it
    // through. `endsWith(".uncorded.app")` does not.
    expect(isAllowedPostLoginRedirect("https://uncorded.app.attacker.com")).toBe(false);
    expect(isAllowedPostLoginRedirect("https://evil-uncorded.app")).toBe(false);
    expect(isAllowedPostLoginRedirect("https://notuncorded.app")).toBe(false);
  });

  test("rejects javascript: and other dangerous schemes", () => {
    expect(isAllowedPostLoginRedirect("javascript:alert(1)")).toBe(false);
    expect(isAllowedPostLoginRedirect("file:///etc/passwd")).toBe(false);
    expect(isAllowedPostLoginRedirect("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  test("rejects values with userinfo, query, or fragment — handlers append their own ?error/?verified", () => {
    expect(isAllowedPostLoginRedirect("https://user:pass@uncorded.app")).toBe(false);
    expect(isAllowedPostLoginRedirect("https://uncorded.app/?next=evil")).toBe(false);
    expect(isAllowedPostLoginRedirect("https://uncorded.app/#frag")).toBe(false);
  });

  test("rejects malformed URLs", () => {
    expect(isAllowedPostLoginRedirect("")).toBe(false);
    expect(isAllowedPostLoginRedirect("not a url")).toBe(false);
    expect(isAllowedPostLoginRedirect("/relative")).toBe(false);
  });
});
