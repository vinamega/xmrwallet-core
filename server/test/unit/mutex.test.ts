import { describe, expect, it } from "vitest";
import { KeyedMutexes, Mutex, runWithTimeout } from "../../src/wallets/mutex.js";

describe("Mutex", () => {
  it("serializes concurrent runs", async () => {
    const m = new Mutex();
    const order: number[] = [];
    await Promise.all([
      m.run(async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push(1);
      }),
      m.run(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});

describe("runWithTimeout", () => {
  it("runs fn when lock free", async () => {
    const m = new Mutex();
    const res = await runWithTimeout(m, async () => 42, 1000);
    expect(res).toBe(42);
  });

  it("times out when lock held", async () => {
    const m = new Mutex();
    const release = m.run(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return "slow";
    });
    const res = await runWithTimeout(m, async () => "fast", 20);
    expect(res).toBe("timeout");
    await release;
  });
});

describe("KeyedMutexes", () => {
  it("independent locks per key", async () => {
    const km = new KeyedMutexes();
    const order: string[] = [];
    const a = km.for("a").run(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("a");
    });
    const b = km.for("b").run(async () => {
      order.push("b");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["b", "a"]);
  });
});
