// Bounded FIFO queue backed by a ring buffer.
// Supports overflow policies for event bus backpressure.

import type { OverflowPolicy } from "./types";

export interface EnqueueResult<T> {
  /** Whether the item was accepted into the queue. */
  accepted: boolean;
  /** The item that was dropped, if any (drop_oldest drops head, drop_newest drops incoming). */
  dropped: T | null;
}

export class BoundedQueue<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private count = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error("BoundedQueue capacity must be at least 1");
    }
    this.capacity = capacity;
    this.buffer = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  get isFull(): boolean {
    return this.count === this.capacity;
  }

  enqueue(item: T, policy: OverflowPolicy): EnqueueResult<T> {
    if (!this.isFull) {
      this.buffer[this.tail] = item;
      this.tail = (this.tail + 1) % this.capacity;
      this.count++;
      return { accepted: true, dropped: null };
    }

    switch (policy) {
      case "mark_unhealthy":
        // Caller handles marking unhealthy — we just reject
        return { accepted: false, dropped: null };

      case "drop_oldest": {
        const dropped = this.buffer[this.head] as T;
        this.buffer[this.head] = undefined;
        this.head = (this.head + 1) % this.capacity;
        // Insert at tail (which is now the old head's slot after wrapping)
        this.buffer[this.tail] = item;
        this.tail = (this.tail + 1) % this.capacity;
        return { accepted: true, dropped };
      }

      case "drop_newest":
        // The incoming item is the one dropped
        return { accepted: true, dropped: item };
    }
  }

  dequeue(): T | undefined {
    if (this.count === 0) return undefined;
    const item = this.buffer[this.head] as T;
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    return item;
  }

  peek(): T | undefined {
    if (this.count === 0) return undefined;
    return this.buffer[this.head] as T;
  }

  drain(): T[] {
    const items: T[] = [];
    while (this.count > 0) {
      items.push(this.dequeue() as T);
    }
    return items;
  }

  clear(): void {
    this.buffer = new Array<T | undefined>(this.capacity);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}
