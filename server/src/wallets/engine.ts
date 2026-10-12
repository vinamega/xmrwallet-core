// Engine-agnostic wallet interface. The manager talks only to this; the
// engine (monero-ts headless today, monero-wallet-rpc-per-user fallback
// tomorrow) is a drop-in behind it (decision 0001).

export interface IncomingTransfer {
  txid: string;
  amountAtomic: bigint;
  height: number | null;
  /** Unix seconds. */
  timestamp: number | null;
  /** Subaddress index that received the transfer (0 = primary). */
  subaddressIndex: number | null;
}

export interface OutgoingTransfer {
  txid: string;
  amountAtomic: bigint;
  feeAtomic: bigint;
  height: number | null;
  /** Unix seconds. */
  timestamp: number | null;
}

export interface SubaddressInfo {
  index: number;
  address: string;
  label: string | null;
  used: boolean;
}

export interface Balances {
  total: bigint;
  unlocked: bigint;
}

export type SyncProgressFn = (height: number, targetHeight: number) => void;

export interface WalletHandle {
  syncOnce(onProgress?: SyncProgressFn): Promise<void>;
  getPrimaryAddress(): Promise<string>;
  getBalances(): Promise<Balances>;
  getIncoming(limit: number): Promise<IncomingTransfer[]>;
  getOutgoing(limit: number): Promise<OutgoingTransfer[]>;
  getSubaddresses(): Promise<SubaddressInfo[]>;
  createSubaddress(label: string | null): Promise<SubaddressInfo>;
  sendToAddress(address: string, amountAtomic: bigint): Promise<{ txid: string }>;
  /** Spend the full unlocked balance to one address (fee deducted from amount). */
  sweepToAddress(address: string): Promise<{ txid: string }>;
  save(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenWalletOpts {
  seed: string;
  walletPath: string;
  walletPass: string;
  restoreHeight: number;
}

export interface CreateRandomResult {
  seed: string;
  address: string;
  restoreHeight: number;
}

export interface WalletEngine {
  readonly name: string;
  /** Create a brand-new random wallet file; seed returned once. */
  createRandomWallet(opts: { walletPath: string; walletPass: string; restoreHeight: number }): Promise<CreateRandomResult>;
  /** Open existing wallet file at walletPath, or create it from seed (restore). */
  openWallet(opts: OpenWalletOpts): Promise<WalletHandle>;
  /** Validate a seed phrase; throws when invalid. */
  validateSeed(seed: string): Promise<void>;
  /** Derive the primary address for a seed offline; throws when invalid. */
  deriveAddress(seed: string): Promise<string>;
  daemonHeight(): Promise<number>;
  /** Unix seconds of the block at height. */
  getBlockTimestamp(height: number): Promise<number>;
}
