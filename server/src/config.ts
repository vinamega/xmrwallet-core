import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (dev only; prod env comes from the service environment).
// Never logs values.
function loadDotEnv(): void {
  const p = resolve(serverRoot, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadDotEnv();

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`bad ${name}`);
  return n;
}

function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

function requireStr(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

export type EngineKind = "monerots" | "fake";

export interface Config {
  databaseUrl: string;
  masterKey: Buffer;
  network: "stagenet" | "mainnet";
  daemonUrl: string;
  walletDir: string;
  port: number;
  host: string;
  appOrigin: string;
  cookieSecure: boolean;
  engine: EngineKind;
  restoreConcurrency: number;
  restoreMaxAttempts: number;
  restorePollMs: number;
  maxOpenWallets: number;
  watchRefreshMs: number;
  chainLockTimeoutMs: number;
  maxWalletsPerUser: number;
  maxQueuedRestoresPerUser: number;
  registerRatePerHour: number;
  walletCreateRatePerHour: number;
  sessionTtlDays: number;
  logLevel: "debug" | "info" | "warn" | "error";
  pluginPaths: string[];
  /** Optional site gate key (ACCESS_KEY env): requests must present ?key=
   *  (or the cookie it sets) — keeps bots/scanners off the dev site.
   *  Empty/absent = gate off. Not a security boundary (app auth is). */
  accessKey?: string;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const masterKeyB64 = requireStr("MASTER_KEY_B64");
  const masterKey = Buffer.from(masterKeyB64, "base64");
  if (masterKey.length !== 32) throw new Error("MASTER_KEY_B64 must decode to 32 bytes");

  const walletDir = requireStr("WALLET_DIR");
  mkdirSync(walletDir, { recursive: true });

  const engine = str("ENGINE", "monerots");
  if (engine !== "monerots" && engine !== "fake") throw new Error("ENGINE must be monerots|fake");

  cached = {
    databaseUrl: requireStr("DATABASE_URL"),
    masterKey,
    network: str("NETWORK", "stagenet") === "mainnet" ? "mainnet" : "stagenet",
    daemonUrl: process.env.DAEMON_URL ?? requireStr("STAGENET_DAEMON_URL"),
    walletDir,
    port: num("PORT", 3000),
    host: str("HOST", "127.0.0.1"),
    appOrigin: str("APP_ORIGIN", "http://127.0.0.1:3000"),
    cookieSecure: str("COOKIE_SECURE", "false") === "true",
    engine,
    restoreConcurrency: num("RESTORE_CONCURRENCY", 20),
    restoreMaxAttempts: num("RESTORE_MAX_ATTEMPTS", 3),
    restorePollMs: num("RESTORE_POLL_MS", 1000),
    maxOpenWallets: num("MAX_OPEN_WALLETS", 50),
    watchRefreshMs: num("WATCH_REFRESH_MS", 30000),
    chainLockTimeoutMs: num("CHAIN_LOCK_TIMEOUT_MS", 5000),
    maxWalletsPerUser: num("MAX_WALLETS_PER_USER", 5),
    maxQueuedRestoresPerUser: num("MAX_QUEUED_RESTORES_PER_USER", 3),
    registerRatePerHour: num("REGISTER_RATE_PER_HOUR", 5),
    walletCreateRatePerHour: num("WALLET_CREATE_RATE_PER_HOUR", 10),
    sessionTtlDays: num("SESSION_TTL_DAYS", 7),
    logLevel: str("LOG_LEVEL", "info") as Config["logLevel"],
    pluginPaths: str("PLUGIN_PATHS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    accessKey: str("ACCESS_KEY", "") || undefined,
  };
  return cached;
}
