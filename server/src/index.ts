// Entry point: config -> db migrate -> engine -> manager (+plugins) ->
// restore queue + watch loop -> HTTP.

import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { setLogLevel, log } from "./logging.js";
import { MoneroTsEngine } from "./wallets/engine-monetots.js";
import { FakeEngine } from "./wallets/engine-fake.js";
import { WalletManager } from "./wallets/manager.js";
import { loadPlugins } from "./plugins/loader.js";
import { PgQueueRepo, RestoreQueue, WatchLoop } from "./restore/queue.js";
import { buildApp } from "./api/app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  log.info("starting", { engine: config.engine, network: config.network });

  const db = await createPool(config.databaseUrl);
  await migrate(db);

  const engine = config.engine === "fake" ? new FakeEngine() : new MoneroTsEngine(config);
  const plugins = await loadPlugins(config.pluginPaths);
  const manager = new WalletManager(engine, config, plugins);

  const repo = new PgQueueRepo(db);
  const queue = new RestoreQueue(repo, manager, {
    concurrency: config.restoreConcurrency,
    pollMs: config.restorePollMs,
    maxAttempts: config.restoreMaxAttempts,
  });
  const watch = new WatchLoop(repo, manager, { refreshMs: config.watchRefreshMs, maxOpen: config.maxOpenWallets });

  const app = buildApp({ db, config, manager, engine });

  const server = app.listen(config.port, config.host, () => {
    log.info("http listening", { host: config.host, port: config.port });
  });

  queue.start();
  watch.start();

  const shutdown = async (): Promise<void> => {
    log.info("shutting down");
    queue.stop();
    watch.stop();
    server.close();
    await manager.closeAll();
    await db.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((e) => {
  log.error("fatal", { err: String(e).slice(0, 500) });
  process.exit(1);
});
