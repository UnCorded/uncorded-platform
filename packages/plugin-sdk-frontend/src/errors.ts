/** Structured SDK error surfaced by generic plugin frontend helpers. */
export class PluginError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly context: Record<string, unknown> | null;

  constructor(
    code: string,
    message: string,
    options: { status?: number | null; context?: Record<string, unknown> | null } = {},
  ) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.status = options.status ?? null;
    this.context = options.context ?? null;
  }
}
