// Stagenet integration slice (Phase 3 acceptance): register → restore →
// receive faucet → spend, all through the real API with the real monero-ts
// engine + stagenet node. Env-gated:
//
//   INTEGRATION_STAGENET=1      run this suite (otherwise skipped)
//   RESTORE_FROM_ZERO=1        restore wallet A from height 0 (guide's
//                              worst case; hours on a full stagenet chain).
//                              Default: restore at daemon tip (quick wiring)
//   WAIT_FOR_SYNC=1            wait (up to SYNC_TIMEOUT_MIN) for daemon tip
//   FAUCET_API=https://...     faucet claim endpoint (default cypherfaucet)
//
// Never logs seeds/mnemonics/addresses: only wallet ids, states, txids.

import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createPool, migrate } from "../../src/db.js";
import { MoneroTsEngine } from "../../src/wallets/engine-monetots.js";
import { WalletManager } from "../../src/wallets/manager.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import type { BalanceActionPlugin } from "../../../plugins/src/index.js";
import { PgQueueRepo, RestoreQueue, WatchLoop } from "../../src/restore/queue.js";
import { buildApp } from "../../src/api/app.js";
import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const RUN = process.env.INTEGRATION_STAGENET === "1";
const FROM_ZERO = process.env.RESTORE_FROM_ZERO === "1";
const WAIT_SYNC = process.env.WAIT_FOR_SYNC === "1";
const SYNC_TIMEOUT_MIN = Number(process.env.SYNC_TIMEOUT_MIN ?? 720);
const FAUCET_API = process.env.FAUCET_API ?? "https://cypherfaucet.com/api/v1/claim";

