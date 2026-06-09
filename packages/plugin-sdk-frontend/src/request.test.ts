import { describe, expect, test } from "bun:test";

import { PluginError } from "./errors";
import { createRequestClient } from "./request";

describe("createRequestClient", () => {
  test("rejects runtime error responses with PluginError", async () => {
    const sent: unknown[] = [];
    const client = createRequestClient((msg) => sent.push(msg), "demo-plugin");

    const promise = client.request("doThing", { ok: true });
    const id = (sent[0] as { id: string }).id;

    client.handleResponse({
      type: "response",
      id,
      error: { code: "CAPABILITY_DENIED", message: "No permission." },
    });

    await expect(promise).rejects.toMatchObject({
      name: "PluginError",
      code: "CAPABILITY_DENIED",
      message: "No permission.",
      context: {
        id,
      },
    });

    await promise.catch((err) => {
      expect(err).toBeInstanceOf(PluginError);
    });
  });
});
