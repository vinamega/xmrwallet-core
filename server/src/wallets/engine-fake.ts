// Fake engine for API smoke tests without a chain. Deterministic balances,
// no daemon. Never used in prod (ENGINE=monerots).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Balances,
  CreateRandomResult,
  IncomingTransfer,
  OpenWalletOpts,
  OutgoingTransfer,
  SubaddressInfo,
  WalletEngine,
  WalletHandle,
} from "./engine.js";

const FAKE_TOTAL = 1_000_000_000_000n; // 0.000001 XMR-scale fake atomic units (display only)

class FakeHandle implements WalletHandle {
  incoming: IncomingTransfer[] = [];
  outgoing: OutgoingTransfer[] = [];
  subaddresses: SubaddressInfo[] = [];

  constructor(public seed: string, primaryAddress: string) {
    this.subaddresses.push({ index: 0, address: primaryAddress, label: "primary", used: true });
  }
  private sent = 0;

  async syncOnce(onProgress?: (h: number, t: number) => void): Promise<void> {
    onProgress?.(1_000_000, 2_000_000);
  }

  async getPrimaryAddress(): Promise<string> {
    return this.subaddresses[0]?.address ?? "FAKEADDR";
  }

  async getBalances(): Promise<Balances> {
    return { total: FAKE_TOTAL, unlocked: FAKE_TOTAL };
  }

  async getIncoming(limit: number): Promise<IncomingTransfer[]> {
    return this.incoming.slice(0, limit);
  }

  getOutgoing(limit: number): Promise<OutgoingTransfer[]> {
    return Promise.resolve(
      this.outgoing.slice(0, limit).map((o) => ({ ...o })),
    );
  }

  getSubaddresses(): Promise<SubaddressInfo[]> {
    return Promise.resolve(this.subaddresses);
  }

  createSubaddress(label: string | null): Promise<SubaddressInfo> {
    const info: SubaddressInfo = {
      index: this.subaddresses.length,
      address: `${this.subaddresses[0]?.address ?? "FAKEADDR"}-${this.subaddresses.length}`,
      label,
      used: false,
    };
    this.subaddresses.push(info);
    return Promise.resolve(info);
  }

  async sendToAddress(_address: string, amountAtomic: bigint): Promise<{ txid: string }> {
    this.sent += 1;
    const txid = `faketx-${randomBytes(6).toString("hex")}`;
    this.outgoing.push({ txid, amountAtomic, feeAtomic: 100000000n, height: 999, timestamp: 123 });
    return { txid };
  }

  sweepToAddress(_address: string): Promise<{ txid: string }> {
    return Promise.resolve({ txid: `fakesweep-${randomBytes(4).toString("hex")}` });
  }

  async save(): Promise<void> {}

  async close(): Promise<void> {}
}

export class FakeEngine implements WalletEngine {
  readonly name = "fake";
  private handlesByPath = new Map<string, FakeHandle>();

  async createRandomWallet(opts: {
    walletPath: string;
    walletPass: string;
    restoreHeight: number;
  }): Promise<CreateRandomResult> {
    const seed = Array.from({ length: 25 }, (_, i) => `fakeword${i + 1}`).join(" ");
    const address = `FAKEADDR${randomBytes(8).toString("hex")}`;
    mkdirSync(dirname(opts.walletPath), { recursive: true });
    writeFileSync(opts.walletPath, "fake");
    const h = new FakeHandle(seed, address);
    this.handlesByPath.set(opts.walletPath, h);
    return { seed, address, restoreHeight: opts.restoreHeight };
  }

  async openWallet(opts: OpenWalletOpts): Promise<WalletHandle> {
    let h = this.handlesByPath.get(opts.walletPath);
    if (!h) {
      h = new FakeHandle(opts.seed, existsSync(opts.walletPath) ? "FAKEEXISTING" : "FAKEADDR");
      this.handlesByPath.set(opts.walletPath, h);
    }
    return h;
  }

  async daemonHeight(): Promise<number> {
    return 2_000_000;
  }

  async validateSeed(seed: string): Promise<void> {
    if (seed.split(/\s+/).filter(Boolean).length < 13) throw new Error("Invalid mnemonic");
  }

  async deriveAddress(seed: string): Promise<string> {
    await this.validateSeed(seed);
    const h = createHash("sha256").update(seed).digest("hex");
    return ("FAKEADDR" + h + "a".repeat(95)).slice(0, 95);
  }

  async getBlockTimestamp(height: number): Promise<number> {
    // fake chain: 120s blocks from 2020-01-01
    return 1577836800 + height * 120;
  }
}
