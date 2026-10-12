# 0001 — Wallet engine (Phase 0 gate)

- **Status:** Accepted
- **Date:** 2026-10-11
- **Phase:** 0 (Dependency verification gate)
- **Context:** public repo (`xmrwallet-core`), stagenet-only dev

## Decision

Use **`monero-ts` headless wallets** (in-process, server-side) as the wallet engine
for the wallet manager. Pin `monero-ts` (current release line: v0.11.x).

The wallet manager interface is written so that the fallback — one
`monero-wallet-rpc` per user behind the same manager interface — remains a cheap
swap if the headless path fails in Phase 2 (see "Revisit triggers").

## Verification summary (checked 2026-10-11)

| Item | Finding |
|---|---|
| `monero-javascript` (npm) | **Deprecated/stale.** Last release 0.8.4 (2023-09). npm deprecation notice: "renamed to monero-ts". Not used. |
| Upstream repo | Moved to **`woodser/monero-ts`** (same author). Actively maintained: pushed 2026-10-07, releases v0.11.14 → v0.11.20 (Aug–Oct 2026), not archived. |
| Monero core alignment | Built against Monero **v0.18.5.3** (recent commits: compile wallet pending_tx_validation, bigint RPC fixes for v0.18.5.3). |
| Headless support | Yes — in-process WebAssembly (WASM) full-wallet bindings for Node.js; wallet implementations (WASM / RPC / keys) interchangeable behind `MoneroWallet` interface. |
| Node compatibility | `engines: node >=10`; README recommends **Node 20 LTS** (Node 16/18 need `--experimental-wasm-threads`). Matches our Node LTS app-server plan. Use Node 20 LTS. |
| Testing | Project ships its own Node.js test suite driven against stagenet monerod + monero-wallet-rpc test servers — same stagenet-only model we use. |

## Consequences

- Go/no-go on Phase 2 wallet manager: **GO with monero-ts headless.**
- Node.js 20 LTS on the app server (no wasm-threads flag needed).
- Restore-queue RAM planning uses headless wallet figure (~100–300 MB/wallet);
  cap ~20 concurrent restores, benchmark in Phase 2 (guide §2).
- Manager interface must be engine-agnostic (`MoneroWallet`-shape operations:
  open/restore/sync/lock/balance/build-and-sign) so the per-user
  `monero-wallet-rpc` fallback stays a drop-in.

## Revisit triggers (fallback to wallet-rpc-per-user)

- WASM headless wallets prove unstable under 10–20 concurrent restores (RSS
  blowup, lockups, or sync errors) during Phase 2 benchmarks.
- monero-ts goes dormant again (>6 months without a release while a Monero
  protocol upgrade lands) and we cannot pin a compatible version.
- A Monero hard fork ships a wallet feature monero-ts cannot support at
  the needed timeline.

## Security notes

- Stagenet-only dev/testing. No keys/seeds in repo.
- monero-ts WASM wallet runs in-process on the app server: wallet material
  never leaves the server; encrypted seed store + per-wallet mutex unchanged.