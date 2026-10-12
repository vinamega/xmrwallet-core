// Plugin loader: always loads the reference no-op plugin (public repo ships
// an EMPTY implementation; nothing references specific behavior); optional
// extra plugin modules via PLUGIN_PATHS (comma-separated module paths).

import { NoopBalanceActionPlugin, type BalanceActionPlugin } from "../../../plugins/src/index.js";
import { log } from "../logging.js";

export async function loadPlugins(paths: string[]): Promise<BalanceActionPlugin[]> {
  const plugins: BalanceActionPlugin[] = [new NoopBalanceActionPlugin()];
  for (const p of paths) {
    try {
      const mod = (await import(p)) as Record<string, unknown>;
      const found = Object.values(mod).filter(
        (v): v is BalanceActionPlugin =>
          typeof v === "object" &&
          v !== null &&
          "id" in v &&
          typeof (v as BalanceActionPlugin).id === "string" &&
          typeof (v as BalanceActionPlugin).onBalanceChange === "function",
      );
      if (found.length === 0) throw new Error("no BalanceActionPlugin export found");
      plugins.push(...found);
      log.info("plugin loaded", { path: p, count: found.length });
    } catch (e) {
      log.error("plugin failed to load", { path: p, err: String(e).slice(0, 200) });
    }
  }
  return plugins;
}
