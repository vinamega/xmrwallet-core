// Restore queue: async jobs, states queued -> restoring -> ready -> watching.
// Never restore on the request path. Claim uses SELECT ... FOR UPDATE SKIP
// LOCKED so multiple app instances (or just safety) never double-claim.
// Concurrency cap (default 20, guide §2); failures retry up to
// RESTORE_MAX_ATTEMPTS with the message scrubbed (no secrets in DB logs).

import type { Pool } from "pg";
import { log } from "../logging.js";
import type { WalletManager } from "../wallets/manager.js";
import type { WalletRecord } from "../wallets/record.js";
import { scrub } from "../logging.js";

export interface QueueRepo {
  /** Reset wallets orphaned in 'restoring' by a dead process back to 'queued'. */
  recoverOrphaned(): Promise<void>;
  claimNextQueued(): Promise<WalletRecord | null>;
  markReady(walletId: string): Promise<void>;
  updateSyncProgress(walletId: string, height: number, target: number): Promise<void>;
  markFailed(walletId: string, attempts: number, maxAttempts: number, err: string): Promise<void>;
  listWatched(): Promise<WalletRecord[]>;
  markWatching(walletId: string): Promise<void>;
}

export class PgQueueRepo implements QueueRepo {
  constructor(private db: Pool) {}

  async recoverOrphaned(): Promise<void> {
    await this.db.query(
      "UPDATE wallets SET state='queued', updated_at=now() WHERE state='restoring'",
    );
  }

  async claimNextQueued(): Promise<WalletRecord | null> {
    const res = await this.db.query(
      `UPDATE wallets SET state='restoring', updated_at=now()
       WHERE id = (
         SELECT id FROM wallets WHERE state='queued'
         ORDER BY created_at
         LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id, user_id AS "userId", label, address,
                 encrypted_seed AS "encryptedSeed",
                 wrapped_data_key AS "wrappedDataKey",
                 encrypted_wallet_pass AS "encryptedWalletPass",
                 restore_height AS "restoreHeight", state, attempts, error,
                 created_at AS "createdAt"`,
    );
    return (res.rows[0] as WalletRecord | undefined) ?? null;
  }

  async updateSyncProgress(walletId: string, height: number, target: number): Promise<void> {
    await this.db.query(
      "UPDATE wallets SET sync_height=$2, sync_target=$3, updated_at=now() WHERE id=$1 AND state='restoring'",
      [walletId, height, target],
    );
  }

  async markReady(walletId: string): Promise<void> {
    await this.db.query(
      `UPDATE wallets SET state='ready', error=NULL, updated_at=now()
       WHERE id=$1 AND state='restoring'`,
      [walletId],
    );
  }

  async markFailed(walletId: string, attempts: number, maxAttempts: number, err: string): Promise<void> {
    const retry = attempts < maxAttempts;
    await this.db.query(
      `UPDATE wallets SET state=$2, attempts=$3, error=$4, updated_at=now()
       WHERE id=$1 AND state='restoring'`,
      [walletId, retry ? "queued" : "error", attempts, scrub(err).slice(0, 300)],
    );
  }

  async listWatched(): Promise<WalletRecord[]> {
    const res = await this.db.query(
      `SELECT id, user_id AS "userId", label, address,
              encrypted_seed AS "encryptedSeed",
              wrapped_data_key AS "wrappedDataKey",
              encrypted_wallet_pass AS "encryptedWalletPass",
              restore_height AS "restoreHeight", state, attempts, error,
              created_at AS "createdAt"
       FROM wallets WHERE state IN ('ready','watching') ORDER BY created_at
       LIMIT 500`,
    );
    return res.rows as WalletRecord[];
  }

  async markWatching(walletId: string): Promise<void> {
    await this.db.query(
      `UPDATE wallets SET state='watching', updated_at=now()
       WHERE id=$1 AND state='ready'`,
      [walletId],
    );
  }
}

export class RestoreQueue {
  private active = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private repo: QueueRepo,
    private manager: WalletManager,
    private opts: { concurrency: number; pollMs: number; maxAttempts: number },
  ) {}

  start(): void {
    this.stopped = false;
    // restart recovery: wallets orphaned in 'restoring' by a previous process
    void this.repo.recoverOrphaned();
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs);
    this.timer.unref();
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    while (this.active < this.opts.concurrency && !this.stopped) {
      const claimed = await this.runOne();
      if (!claimed) break;
    }
  }

  private async runOne(): Promise<boolean> {
    const record = await this.repo.claimNextQueued();
    if (!record) return false;
    this.active += 1;
    void (async () => {
      try {
        let lastUpdate = 0;
        await this.manager.restore(record, (height, target) => {
          const now = Date.now();
          if (now - lastUpdate < 5000) return; // throttle to every 5s
          lastUpdate = now;
          void this.repo.updateSyncProgress(record.id, height, target).catch(() => {});
        });
        await this.repo.markReady(record.id);
        log.info("restore job done", { walletId: record.id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn("restore job failed", { walletId: record.id, err: scrub(msg).slice(0, 300) });
        await this.repo.markFailed(record.id, record.attempts + 1, this.opts.maxAttempts, msg);
      } finally {
        this.active -= 1;
      }
    })();
    return true;
  }
}

// Watch loop: every WATCH_REFRESH_MS, refresh watched wallets through the
// manager (chain-lock serialized) and transition ready -> watching.
export class WatchLoop {
  private timer: NodeJS.Timeout | undefined;
  private lastTotals = new Map<string, bigint>();
  private cursor = 0;

  constructor(
    private repo: QueueRepo,
    private manager: WalletManager,
    private opts: { refreshMs: number; maxOpen?: number },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.cycle(), this.opts.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async cycle(): Promise<void> {
    let watched: WalletRecord[];
    try {
      watched = await this.repo.listWatched();
    } catch (e) {
      log.warn("watch list query failed", { err: String(e).slice(0, 200) });
      return;
    }
    // round-robin: refresh a bounded slice per cycle so the open-wallet
    // cache is not thrashed when watched count exceeds the cap
    const slice = Math.min(watched.length, this.opts.maxOpen ?? watched.length);
    const start = slice < watched.length ? this.cursor % watched.length : 0;
    const order = watched.slice(start, start + slice).concat(watched.slice(0, Math.max(0, start + slice - watched.length)));
    this.cursor = (this.cursor + slice) % Math.max(1, watched.length);
    for (const record of order) {
      const prev = this.lastTotals.get(record.id) ?? null;
      try {
        const refreshed = await this.manager.refreshWatched(record, prev);
        if (refreshed) {
          const balances = await this.manager.getBalances(record).catch(() => null);
          if (balances) this.lastTotals.set(record.id, balances.total);
          if (record.state === "ready") await this.repo.markWatching(record.id);
        }
      } catch (e) {
        log.warn("watch refresh failed", { walletId: record.id, err: scrubErr200(e) });
      }
    }
  }
}

function scrubErr200(e: unknown): string {
  return scrub(e instanceof Error ? e.message : String(e)).slice(0, 200);
}
