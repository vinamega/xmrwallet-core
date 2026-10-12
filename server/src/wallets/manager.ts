// Wallet manager: owns wallet lifecycle.
// - per-wallet mutex: a wallet is never touched by two workers at once
// - global chain lock: watch-mode refreshes (chain-pool-touching) serialize
// - restore syncs run capped-concurrent in the engine workers (not chained:
//   they are the long CPU-bound phase; see docs/decisions/0001-engine.md)
// - LRU cap on open wallet handles
// - balance-action plugin notified on detected balance changes

import type { Config } from "../config.js";
import type { BalanceActionPlugin } from "../../../plugins/src/index.js";
import { log } from "../logging.js";
import type { Balances, IncomingTransfer, OutgoingTransfer, SubaddressInfo, WalletEngine, WalletHandle } from "./engine.js";
import { KeyedMutexes, Mutex, runWithTimeout } from "./mutex.js";
import { walletPathFor, type WalletRecord } from "./record.js";
import { decryptWalletMaterial } from "./seedstore.js";
import { resolveRestoreHeight } from "./fast-restore.js";

interface CacheEntry {
  handle: WalletHandle;
  lastUsed: number;
  busy: boolean;
}

export class WalletManager {
  private cache = new Map<string, CacheEntry>();
  private locks = new KeyedMutexes();
  private chainLock = new Mutex();

  constructor(
    private engine: WalletEngine,
    private config: Config,
    private plugins: BalanceActionPlugin[],
  ) {}

  /** Restore a wallet: open from seed and sync from restore height (full scan
   *  for height 0 — unless fast restore discovers the first-use height).
   *  Leaves the handle open + cached for the watch loop. */
  async restore(record: WalletRecord, onProgress?: (height: number, target: number) => void): Promise<void> {
    const material = decryptWalletMaterial(this.config.masterKey, record.id, {
      encryptedSeed: record.encryptedSeed,
      wrappedDataKey: record.wrappedDataKey,
      encryptedWalletPass: record.encryptedWalletPass,
    });
    let restoreHeight = record.restoreHeight;
    if (restoreHeight === 0) {
      try {
        const tip = await this.engine.daemonHeight();
        restoreHeight = await resolveRestoreHeight(this.config, material.seed, 0, tip);
      } catch {
        log.warn("fast restore unavailable, scanning from 0", { walletId: record.id });
      }
    }
    const handle = await this.engine.openWallet({
      seed: material.seed,
      walletPath: walletPathFor(this.config.walletDir, record.id),
      walletPass: material.walletPass,
      restoreHeight,
    });
    const started = Date.now();
    await handle.syncOnce(onProgress);
    await handle.save();
    this.cache.set(record.id, { handle, lastUsed: Date.now(), busy: false });
    log.info("wallet restored", {
      walletId: record.id,
      seconds: Math.round((Date.now() - started) / 1000),
    });
  }

  private decryptMaterial(record: WalletRecord) {
    return decryptWalletMaterial(this.config.masterKey, record.id, {
      encryptedSeed: record.encryptedSeed,
      wrappedDataKey: record.wrappedDataKey,
      encryptedWalletPass: record.encryptedWalletPass,
    });
  }

  private async ensureOpen(record: WalletRecord): Promise<WalletHandle> {
    const hit = this.cache.get(record.id);
    if (hit) {
      hit.lastUsed = Date.now();
      return hit.handle;
    }
    const material = this.decryptMaterial(record);
    const handle = await this.engine.openWallet({
      seed: material.seed,
      walletPath: walletPathFor(this.config.walletDir, record.id),
      walletPass: material.walletPass,
      restoreHeight: record.restoreHeight,
    });
    this.cache.set(record.id, { handle, lastUsed: Date.now(), busy: false });
    await this.evictIfNeeded();
    return handle;
  }

