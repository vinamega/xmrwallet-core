import { Pool, type PoolClient } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logging.js";

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");

export type Db = Pool;

export async function createPool(databaseUrl: string): Promise<Pool> {
  const pool = new Pool({ connectionString: databaseUrl, max: 20 });
  // fail fast on bad connection info
  await pool.query("SELECT 1");
  return pool;
}

export async function migrate(db: Pool): Promise<void> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Set(
    (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(resolve(migrationsDir, f), "utf8");
    const client: PoolClient = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      log.info("migration applied", { name: f });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
