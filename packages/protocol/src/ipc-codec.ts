// Newline-delimited JSON IPC needs a way to ferry Uint8Array fields across
// the wire. `JSON.stringify(new Uint8Array([1,2,3]))` produces `{"0":1,"1":2,
// "2":3}` — i.e. it loses the type and balloons the size. The PR-T5 plugin
// terminals path needs honest byte-array survival for `e2e_pubkey`,
// `attach_pubkey`, `attach_random`, `ciphertext`, `nonce` etc.
//
// Solution: tag Uint8Array values as `{ __bin: "<base64>" }` on encode and
// restore them on decode. Both the runtime parent transport (StdioParent
// Transport) and the plugin SDK child transport import these helpers so the
// wire shape is symmetric.
//
// We only tag Uint8Array — nested ArrayBuffer, typed-array views other than
// Uint8Array, and Buffer subclasses are not part of our IPC contract.

const BIN_TAG = "__bin";

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Both Bun and modern browsers ship `Buffer` (Bun) and `btoa` (browser); to
  // stay portable across runtimes the loop here is small and the byte volume
  // is bounded by MAX_IPC_LINE_BYTES upstream.
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  // `btoa` exists in every modern JS runtime we support (Bun, Node 16+,
  // browsers). No need to branch on environment.
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const ipcReplacer = function (this: unknown, _key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BIN_TAG]: uint8ArrayToBase64(value) };
  }
  return value;
};

const ipcReviver = function (this: unknown, _key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    BIN_TAG in (value as Record<string, unknown>) &&
    typeof (value as Record<string, unknown>)[BIN_TAG] === "string"
  ) {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1) {
      return base64ToUint8Array((value as Record<string, string>)[BIN_TAG] as string);
    }
  }
  return value;
};

/** Serialize an IPC message, tagging any Uint8Array values as `{ __bin: <b64> }`. */
export function encodeIpcJson(message: unknown): string {
  return JSON.stringify(message, ipcReplacer);
}

/** Parse an IPC message, restoring `{ __bin: <b64> }` tags back to Uint8Array. */
export function decodeIpcJson(json: string): unknown {
  return JSON.parse(json, ipcReviver);
}
