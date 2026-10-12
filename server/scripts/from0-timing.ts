// True from-0 restore timing: scan the user's stagenet test seed from
// genesis to tip with a fresh wallet file, logging progress + rate.
// Standalone (no app/db) — only touches the local daemon's block feed.
import { createWalletFull, MoneroWalletListener, type MoneroWalletFull } from "monero-ts";
import { rmSync } from "node:fs";

const SEED = process.env.FROM0_SEED!;
const PATH = "/tmp/opencode/from0-timing";
const NET = 2; // stagenet
rmSync(`${PATH}.keys`, { force: true });
rmSync(PATH, { force: true });

const t0 = Date.now();
const wallet: MoneroWalletFull = await createWalletFull({
  path: PATH,
  password: "timing",
  networkType: NET,
  server: "http://127.0.0.1:38081",
  seed: SEED,
  restoreHeight: 0,
});

let lastLog = 0;
class ProgressListener extends MoneroWalletListener {
  override async onSyncProgress(
    height: number,
    startHeight: number,
    endHeight: number,
    pctDone: number,
    _message: string,
  ): Promise<void> {
    const now = Date.now();
    if (now - lastLog > 60_000) {
      lastLog = now;
      const mins = ((now - t0) / 60_000).toFixed(1);
      const rate = ((height - startHeight) / ((now - t0) / 1000)).toFixed(0);
      console.log(`t+${mins}min height=${height} / ${endHeight} (${pctDone.toFixed(2)}%) ~${rate} blocks/s`);
    }
  }
}
await wallet.sync(new ProgressListener());

const secs = ((Date.now() - t0) / 1000).toFixed(0);
const bal = await wallet.getBalance();
console.log(`FROM0 DONE in ${secs}s (${(Number(secs) / 60).toFixed(1)} min), final balance: ${bal}`);
await wallet.close(true);
process.exit(0);
