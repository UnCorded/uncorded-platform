import { describe, expect, test } from "bun:test";
import { BoundedQueue } from "./queue";

describe("BoundedQueue", () => {
  test("rejects capacity < 1", () => {
    expect(() => new BoundedQueue(0)).toThrow("capacity must be at least 1");
  });

  test("basic enqueue/dequeue FIFO order", () => {
    const q = new BoundedQueue<number>(4);
    q.enqueue(1, "mark_unhealthy");
    q.enqueue(2, "mark_unhealthy");
    q.enqueue(3, "mark_unhealthy");
    expect(q.size).toBe(3);
    expect(q.dequeue()).toBe(1);
    expect(q.dequeue()).toBe(2);
    expect(q.dequeue()).toBe(3);
    expect(q.dequeue()).toBeUndefined();
  });

  test("peek does not remove", () => {
    const q = new BoundedQueue<string>(4);
    q.enqueue("a", "mark_unhealthy");
    expect(q.peek()).toBe("a");
    expect(q.size).toBe(1);
    expect(q.peek()).toBe("a");
  });

  test("drain returns all items in FIFO order and empties queue", () => {
    const q = new BoundedQueue<number>(8);
    for (let i = 0; i < 5; i++) q.enqueue(i, "mark_unhealthy");
    const items = q.drain();
    expect(items).toEqual([0, 1, 2, 3, 4]);
    expect(q.size).toBe(0);
  });

  test("clear empties the queue", () => {
    const q = new BoundedQueue<number>(4);
    q.enqueue(1, "mark_unhealthy");
    q.enqueue(2, "mark_unhealthy");
    q.clear();
    expect(q.size).toBe(0);
    expect(q.dequeue()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // mark_unhealthy policy
  // -------------------------------------------------------------------------

  test("mark_unhealthy: rejects when full", () => {
    const q = new BoundedQueue<number>(2);
    q.enqueue(1, "mark_unhealthy");
    q.enqueue(2, "mark_unhealthy");
    expect(q.isFull).toBe(true);

    const result = q.enqueue(3, "mark_unhealthy");
    expect(result.accepted).toBe(false);
    expect(result.dropped).toBeNull();
    expect(q.size).toBe(2);
    // Original items intact
    expect(q.dequeue()).toBe(1);
    expect(q.dequeue()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // drop_oldest policy
  // -------------------------------------------------------------------------

  test("drop_oldest: drops head when full, keeps newest", () => {
    const q = new BoundedQueue<number>(3);
    q.enqueue(1, "drop_oldest");
    q.enqueue(2, "drop_oldest");
    q.enqueue(3, "drop_oldest");

    const result = q.enqueue(4, "drop_oldest");
    expect(result.accepted).toBe(true);
    expect(result.dropped).toBe(1);
    expect(q.size).toBe(3);
    expect(q.drain()).toEqual([2, 3, 4]);
  });

  test("drop_oldest: multiple overflows maintain order", () => {
    const q = new BoundedQueue<number>(2);
    q.enqueue(1, "drop_oldest");
    q.enqueue(2, "drop_oldest");
    q.enqueue(3, "drop_oldest"); // drops 1
    q.enqueue(4, "drop_oldest"); // drops 2
    expect(q.drain()).toEqual([3, 4]);
  });

  // -------------------------------------------------------------------------
  // drop_newest policy
  // -------------------------------------------------------------------------

  test("drop_newest: drops incoming when full", () => {
    const q = new BoundedQueue<number>(2);
    q.enqueue(1, "drop_newest");
    q.enqueue(2, "drop_newest");

    const result = q.enqueue(3, "drop_newest");
    expect(result.accepted).toBe(true);
    expect(result.dropped).toBe(3);
    expect(q.size).toBe(2);
    expect(q.drain()).toEqual([1, 2]);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  test("capacity 1 works correctly", () => {
    const q = new BoundedQueue<string>(1);
    q.enqueue("a", "mark_unhealthy");
    expect(q.isFull).toBe(true);

    const r1 = q.enqueue("b", "mark_unhealthy");
    expect(r1.accepted).toBe(false);

    const r2 = q.enqueue("b", "drop_oldest");
    expect(r2.accepted).toBe(true);
    expect(r2.dropped).toBe("a");
    expect(q.dequeue()).toBe("b");
  });

  test("wraps around ring buffer correctly", () => {
    const q = new BoundedQueue<number>(3);
    // Fill and partially drain to force wraparound
    q.enqueue(1, "mark_unhealthy");
    q.enqueue(2, "mark_unhealthy");
    q.dequeue(); // remove 1
    q.enqueue(3, "mark_unhealthy");
    q.enqueue(4, "mark_unhealthy"); // wraps around
    expect(q.drain()).toEqual([2, 3, 4]);
  });

  test("isFull and size track correctly through lifecycle", () => {
    const q = new BoundedQueue<number>(2);
    expect(q.size).toBe(0);
    expect(q.isFull).toBe(false);

    q.enqueue(1, "mark_unhealthy");
    expect(q.size).toBe(1);
    expect(q.isFull).toBe(false);

    q.enqueue(2, "mark_unhealthy");
    expect(q.size).toBe(2);
    expect(q.isFull).toBe(true);

    q.dequeue();
    expect(q.size).toBe(1);
    expect(q.isFull).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Stress test — 10k inserts into a 1024-slot ring buffer per policy
  // -------------------------------------------------------------------------

  describe("stress: 10,000 inserts into capacity-1024 queue", () => {
    const CAPACITY = 1024;
    const INSERTS = 10_000;

    test("mark_unhealthy: accepts first 1024, rejects remaining 8976", () => {
      const q = new BoundedQueue<number>(CAPACITY);
      let accepted = 0;
      let rejected = 0;

      for (let i = 0; i < INSERTS; i++) {
        const r = q.enqueue(i, "mark_unhealthy");
        if (r.accepted) accepted++;
        else rejected++;
      }

      expect(accepted).toBe(CAPACITY);
      expect(rejected).toBe(INSERTS - CAPACITY);
      expect(q.size).toBe(CAPACITY);

      // FIFO preserved: first 1024 items
      const items = q.drain();
      expect(items.length).toBe(CAPACITY);
      expect(items[0]).toBe(0);
      expect(items[CAPACITY - 1]).toBe(CAPACITY - 1);
    });

    test("drop_oldest: always accepts, keeps last 1024 items in order", () => {
      const q = new BoundedQueue<number>(CAPACITY);
      let dropCount = 0;

      for (let i = 0; i < INSERTS; i++) {
        const r = q.enqueue(i, "drop_oldest");
        expect(r.accepted).toBe(true);
        if (r.dropped !== null) dropCount++;
      }

      expect(dropCount).toBe(INSERTS - CAPACITY);
      expect(q.size).toBe(CAPACITY);

      // Should contain the last 1024 values in FIFO order
      const items = q.drain();
      expect(items.length).toBe(CAPACITY);
      const expectedStart = INSERTS - CAPACITY;
      for (let i = 0; i < CAPACITY; i++) {
        expect(items[i]).toBe(expectedStart + i);
      }
    });

    test("drop_newest: always accepts, keeps first 1024 items in order", () => {
      const q = new BoundedQueue<number>(CAPACITY);
      let dropCount = 0;

      for (let i = 0; i < INSERTS; i++) {
        const r = q.enqueue(i, "drop_newest");
        expect(r.accepted).toBe(true);
        if (r.dropped !== null) dropCount++;
      }

      expect(dropCount).toBe(INSERTS - CAPACITY);
      expect(q.size).toBe(CAPACITY);

      // Should contain the first 1024 values in FIFO order
      const items = q.drain();
      expect(items.length).toBe(CAPACITY);
      for (let i = 0; i < CAPACITY; i++) {
        expect(items[i]).toBe(i);
      }
    });
  });
});
