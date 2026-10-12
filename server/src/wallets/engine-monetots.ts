// monero-ts headless engine (decision 0001): in-process WASM full wallets,
// each proxied to its own worker thread (proxyToWorker, monero-ts default)
// so heavy restores do not block the app event loop.

import { existsSync, rmSync } from "node:fs";
import {
  MoneroWalletKeys,
  MoneroWalletListener,
  connectToDaemonRpc,
  type MoneroDaemonRpc,
  createWalletFull,
  openWalletFull,
  MoneroNetworkType,
  MoneroWalletFull,
  type MoneroIncomingTransfer,
  type MoneroSubaddress,
} from "monero-ts";
import type {
  Balances,
  CreateRandomResult,
  IncomingTransfer,
  OpenWalletOpts,
  OutgoingTransfer,
  SubaddressInfo,
  WalletEngine,
  WalletHandle,
} from "./engine.js";
import type { Config } from "../config.js";

const NET: Record<Config["network"], MoneroNetworkType> = {
  stagenet: MoneroNetworkType.STAGENET,
  mainnet: MoneroNetworkType.MAINNET,
};

class SyncProgressListener extends MoneroWalletListener {
  constructor(private onProgress?: (height: number, targetHeight: number) => void) {
    super();
  }

  override async onSyncProgress(
    height: number,
    _startHeight: number,
    endHeight: number,
    _pctDone: number,
    _message: string,
  ): Promise<void> {
    this.onProgress?.(height, endHeight);
  }
}

class MoneroTsHandle implements WalletHandle {
  constructor(
    private wallet: MoneroWalletFull,
    private walletPath: string,
    private getDaemon: () => Promise<MoneroDaemonRpc>,
  ) {}

  async syncOnce(onProgress?: (height: number, targetHeight: number) => void): Promise<void> {
    await this.wallet.sync(onProgress ? new SyncProgressListener(onProgress) : undefined);
  }

  async getPrimaryAddress(): Promise<string> {
    return this.wallet.getAddress(0, 0);
  }

  async getBalances(): Promise<Balances> {
    const [total, unlocked] = await Promise.all([
      this.wallet.getBalance(),
      this.wallet.getUnlockedBalance(),
    ]);
    return { total, unlocked };
  }

  async getIncoming(limit: number): Promise<IncomingTransfer[]> {
    const transfers = await this.wallet.getTransfers({ isIncoming: true });
    const out: IncomingTransfer[] = transfers.map((t) => ({
      txid: t.getTx()?.getHash() ?? "unknown",
      amountAtomic: t.getAmount(),
      height: t.getTx()?.getHeight() ?? null,
      timestamp: null, // not exposed by monero-ts wallet txs; height is authoritative
      subaddressIndex: (t as MoneroIncomingTransfer).getSubaddressIndex?.() ?? null,
    }));
    await this.fillTimestamps(out);
    out.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    return out.slice(0, limit);
  }

  async getOutgoing(limit: number): Promise<OutgoingTransfer[]> {
    const transfers = await this.wallet.getTransfers({ isIncoming: false });
    const out: OutgoingTransfer[] = transfers.map((t) => ({
      txid: t.getTx()?.getHash() ?? "unknown",
      amountAtomic: t.getAmount(),
      feeAtomic: t.getTx()?.getFee() ?? 0n,
      height: t.getTx()?.getHeight() ?? null,
      timestamp: null,
    }));
    await this.fillTimestamps(out);
    out.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    return out.slice(0, limit);
  }

  /** resolve block timestamps for transfers (batched, cached) */
  private async fillTimestamps(
    txs: { height: number | null; timestamp: number | null }[],
  ): Promise<void> {
    const missing = [...new Set(txs.filter((t) => t.height !== null).map((t) => t.height!))];
    const toFetch = missing.filter((h) => !blockTimestampCache.has(h));
    if (toFetch.length === 0) {
      for (const t of txs) if (t.height !== null) t.timestamp = blockTimestampCache.get(t.height) ?? null;
      return;
    }
    const daemon = await this.getDaemon();
    if (toFetch.length > 0) {
      const headers = await Promise.all(
        toFetch.map((h) => daemon.getBlockHeaderByHeight(h).catch(() => null)),
      );
      toFetch.forEach((h, i) => {
        const ts = headers[i]?.getTimestamp();
        if (typeof ts === "number") blockTimestampCache.set(h, ts);
      });
    }
    for (const t of txs) {
      if (t.height !== null) t.timestamp = blockTimestampCache.get(t.height) ?? null;
    }
  }

