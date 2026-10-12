# tests/

- Stagenet integration slice: `server/test/integration/stagenet-slice.test.ts`
  (Phase 3 acceptance — register → restore-from-0 → receive faucet → spend;
  env-gated `INTEGRATION_STAGENET=1`, needs a synced stagenet node).
- Unit tests: `server/test/unit` (CI, no chain/DB needed).
- API smoke: `server/scripts/smoke.ts` (fake engine + Postgres; CI runs it
  as the "stagenet fixture" stage).

Rules: stagenet + faucet seeds only; no seeds/mnemonics/addresses in any
log; dev DB is throwaway.
