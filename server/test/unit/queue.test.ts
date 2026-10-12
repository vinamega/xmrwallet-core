// Queue state machine test with an in-memory repo + fake manager behaviors.
// Verifies: claim ordering, retry-then-error path, ready transition,
// concurrency cap respected.

import { describe, expect, it, vi } from "vitest";
import { RestoreQueue, type QueueRepo } from "../../src/restore/queue.js";
import type { WalletManager } from "../../src/wallets/manager.js";
import type { WalletRecord } from "../../src/wallets/record.js";

function rec(id: string, attempts = 0): WalletRecord {
  return {
    id,
    userId: "u1",
    label: null,
    address: "",
    encryptedSeed: Buffer.from("s"),
    wrappedDataKey: Buffer.from("k"),
    encryptedWalletPass: Buffer.from("p"),
    restoreHeight: 0,
    state: "queued",
    attempts,
    error: null,
    createdAt: new Date(),
  };
}

class MemRepo implements QueueRepo {
  recovered = false;
  async recoverOrphaned(): Promise<void> {
    this.recovered = true;
  }
  async updateSyncProgress(): Promise<void> {}
  queued: WalletRecord[] = [];
  ready: string[] = [];
  watching: string[] = [];
  failed: { id: string; attempts: number }[] = [];
  errored: string[] = [];

  async claimNextQueued(): Promise<WalletRecord | null> {
    return this.queued.shift() ?? null;
  }
  async markReady(id: string): Promise<void> {
    this.ready.push(id);
  }
  async markFailed(id: string, attempts: number, maxAttempts: number, _err: string): Promise<void> {
    this.failed.push({ id, attempts });
    if (attempts < maxAttempts) this.queued.push(rec(id, attempts));
    else this.errored.push(id);
  }
  async listWatched(): Promise<WalletRecord[]> {
    return [];
  }
  async markWatching(): Promise<void> {}
}

function fakeManager(restoreImpl: (r: WalletRecord) => Promise<void>) {
  return { restore: restoreImpl } as unknown as WalletManager;
}

describe("RestoreQueue", () => {
  it("processes queued wallets to ready", async () => {
    const repo = new MemRepo();
    repo.queued = [rec("w1"), rec("w2")];
    const restored: string[] = [];
    const manager = fakeManager(async (r) => {
      restored.push(r.id);
    });
    const q = new RestoreQueue(repo, manager, { concurrency: 2, pollMs: 10, maxAttempts: 3 });
    q.start();
    await vi.waitFor(() => expect(repo.ready).toEqual(["w1", "w2"]), { timeout: 2000 });
    q.stop();
    expect(restored).toEqual(["w1", "w2"]);
  });

  it("retries then errors after max attempts", async () => {
    const repo = new MemRepo();
    repo.queued = [rec("w9")];
    let calls = 0;
    const manager = fakeManager(async () => {
      calls += 1;
      throw new Error("boom 55P1V8DvMrab3xzKDtJMeVVLhsFtjKCpqVeS4njj4X6XFEkoGwCWYmTjjm8BfRJS9eEFKvMdLwtzpb5rwsmHtzoT3eUT2tn");
    });
    const q = new RestoreQueue(repo, manager, { concurrency: 1, pollMs: 5, maxAttempts: 3 });
    q.start();
    await vi.waitFor(() => expect(repo.errored).toEqual(["w9"]), { timeout: 3000 });
    q.stop();
    expect(calls).toBe(3);
    expect(repo.failed.length).toBe(3);
  });

  it("respects concurrency cap", async () => {
    const repo = new MemRepo();
    repo.queued = [rec("a"), rec("b"), rec("c"), rec("d"), rec("e")];
    let inFlight = 0;
    let maxInFlight = 0;
    const manager = fakeManager(
      () =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolve();
          }, 40);
        }),
    );
    const q = new RestoreQueue(repo, manager, { concurrency: 2, pollMs: 5, maxAttempts: 3 });
    q.start();
    await vi.waitFor(() => expect(repo.ready.length).toBe(5), { timeout: 5000 });
    q.stop();
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
