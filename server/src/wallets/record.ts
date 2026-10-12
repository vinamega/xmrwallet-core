// Wallet record shape shared by manager/queue/API layers.

export type WalletState = "queued" | "restoring" | "ready" | "watching" | "error";

export interface WalletRecord {
  id: string;
  userId: string;
  label: string | null;
  address: string;
  encryptedSeed: Buffer;
  wrappedDataKey: Buffer;
  encryptedWalletPass: Buffer;
  restoreHeight: number;
  creationHeight?: number | null;
  syncHeight?: number | null;
  syncTarget?: number | null;
  state: WalletState;
  attempts: number;
  error: string | null;
  createdAt: Date;
}

export function walletPathFor(walletDir: string, walletId: string): string {
  // walletId is a uuid; no traversal risk after uuid validation.
  return `${walletDir.replace(/\/$/, "")}/${walletId}`;
}