  private async evictIfNeeded(): Promise<void> {
    if (this.cache.size <= this.config.maxOpenWallets) return;
    const candidates = [...this.cache.entries()]
      .filter(([, e]) => !e.busy)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let toEvict = this.cache.size - this.config.maxOpenWallets;
    for (const [id, entry] of candidates) {
      if (toEvict <= 0) break;
      toEvict -= 1;
      this.cache.delete(id);
      try {
        await entry.handle.close();
      } catch (e) {
        log.warn("wallet close failed during eviction", { walletId: id, err: scrubErr(e) });
      }
    }
  }

  private markBusy(id: string, busy: boolean): void {
    const e = this.cache.get(id);
    if (e) e.busy = busy;
  }

  async getBalances(record: WalletRecord): Promise<Balances> {
    return this.withWallet(record, (handle) => handle.getBalances());
  }

  async getIncoming(record: WalletRecord, limit = 25): Promise<IncomingTransfer[]> {
    return this.withWallet(record, (handle) => handle.getIncoming(limit));
  }

  async getOutgoing(record: WalletRecord, limit = 25): Promise<OutgoingTransfer[]> {
    return this.withWallet(record, (handle) => handle.getOutgoing(limit));
  }

  async getSubaddresses(record: WalletRecord): Promise<SubaddressInfo[]> {
    return this.withWallet(record, (handle) => handle.getSubaddresses());
  }

  async createSubaddress(record: WalletRecord, label: string | null): Promise<SubaddressInfo> {
    return this.withWallet(record, async (handle) => {
      const info = await handle.createSubaddress(label);
      await handle.save();
      return info;
    });
  }

  async sendMax(record: WalletRecord, address: string): Promise<{ txid: string }> {
    return this.withWallet(record, async (handle) => {
      const res = await handle.sweepToAddress(address);
      await handle.save();
      return res;
    });
  }

  async send(record: WalletRecord, address: string, amountAtomic: bigint): Promise<{ txid: string }> {
    return this.withWallet(record, async (handle) => {
      const res = await handle.sendToAddress(address, amountAtomic);
      await handle.save();
      return res;
    });
  }

  async getAddress(record: WalletRecord): Promise<string> {
    return this.withWallet(record, (handle) => handle.getPrimaryAddress());
  }

  /** Watch-mode refresh: serialized chain-pool access via the global chain lock
   *  (with timeout), plugin notification on balance change. Returns false if
   *  the lock was contended and the refresh was skipped this cycle. */
  async refreshWatched(record: WalletRecord, previousTotal: bigint | null): Promise<boolean> {
    const job = async (): Promise<bigint> => {
      const handle = await this.ensureOpen(record);
      this.markBusy(record.id, true);
      try {
        await handle.syncOnce();
        const balances = await handle.getBalances();
        if (previousTotal !== null && balances.total !== previousTotal) {
          await this.notifyPlugins(record, previousTotal, balances);
        }
        return balances.total;
      } finally {
        this.markBusy(record.id, false);
      }
    };
    const res = await runWithTimeout(this.chainLock, job, this.config.chainLockTimeoutMs);
    return res !== "timeout";
  }

  private async notifyPlugins(record: WalletRecord, previous: bigint, now: Balances): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.onBalanceChange({
          walletId: record.id,
          userId: record.userId,
          network: this.config.network,
          totalBalance: now.total.toString(),
          unlockedBalance: now.unlocked.toString(),
          previousTotalBalance: previous.toString(),
          detectedAt: Date.now(),
        });
      } catch (e) {
        log.warn("plugin error (ignored)", { plugin: plugin.id, err: scrubErr(e) });
      }
    }
  }

  private async withWallet<T>(record: WalletRecord, fn: (handle: WalletHandle) => Promise<T>): Promise<T> {
    const lock = this.locks.for(record.id);
    return lock.run(async () => {
      const handle = await this.ensureOpen(record);
      this.markBusy(record.id, true);
      try {
        return await fn(handle);
      } finally {
        this.markBusy(record.id, false);
      }
    });
  }

  async closeAll(): Promise<void> {
    for (const [id, entry] of this.cache) {
      try {
        await entry.handle.close();
      } catch (e) {
        log.warn("wallet close failed on shutdown", { walletId: id, err: scrubErr(e) });
      }
    }
    this.cache.clear();
  }
}

export function scrubErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 300);
}
