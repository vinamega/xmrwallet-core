#!/bin/sh
# backup-seedstore.sh — encrypted off-box backup of the wallet database.
# Non-prod example: prod runs as mwprod with its own env (BACKUP_PASSPHRASE
# + BACKUP_TARGET entered by the human, never in the repo).
#
# Pipeline: pg_dump | openssl aes-256-cbc (pbkdf2) | ssh to off-box target.
# Also ships the monero-ts wallet cache dir (key images) if WALLET_BACKUP_DIR
# is set — rebuildable, but losing it wholesale = days of rescans (guide §5).
#
# Env:
#   DATABASE_URL        postgres connection string
#   BACKUP_PASSPHRASE   encryption passphrase (service env only)
#   BACKUP_TARGET       e.g. backupuser@offbox:/srv/backups/xmrwallet
#   WALLET_BACKUP_DIR   optional: /srv/wallets/<net>/managed (tar+encrypt too)
#
# Never logs secrets; output only timestamp + byte counts + rsync/ssh status.

set -eu

DATABASE_URL="${DATABASE_URL:?DATABASE_URL required}"
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE required}"
BACKUP_TARGET="${BACKUP_TARGET:?BACKUP_TARGET required}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# 1. wallet database (users, sessions, wallets incl. encrypted seed blobs)
pg_dump "$DATABASE_URL" | openssl enc -aes-256-cbc -pbkdf2 -salt \
  -pass env:BACKUP_PASSPHRASE -out "$WORK/seedstore-$STAMP.sql.enc"

# 2. wallet caches (key images; optional)
if [ -n "${WALLET_BACKUP_DIR:-}" ] && [ -d "$WALLET_BACKUP_DIR" ]; then
  tar -C "$(dirname "$WALLET_BACKUP_DIR")" -czf - "$(basename "$WALLET_BACKUP_DIR")" \
    | openssl enc -aes-256-cbc -pbkdf2 -salt \
      -pass env:BACKUP_PASSPHRASE -out "$WORK/walletcache-$STAMP.tar.gz.enc"
fi

# 3. ship off-box
for f in "$WORK"/*.enc; do
  ssh -o BatchMode=yes "$BACKUP_TARGET" "cat > $(basename "$f")" < "$f"
done

echo "backup ok: $STAMP ($(du -sh "$WORK" | cut -f1))"

# verification hint (run on the off-box):
#   openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE \
#     -in seedstore-<stamp>.sql.enc | head -c 200   # readable dump header
# restore (into a scratch db):
#   ... | psql -d scratchdb