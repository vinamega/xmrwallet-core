# Stagenet infra (Phase 1) — dev box setup

Dev box: Ubuntu 26.04 LTS, 40 cores, 92 GB RAM, 300 GB NVMe (Amsterdam VPS).
Everything below is **stagenet only**. No secrets anywhere
in this repo; `.env` values are placeholders.

## Layout

| Path | Purpose |
|---|---|
| `/opt/monero/bin` | Monero v0.18.5.3 CLI binaries (tarball SHA256-verified against the GPG-signed `hashes.txt` from getmonero.org) |
| `/etc/monero/stagenet/monerod.conf` | monerod stagenet config (from `deploy/monero/monerod-stagenet.conf.example`) |
| `/srv/monero/stagenet` | monerod stagenet data dir (own service user `monerosvc`; strictly separate from any mainnet dir) |
| `/srv/wallets/stagenet/wallet-rpc` | monero-wallet-rpc wallet dir (service user `xmrwallet`) |
| `/srv/wallets/stagenet/faucet` | faucet wallet material (dev-only, never in repo) |

## Services (systemd, enabled at boot)

- `monerod-stagenet.service` — P2P 38080 (open in ufw for stagenet peers),
  RPC 38081 loopback, restricted RPC 38082 loopback.
- `monero-wallet-rpc-stagenet.service` — loopback 38084 (monerod's restricted
  RPC occupies 38082), digest auth with local dev credentials
  (`CHANGE_ME_LOCAL_DEV_ONLY` placeholder in the repo copy).
- `disk-alert@.timer` / `disk-alert@srv.service` — hourly check, warns via
  syslog at 75% disk use on `/srv` (guide §2/§5).

All units are non-prod examples with systemd hardening
(`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`,
scoped `ReadWritePaths`).

## Stagenet faucet

Faucet wallet `faucet-dev` is a fresh stagenet wallet created via
monero-wallet-rpc (`create_wallet`, English seed language). The mnemonic
never enters the repo, a session log, or a chat; it lives only in the
`xmrwallet`-owned wallet files under `/srv/wallets/stagenet/`.

Funding source: **CypherFaucet** `https://cypherfaucet.com/xmr-stagenet`
(sXMR, 0.01 per claim; web claim uses a captcha; developer API is keyless):

```sh
curl -X POST https://cypherfaucet.com/api/v1/claim \
  -H 'Content-Type: application/json' \
  -d '{"network":"xmr-stagenet","address":"<FAUCET_WALLET_STAGENET_ADDRESS>"}'
```

Response includes `txid` (and `tx_key` for in-transaction proof checks).
Rate-limited to one payout per hour per address; plan test cycles around it
(or contact the faucet for a higher-limit integration before Phase 3).

A `getmonero.org`-listed faucet URLs (e.g. `community.monero.dev`) are stale
as of 2026-10; CypherFaucet is live, synced (block 2226502) and maintained.

## Day-1 checks

- monerod syncing stagenet (2.2M blocks; full sync takes a while — see
  `journalctl -u monerod-stagenet`).
- wallet-rpc reachable on 127.0.0.1:38084 (digest auth).
- Faucet payout received post-sync (verify with `get_balance` after the node
  reaches the tip; the claim tx is at the current tip height).
- Disk alert active (`systemctl list-timers | grep disk`).

## Port map (stagenet, dev box)

| Port | Binding | Use |
|---|---|---|
| 38080 | 0.0.0.0 (ufw allow) | monerod stagenet P2P |
| 38081 | 127.0.0.1 | monerod unrestricted RPC (dev) |
| 38082 | 127.0.0.1 | monerod restricted RPC (auto) |
| 38084 | 127.0.0.1 | monero-wallet-rpc (dev) |