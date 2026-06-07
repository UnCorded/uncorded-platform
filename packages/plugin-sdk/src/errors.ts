// Typed errors for the plugin SDK.
//
// The SDK is a public API consumed by third-party plugin authors, so every
// error thrown across the SDK boundary must be `instanceof SdkError` (or a
// subclass) — that is the contract plugin authors write `catch` blocks
// against. Raw `new Error("...")` from inside the SDK is forbidden because
// it forces consumers to string-match messages, which is brittle and silently
// breaks when we tweak wording.
//
// Convention:
//   - SdkError carries a stable `code` (machine-readable) and an optional
//     `context` object (debugging detail). Message is for humans only.
//   - Subclasses narrow the kind: SdkProtocolError signals "the IPC peer
//     returned something the SDK couldn't understand" — used by the
//     schema-validating sendAndWait wrapper so a malformed runtime response
//     surfaces as one typed error rather than a raw ZodError.

export class SdkError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "SdkError";
    this.code = code;
    if (context !== undefined) this.context = context;
  }
}

/**
 * Thrown when the runtime IPC layer returns an error response, or when the
 * runtime returns a successful response whose payload doesn't match the
 * expected per-action schema. Plugin authors catching this can rely on
 * `code` to distinguish runtime-reported failures from response-shape bugs.
 */
export class SdkProtocolError extends SdkError {
  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super(code, message, context);
    this.name = "SdkProtocolError";
  }
}
