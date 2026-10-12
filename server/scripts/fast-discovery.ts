// CLI validation: run fast discovery on a seed and (optionally) verify a
// known tx hash is detected as owned. Usage:
//   tsx scripts/fast-discovery.ts <seed> [--verify-tx <hash>] [--workers N]

import { discoverFirstUseHeight, deriveKeyset } from "../src/wallets/fast-restore.js";
import { connectToDaemonRpc } from "monero-ts";

const seed = process.argv[2] ?? "";
if (seed.split(/\s+/).length < 13) {
  console.error("usage: fast-discovery.ts <25-word seed> [--verify-tx <hash>]");
  process.exit(1);
}
const verifyIdx = process.argv.indexOf("--verify-tx");
const verifyTx = verifyIdx > 0 ? process.argv[verifyIdx + 1] : null;
const workersIdx = process.argv.indexOf("--workers");
const workers = workersIdx > 0 ? Number(process.argv[workersIdx + 1]) : undefined;

const daemonUrl = "http://127.0.0.1:38081";
const daemon = await connectToDaemonRpc(daemonUrl);
const tip = await daemon.getHeight();
console.log(`tip: ${tip}, workers: ${workers ?? "auto"}`);

// optional: verify ownership math against a known tx before the big scan
if (verifyTx) {
  const keyset = await deriveKeyset(seed, 2);
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const Point = ed25519.Point;
  const a = BigInt("0x" + Buffer.from(keyset.viewScalarHex, "hex").reverse().toString("hex"));
  const B = Point.fromHex(keyset.spendPubHex);
  const txes = await daemon.getTxs([verifyTx]);
  const tx = txes.find((t) => t.getHash() === verifyTx) ?? txes[0];
  const extra = tx!.getExtra() ?? new Uint8Array();
  // reuse worker parser inline
  const keys = [];
  let i = 0;
  while (i < extra.length) {
    if (extra[i] === 0x01 && i + 33 <= extra.length) {
      keys.push(Buffer.from(extra.slice(i + 1, i + 33)).toString("hex"));
      i += 33;
    } else if (extra[i] === 0x02) {
      let n = 0,
        j = i + 1,
        shift = 0;
      while ((extra[j] ?? 0) & 0x80) {
        n |= ((extra[j] ?? 0) & 0x7f) << shift;
        shift += 7;
        j++;
      }
      n |= (extra[j] ?? 0) << shift;
      j++;
      for (let k = 0; k < n && j + 32 <= extra.length; k++) {
        keys.push(Buffer.from(extra.slice(j, j + 32)).toString("hex"));
        j += 32;
      }
      i = j;
    } else if (extra[i] === 0x03) {
      let len = 0,
        j = i + 1,
        shift = 0;
      while ((extra[j] ?? 0) & 0x80) {
        len |= ((extra[j] ?? 0) & 0x7f) << shift;
        shift += 7;
        j++;
      }
      len |= (extra[j] ?? 0) << shift;
      i = j + 1 + len;
    } else if (extra[i] === 0x04) i += 33;
    else i += 1;
  }
  const outputs = tx!.getOutputs() ?? [];
  let owned = 0;
  for (let idx = 0; idx < outputs.length; idx++) {
    const stealth = outputs[idx]?.getStealthPublicKey();
    for (const r of keys) {
      const D = Point.fromHex(r).multiply(a).multiply(8n);
      const vi = idx < 128 ? Uint8Array.of(idx) : Uint8Array.of((idx & 0x7f) | 0x80, idx >> 7);
      const h = keccak_256(new Uint8Array([...D.toBytes(), ...vi]));
      const hG = Point.BASE.multiply(
        BigInt("0x" + Buffer.from(h).reverse().toString("hex")) % ed25519.Point.Fn.ORDER,
      );
      if (stealth && Point.fromHex(stealth).subtract(hG).equals(B)) owned++;
    }
  }
  console.log(`verify-tx: ${owned > 0 ? "OWNED output found ✓" : "not owned ✗"} (${keys.length} tx pubkeys, ${outputs.length} outputs)`);
}

const t0 = Date.now();
const result = await discoverFirstUseHeight({
  daemonUrl,
  seed,
  networkType: 2,
  fromHeight: 0,
  toHeight: tip,
  workerCount: workers,
  onProgress: (s, t) => {
    if (s % 200000 === 0) console.log(`  scanned ${s}/${t}`);
  },
});
console.log(
  `discovery: first use at height ${result.height} (or null: ${result.height === null}), scanned ${result.scannedBlocks} blocks in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
console.log(`DONE height=${result.height ?? "none"} seconds=${((Date.now() - t0) / 1000).toFixed(0)}`);
process.exit(0);
