// Balance-action plugin interface (public repo).
//
// The public repo ships this interface plus an EMPTY reference implementation
// (no-op plugin). Nothing here references any specific plugin behavior.

/** Context passed to a plugin when a wallet's balance changes. */
export interface BalanceActionContext {
  /** Wallet id (uuid) whose balance changed. */
  walletId: string;
  /** User id owning the wallet. */
  userId: string;
  /** Network the wallet runs on ("stagenet" in dev, "mainnet" in prod). */
  network: "stagenet" | "mainnet" | "testnet";
  /** Total balance, atomic units, decimal string (piconero). */
  totalBalance: string;
  /** Unlocked balance, atomic units, decimal string. */
  unlockedBalance: string;
  /** Previous total balance, atomic units, decimal string. */
  previousTotalBalance: string;
  /** Timestamp of the change detection (ms epoch). */
  detectedAt: number;
}

/**
 * Balance-action plugin: invoked by the wallet manager when a watched
 * wallet's balance changes. Implementations must never throw during
 * invocation (the manager treats throwing plugins as logged-and-ignored).
 * Implementations must not log wallet addresses, seeds, or mnemonics.
 */
export interface BalanceActionPlugin {
  /** Unique plugin id. */
  readonly id: string;
  /** Called on balance change. Errors are caught and logged (scrubbed). */
  onBalanceChange(context: BalanceActionContext): Promise<void> | void;
}
