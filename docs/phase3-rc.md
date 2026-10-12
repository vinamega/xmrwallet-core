# Phase 3 — Public release candidate

Status: **built**. On-chain acceptance (restore-from-0 → faucet → spend)
runs automatically once the stagenet node reaches tip —
`deploy/scripts/run-phase3-integration.sh` (results: `/root/phase3-integration.log`).

## Checklist (Phase 3)

| Item | Status | Where |
|---|---|---|
| Stagenet integration tests (register → restore-from-0 → receive faucet → spend) | built; runs at tip (see below) | `server/test/integration/stagenet-slice.test.ts` |
| Registration rate limits | day-one caps (Phase 2) + login brute-force cap (Phase 3) | `server/src/api/app.ts`, `server/src/auth/ratelimit.ts` |
| Strict-CSP frontend | done (Phase 2) | `web/`, CSP header in `server/src/api/app.ts` |
| Backup script (off-box, encrypted) | done, roundtrip-verified | `deploy/scripts/backup-seedstore.sh` + timer examples |
| Monitoring (disk, queue depth, node sync) | done, live on dev box | `deploy/scripts/{disk-alert,queue-depth-alert,node-sync-alert}.sh` + timers |
| Log scrubbing (no secrets in any log) | done: logger scrubs addresses/mnemonics; bodies never logged; plaintext `.address.txt` removed from wallet dirs | `server/src/logging.ts`, `server/src/wallets/engine-monetots.ts` |
| CI | lint + typecheck + unit + fake-engine smoke (postgres service) | `.github/workflows/ci.yml` |

## Integration test

Env-gated (`INTEGRATION_STAGENET=1`, otherwise skipped in CI):

```sh
cd server
# quick wiring check (restore at daemon tip):
INTEGRATION_STAGENET=1 npx vitest run test/integration
# acceptance (worst case, hours):
INTEGRATION_STAGENET=1 RESTORE_FROM_ZERO=1 npx vitest run test/integration
```

Flow: anon register → wallet A (restore from 0 / tip) → fund via
CypherFaucet dev API (0.01 sXMR) → wait unlocked → wallet B (new) →
send A→B (0.000001 XMR) → assert B sees the exact txid + balance.

Logs only wallet ids, states, and txids — never seeds/mnemonics/addresses.

## Monitoring on the dev box (live)

- `disk-alert@srv.timer` — hourly, warns ≥75% on /srv
- `queue-depth-alert.timer` — every 5 min, warns queue depth ≥100
  (`QUEUE_DEPTH_THRESHOLD`), logs restoring/error counts
- `node-sync-alert.timer` — every 5 min, warns daemon lag >100 blocks;
  errors on unreachable RPC

All via syslog (`journalctl -t disk-alert -t queue-depth -t node-sync`).

## Backup

`backup-seedstore.sh`: `pg_dump | openssl aes-256-cbc (pbkdf2)` → ssh to
`$BACKUP_TARGET`; optional wallet-cache tarball (key images). Env from
service-owned `/etc/xmrwallet/backup.env` (prod: mwprod, chmod 600,
human-entered). Verified: encrypt → decrypt → 4 tables intact.

## Remaining before public release

- On-chain acceptance pass (auto-runs at tip)
- Restore-concurrency benchmark (~20 cap tuning) — single-wallet timing
  comes free with the acceptance run; a 20-wallet benchmark run is
  `RESTORE_CONCURRENCY` + 20 queued wallets, repeatable on demand
- Final review + push to public (maintainer approval)
