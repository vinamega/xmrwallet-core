// HTTP app: API routes + strict-CSP static frontend.
// Log scrubbing: request bodies are never logged (mnemonics/addresses pass
// through here). Errors are scrubbed before logging/response.

import express, { type Request, type Response, type NextFunction } from "express";
import type { Pool } from "pg";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { Config } from "../config.js";
import { log, scrub } from "../logging.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import {
  COOKIE_NAME,
  clearSessionCookie,
  createSession,
  destroySession,
  parseCookies,
  resolveSession,
  sessionCookie,
} from "../auth/sessions.js";
import { RateLimiter } from "../auth/ratelimit.js";
import { WalletManager } from "../wallets/manager.js";
import type { WalletEngine } from "../wallets/engine.js";
import { encryptWalletMaterial, newWalletPass } from "../wallets/seedstore.js";
import { walletPathFor, type WalletRecord } from "../wallets/record.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { UUID_RE, AMOUNT_RE, ADDRESS_RE } from "./validate.js";

// web/ lives at the repo root; its depth relative to this file differs
// between tsx dev (src/api -> repo) and dist (dist/server/src/api -> repo),
// so walk up until we find web/index.html.
function findWebRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "web/index.html"))) return resolve(dir, "web");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../web");
}

const webRoot = findWebRoot();

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface AppDeps {
  db: Pool;
  config: Config;
  manager: WalletManager;
  engine: WalletEngine;
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function buildApp(deps: AppDeps): express.Express {
  const { db, config, manager, engine } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  const registerLimiter = new RateLimiter(config.registerRatePerHour);
  const loginLimiter = new RateLimiter(config.registerRatePerHour * 4); // brute-force cap
  const walletCreateLimiter = new RateLimiter(config.walletCreateRatePerHour);

  // security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    next();
  });

  // site gate (dev): ?key=<ACCESS_KEY> on first hit sets a cookie; afterwards
  // the cookie gates API + static. Bots without the key get 403.
  if (config.accessKey) {
    const gateCookieName = "mwgate";
    app.use((req, res, next) => {
      const q = req.query.key;
      const urlKey = typeof q === "string" ? q : undefined;
      if (urlKey !== undefined && safeEq(urlKey, config.accessKey!)) {
        res.append(
          "Set-Cookie",
          `${gateCookieName}=${config.accessKey}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`,
        );
        next();
        return;
      }
      const cookies = parseCookies(req.headers.cookie);
      if (safeEq(cookies[gateCookieName] ?? "", config.accessKey!)) {
        next();
        return;
      }
      if (req.path.startsWith("/api/")) {
        res.status(403).json({ error: "forbidden" });
      } else {
        res.status(403).type("text/html").send("<!doctype html><p>403 — append ?key=…</p>");
      }
    });
  }

  // attach session user
  app.use((req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    void resolveSession(db, token).then((user) => {
      (req as AuthedRequest).user = user;
      (req as AuthedRequest).sessionToken = token;
      next();
    }).catch(next);
  });

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const u = (req as AuthedRequest).user;
    if (!u) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    next();
  }

  // ---------- auth ----------
  app.post(
    "/api/auth/anon",
    asyncHandler(async (req, res) => {
      const ip = req.ip ?? "unknown";
      if (!registerLimiter.allow(`anon:${ip}`)) {
        res.status(429).json({ error: "rate limited, try later" });
        return;
      }
      const r = await db.query<{ id: string }>(
        "INSERT INTO users (is_anon) VALUES (true) RETURNING id",
      );
      const token = await createSession(db, r.rows[0]!.id, config.sessionTtlDays);
      res.append("Set-Cookie", sessionCookie(token, config.cookieSecure));
      res.status(201).json({ ok: true });
    }),
  );

  app.post(
    "/api/auth/register",
    asyncHandler(async (req, res) => {
      const ip = req.ip ?? "unknown";
      if (!registerLimiter.allow(`reg:${ip}`)) {
        res.status(429).json({ error: "rate limited, try later" });
        return;
      }
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const password = String(req.body?.password ?? "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 8) {
        res.status(400).json({ error: "valid email and 8+ char password required" });
        return;
      }
      const exists = await db.query("SELECT 1 FROM users WHERE email=$1", [email]);
      if (exists.rowCount && exists.rowCount > 0) {
        res.status(409).json({ error: "email already registered" });
        return;
      }
      const r = await db.query<{ id: string }>(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, hashPassword(password)],
      );
      const token = await createSession(db, r.rows[0]!.id, config.sessionTtlDays);
      res.append("Set-Cookie", sessionCookie(token, config.cookieSecure));
      res.status(201).json({ ok: true });
    }),
  );

  app.post(
    "/api/auth/login",
    asyncHandler(async (req, res) => {
      const ip = req.ip ?? "unknown";
      if (!loginLimiter.allow(`login:${ip}`)) {
        res.status(429).json({ error: "rate limited, try later" });
        return;
      }
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const password = String(req.body?.password ?? "");
      const r = await db.query<{ id: string; password_hash: string }>(
        "SELECT id, password_hash FROM users WHERE email=$1",
        [email],
      );
      const row = r.rows[0];
      if (!row || !row.password_hash || !verifyPassword(password, row.password_hash)) {
        res.status(401).json({ error: "invalid credentials" });
        return;
      }
      const token = await createSession(db, row.id, config.sessionTtlDays);
      res.append("Set-Cookie", sessionCookie(token, config.cookieSecure));
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/auth/logout",
    asyncHandler(async (req, res) => {
      await destroySession(db, (req as AuthedRequest).sessionToken);
      res.append("Set-Cookie", clearSessionCookie(config.cookieSecure));
      res.json({ ok: true });
    }),
  );

  const priceCache: { usd: number | null; at: number } = { usd: null, at: 0 };
  app.get("/api/price", async (_req, res) => {
    if (priceCache.usd !== null && Date.now() - priceCache.at < 60_000) {
      res.json({ usd: priceCache.usd });
      return;
    }
    let usd: number | null;
    try {
      const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=XMRUSD", {
        signal: AbortSignal.timeout(5000),
      });
      const j = (await r.json()) as {
        result?: Record<string, { c?: string[] }>;
      };
      const pair = j.result?.XXMRZUSD ?? j.result?.XMRUSD;
      usd = pair?.c?.[0] ? Number(pair.c[0]) : null;
    } catch {
      usd = null;
    }
    if (usd !== null && Number.isFinite(usd)) {
      priceCache.usd = usd;
      priceCache.at = Date.now();
    }
    res.json({ usd: priceCache.usd });
  });

  app.get("/api/config", (req, res) => {
    res.json({ network: config.network });
  });

  app.get("/api/me", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user!;
    res.json({ id: u.id, email: u.email, isAnon: u.isAnon });
  });

  // ---------- wallets ----------
  app.post(
    "/api/wallets",
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = (req as AuthedRequest).user!;
      if (!walletCreateLimiter.allow(`wc:${user.id}`)) {
        res.status(429).json({ error: "rate limited, try later" });
        return;
      }
      const mode = req.body?.mode === "restore" ? "restore" : "new";
      const label = req.body?.label ? String(req.body.label).slice(0, 64) : null;

      const count = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM wallets WHERE user_id=$1",
        [user.id],
      );
      if (Number(count.rows[0]!.n) >= config.maxWalletsPerUser) {
        res.status(409).json({ error: "wallet limit reached" });
        return;
      }
      if (mode === "restore") {
        const queued = await db.query<{ n: string }>(
          "SELECT count(*) AS n FROM wallets WHERE user_id=$1 AND state='queued'",
          [user.id],
        );
        if (Number(queued.rows[0]!.n) >= config.maxQueuedRestoresPerUser) {
          res.status(409).json({ error: "restore queue limit reached" });
          return;
        }
      }

      const walletId = randomUUID();
      const walletPass = newWalletPass();
      const walletPath = walletPathFor(config.walletDir, walletId);

      if (mode === "new") {
        // Optional restore_height override for fresh wallets (0 = full scan;
        // only safe because the wallet has no history yet).
        const heightOverride = req.body?.restore_height;
        const created = Number.isInteger(heightOverride) && Number(heightOverride) >= 0
          ? await engine.createRandomWallet({ walletPath, walletPass, restoreHeight: Number(heightOverride) })
          : await managerCreateNew(walletPath, walletPass);
        const creationHeight =
          Number.isInteger(heightOverride) && Number(heightOverride) >= 0
            ? null
            : created.restoreHeight;
        const enc = encryptWalletMaterial(config.masterKey, walletId, {
          seed: created.seed,
          walletPass,
        });
        const r = await db.query(
          `INSERT INTO wallets (id, user_id, label, address, encrypted_seed, wrapped_data_key,
                                encrypted_wallet_pass, restore_height, creation_height, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued') RETURNING id`,
          [
            walletId,
            user.id,
            label,
            created.address,
            enc.encryptedSeed,
            enc.wrappedDataKey,
            enc.encryptedWalletPass,
            created.restoreHeight,
            creationHeight,
          ],
        );
        res.status(201).json({ id: r.rows[0]!.id, state: "queued", mnemonic: created.seed });
      } else {
        const mnemonic = String(req.body?.mnemonic ?? "").trim();
        const restoreHeight = Number(req.body?.restore_height ?? 0);
        if (mnemonic.split(/\s+/).filter(Boolean).length < 13 || !Number.isInteger(restoreHeight) || restoreHeight < 0) {
          res.status(400).json({ error: "mnemonic and non-negative integer restore_height required" });
          return;
        }
        // derive the primary address offline (also validates the mnemonic)
        let derivedAddress: string;
        try {
          derivedAddress = await engine.deriveAddress(mnemonic);
        } catch {
          res.status(400).json({ error: "invalid mnemonic" });
          return;
        }

        // dedupe: same seed already imported by this user -> return the
        // existing wallet (requeue it if it errored)
        const dupe = await db.query<{ id: string; state: string }>(
          `SELECT id, state FROM wallets WHERE user_id=$1 AND address=$2 LIMIT 1`,
          [user.id, derivedAddress],
        );
        if (dupe.rowCount && dupe.rowCount > 0) {
          const existing = dupe.rows[0]!;
          if (existing.state === "error") {
            await db.query(
              `UPDATE wallets SET state='queued', attempts=0, error=NULL,
                 restore_height = CASE WHEN $2 > 0 THEN $2 ELSE restore_height END,
                 updated_at=now()
               WHERE id=$1`,
              [existing.id, restoreHeight],
            );
          }
          res.status(200).json({ id: existing.id, state: existing.state, existing: true });
          return;
        }

        // reuse a known height for this address when the import has none:
        // prefer the on-site creation height (seed first existed then), fall
        // back to the earliest restore height seen for the address
        let height = restoreHeight;
        if (height === 0) {
          const known = await db.query<{ ch: string | null; h: string | null }>(
            `SELECT max(creation_height) AS ch, min(restore_height) AS h FROM wallets
             WHERE address=$1 AND state IN ('ready','watching')
               AND (creation_height IS NOT NULL OR restore_height > 0)`,
            [derivedAddress],
          );
          const ch = known.rows[0]?.ch;
          const rh = known.rows[0]?.h;
          const best =
            ch !== null && ch !== undefined
              ? Number(ch)
              : rh !== null && rh !== undefined
                ? Number(rh)
                : null;
          if (best !== null) height = best;
        }

        const enc = encryptWalletMaterial(config.masterKey, walletId, { seed: mnemonic, walletPass });
        const r = await db.query(
          `INSERT INTO wallets (id, user_id, label, address, encrypted_seed, wrapped_data_key,
                                encrypted_wallet_pass, restore_height, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued') RETURNING id`,
          [
            walletId,
            user.id,
            label,
            derivedAddress,
            enc.encryptedSeed,
            enc.wrappedDataKey,
            enc.encryptedWalletPass,
            height,
          ],
        );
        res.status(201).json({ id: r.rows[0]!.id, state: "queued" });
      }
    }),
  );

  app.get(
    "/api/wallets",
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = (req as AuthedRequest).user!;
      const r = await db.query(
        `SELECT id, label, address, state, restore_height, attempts, error, created_at
         FROM wallets WHERE user_id=$1 ORDER BY created_at`,
        [user.id],
      );
      res.json({ wallets: r.rows.map(rowToJson) });
    }),
  );

  app.get(
    "/api/wallets/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      const record = await loadOwnedWallet(req);
      if (!record) {
        res.status(404).json({ error: "not found" });
        return;
      }
      let balances = null;
      const syncProgress =
        record.state === "restoring" && record.syncTarget && record.syncTarget > 0
          ? { height: record.syncHeight ?? 0, target: record.syncTarget }
          : null;
      let address: string = record.address ?? "";
      if (record.state === "ready" || record.state === "watching") {
        balances = await manager.getBalances(record);
        if (address === "") {
          address =
            record.state === "ready" || record.state === "watching"
              ? await manager.getAddress(record).catch(() => "")
              : "";
          if (address !== "") {
            await db.query("UPDATE wallets SET address=$1, updated_at=now() WHERE id=$2", [
              address,
              record.id,
            ]);
          }
        }
      }
      res.json({
        id: record.id,
        label: record.label,
        address,
        state: record.state,
        restore_height: record.restoreHeight,
        attempts: record.attempts,
        error: record.error,
        created_at: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
        balance_atomic: balances ? balances.total.toString() : null,
        unlocked_atomic: balances ? balances.unlocked.toString() : null,
        sync_height: syncProgress ? syncProgress.height : null,
        sync_target: syncProgress ? syncProgress.target : null,
      });
    }),
  );

  app.get(
    "/api/wallets/:id/incoming",
    requireAuth,
    asyncHandler(async (req, res) => {
      const record = await loadOwnedWallet(req);
      if (!record) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (record.state !== "ready" && record.state !== "watching") {
        res.status(409).json({ error: `wallet not ready (state: ${record.state})` });
        return;
      }
      const [incoming, outgoing, tip] = await Promise.all([
        manager.getIncoming(record, 25),
        manager.getOutgoing(record, 25),
        engine.daemonHeight().catch(() => 0),
      ]);
      const conf = (height: number | null): number | null =>
        height === null || tip <= 0 ? null : tip - height + 1;
      res.json({
        incoming: incoming.map((t) => ({
          txid: t.txid,
          amount_atomic: t.amountAtomic.toString(),
          height: t.height,
          timestamp: t.timestamp,
          confirmations: conf(t.height),
        })),
        outgoing: outgoing.map((t) => ({
          txid: t.txid,
          amount_atomic: t.amountAtomic.toString(),
          fee_atomic: t.feeAtomic.toString(),
          height: t.height,
          timestamp: t.timestamp,
          confirmations: conf(t.height),
        })),
      });
    }),
  );

  app.get(
    "/api/height-for-date",
    requireAuth,
    asyncHandler(async (req, res) => {
      const dateStr = String(req.query.date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        res.status(400).json({ error: "date must be YYYY-MM-DD" });
        return;
      }
      const target = Date.parse(`${dateStr}T00:00:00Z`);
      if (!Number.isFinite(target)) {
        res.status(400).json({ error: "invalid date" });
        return;
      }
      const tip = await engine.daemonHeight();
      // binary search the newest height with block timestamp <= target
      let lo = 0;
      let hi = tip;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        const ts = (await engine.getBlockTimestamp(mid)) * 1000;
        if (ts <= target) lo = mid;
        else hi = mid - 1;
      }
      // safety margin: ~2 days of blocks before the date
      const MARGIN_BLOCKS = 1440;
      const height = Math.max(0, lo - MARGIN_BLOCKS);
      res.json({ height });
    }),
  );

  app.get(
    "/api/wallets/:id/addresses",
    requireAuth,
    asyncHandler(async (req, res) => {
      const record = await loadOwnedWallet(req);
      if (!record) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (record.state !== "ready" && record.state !== "watching") {
        res.status(409).json({ error: `wallet not ready (state: ${record.state})` });
        return;
      }
      const addresses = await manager.getSubaddresses(record);
      res.json({ addresses });
    }),
  );

  app.post(
    "/api/wallets/:id/addresses",
    requireAuth,
    asyncHandler(async (req, res) => {
      const record = await loadOwnedWallet(req);
      if (!record) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (record.state !== "ready" && record.state !== "watching") {
        res.status(409).json({ error: `wallet not ready (state: ${record.state})` });
        return;
      }
      const label = req.body?.label ? String(req.body.label).slice(0, 64) : null;
      const info = await manager.createSubaddress(record, label);
      res.status(201).json(info);
    }),
  );

  app.post(
    "/api/wallets/:id/send",
    requireAuth,
    asyncHandler(async (req, res) => {
      const record = await loadOwnedWallet(req);
      if (!record) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (record.state !== "ready" && record.state !== "watching") {
        res.status(409).json({ error: `wallet not ready (state: ${record.state})` });
        return;
      }
      const address = String(req.body?.address ?? "").trim();
      const max = req.body?.max === true;
      const amountAtomicStr = String(req.body?.amount_atomic ?? "").trim();
      if (!ADDRESS_RE.test(address) || (!max && !AMOUNT_RE.test(amountAtomicStr))) {
        res.status(400).json({ error: "address and amount_atomic (decimal string) required" });
        return;
      }
      try {
        if (max) {
          const result = await manager.sendMax(record, address);
          res.json({ txid: result.txid });
          return;
        }
        const amountAtomic = BigInt(amountAtomicStr);
        if (amountAtomic <= 0n) {
          res.status(400).json({ error: "amount must be positive" });
          return;
        }
        const result = await manager.send(record, address, amountAtomic);
        res.json({ txid: result.txid });
      } catch (e) {
        const msg = scrub(e instanceof Error ? e.message : String(e)).slice(0, 200);
        if (/not enough|insufficient/i.test(msg)) {
          res.status(400).json({ error: "not enough unlocked balance" });
        } else if (/dust/i.test(msg)) {
          res.status(400).json({ error: "amount too small (below dust threshold)" });
        } else if (/wrong|invalid.*address/i.test(msg)) {
          res.status(400).json({ error: "invalid recipient address" });
        } else {
          throw e;
        }
      }
    }),
  );

  // ---------- pages ----------
  app.get("/donate", (_req, res) => res.sendFile(resolve(webRoot, "donate.html")));
  app.get("/blog", (_req, res) => res.sendFile(resolve(webRoot, "blog.html")));

  // ---------- static frontend (strict CSP, zero third-party) ----------
  app.use(
    express.static(webRoot, {
      setHeaders: (res, path) => {
        if (path.endsWith(".html")) {
          res.setHeader(
            "Content-Security-Policy",
            [
              "default-src 'self'",
              "script-src 'self'",
              "style-src 'self'",
              "img-src 'self' data:",
              "connect-src 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
              "base-uri 'none'",
              "object-src 'none'",
            ].join("; "),
          );
        }
      },
    }),
  );

  // error handler: scrub everything dynamic
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = scrub(err instanceof Error ? err.message : String(err)).slice(0, 300);
    log.error("request failed", { err: msg });
    res.status(500).json({ error: "internal error" });
  });

  return app;

  // ----- helpers (closure over deps) -----

  async function managerCreateNew(walletPath: string, walletPass: string) {
    const height = await deps.engine.daemonHeight().catch(() => 0);
    return deps.engine.createRandomWallet({ walletPath, walletPass, restoreHeight: height });
  }

  async function loadOwnedWallet(req: Request): Promise<WalletRecord | null> {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) return null;
    const user = (req as AuthedRequest).user!;
    const r = await db.query(
      `SELECT id, user_id AS "userId", label, address,
              encrypted_seed AS "encryptedSeed",
              wrapped_data_key AS "wrappedDataKey",
              encrypted_wallet_pass AS "encryptedWalletPass",
              restore_height AS "restoreHeight", state, attempts, error,
              created_at AS "createdAt"
       , sync_height AS "syncHeight", sync_target AS "syncTarget"
       FROM wallets WHERE id=$1 AND user_id=$2`,
      [id, user.id],
    );
    return (r.rows[0] as WalletRecord | undefined) ?? null;
  }
}

interface AuthedRequest extends Request {
  user: { id: string; email: string | null; isAnon: boolean } | null;
  sessionToken?: string;
}

interface WalletRow {
  id: string;
  label: string | null;
  address: string;
  state: string;
  restore_height: string | number | null;
  attempts: string | number | null;
  error: string | null;
  created_at: Date | string;
}

function rowToJson(row: WalletRow): Record<string, unknown> {
  return {
    id: row.id,
    label: row.label ?? null,
    address: row.address ?? "",
    state: row.state,
    restore_height: row.restore_height !== undefined ? Number(row.restore_height) : null,
    attempts: row.attempts !== undefined ? Number(row.attempts) : null,
    error: row.error ?? null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}
