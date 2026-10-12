#!/bin/bash
# overnight.sh — runs after the Phase 3 acceptance completes:
#   1. restore-concurrency benchmark (20 wallets from tip-500 through the site API)
#   2. writes /root/morning-status.txt summarizing everything that happened overnight
# Unattended; logs only states/timings/RSS (no addresses, no seeds).

BENCH_LOG=/root/bench-restore.log
REPORT=/root/morning-status.txt
SITE_KEY=$(grep -o '[a-f0-9]*' /root/.site-key)
BASE=http://127.0.0.1:3000
JAR=/tmp/opencode/bench.jar

section() { echo "=== $1 ==="; }

# ---- wait for tip ----
while :; do
  INFO=$(curl -s --max-time 10 http://127.0.0.1:38081/get_info || true)
  case "$INFO" in *'"synchronized": true'*) break ;; esac
  sleep 60
done
TIP_AT=$(date -u +%FT%TZ)

# ---- wait for the acceptance run to finish (cap 8h, then proceed anyway) ----
DEADLINE=$(( $(date +%s) + 8 * 3600 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if grep -q "integration finished" /root/phase3-integration.log 2>/dev/null; then break; fi
  sleep 120
done

# ---- benchmark: 20 concurrent restores through the site API ----
# (5 anon sessions x 4 wallets: per-user wallet cap is 5)
echo "$(date -u +%FT%TZ) benchmark start" >> "$BENCH_LOG"
for u in 1 2 3 4 5; do
  JAR="/tmp/opencode/bench-$u.jar"; rm -f "$JAR"; touch "$JAR"
  curl -s -c "$JAR" -o /dev/null "$BASE/?key=$SITE_KEY"
  curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/auth/anon" -o /dev/null
done

TIP=$(curl -s http://127.0.0.1:38081/get_info | python3 -c "import json,sys; print(json.load(sys.stdin)['height'])")
H=$(( TIP - 500 ))
T0=$(date +%s)
for i in $(seq 1 20); do
  U=$(( (i - 1) / 4 + 1 ))
  curl -s -b "/tmp/opencode/bench-$U.jar" -X POST "$BASE/api/wallets" -H "Content-Type: application/json" \
    -d "{\"mode\":\"new\",\"label\":\"bench-$i\",\"restore_height\":$H}" -o /dev/null
done

PEAK_RSS=0
while :; do
  STATES=$(psql "$(grep DATABASE_URL /etc/xmrwallet/app-dev.env | cut -d= -f2-)" -At -c \
    "SELECT state || ':' || count(*) FROM wallets WHERE label LIKE 'bench-%' GROUP BY state" 2>/dev/null | tr '\n' ' ')
  PID=$(systemctl show -p MainPID --value xmrwallet-site 2>/dev/null)
  RSS=$(grep VmRSS "/proc/$PID/status" 2>/dev/null | awk '{print $2}')
  RSS_MB=$(( ${RSS:-0} / 1024 ))
  [ "$RSS_MB" -gt "$PEAK_RSS" ] && PEAK_RSS=$RSS_MB
  ELAPSED=$(( $(date +%s) - T0 ))
  echo "$(date -u +%FT%TZ) t+${ELAPSED}s states: $STATES rss: ${RSS_MB}MB" >> "$BENCH_LOG"
  case "$STATES" in *queued*|*restoring*) sleep 15 ;; *) break ;; esac
done
echo "$(date -u +%FT%TZ) benchmark done in $(( $(date +%s) - T0 ))s, peak rss ${PEAK_RSS}MB" >> "$BENCH_LOG"

# ---- morning report ----
{
  section "morning status — $(date -u +%FT%TZ)"
  section "monerod"
  curl -s http://127.0.0.1:38081/get_info | python3 -c "import json,sys; d=json.load(sys.stdin); print('height', d['height'], 'synced', d['synchronized'], 'tip reached at', '$TIP_AT')"
  section "phase3 acceptance (tail)"
  tail -20 /root/phase3-integration.log 2>/dev/null
  section "faucet retry (tail)"
  tail -5 /root/faucet-retry.log 2>/dev/null
  section "mining (tail)"
  tail -8 /root/stagenet-mining.log 2>/dev/null
  section "benchmark (tail)"
  tail -8 "$BENCH_LOG" 2>/dev/null
  section "site wallets"
  psql "$(grep DATABASE_URL /etc/xmrwallet/app-dev.env | cut -d= -f2-)" -c \
    "SELECT label, state, restore_height, created_at FROM wallets ORDER BY created_at;" 2>/dev/null
  section "services"
  systemctl is-active monerod-stagenet monero-wallet-rpc-stagenet xmrwallet-site disk-alert@srv.timer 2>/dev/null
  section "disk"
  df -h /srv | tail -1
} > "$REPORT" 2>&1
echo "report written: $REPORT"