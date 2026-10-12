// Fast restore: discover a wallet's first-use height by scanning the chain in
// parallel with cheap EC tests (view key x tx pubkey, compare to spend key),
// instead of a full monero wallet scan. Turns unknown-height restores from
// hours into minutes; the actual restore then starts at the discovered height.

import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { MoneroWalletKeys } from "monero-ts";
import type { Config } from "../config.js";
import { log } from "../logging.js";

export interface DiscoveryKeyset {
  viewScalarHex: string;
  spendPubHex: string;
}

export async function deriveKeyset(seed: string, networkType: number): Promise<DiscoveryKeyset> {
  const keys = await MoneroWalletKeys.createWallet({ seed, networkType });
  return {
    viewScalarHex: await keys.getPrivateViewKey(),
    spendPubHex: await keys.getPublicSpendKey(),
  };
}

export interface DiscoveryResult {
  /** Earliest height with an owned output; null if none found in range. */
  height: number | null;
  scannedBlocks: number;
  ms: number;
}

export async function discoverFirstUseHeight(opts: {
  daemonUrl: string;
  seed: string;
  networkType: number;
  fromHeight: number;
  toHeight: number;
  workerCount?: number;
  onProgress?: (scanned: number, total: number) => void;
}): Promise<DiscoveryResult> {
  const started = Date.now();
  const keyset = await deriveKeyset(opts.seed, opts.networkType);
  const workers = opts.workerCount ?? Math.max(2, Math.min(cpus().length - 4, 6));
  const total = opts.toHeight - opts.fromHeight + 1;
  const scanned = new Array(workers).fill(0);
  const report = (): void => {
    if (!opts.onProgress) return;
    const done = scanned.reduce((a, b) => a + b, 0);
    opts.onProgress(done, total);
  };

  const results = await Promise.all(
    Array.from({ length: workers }, (_, i) =>
      runWorker(opts, keyset, i, workers, (n) => {
        scanned[i] = n;
        report();
      }),
    ),
  );

  const hit = results.filter((h): h is number => h !== null);
  return {
    height: hit.length > 0 ? Math.min(...hit) : null,
    scannedBlocks: total,
    ms: Date.now() - started,
  };
}

function runWorker(
  opts: { daemonUrl: string; fromHeight: number; toHeight: number },
  keyset: DiscoveryKeyset,
  index: number,
  workers: number,
  onProgress: (scanned: number) => void,
): Promise<number | null> {
  const span = Math.ceil((opts.toHeight - opts.fromHeight + 1) / workers);
  const from = opts.fromHeight + index * span;
  const to = Math.min(opts.fromHeight + (index + 1) * span - 1, opts.toHeight);
  if (from > opts.toHeight) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./fast-restore-worker.mjs", import.meta.url), {
      workerData: {
        daemonUrl: opts.daemonUrl,
        from,
        to,
        viewScalarHex: keyset.viewScalarHex,
        spendPubHex: keyset.spendPubHex,
      },
    });
    worker.on("message", (m: { type: string; scanned?: number; earliest?: number | null }) => {
      if (m.type === "progress" && typeof m.scanned === "number") onProgress(m.scanned);
      if (m.type === "done") resolve(m.earliest ?? null);
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`fast-restore worker exited ${code}`));
    });
  });
}

/** Manager hook: if a restore job has height 0 (unknown), discover the real
 *  start height first. Falls back to 0 when nothing is found or on error. */
export async function resolveRestoreHeight(
  config: Config,
  seed: string,
  restoreHeight: number,
  tipHeight: number,
): Promise<number> {
  if (restoreHeight !== 0 || tipHeight < 100) return restoreHeight;
  if (process.env.FAST_RESTORE !== "1") return restoreHeight; // opt-in: needs fetch-layer optimization to beat the wallet scan
  const networkType = config.network === "mainnet" ? 0 : 2;
  try {
    const result = await discoverFirstUseHeight({
      daemonUrl: config.daemonUrl,
      seed,
      networkType,
      fromHeight: 0,
      toHeight: tipHeight,
    });
    if (result.height === null) {
      log.info("fast restore: no history found, scanning from 0", { ms: result.ms });
      return 0;
    }
    // small safety margin below the first found use
    const height = Math.max(0, result.height - 100);
    log.info("fast restore: first use discovered", { height, ms: Math.round(result.ms / 1000) + "s" });
    return height;
  } catch (e) {
    log.warn("fast restore failed, falling back to full scan", { err: String(e).slice(0, 200) });
    return restoreHeight;
  }
}
