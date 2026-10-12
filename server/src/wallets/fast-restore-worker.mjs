// fast-restore-worker.mjs — worker thread: scan a height range for outputs
// owned by a wallet (view key + primary spend key). Plain ESM, raw daemon RPC
// (no monero-ts in the worker: it was the bottleneck + failure source).

import { parentPort, workerData } from "node:worker_threads";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import axios from "axios";

const { daemonUrl, from, to, viewScalarHex, spendPubHex } = workerData;

const http = axios.create({ baseURL: daemonUrl, timeout: 60000 });

const Point = ed25519.Point;
const N = ed25519.Point.Fn.ORDER;
const a = hexToBigIntLE(viewScalarHex) % N;
const B = Point.fromHex(spendPubHex);

function hexToBigIntLE(hex) {
  const bytes = hexToBytes(hex);
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function varint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Uint8Array.from(out);
}
function txPubkeys(extra) {
  const keys = [];
  let i = 0;
  while (i < extra.length) {
    const tag = extra[i];
    if (tag === 0x01 && i + 33 <= extra.length) {
      keys.push(Buffer.from(extra.slice(i + 1, i + 33)).toString("hex"));
      i += 33;
    } else if (tag === 0x02) {
      let n = 0;
      let j = i + 1;
      let shift = 0;
      while (j < extra.length && (extra[j] ?? 0) & 0x80) {
        n |= ((extra[j] ?? 0) & 0x7f) << shift;
        shift += 7;
        j++;
      }
      if (j < extra.length) {
        n |= (extra[j] ?? 0) << shift;
        j++;
      }
      for (let k = 0; k < n && j + 32 <= extra.length; k++) {
        keys.push(Buffer.from(extra.slice(j, j + 32)).toString("hex"));
        j += 32;
      }
      i = j;
    } else if (tag === 0x03) {
      let len = 0;
      let j = i + 1;
      let shift = 0;
      while (j < extra.length && (extra[j] ?? 0) & 0x80) {
        len |= ((extra[j] ?? 0) & 0x7f) << shift;
        shift += 7;
        j++;
      }
      if (j < extra.length) {
        len |= (extra[j] ?? 0) << shift;
        j++;
      }
      i = j + len;
    } else if (tag === 0x04) {
      i += 33;
    } else {
      i += 1;
    }
  }
  return keys;
}

// does output (stealthKey, index) belong to us, given tx pubkey R?
// derivation is cofactor-cleared: D = 8*(a*R)
function isOwned(rHex, index, stealthHex) {
  const R = Point.fromHex(rHex);
  const D = R.multiply(a).multiply(8n);
  const h = keccak_256(new Uint8Array([...D.toBytes(), ...varint(index)]));
  const hG = Point.BASE.multiply(hexToBigIntLE(Buffer.from(h).toString("hex")) % N);
  const Q = Point.fromHex(stealthHex).subtract(hG);
  return Q.equals(B);
}

let rpcId = 0;
async function rpc(method, params) {
  const j = await http.post("/json_rpc", { jsonrpc: "2.0", id: rpcId++, method, params });
  if (j.data.error) throw new Error(`rpc ${method}: ${j.data.error.message}`);
  return j.data.result;
}
// small concurrency pool for per-height getblock calls
async function pool(items, worker, concurrency) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return out;
}
async function withRetry(fn, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

async function checkTxJson(tx, height, found) {
  const extra = Uint8Array.from(tx.extra ?? []);
  const pubkeys = txPubkeys(extra);
  if (pubkeys.length === 0) return;
  const vouts = tx.vout ?? [];
  for (let i = 0; i < vouts.length; i++) {
    const stealth = vouts[i]?.target?.tagged_key?.key ?? vouts[i]?.target?.key;
    if (!stealth) continue;
    for (const r of pubkeys) {
      try {
        if (isOwned(r, i, stealth)) {
          if (found.height === null || height < found.height) found.height = height;
          return;
        }
      } catch {
        // non-canonical point: skip
      }
    }
  }
}

let scanned = 0;
let earliest = null;
const totalBlocks = to - from + 1;

try {
  // phase 1: headers (one ranged call per chunk) -> heights containing txs
  const heightsWithTxs = [];
  const HEADER_CHUNK = 2000;
  for (let h = from; h <= to; h += HEADER_CHUNK) {
    const end = Math.min(h + HEADER_CHUNK - 1, to);
    try {
      const r = await withRetry(() => rpc("getblockheadersrange", { start_height: h, end_height: end }));
      for (const hd of r.headers ?? []) {
        if (hd.num_txes > 0) heightsWithTxs.push(hd.height);
      }
    } catch (e) {
      console.error(`fast-restore headers ${h}: ${String(e).slice(0, 120)}`);
    }
  }
  const emptyBlocks = totalBlocks - heightsWithTxs.length;

  // phase 2: per block (batched json_rpc) -> tx hashes + miner tx
  const found = { height: null };
  const BATCH = 25;
  for (let idx = 0; idx < heightsWithTxs.length; idx += BATCH) {
    const heights = heightsWithTxs.slice(idx, idx + BATCH);
    try {
      const blocks = await withRetry(() =>
        pool(heights, (h) => rpc("getblock", { height: h }), 4),
      );
      const txHashes = [];
      for (let bi = 0; bi < heights.length; bi++) {
        const h = heights[bi];
        const b = blocks[bi];
        const bj = b ? JSON.parse(b.json ?? "{}") : {};
        // miner tx (coinbase) is in the parsed block json
        const minerTx = bj.miner_tx;
        if (minerTx) await checkTxJson(minerTx, h, found);
        for (const txh of b?.tx_hashes ?? []) {
          txHashes.push({ hash: txh, height: h });
        }
      }
      // fetch tx bodies in chunks
      for (let c = 0; c < txHashes.length; c += 100) {
        const chunk = txHashes.slice(c, c + 200);
        try {
          const j = await http.post("/get_transactions", {
            txs_hashes: chunk.map((t) => t.hash),
            decode_as_json: true,
          });
          for (const t of j.data.txs ?? []) {
            const meta = chunk.find((x) => x.hash === t.tx_hash);
            if (!meta || !t.as_json) continue;
            await checkTxJson(JSON.parse(t.as_json), meta.height, found);
          }
        } catch (e) {
          console.error(`fast-restore txs: ${String(e).slice(0, 120)}`);
        }
      }
    } catch (e) {
      console.error(`fast-restore batch: ${String(e).slice(0, 120)}`);
    }
    if (found.height !== null && (earliest === null || found.height < earliest)) {
      earliest = found.height;
    }
    scanned = totalBlocks - emptyBlocks - Math.max(0, heightsWithTxs.length - (idx + BATCH));
    parentPort.postMessage({ type: "progress", scanned, earliest });
  }
} catch (e) {
  console.error(`fast-restore worker: ${String(e).slice(0, 200)}`);
}

parentPort.postMessage({ type: "done", scanned, earliest });
