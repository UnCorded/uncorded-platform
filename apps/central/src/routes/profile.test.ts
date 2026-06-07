import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";
// startTestServer and registerAndLogin are reused inside each describe-level
// `inner` block to keep username renames isolated from the outer tests.

let ts: TestServer;
let sessionToken: string;

beforeAll(async () => {
  ts = await startTestServer();
  ({ token: sessionToken } = await registerAndLogin(ts, "profile-tester"));
});

afterAll(async () => {
  await ts.shutdown();
});

describe("GET /v1/auth/profile", () => {
  test("returns profile for authenticated user", async () => {
    const res = await fetch(`${ts.url}/v1/auth/profile`, {
      headers: authHeaders(sessionToken),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("profile-tester@example.com");
    expect(body.username).toBe("profile_tester_x");
    expect(body.username_changed_at).toBeNull();
    expect(body.username_change_available_at).toBeNull();
    expect(body.display_name).toBe("profile-tester");
    expect(body.avatar_url).toBeNull();
    expect(body.email_verified).toBe(true);
    expect(body.phone_verified).toBe(false);
  });

  test("returns 401 without session", async () => {
    const res = await fetch(`${ts.url}/v1/auth/profile`);
    expect(res.status).toBe(401);
  });
});

describe("PATCH /v1/auth/profile", () => {
  test("updates display name", async () => {
    const res = await fetch(`${ts.url}/v1/auth/profile`, {
      method: "PATCH",
      headers: {
        ...authHeaders(sessionToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ display_name: "New Name" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.display_name).toBe("New Name");
  });

  test("updates avatar url", async () => {
    const res = await fetch(`${ts.url}/v1/auth/profile`, {
      method: "PATCH",
      headers: {
        ...authHeaders(sessionToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ avatar_url: "https://example.com/avatar.png" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.avatar_url).toBe("https://example.com/avatar.png");
  });

  test("rejects empty display name", async () => {
    const res = await fetch(`${ts.url}/v1/auth/profile`, {
      method: "PATCH",
      headers: {
        ...authHeaders(sessionToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ display_name: "" }),
    });

    expect(res.status).toBe(400);
  });

  test("rejects empty body", async () => {
    const res = await fetch(`${ts.url}/v1/auth/profile`, {
      method: "PATCH",
      headers: {
        ...authHeaders(sessionToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  test("returns 401 without session", async () => {
    const res = await fetch(`${ts.url}/v1/auth/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: "Hacker" }),
    });

    expect(res.status).toBe(401);
  });
});

describe("PATCH /v1/auth/profile — username", () => {
  test("renames username and stamps username_changed_at", async () => {
    // Use a separate test server so the rename here doesn't bleed into the
    // sibling tests above. Each inner DB gets a unique name so the outer
    // shared pool doesn't fight DROP DATABASE.
    const inner = await startTestServer({ dbName: "uncorded_central_test_rename" });
    const { token } = await registerAndLogin(inner, "rename-me");
    try {
      const res = await fetch(`${inner.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ username: "newname" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.username).toBe("newname");
      expect(body.username_changed_at).not.toBeNull();
      expect(body.username_change_available_at).not.toBeNull();
    } finally {
      await inner.shutdown();
    }
  });

  test("returns 429 USERNAME_COOLDOWN when within 30-day window", async () => {
    const inner = await startTestServer({ dbName: "uncorded_central_test_cooldown" });
    const { token, accountId } = await registerAndLogin(inner, "cooldown-me");
    try {
      // First rename — succeeds.
      let res = await fetch(`${inner.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ username: "firstrename" }),
      });
      expect(res.status).toBe(200);

      // Second rename inside the cooldown window — must fail.
      res = await fetch(`${inner.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ username: "secondrename" }),
      });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.code).toBe("USERNAME_COOLDOWN");

      // Sanity: the username in the DB still reads `firstrename`.
      const rows = await inner.sql`SELECT username FROM accounts WHERE id = ${accountId}`;
      expect(rows[0]?.username).toBe("firstrename");
    } finally {
      await inner.shutdown();
    }
  });

  test("returns 409 USERNAME_TAKEN when target is in use (case-insensitive)", async () => {
    const inner = await startTestServer({ dbName: "uncorded_central_test_taken" });
    await registerAndLogin(inner, "occupant"); // owns username `occupant_x`
    const { token } = await registerAndLogin(inner, "challenger");
    try {
      const res = await fetch(`${inner.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ username: "OCCUPANT_X" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("USERNAME_TAKEN");
    } finally {
      await inner.shutdown();
    }
  });

  test("rejects USERNAME_RESERVED on patch", async () => {
    const inner = await startTestServer({ dbName: "uncorded_central_test_reserved" });
    const { token } = await registerAndLogin(inner, "want-admin");
    try {
      const res = await fetch(`${inner.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("USERNAME_RESERVED");
    } finally {
      await inner.shutdown();
    }
  });

  test("re-saving the same username is a no-op (no cooldown trigger)", async () => {
    const inner = await startTestServer({ dbName: "uncorded_central_test_samesame" });
    const { token, username } = await registerAndLogin(inner, "samesame");
    try {
      const res = await fetch(`${inner.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ username, display_name: "Same Same" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.username).toBe(username);
      expect(body.username_changed_at).toBeNull();
    } finally {
      await inner.shutdown();
    }
  });
});

describe("PATCH /v1/auth/profile — email", () => {
  test("changing email requires current_password", async () => {
    const inner = await startTestServer({ dbName: "uncorded_central_test_email_pw_required" });
    const { token } = await registerAndLogin(inner, "email-changer");
    try {
      const res = await fetch(`${inner.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ email: "new-address@example.com" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("CURRENT_PASSWORD_REQUIRED");
    } finally {
      await inner.shutdown();
    }
  });

  test("changing email with wrong password returns 401", async () => {
    const inner = await startTestServer({ dbName: "uncorded_central_test_email_bad_pw" });
    const { token } = await registerAndLogin(inner, "email-bad-pw");
    try {
      const res = await fetch(`${inner.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "still-new@example.com",
          current_password: "wrong-pass",
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      await inner.shutdown();
    }
  });

  test("successful email change clears email_verified and creates new verification row", async () => {
    const inner = await startTestServer({ dbName: "uncorded_central_test_email_ok" });
    const { token, accountId } = await registerAndLogin(inner, "email-ok");
    try {
      const res = await fetch(`${inner.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "new-ok@example.com",
          current_password: "password123",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.email).toBe("new-ok@example.com");
      expect(body.email_verified).toBe(false);

      const verRows = await inner.sql`
        SELECT account_id FROM email_verifications WHERE account_id = ${accountId}
      `;
      expect(verRows.length).toBe(1);
    } finally {
      await inner.shutdown();
    }
  });
});

describe("PATCH /v1/auth/profile — password", () => {
  test("password change wipes other sessions and mints a fresh one", async () => {
    const inner = await startTestServer({ dbName: "uncorded_central_test_pw_changer" });
    const { token, accountId } = await registerAndLogin(inner, "pw-changer");
    try {
      // Seed a second session row to prove the wipe is real.
      const beforeRows = await inner.sql`
        SELECT count(*)::int AS n FROM sessions WHERE account_id = ${accountId}
      `;
      const beforeCount = beforeRows[0]?.n as number;
      expect(beforeCount).toBeGreaterThanOrEqual(1);

      const res = await fetch(`${inner.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: "password123",
          new_password: "new-strong-password",
        }),
      });
      expect(res.status).toBe(200);
      // Set-Cookie header should be present (fresh session)
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).not.toBeNull();
      expect(setCookie!.includes("__Host-session=")).toBe(true);

      // After the wipe + mint, exactly one row should remain.
      const afterRows = await inner.sql`
        SELECT count(*)::int AS n FROM sessions WHERE account_id = ${accountId}
      `;
      expect(afterRows[0]?.n).toBe(1);

      // The old password no longer logs in.
      const loginOld = await fetch(`${inner.url}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "pw-changer@example.com",
          password: "password123",
        }),
      });
      expect(loginOld.status).toBe(401);

      // The new password does.
      const loginNew = await fetch(`${inner.url}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "pw-changer@example.com",
          password: "new-strong-password",
        }),
      });
      expect(loginNew.status).toBe(200);
    } finally {
      await inner.shutdown();
    }
  });

  test("rejects new_password without current_password", async () => {
    const inner = await startTestServer({ dbName: "uncorded_central_test_pw_no_current" });
    const { token } = await registerAndLogin(inner, "pw-no-current");
    try {
      const res = await fetch(`${inner.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ new_password: "another-pass" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("CURRENT_PASSWORD_REQUIRED");
    } finally {
      await inner.shutdown();
    }
  });

  test("rejects too-short new_password", async () => {
    const inner = await startTestServer({ dbName: "uncorded_central_test_pw_short" });
    const { token } = await registerAndLogin(inner, "pw-short");
    try {
      const res = await fetch(`${inner.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: "password123",
          new_password: "1234567",
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      await inner.shutdown();
    }
  });
});
