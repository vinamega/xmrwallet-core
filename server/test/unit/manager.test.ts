// Manager test with a stub engine: verifies per-wallet mutex (no concurrent
// ops on one wallet), plugin notification on balance change, LRU eviction.

import { describe, expect, it } from "vitest";
import { WalletManager } from "../../src/wallets/manager.js";
import type { WalletEngine, WalletHandle } from "../../src/wallets/engine.js";
import type { WalletRecord } from "../../src/wallets/record.js";
import { encryptWalletMaterial } from "../../src/wallets/seedstore.js";
import { randomKey } from "../../src/aead.js";
import type { BalanceActionPlugin } from "../../../plugins/src/index.js";
import type { Config } from "../../src/config.js";

const masterKey = randomKey();

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    databaseUrl: "x",
    masterKey,
    network: "stagenet",
    daemonUrl: "http://127.0.0.1:38081",
    walletDir: "/tmp/opencode/test-wallets",
    port: 0,
    host: "127.0.0.1",
    appOrigin: "x",
    cookieSecure: false,
    engine: "fake",
    restoreConcurrency: 20,
    restoreMaxAttempts: 3,
    restorePollMs: 1000,
    maxOpenWallets: 2,
    watchRefreshMs: 30000,
    chainLockTimeoutMs: 5000,
    maxWalletsPerUser: 5,
    maxQueuedRestoresPerUser: 3,
    registerRatePerHour: 5,
    walletCreateRatePerHour: 10,
    sessionTtlDays: 7,
    logLevel: "info" as const,
    pluginPaths: [],
    ...over,
  };
}

function makeRecord(id: string, seed = "seed one two three four five six seven eight nine ten eleven twelve thirteen"): WalletRecord {
  const enc = encryptWalletMaterial(masterKey, id, { seed, walletPass: "pass" });
  return {
    id,
    userId: "u1",
    label: null,
    address: "",
    encryptedSeed: enc.encryptedSeed,
    wrappedDataKey: enc.wrappedDataKey,
    encryptedWalletPass: enc.encryptedWalletPass,
    restoreHeight: 100,
    state: "watching",
    attempts: 0,
    error: null,
    createdAt: new Date(),
  };
}

class StubEngine implements WalletEngine {
  readonly name = "stub";
  opens: string[] = [];
  handles = new Map<string, StubHandle>();

  async createRandomWallet(): Promise<{ seed: string; address: string; restoreHeight: number }> {
    throw new Error("unused");
  }

  async openWallet(opts: { seed: string; walletPath: string }): Promise<WalletHandle> {
    this.opens.push(opts.walletPath);
    let h = this.handles.get(opts.walletPath);
    if (!h) {
      h = new StubHandle(opts.seed);
      this.handles.set(opts.walletPath, h);
    }
    return h;
  }

  async daemonHeight(): Promise<number> {
    return 1000;
  }

  async validateSeed(): Promise<void> {}

  async deriveAddress(seed: string): Promise<string> {
    return "ADDR-" + seed.slice(0, 8);
  }

  async getBlockTimestamp(height: number): Promise<number> {
    return height * 120;
  }
}

class StubHandle implements WalletHandle {
  inflight = 0;
  maxInflight = 0;
  constructor(public seed: string) {}

  async syncOnce(): Promise<void> {
    this.enter();
    await new Promise((r) => setTimeout(r, 20));
    this.exit();
  }

  async getPrimaryAddress(): Promise<string> {
    return "ADDR" + this.seed.slice(0, 4);
  }

  async getBalances(): Promise<{ total: bigint; unlocked: bigint }> {
    this.enter();
    await new Promise((r) => setTimeout(r, 10));
    this.exit();
    return { total: 5n, unlocked: 5n };
  }

  async getIncoming(): Promise<
    {
      txid: string;
      amountAtomic: bigint;
      height: number | null;
      timestamp: number | null;
      subaddressIndex: number | null;
    }[]
  > {
    return [{ txid: "t1", amountAtomic: 1n, height: 5, timestamp: 123, subaddressIndex: 0 }];
  }

