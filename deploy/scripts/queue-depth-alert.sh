#!/bin/sh
# queue-depth-alert.sh — warn when the restore queue backs up (guide §5).
# Non-prod example; runs from deploy/systemd/queue-depth-alert.timer.
# Env: DATABASE_URL, QUEUE_DEPTH_THRESHOLD (default 100)

set -eu

DATABASE_URL="${DATABASE_URL:?DATABASE_URL required}"
THRESHOLD="${QUEUE_DEPTH_THRESHOLD:-100}"

DEPTH=$(psql "$DATABASE_URL" -At -c "SELECT count(*) FROM wallets WHERE state='queued'")
RESTORING=$(psql "$DATABASE_URL" -At -c "SELECT count(*) FROM wallets WHERE state='restoring'")
ERRORS=$(psql "$DATABASE_URL" -At -c "SELECT count(*) FROM wallets WHERE state='error'")

if [ "$DEPTH" -ge "$THRESHOLD" ]; then
  logger -t queue-depth -p user.warning \
    "WARN: restore queue depth ${DEPTH} >= ${THRESHOLD} (restoring: ${RESTORING}, error: ${ERRORS})"
  exit 1
fi
logger -t queue-depth -p user.info "OK: queue depth ${DEPTH} (restoring ${RESTORING}, error ${ERRORS})"