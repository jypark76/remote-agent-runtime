#!/bin/bash
# Launcher: logs mintty output to ../logs/<PST-timestamp>.txt

LOGS_DIR="$(dirname "$0")/logs"
mkdir -p "$LOGS_DIR"

TIMESTAMP=$(powershell -Command '$tz=[System.TimeZoneInfo]::FindSystemTimeZoneById("Pacific Standard Time");$dt=[System.TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow,$tz);$dt.ToString("yyyy-MM-dd_HH-mm-ss")' 2>/dev/null | tr -d '\r')
LOG_FILE="$LOGS_DIR/${TIMESTAMP}.txt"

echo "Logging to $LOG_FILE"

# Prevent sleep when lid is closed while server is running
powercfg.exe -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 2>/dev/null && \
powercfg.exe -setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 2>/dev/null && \
powercfg.exe -SetActive SCHEME_CURRENT 2>/dev/null && \
echo "Lid close: sleep disabled (will restore on exit)" && _LID_CHANGED=1 || _LID_CHANGED=0

cleanup() {
  if [[ $_LID_CHANGED -eq 1 ]]; then
    powercfg.exe -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1 2>/dev/null
    powercfg.exe -setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1 2>/dev/null
    powercfg.exe -SetActive SCHEME_CURRENT 2>/dev/null
    echo "Lid close: sleep restored"
  fi
}
trap cleanup EXIT

source "$(dirname "$0")/.env"
RELAY_URL=wss://remoteclaude-production.up.railway.app \
RELAY_TOKEN="$RELAY_TOKEN" \
node "$(dirname "$0")/server.js" 2>&1 | tee "$LOG_FILE"
