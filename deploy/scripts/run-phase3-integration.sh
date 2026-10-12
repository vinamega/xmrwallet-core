#!/bin/sh
# run-phase3-integration.sh — waits for the stagenet daemon to reach tip,
# then runs the Phase 3 acceptance slice (restore-from-0 → faucet → spend).
# Output goes to /root/phase3-integration.log (scrubbed logs + txids only).

set -u
LOG=/root/phase3-integration.log
cd /root/xmrwallet-core/server

echo "$(date -u +%FT%TZ) waiting for stagenet tip..." >> "$LOG"
while :; do
  INFO=$(curl -s --max-time 10 http://127.0.0.1:38081/get_info || true)
  case "$INFO" in
    *'"synchronized": true'*) break ;;
  esac
  sleep 60
done
echo "$(date -u +%FT%TZ) tip reached; running integration slice (from 0)" >> "$LOG"

INTEGRATION_STAGENET=1 RESTORE_FROM_ZERO=1 WAIT_FOR_SYNC=1 \
WATCH_REFRESH_MS=3000 RESTORE_POLL_MS=500 \
npx vitest run test/integration --reporter=basic >> "$LOG" 2>&1
RC=$?
echo "$(date -u +%FT%TZ) integration finished rc=$RC" >> "$LOG"
exit $RC