import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ProxyApprovalStore, mountDefinitionHash, type ProxyApprovalInput } from "./approvals";

const SCHEMA = `
CREATE TABLE proxy_approvals (
  plugin_slug                  TEXT    NOT NULL,
  plugin_version               TEXT    NOT NULL,
  mount_name                   TEXT    NOT NULL,
  mount_definition_hash        TEXT    NOT NULL,
  upstream_setting_key         TEXT    NOT NULL,
  normalized_upstream_origin   TEXT    NOT NULL,
  normalized_upstream_base_path TEXT   NOT NULL,
  approved_by_user_id          TEXT    NOT NULL,
  approved_at                  INTEGER NOT NULL,
  approval_version             INTEGER NOT NULL,
  approved_address_class       TEXT,
  PRIMARY KEY (plugin_slug, mount_name)
);
`;

function seedInput(overrides: Partial<ProxyApprovalInput> = {}): ProxyApprovalInput {
  return {
    plugin_slug: "foundry",
    plugin_version: "1.0.0",
    mount_name: "app",
    mount_definition_hash: "hash-1",
    upstream_setting_key: "upstream_url",
    normalized_upstream_origin: "http://host:30000",
    normalized_upstream_base_path: "/",
    approved_by_user_id: "owner-1",
    approved_at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("ProxyApprovalStore", () => {
  let db: Database;
  let store: ProxyApprovalStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(SCHEMA);
    store = new ProxyApprovalStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("get returns null when no approval exists (fail closed)", () => {
    expect(store.get("foundry", "app")).toBeNull();
  });

  test("upsert creates an approval at version 1 and is readable", () => {
    const row = store.upsert(seedInput());
    expect(row.approval_version).toBe(1);
    const fetched = store.get("foundry", "app");
    expect(fetched).not.toBeNull();
    expect(fetched?.normalized_upstream_origin).toBe("http://host:30000");
    expect(fetched?.approval_version).toBe(1);
  });

  test("re-approving the same mount bumps approval_version", () => {
    store.upsert(seedInput());
    const second = store.upsert(seedInput({ normalized_upstream_origin: "http://host:40000" }));
    expect(second.approval_version).toBe(2);
    expect(store.get("foundry", "app")?.normalized_upstream_origin).toBe("http://host:40000");
  });

  test("invalidateBySettingKey deletes matching mounts only", () => {
    store.upsert(seedInput({ mount_name: "app", upstream_setting_key: "upstream_url" }));
    store.upsert(seedInput({ mount_name: "admin", upstream_setting_key: "admin_url" }));
    const removed = store.invalidateBySettingKey("foundry", "upstream_url");
    expect(removed).toBe(1);
    expect(store.get("foundry", "app")).toBeNull();
    expect(store.get("foundry", "admin")).not.toBeNull();
  });

  test("deletePlugin removes every mount for the plugin", () => {
    store.upsert(seedInput({ mount_name: "app" }));
    store.upsert(seedInput({ mount_name: "admin" }));
    expect(store.deletePlugin("foundry")).toBe(2);
    expect(store.get("foundry", "app")).toBeNull();
  });

  test("approved_address_class defaults to null and round-trips when set", () => {
    store.upsert(seedInput({ mount_name: "app" }));
    expect(store.get("foundry", "app")?.approved_address_class).toBeNull();

    const classified = store.upsert(seedInput({ mount_name: "admin", approved_address_class: "loopback" }));
    expect(classified.approved_address_class).toBe("loopback");
    expect(store.get("foundry", "admin")?.approved_address_class).toBe("loopback");
  });

  test("mountDefinitionHash is stable and access-sensitive", () => {
    const base = mountDefinitionHash({ name: "app", upstream_setting: "u" });
    const sameDefault = mountDefinitionHash({ name: "app", upstream_setting: "u", access: "members" });
    const owner = mountDefinitionHash({ name: "app", upstream_setting: "u", access: "owner" });
    expect(base).toBe(sameDefault); // members is the implicit default
    expect(base).not.toBe(owner);
  });
});