describe.skipIf(!RUN)("stagenet slice", () => {
  let base: string;
  let cookie: string;
  let cleanup: () => Promise<void>;

  it(
    "register → restore → receive faucet → spend",
    async () => {
      // fast loops for the test run
      process.env.WATCH_REFRESH_MS = "3000";
      process.env.RESTORE_POLL_MS = "500";
      const config = loadConfig();

      const db = await createPool(config.databaseUrl);
      await migrate(db);
      const engine = new MoneroTsEngine(config);
      // Phase 4 public scope: the reference no-op plugin must pass the same
      // integration tests. A recording plugin additionally proves the
      // balance-action wiring end to end (invoked on the faucet receive).
      const recorded: { walletId: string; total: string }[] = [];
      const recorder: BalanceActionPlugin = {
        id: "test-recorder",
        onBalanceChange: (ctx) => {
          recorded.push({ walletId: ctx.walletId, total: ctx.totalBalance });
        },
      };
      const manager = new WalletManager(engine, config, [
        ...(await loadPlugins([])), // includes the reference no-op
        recorder,
      ]);
      const app = buildApp({ db, config, manager, engine });
      const repo = new PgQueueRepo(db);
      const queue = new RestoreQueue(repo, manager, {
        concurrency: config.restoreConcurrency,
        pollMs: 500,
        maxAttempts: 1, // fail fast on integration errors
      });
      const watch = new WatchLoop(repo, manager, { refreshMs: 3000 });
      queue.start();
      watch.start();

      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      cleanup = async () => {
        queue.stop();
        watch.stop();
        server.close();
        await manager.closeAll();
        await db.end();
      };

      const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(base + path, {
          method,
          headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        const setCookie = res.headers.get("set-cookie");
        if (setCookie) cookie = setCookie.split(";")[0]!;
        return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
      };

      // optional: wait for daemon tip
      if (WAIT_SYNC) {
        const deadline = Date.now() + SYNC_TIMEOUT_MIN * 60 * 1000;
        for (;;) {
          const info = (await (await fetch("http://127.0.0.1:38081/get_info")).json()) as {
            synchronized: boolean;
          };
          if (info.synchronized === true) break;
          if (Date.now() > deadline) throw new Error("daemon did not reach tip in time");
          await sleep(60_000);
        }
      }

      // 1. register (anon)
      let r = await call("POST", "/api/auth/anon");
      expect(r.status).toBe(201);

      // 2. wallet A (new seed); restore from 0 when RESTORE_FROM_ZERO=1
      const daemonHeight = await engine.daemonHeight();
      const restoreHeight = FROM_ZERO ? 0 : Math.max(0, daemonHeight - 5);
      r = await call("POST", "/api/wallets", {
        mode: "new",
        restore_height: restoreHeight,
        label: "integration-a",
      });
      expect(r.status).toBe(201);
      const walletA = r.json.id as string;

      // 3. wait for ready/watching (restore-from-0 = hours; tip = minutes)
      const deadlineH = FROM_ZERO ? 6 * 3600_000 : 20 * 60_000;
      const getState = async (): Promise<string> =>
        ((await call("GET", `/api/wallets/${walletA}`)).json as { state: string; error?: string }).state;
      let stateA = await getState();
      const t0 = Date.now();
      while (stateA !== "ready" && stateA !== "watching") {
        if (stateA === "error") throw new Error("wallet A error");
        if (Date.now() - t0 > deadlineH) throw new Error(`wallet A stuck in ${stateA}`);
        await sleep(5000);
        stateA = await getState();
      }
      console.log(`[integration] wallet A ${stateA} after ${Math.round((Date.now() - t0) / 1000)}s (from ${restoreHeight})`);

      const detailA = (await call("GET", `/api/wallets/${walletA}`)).json as {
        address: string;
        balance_atomic: string | null;
      };
      const addrA = detailA.address;
      expect(addrA).toMatch(/^5[1-9A-HJ-NP-Za-km-z]{94}$/);

      // 4. fund wallet A from the stagenet faucet
      const claim = (await (
        await fetch(FAUCET_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ network: "xmr-stagenet", address: addrA }),
        })
      ).json()) as { ok?: boolean; txid?: string; amount?: string };
      expect(claim.ok, `faucet claim failed: ${JSON.stringify(claim)}`).toBe(true);
      const faucetTxid = claim.txid as string;
      console.log(`[integration] faucet sent ${claim.amount} sXMR, txid ${faucetTxid.slice(0, 12)}…`);

      // 5. wait for funds to appear + unlock
      const getUnlockedA = async (): Promise<bigint> =>
        BigInt(
          ((await call("GET", `/api/wallets/${walletA}`)).json as { unlocked_atomic: string | null })
            .unlocked_atomic ?? "0",
        );
      let unlockedA = await getUnlockedA();
      const deadlineF = Date.now() + 30 * 60_000;
      while (unlockedA === 0n && Date.now() < deadlineF) {
        await sleep(15_000);
        unlockedA = await getUnlockedA();
      }
      if (unlockedA === 0n) throw new Error("faucet funds never unlocked");
      expect(unlockedA > 0n).toBe(true);

      // plugin wiring: the balance-action interface fired on the faucet
      // receive (recorder), and the reference no-op plugin ran alongside
      // without error (its invocation is implicit in the manager loop).
      expect(recorded.some((e) => e.walletId === walletA && BigInt(e.total) > 0n)).toBe(true);

      // 6. wallet B (new, at tip)
      r = await call("POST", "/api/wallets", { mode: "new", label: "integration-b" });
      expect(r.status).toBe(201);
      const walletB = r.json.id as string;
      const deadlineB = Date.now() + 20 * 60_000;
      for (;;) {
        const g = (await call("GET", `/api/wallets/${walletB}`)).json as { state: string };
        if (g.state === "ready" || g.state === "watching") break;
        if (g.state === "error") throw new Error("wallet B error");
        if (Date.now() > deadlineB) throw new Error("wallet B stuck");
        await sleep(5000);
      }
      const addrB = ((await call("GET", `/api/wallets/${walletB}`)).json as { address: string }).address;
      expect(addrB).toMatch(/^5[1-9A-HJ-NP-Za-km-z]{94}$/);

      // 7. spend: A -> B
      const sendAmount = 1000000000n; // 0.000001 XMR
      r = await call("POST", `/api/wallets/${walletA}/send`, {
        address: addrB,
        amount_atomic: sendAmount.toString(),
      });
      expect(r.status, `send failed: ${JSON.stringify(r.json)}`).toBe(200);
      const spendTxid = (r.json as { txid: string }).txid;
      console.log(`[integration] spend txid ${spendTxid.slice(0, 12)}…`);

      // 8. B sees the incoming
      const deadlineI = Date.now() + 30 * 60_000;
      for (;;) {
        const g = (await call("GET", `/api/wallets/${walletB}/incoming`)).json as {
          incoming: { txid: string; amount_atomic: string }[];
        };
        if (g.incoming.some((t) => t.txid === spendTxid)) break;
        if (Date.now() > deadlineI) throw new Error("spend never arrived at wallet B");
        await sleep(15_000);
      }

      const detailB = (await call("GET", `/api/wallets/${walletB}`)).json as { balance_atomic: string | null };
      expect(BigInt(detailB.balance_atomic ?? "0")).toBe(sendAmount);

      console.log("[integration] SLICE OK: register → restore → receive faucet → spend → receive");
      await cleanup();
    },
    (FROM_ZERO ? 8 : 2) * 3600_000,
  );
});
