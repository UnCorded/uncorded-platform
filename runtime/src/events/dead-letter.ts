// Dead-letter log — bounded, TTL-pruned storage for events that could not
// be delivered after exhausting retries.

import type { DeadLetterEntry } from "./types";

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class DeadLetterLog {
  private entries: DeadLetterEntry[] = [];
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries?: number, ttlMs?: number) {
    this.maxEntries = maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
  }

  add(entry: DeadLetterEntry): void {
    this.pruneExpired();
    // If still at capacity, drop oldest
    while (this.entries.length >= this.maxEntries) {
      this.entries.shift();
    }
    this.entries.push(entry);
  }

  getEntries(): readonly DeadLetterEntry[] {
    return this.entries;
  }

  /** Remove expired entries. Returns the number removed. */
  prune(): number {
    return this.pruneExpired();
  }

  get size(): number {
    return this.entries.length;
  }

  private pruneExpired(): number {
    const cutoff = Date.now() - this.ttlMs;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.failedAt > cutoff);
    return before - this.entries.length;
  }
}
