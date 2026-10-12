# Phase 2 — Core vertical slice (implementation notes)

Status: built + unit-tested + API smoke-tested (fake engine) + real-engine
offline verification. Full on-chain send/receive verification lands with the
Phase 3 integration tests (requires the stagenet node at tip).

## Components

| Component | Where | Notes |
|---|---|---|
| App skeleton | `server/src/index.ts` | Node 22, TS, ESM. Boots config → db migrate → engine → manager → queue/watch → http |
| Auth | `server/src/auth/` | email/pass (scrypt) + anon sessions; httpOnly cookie, sha256-hashed tokens in PG; in-memory rate limits (register, wallet create) |
| Seed store | `server/src/aead.ts`, `server/src/wallets/seedstore.ts` | AES-256-GCM; per-wallet data key wrapped by master key (env); AAD binds wallet id + field; wallet-file password random per wallet |
| Restore queue | `server/src/restore/queue.ts` | `queued → restoring → ready → watching` (+ `error`); claim via `FOR UPDATE SKIP LOCKED`; cap `RESTORE_CONCURRENCY` (20); retries with capped attempts; never on request path |
| Wallet manager | `server/src/wallets/manager.ts` | per-wallet mutex; global chain lock (timeout) serializes watch refreshes; LRU handle cache (`MAX_OPEN_WALLETS`); plugin notify on balance change |
| Engine | `server/src/wallets/engine-monetots.ts` | monero-ts `createWalletFull`/`openWalletFull` (WASM, worker-proxied); engine-agnostic interface keeps the wallet-rpc-per-user fallback cheap |
| Web API | `server/src/api/app.ts` | register/login/anon/me; wallet create (new/restore), list, detail (balances+address), incoming, send; 64kb body cap; errors scrubbed |
| Frontend | `web/` | vanilla JS, strict CSP (no inline script/style, zero third-party) |
| Plugins | `plugins/` | balance-action interface + reference no-op (loaded by default; `PLUGIN_PATHS` for extras) |

## Amounts

All amounts cross the API as **atomic units (piconero) in decimal strings**
(no floats). BigInt internally (monero-ts 0.11 is BigInt-native).

## Security notes

- Seeds/mnemonics/wallet passes only ever exist: in request memory, in
  AES-256-GCM blobs in PG, or in service-owned wallet files. Never logged
  (logger scrubs addresses + mnemonics defensively; bodies never logged).
- Mnemonic returned exactly once, in the create-wallet response (user's own
  wallet, semi-custodial model).
- Restore-queue caps + registration/wallet-create rate limits from day one
  (rescan-from-0 DoS is the abuse vector).
- Engine change (wallet-rpc fallback) = implement `WalletEngine` in
  `server/src/wallets/engine.ts` terms; manager is engine-agnostic.

## Deferred to Phase 3

- Full stagenet integration test: register → restore-from-0 → receive faucet
  → spend (`tests/`, needs node at tip; faucet: cypherfaucet.com dev API).
- Restore concurrency benchmark (~20 cap tuning; RSS watch at 20+ concurrent).
- Registration/restore-queue hardening beyond the in-memory day-one caps.
- Backup script, monitoring, release checklist.
