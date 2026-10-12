# xmrwallet-core

Open-source hosted Monero web wallet ("light-wallet-style, server-side full
wallet"). The public repo is the complete, working wallet; xmrwallet.net is
a hosted instance of this code. No keys or wallet logic run in the browser.

- `server/` — Node.js app: auth, encrypted seed store (Postgres, AES-256-GCM),
  restore queue, wallet manager (monero-ts headless engine), web API, plugin
  interface
- `web/` — static frontend (strict CSP, zero third-party scripts)
- `plugins/` — balance-action plugin interface + reference no-op plugin
- `deploy/` — systemd units (non-prod examples), scripts
- `tests/` — stagenet integration tests (Phase 3)
- `docs/` — architecture, decisions

Dev is stagenet-only. See `docs/` and `server/.env.example` for setup.

## Quick start (dev)

```sh
npm install
cp server/.env.example server/.env   # fill placeholders (dev values only)
npm run build -w server
node server/dist/server/src/index.js
# or: cd server && npm run dev
```

Requires a stagenet monerod (see `docs/stagenet-infra.md`) and Postgres.

## Status

- Phase 0: engine gate closed — monero-ts headless (`docs/decisions/0001-engine.md`)
- Phase 1: stagenet infra (`docs/stagenet-infra.md`)
- Phase 2: core vertical slice — auth, encrypted seed store, restore queue,
  wallet manager, send/receive API, minimal frontend. Smoke: `npm run smoke`.
- Phase 3: release candidate — integration slice (runs at node tip),
  backups, monitoring, log-scrubbing audit, CI (`docs/phase3-rc.md`).
