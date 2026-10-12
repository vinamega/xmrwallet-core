// API smoke test: boots the real app (express + pg) with ENGINE=fake and runs
// the full vertical slice: anon register -> create wallet -> wait ready ->
// balances -> address -> send -> incoming. Uses the dev database
// (throwaway); no chain needed.

import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { FakeEngine } from "../src/wallets/engine-fake.js";
import { WalletManager } from "../src/wallets/manager.js";
import { loadPlugins } from "../src/plugins/loader.js";
import { PgQueueRepo, RestoreQueue, WatchLoop } from "../src/restore/queue.js";
import { buildApp } from "../src/api/app.js";
import type { Server } from "node:http";

process.env.ENGINE = process.env.ENGINE ?? "fake";
process.env.LOG_LEVEL = "info";
process.env.ACCESS_KEY = process.env.ACCESS_KEY ?? "smoke-gate-key";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createPool(config.databaseUrl);
  await migrate(db);
  const engine = new FakeEngine();
  const manager = new WalletManager(engine, config, await loadPlugins([]));
  const app = buildApp({ db, config, manager, engine });

  const repo = new PgQueueRepo(db);
  const queue = new RestoreQueue(repo, manager, {
    concurrency: config.restoreConcurrency,
    pollMs: 50,
    maxAttempts: config.restoreMaxAttempts,
  });
  const watch = new WatchLoop(repo, manager, { refreshMs: 500 });
  queue.start();
  watch.start();

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    // merge all Set-Cookie pairs into a simple jar (like a browser)
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) {
      const jar = new Map(
        cookie
          .split("; ")
          .filter(Boolean)
          .map((c) => [c.split("=")[0]!, c]),
      );
      for (const c of setCookies) {
        const pair = c.split(";")[0]!;
        jar.set(pair.split("=")[0]!, pair);
      }
      cookie = [...jar.values()].join("; ");
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  };

  const must = (label: string, cond: unknown): void => {
    if (!cond) throw new Error(`smoke failed at: ${label}`);
  };

  // site gate: no key -> 403 (API + static); ?key= -> pass + cookie
  let r = await call("POST", "/api/auth/anon");
  must("gate blocks api", r.status === 403);
  const page = await fetch(base + "/").then((res) => res.status);
  must("gate blocks static", page === 403);

  // anon session
  r = await call("POST", "/api/auth/anon?key=smoke-gate-key");
  must("gate opens with ?key=", r.status === 201);
  must("gate cookie set", cookie.includes("mwgate=smoke-gate-key"));
  r = await call("GET", "/api/me");
  must("cookie keeps gate open", r.status === 200 && (r.json as { isAnon?: boolean }).isAnon === true);

  // email register (second user, fresh cookie jar = new browser; needs the
  // gate key once, then its own gate cookie)
  const savedCookie = cookie;
  cookie = "mwgate=smoke-gate-key";
  const email = `smoke-${Date.now()}@example.test`;
  r = await call("POST", "/api/auth/register", { email, password: "password-123" });
  must("email register", r.status === 201);
  r = await call("POST", "/api/auth/login", { email, password: "password-123" });
  must("login", r.status === 200);
  r = await call("GET", "/api/me");
  must("me email", (r.json as { email?: string }).email === email);
  cookie = savedCookie; // back to anon user

  // new wallet
  r = await call("POST", "/api/wallets", { mode: "new", label: "smoke" });
  must("create wallet", r.status === 201 && typeof (r.json as { mnemonic?: string }).mnemonic === "string");
  const walletId = (r.json as { id: string }).id;

  // restore wallet (fake mnemonic passes 13+ word validation)
  const fakeMnemonic = Array.from({ length: 25 }, (_, i) => `seedword${i}`).join(" ");
  r = await call("POST", "/api/wallets", { mode: "restore", mnemonic: fakeMnemonic, restore_height: 100 });
  must("restore wallet", r.status === 201);
  const restoreId = (r.json as { id: string }).id;

  // wait for restore queue to bring them ready (fake engine = instant)
  let state = "queued";
  for (let i = 0; i < 50 && state !== "ready" && state !== "watching"; i++) {
    await new Promise((res) => setTimeout(res, 200));
    const g = await call("GET", `/api/wallets/${walletId}`);
    state = (g.json as { state: string }).state;
  }
  must("wallet ready", state === "ready" || state === "watching");

  let restoreState = "queued";
  for (let i = 0; i < 50 && restoreState !== "ready" && restoreState !== "watching"; i++) {
    await new Promise((res) => setTimeout(res, 200));
    const g = await call("GET", `/api/wallets/${restoreId}`);
    restoreState = (g.json as { state: string }).state;
  }
  must("restored wallet ready", restoreState === "ready" || restoreState === "watching");

  // re-import the same seed -> dedupe returns the existing wallet, no new row
  const before = (await call("GET", "/api/wallets")).json as { wallets: unknown[] };
  r = await call("POST", "/api/wallets", { mode: "restore", mnemonic: fakeMnemonic, restore_height: 100 });
  must("duplicate import deduped", r.status === 200 && (r.json as { existing?: boolean }).existing === true);
  const after = (await call("GET", "/api/wallets")).json as { wallets: unknown[] };
  must("no duplicate rows", before.wallets.length === after.wallets.length);

  r = await call("GET", `/api/wallets/${walletId}`);
  must("balances", (r.json as { balance_atomic: string }).balance_atomic === "1000000000000");
  must("address", String((r.json as { address: string }).address).startsWith("FAKEADDR"));

  // send
  // send (95-char fake address passes structural validation)
  const fakeAddr = "FAKEADDR" + "a".repeat(87);
  r = await call("POST", `/api/wallets/${walletId}/send`, { address: fakeAddr, amount_atomic: "1000" });
  must("send", r.status === 200 && String((r.json as { txid: string }).txid).startsWith("faketx-"));

  // bad send (invalid address)
  r = await call("POST", `/api/wallets/${walletId}/send`, { address: "notanaddress", amount_atomic: "1000" });
  must("bad send rejected", r.status === 400);

  // incoming
  r = await call("GET", `/api/wallets/${walletId}/incoming`);
  must("incoming", r.status === 200);

  // auth wall (session gone, gate cookie present)
  cookie = "mwgate=smoke-gate-key";
  r = await call("GET", "/api/wallets");
  must("auth wall", r.status === 401);

  // ownership wall
  cookie = savedCookie;
  const r2 = await call("GET", `/api/wallets/${crypto.randomUUID()}`);
  must("ownership wall (404)", r2.status === 404);

  server.close();
  queue.stop();
  watch.stop();
  await manager.closeAll();
  await db.end();
  console.log("SMOKE OK");
  process.exit(0);
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
