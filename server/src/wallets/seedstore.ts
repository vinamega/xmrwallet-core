// Encrypted seed store: per-wallet data key wrapped by the master key,
// seed and wallet-file password sealed under the per-wallet data key.
// Layout of every blob: AES-256-GCM iv|tag|ciphertext (see aead.ts).

import { randomBytes } from "node:crypto";
import { open, randomKey, seal } from "../aead.js";

export interface WalletMaterialInput {
  seed: string;
  walletPass: string;
}

export interface EncryptedWalletMaterial {
  encryptedSeed: Buffer;
  wrappedDataKey: Buffer;
  encryptedWalletPass: Buffer;
}

export interface DecryptedWalletMaterial {
  seed: string;
  walletPass: string;
}

function aad(walletId: string, field: string): string {
  return `wallet:${walletId}:${field}`;
}

export function newWalletPass(): string {
  return randomBytes(24).toString("base64url");
}

export function encryptWalletMaterial(
  masterKey: Buffer,
  walletId: string,
  material: WalletMaterialInput,
): EncryptedWalletMaterial {
  const dataKey = randomKey();
  return {
    wrappedDataKey: seal(masterKey, dataKey, aad(walletId, "dataKey")),
    encryptedSeed: seal(dataKey, Buffer.from(material.seed, "utf8"), aad(walletId, "seed")),
    encryptedWalletPass: seal(
      dataKey,
      Buffer.from(material.walletPass, "utf8"),
      aad(walletId, "walletPass"),
    ),
  };
}

export function decryptWalletMaterial(
  masterKey: Buffer,
  walletId: string,
  material: EncryptedWalletMaterial,
): DecryptedWalletMaterial {
  const dataKey = open(masterKey, material.wrappedDataKey, aad(walletId, "dataKey"));
  return {
    seed: open(dataKey, material.encryptedSeed, aad(walletId, "seed")).toString("utf8"),
    walletPass: open(dataKey, material.encryptedWalletPass, aad(walletId, "walletPass")).toString("utf8"),
  };
}
