import { describe, expect, test } from "bun:test";
import { createTokenValidator } from "./token-validator";
import type { PublicKeyEntry } from "../heartbeat/types";

// Real Ed25519 keys are needed because the validator goes all the way through
// crypto.subtle.verify. Generated once per test that needs them.

interface KeyMaterial {
  kid: string;
  publicEntry: PublicKeyEntry;
  privateKey: CryptoKey;
}

async function generateKey(kid: string): Promise<KeyMaterial> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    publicEntry: { id: kid, public_key: jwk as JsonWebKey },
    privateKey: pair.privateKey,
  };
}

function base64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i] as number);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlJson(obj: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(obj)));
}

interface SignOptions {
  serverId?: string;
  exp?: number;
  iat?: number;
  jti?: string;
  alg?: string;
}

async function signToken(
  km: KeyMaterial,
  opts: SignOptions = {},
): Promise<string> {
  const nowSecs = Math.floor(Date.now() / 1000);
  const header = { alg: opts.alg ?? "EdDSA", kid: km.kid, typ: "JWT" };
  const payload = {
    sub: "user-1",
    server_id: opts.serverId ?? "server-test",
    display_name: "Test User",
    avatar_url: "",
    is_owner: false,
    iat: opts.iat ?? nowSecs,
    exp: opts.exp ?? nowSecs + 60,
    jti: opts.jti ?? "jti-1",
  };
  const headerB64 = base64urlJson(header);
  const payloadB64 = base64urlJson(payload);
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await crypto.subtle.sign("Ed25519", km.privateKey, signingInput);
  return `${headerB64}.${payloadB64}.${base64url(sig)}`;
}

describe("createTokenValidator — lazy refresh on UNKNOWN_KEY", () => {
  test("miss → triggers refresh → finds key on retry → ok", async () => {
    const km = await generateKey("kid-rotated");
    let keys: readonly PublicKeyEntry[] = []; // initially empty (cache stale)
    let refreshCalls = 0;

    const validator = createTokenValidator({
      getKeys: () => keys,
      getServerId: () => "server-test",
      refreshKeys: async () => {
        refreshCalls++;
        keys = [km.publicEntry]; // simulate Central returning the new key
      },
    });

    const token = await signToken(km);
    const result = await validator.validate(token);
    expect(refreshCalls).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.id).toBe("user-1");
      expect(result.jti).toBe("jti-1");
    }
  });

  test("miss → refresh runs → still missing → returns UNKNOWN_KEY", async () => {
    const km = await generateKey("kid-still-missing");
    let refreshCalls = 0;
    const validator = createTokenValidator({
      getKeys: () => [], // never populated
      getServerId: () => "server-test",
      refreshKeys: async () => {
        refreshCalls++;
      },
    });

    const token = await signToken(km);
    const result = await validator.validate(token);
    expect(refreshCalls).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_KEY");
    }
  });

  test("hit on first lookup → does NOT call refresh", async () => {
    const km = await generateKey("kid-cached");
    let refreshCalls = 0;
    const validator = createTokenValidator({
      getKeys: () => [km.publicEntry],
      getServerId: () => "server-test",
      refreshKeys: async () => {
        refreshCalls++;
      },
    });
    const token = await signToken(km);
    const result = await validator.validate(token);
    expect(refreshCalls).toBe(0);
    expect(result.ok).toBe(true);
  });

  test("INVALID_TOKEN (malformed) does NOT call refresh", async () => {
    let refreshCalls = 0;
    const validator = createTokenValidator({
      getKeys: () => [],
      getServerId: () => "server-test",
      refreshKeys: async () => {
        refreshCalls++;
      },
    });
    const result = await validator.validate("not-a-jwt");
    expect(refreshCalls).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_TOKEN");
  });

  test("INVALID_ALG does NOT call refresh", async () => {
    const km = await generateKey("kid-alg-test");
    let refreshCalls = 0;
    const validator = createTokenValidator({
      getKeys: () => [km.publicEntry],
      getServerId: () => "server-test",
      refreshKeys: async () => {
        refreshCalls++;
      },
    });
    // alg=HS256 must be rejected before key lookup.
    const token = await signToken(km, { alg: "HS256" });
    const result = await validator.validate(token);
    expect(refreshCalls).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_ALG");
  });

  test("WRONG_SERVER returns wrong-server even with valid signature", async () => {
    const km = await generateKey("kid-wrong-server");
    const validator = createTokenValidator({
      getKeys: () => [km.publicEntry],
      getServerId: () => "server-test",
      refreshKeys: async () => {},
    });
    const token = await signToken(km, { serverId: "server-other" });
    const result = await validator.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRONG_SERVER");
  });

  test("SERVER_NOT_READY when server-id getter returns null", async () => {
    const km = await generateKey("kid-not-ready");
    const validator = createTokenValidator({
      getKeys: () => [km.publicEntry],
      getServerId: () => null,
      refreshKeys: async () => {},
    });
    const token = await signToken(km);
    const result = await validator.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SERVER_NOT_READY");
  });

  test("expired token returns TOKEN_EXPIRED", async () => {
    const km = await generateKey("kid-expired");
    const validator = createTokenValidator({
      getKeys: () => [km.publicEntry],
      getServerId: () => "server-test",
      refreshKeys: async () => {},
    });
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await signToken(km, { iat: past - 60, exp: past });
    const result = await validator.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TOKEN_EXPIRED");
  });
});
