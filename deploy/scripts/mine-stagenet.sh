#!/bin/bash
# mine-stagenet.sh — after the node reaches tip, solo-mine stagenet blocks
# to the given wallet address for a bounded time, then stop.
# Coinbase needs ~60 confirmations to unlock (~2h on stagenet).
# Env: MINE_ADDRESS (required), MINE_THREADS (default 8), MINE_MINUTES (default 30)

LOG=${MINE_LOG:-/root/stagenet-mining.log}
ADDRESS="${MINE_ADDRESS:?set MINE_ADDRESS to the wallet's primary address}"
THREADS="${MINE_THREADS:-8}"
MINUTES="${MINE_MINUTES:-30}"

echo "$(date -u +%FT%TZ) waiting for tip..." >> "$LOG"
while :; do
  INFO=$(curl -s --max-time 10 http://127.0.0.1:38081/get_info || true)
  case "$INFO" in
    *'"synchronized": true'*) break ;;
  esac
  sleep 60
done
echo "$(date -u +%FT%TZ) tip reached; starting mining (${THREADS} threads, ${MINUTES}min)" >> "$LOG"

curl -s -X POST http://127.0.0.1:38081/json_rpc -d "{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"start_mining\",\"params\":{\"miner_address\":\"$ADDRESS\",\"threads_count\":$THREADS,\"do_background_mining\":false,\"ignore_battery\":true}}" >> "$LOG" 2>&1

START_H=$(curl -s http://127.0.0.1:38081/get_info | python3 -c "import json,sys; print(json.load(sys.stdin)['height'])")
DEADLINE=$(( $(date +%s) + MINUTES * 60 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep 60
  H=$(curl -s http://127.0.0.1:38081/get_info | python3 -c "import json,sys; print(json.load(sys.stdin)['height'])" 2>/dev/null || echo 0)
  echo "$(date -u +%FT%TZ) height $H (mined $(( H - START_H )) since start)" >> "$LOG"
done

curl -s -X POST http://127.0.0.1:38081/json_rpc -d '{"jsonrpc":"2.0","id":0,"method":"stop_mining"}' >> "$LOG" 2>&1
echo "$(date -u +%FT%TZ) mining stopped" >> "$LOG"