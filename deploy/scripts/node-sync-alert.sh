#!/bin/sh
# node-sync-alert.sh — warn when monerod stalls or falls behind (guide §5).
# Non-prod example; runs from deploy/systemd/node-sync-alert.timer.
# Env: DAEMON_URL (default http://127.0.0.1:38081), SYNC_LAG_THRESHOLD (default 100)

set -eu

DAEMON_URL="${DAEMON_URL:-http://127.0.0.1:38081}"
LAG_THRESHOLD="${SYNC_LAG_THRESHOLD:-100}"

INFO=$(curl -s --max-time 10 "$DAEMON_URL/get_info")
HEIGHT=$(printf '%s' "$INFO" | sed -n 's/.*"height": *\([0-9]*\).*/\1/p' | head -1)
TARGET=$(printf '%s' "$INFO" | sed -n 's/.*"target_height": *\([0-9]*\).*/\1/p' | head -1)

if [ -z "$HEIGHT" ] || [ -z "$TARGET" ]; then
  logger -t node-sync -p user.error "ERROR: daemon RPC unreachable or malformed at $DAEMON_URL"
  exit 1
fi

LAG=$(( TARGET - HEIGHT ))
if [ "$LAG" -gt "$LAG_THRESHOLD" ]; then
  # warning only (log-visible); exit 0 to avoid failed-unit noise during syncs
  logger -t node-sync -p user.warning "WARN: monerod behind by ${LAG} blocks (threshold ${LAG_THRESHOLD})"
  exit 0
fi
logger -t node-sync -p user.info "OK: monerod at ${HEIGHT} (lag ${LAG})"