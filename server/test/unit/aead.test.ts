import { describe, expect, it } from "vitest";
import { seal, open, randomKey } from "../../src/aead.js";

describe("aead (AES-256-GCM)", () => {
  it("roundtrips", () => {
    const key = randomKey();
    const msg = Buffer.from("25 words of seed material here x", "utf8");
    const blob = seal(key, msg, "wallet:abc:seed");
    expect(open(key, blob, "wallet:abc:seed").toString("utf8")).toBe(msg.toString("utf8"));
  });

  it("rejects wrong key", () => {
    const key = randomKey();
    const blob = seal(key, Buffer.from("secret"), "aad");
    expect(() => open(randomKey(), blob, "aad")).toThrow();
  });

  it("rejects wrong aad", () => {
    const key = randomKey();
    const blob = seal(key, Buffer.from("secret"), "wallet:1:seed");
    expect(() => open(key, blob, "wallet:2:seed")).toThrow();
  });

  it("rejects tampering", () => {
    const key = randomKey();
    const blob = seal(key, Buffer.from("secret"), "aad");
    const last = blob.length - 1;
    blob[last] = (blob[last] ?? 0) ^ 0xff;
    expect(() => open(key, blob, "aad")).toThrow();
  });
});