  private static subToInfo(s: MoneroSubaddress): SubaddressInfo {
    return {
      index: s.getIndex(),
      address: s.getAddress(),
      label: s.getLabel() ?? null,
      used: s.getIsUsed() ?? false,
    };
  }

  async getSubaddresses(): Promise<SubaddressInfo[]> {
    const subs = await this.wallet.getSubaddresses(0);
    return subs.map(MoneroTsHandle.subToInfo);
  }

  async createSubaddress(label: string | null): Promise<SubaddressInfo> {
    const s = await this.wallet.createSubaddress(0, label ?? undefined);
    return MoneroTsHandle.subToInfo(s);
  }

  async sendToAddress(address: string, amountAtomic: bigint): Promise<{ txid: string }> {
    const tx = await this.wallet.createTx({
      accountIndex: 0,
      address,
      amount: amountAtomic,
      relay: true,
    });
    return { txid: tx.getHash() };
  }

  async sweepToAddress(address: string): Promise<{ txid: string }> {
    const txs = await this.wallet.sweepUnlocked({ address, accountIndex: 0, relay: true });
    const tx = txs[0];
    if (!tx) throw new Error("nothing to sweep");
    return { txid: tx.getHash() };
  }

  async save(): Promise<void> {
    await this.wallet.save();
  }

  async close(): Promise<void> {
    await this.wallet.close(true);
    // monero-ts writes <path>.address.txt in plaintext; remove it so the
    // wallet dir holds no plaintext address beyond the encrypted wallet files.
    rmSync(`${this.walletPath}.address.txt`, { force: true });
  }
}

const blockTimestampCache = new Map<number, number>();

export class MoneroTsEngine implements WalletEngine {
  readonly name = "monerots";
  private daemon: MoneroDaemonRpc | undefined;

  constructor(private config: Config) {}

  /** one shared daemon client (each connectToDaemonRpc spawns a worker) */
  private async getDaemon(): Promise<MoneroDaemonRpc> {
    this.daemon ??= await connectToDaemonRpc(this.config.daemonUrl);
    return this.daemon;
  }

  async createRandomWallet(opts: {
    walletPath: string;
    walletPass: string;
    restoreHeight: number;
  }): Promise<CreateRandomResult> {
    const wallet = await createWalletFull({
      path: opts.walletPath,
      password: opts.walletPass,
      networkType: NET[this.config.network],
      server: this.config.daemonUrl,
      language: "English",
    });
    try {
      const seed = await wallet.getSeed();
      const address = await wallet.getAddress(0, 0);
      return { seed, address, restoreHeight: opts.restoreHeight };
    } finally {
      await wallet.close(true);
      rmSync(`${opts.walletPath}.address.txt`, { force: true });
    }
  }

  async openWallet(opts: OpenWalletOpts): Promise<WalletHandle> {
    const cfg = {
      path: opts.walletPath,
      password: opts.walletPass,
      networkType: NET[this.config.network],
      server: this.config.daemonUrl,
    };
    // Opening an existing file keeps its key images (fast re-sync); otherwise
    // this is a restore-from-seed at restoreHeight.
    const wallet = existsSync(opts.walletPath)
      ? await openWalletFull(cfg)
      : await createWalletFull({ ...cfg, seed: opts.seed, restoreHeight: opts.restoreHeight });
    rmSync(`${opts.walletPath}.address.txt`, { force: true });
    return new MoneroTsHandle(wallet, opts.walletPath, () => this.getDaemon());
  }

  async validateSeed(seed: string): Promise<void> {
    // offline keys-only wallet; throws "Invalid mnemonic" on bad seeds
    await MoneroWalletKeys.createWallet({ seed, networkType: NET[this.config.network] });
  }

  async deriveAddress(seed: string): Promise<string> {
    const keys = await MoneroWalletKeys.createWallet({ seed, networkType: NET[this.config.network] });
    return keys.getAddress(0, 0);
  }

  async daemonHeight(): Promise<number> {
    const daemon = await this.getDaemon();
    return daemon.getHeight();
  }

  async getBlockTimestamp(height: number): Promise<number> {
    const daemon = await this.getDaemon();
    const header = await daemon.getBlockHeaderByHeight(height);
    return header.getTimestamp();
  }
}
