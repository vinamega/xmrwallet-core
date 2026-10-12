#!/bin/sh
# disk-alert.sh — Phase 1: warn when the filesystem holding the Monero data
# dirs (/srv) exceeds 75% usage (guide §2: "Set a disk alert at 75%").
# Non-prod example; runs from deploy/systemd/disk-alert@.timer.
# No secrets here (log-scrubbing rule respected).
USAGE=$(df -P /srv | awk 'NR==2 {gsub("%","",$5); print $5}')
THRESHOLD=75
if [ "$USAGE" -ge "$THRESHOLD" ]; then
    logger -t disk-alert -p user.warning \
        "WARN: filesystem at ${USAGE}% (threshold ${THRESHOLD}%) on $(df -P /srv | awk 'NR==2 {print $6}')"
    exit 1
fi
logger -t disk-alert -p user.info "OK: /srv at ${USAGE}%"