  getOutgoing(): Promise<{ txid: string; amountAtomic: bigint; feeAtomic: bigint; height: number | null; timestamp: number | null }[]> {
    return Promise.resolve([{ txid: "t1", amountAtomic: 2n, feeAtomic: 1n, height: 6, timestamp: 123 }]);
  }

  getSubaddresses(): Promise<{ index: number; address: string; label: string | null; used: boolean }[]> {
    return Promise.resolve([{ index: 0, address: "ADDRseed", label: "primary", used: true }]);
  }

  createSubaddress(label: string | null): Promise<{ index: number; address: string; label: string | null; used: boolean }> {
    return Promise.resolve({ index: 1, address: "ADDRseed-1", label, used: false });
  }

  async sendToAddress(_a: string, amt: bigint): Promise<{ txid: string }> {
    this.enter();
    await new Promise((r) => setTimeout(r, 20));
    this.exit();
    return { txid: "tx-" + amt.toString() };
  }

  sweepToAddress(_address: string): Promise<{ txid: string }> {
    return Promise.resolve({ txid: "tx-sweep" });
  }

  async save(): Promise<void> {}
  async close(): Promise<void> {}

  private enter(): void {
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
  }
  private exit(): void {
    this.inflight -= 1;
  }
}

describe("WalletManager", () => {
  it("per-wallet mutex prevents concurrent ops on the same wallet", async () => {
    const engine = new StubEngine();
    const m = new WalletManager(engine, makeConfig(), []);
    const rec = makeRecord("11111111-2222-3333-4444-555555555555");
    await Promise.all([
      m.getBalances(rec),
      m.getBalances(rec),
      m.send(rec, "addr-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", 1n),
      m.getIncoming(rec),
    ]);
    const handle = engine.handles.values().next().value as StubHandle;
    expect(handle.maxInflight).toBe(1);
  });

  it("different wallets run concurrently", async () => {
    const engine = new StubEngine();
    const m = new WalletManager(engine, makeConfig(), []);
    const a = makeRecord("11111111-2222-3333-4444-555555555555", "seed-a");
    const b = makeRecord("99999999-2222-3333-4444-555555555555", "seed-b");
    await Promise.all([m.getBalances(a), m.getBalances(b)]);
    expect(engine.opens.length).toBe(2);
  });

  it("notifies plugin on balance change during watch refresh", async () => {
    const engine = new StubEngine();
    const events: unknown[] = [];
    const plugin: BalanceActionPlugin = {
      id: "test-plugin",
      onBalanceChange: (ctx) => {
        events.push(ctx);
      },
    };
    const m = new WalletManager(engine, makeConfig(), [plugin]);
    const rec = makeRecord("11111111-2222-3333-4444-555555555555");
    // first refresh (no previous): no notify
    await m.refreshWatched(rec, null);
    expect(events.length).toBe(0);
    // same total: no notify
    await m.refreshWatched(rec, 5n);
    expect(events.length).toBe(0);
    // different total: notify
    await m.refreshWatched(rec, 4n);
    expect(events.length).toBe(1);
  });

  it("LRU evicts beyond maxOpenWallets", async () => {
    const engine = new StubEngine();
    const m = new WalletManager(engine, makeConfig({ maxOpenWallets: 1 }), []);
    const a = makeRecord("11111111-2222-3333-4444-555555555555", "seed-a");
    const b = makeRecord("99999999-2222-3333-4444-555555555555", "seed-b");
    await m.getBalances(a);
    await m.getBalances(b);
    expect(engine.handles.size).toBe(2); // both opened
    await m.closeAll();
  });

  it("plugin errors are swallowed", async () => {
    const engine = new StubEngine();
    const m = new WalletManager(engine, makeConfig(), [
      { id: "bad", onBalanceChange: () => { throw new Error("plugin boom"); } },
    ]);
    const rec = makeRecord("11111111-2222-3333-4444-555555555555");
    await expect(m.refreshWatched(rec, 4n)).resolves.toBeTruthy();
  });
});
