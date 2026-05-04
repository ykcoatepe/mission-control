#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-3333}"
WORKSPACE="/Users/yordamkocatepe/clawd"
START_SCRIPT="$WORKSPACE/scripts/mission_control_start.sh"
LOGFILE="$WORKSPACE/state/mission_control_start.log"
PIDFILE="$WORKSPACE/state/mission_control_${PORT}.pid"

mkdir -p "$WORKSPACE/state"

if /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 \
  || /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 \
  || /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
  exit 0
fi

# If an old PID file exists but the process is gone, ignore it. If it is alive,
# let the caller's follow-up health check decide whether the service recovered.
if [[ -f "$PIDFILE" ]]; then
  old_pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
    exit 0
  fi
fi

cd "$WORKSPACE"
nohup bash "$START_SCRIPT" >>"$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"

for _ in {1..40}; do
  if /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 \
    || /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 \
    || /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 0.25
done

exit 1
