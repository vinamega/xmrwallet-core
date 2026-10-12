import { describe, expect, it } from "vitest";
import { decryptWalletMaterial, encryptWalletMaterial } from "../../src/wallets/seedstore.js";
import { randomKey } from "../../src/aead.js";

describe("seedstore", () => {
  it("roundtrips seed + wallet pass under wrapped data key", () => {
    const masterKey = randomKey();
    const walletId = "11111111-2222-3333-4444-555555555555";
    const material = { seed: "test test test ...".repeat(3), walletPass: "wallet-pass-123" };
    const enc = encryptWalletMaterial(masterKey, walletId, material);
    const dec = decryptWalletMaterial(masterKey, walletId, enc);
    expect(dec.seed).toBe(material.seed);
    expect(dec.walletPass).toBe(material.walletPass);
  });

  it("wrong master key fails", () => {
    const masterKey = randomKey();
    const walletId = "11111111-2222-3333-4444-555555555555";
    const enc = encryptWalletMaterial(masterKey, walletId, { seed: "s", walletPass: "p" });
    expect(() => decryptWalletMaterial(randomKey(), walletId, enc)).toThrow();
  });

  it("wrong wallet id (aad binding) fails", () => {
    const masterKey = randomKey();
    const enc = encryptWalletMaterial(masterKey, "11111111-2222-3333-4444-555555555555", {
      seed: "s",
      walletPass: "p",
    });
    expect(() => decryptWalletMaterial(masterKey, "99999999-2222-3333-4444-555555555555", enc)).toThrow();
  });
});
