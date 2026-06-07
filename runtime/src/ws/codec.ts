// Wire codec abstraction — JSON now, MessagePack later.
// The WebSocket server encodes/decodes all messages through this interface.
// Swapping to MessagePack means implementing a new WireCodec, not changing the router.

import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";

export interface WireCodec {
  encode(message: unknown): string | Uint8Array;
  decode(data: string | Uint8Array | ArrayBuffer): unknown;
}

const textDecoder = new TextDecoder();

export const jsonCodec: WireCodec = {
  encode(message: unknown): string {
    return JSON.stringify(message);
  },

  decode(data: string | Uint8Array | ArrayBuffer): unknown {
    const text =
      typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? textDecoder.decode(data)
          : textDecoder.decode(data);
    return JSON.parse(text);
  },
};

export const msgpackCodec: WireCodec = {
  encode(message: unknown): Uint8Array {
    return msgpackEncode(message);
  },

  decode(data: string | Uint8Array | ArrayBuffer): unknown {
    if (typeof data === "string") {
      // Fallback: shouldn't happen in msgpack mode, but handle gracefully
      return JSON.parse(data);
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    return msgpackDecode(bytes);
  },
};
