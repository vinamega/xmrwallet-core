// Unit test for the fast-restore ownership math (mirrors the worker):
// P = H(8*(a*R) || varint(i))G + B must match a synthetic owned output,
// and must NOT match other indices or wrong keys.

import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const N = ed25519.Point.Fn.ORDER;

function le(hex: string): bigint {
  return BigInt("0x" + Buffer.from(hex, "hex").reverse().toString("hex")) % N;
}
function scalarToHexLE(n: bigint): string {
  return BigInt(n % N)
    .toString(16)
    .padStart(64, "0")
    .match(/../g)!
    .reverse()
    .join("");
}
function varint(n: number): Uint8Array {
  const out = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Uint8Array.from(out);
}

function isOwned(a: bigint, B: ReturnType<typeof ed25519.Point.fromHex>, rHex: string, index: number, stealthHex: string): boolean {
  const R = ed25519.Point.fromHex(rHex);
  const D = R.multiply(a).multiply(8n);
  const h = keccak_256(new Uint8Array([...D.toBytes(), ...varint(index)]));
  const hG = ed25519.Point.BASE.multiply(le(Buffer.from(h).toString("hex")));
  return ed25519.Point.fromHex(stealthHex).subtract(hG).equals(B);
}

describe("fast-restore ownership math", () => {
  it("detects a synthetic owned output", () => {
    const a = le(scalarToHexLE(12345678901234567890n));
    const b = le(scalarToHexLE(9876543210987654321n));
    const r = le(scalarToHexLE(5555555555555555555n));
    const B = ed25519.Point.BASE.multiply(b);
    const R = ed25519.Point.BASE.multiply(r);
    const index = 3;

    // sender: P = H(8*(a*R) || varint(index))G + B
    const D = R.multiply(a).multiply(8n);
    const h = keccak_256(new Uint8Array([...D.toBytes(), ...varint(index)]));
    const P = ed25519.Point.BASE.multiply(le(Buffer.from(h).toString("hex"))).add(B).toHex();

    expect(isOwned(a, B, R.toHex(), index, P)).toBe(true);
    // wrong index -> not owned
    expect(isOwned(a, B, R.toHex(), index + 1, P)).toBe(false);
    // wrong tx pubkey -> not owned
    expect(isOwned(a, B, ed25519.Point.BASE.multiply(2n).toHex(), index, P)).toBe(false);
    // wrong spend key -> not owned
    const B2 = ed25519.Point.BASE.multiply(b + 1n);
    expect(isOwned(a, B2, R.toHex(), index, P)).toBe(false);
  });
});
