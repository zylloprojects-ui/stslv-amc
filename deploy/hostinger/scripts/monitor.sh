#!/usr/bin/env bash
# STSLV AMC — resource and health monitor. TEMPLATE: NOT YET DEPLOYED.
# Install as /usr/local/lib/stslv-amc/monitor.sh (root:root 0755); run by stslv-amc-monitor.timer.
#
# Checks: disk use, available memory, API and database health on the loopback address, the public HTTPS
# address and its certificate expiry, failed systemd units, and the age of the last successful backups.
# A check that changes state (OK -> FAIL or FAIL -> OK) sends one alert; a check still failing is reported
# again every MONITOR_REPEAT_MINUTES. Nothing here prints or sends a password, token or key.
#
# Settings (/etc/stslv-amc/monitor.env); every one has a default except the webhook:
#   MONITOR_ALERT_WEBHOOK_URL     where alerts are POSTed as JSON {"text": ..., "content": ...} (Slack, Google Chat,
#                                 Discord and most chat webhooks accept one of the two). Empty = log only.
#   MONITOR_HEARTBEAT_URL         optional dead-man's switch (e.g. a healthchecks-style URL), pinged when all is OK;
#                                 "<url>/fail" is pinged when something fails. Detects a dead VPS too.
#   MONITOR_ENVIRONMENT           label in every alert (default: production)
#   MONITOR_DISK_PATHS            space-separated mount points (default: "/")
#   MONITOR_DISK_WARN_PERCENT     default 80
#   MONITOR_MEM_MIN_AVAILABLE_PERCENT  default 10
#   MONITOR_API_URL               default http://127.0.0.1:3001
#   MONITOR_PUBLIC_URL            e.g. https://<confirmed domain>  (empty = public checks skipped)
#   MONITOR_CERT_MIN_DAYS         default 14
#   MONITOR_UNITS                 default "nginx stslv-amc-api stslv-amc-db-backup stslv-amc-docs-backup"
#   MONITOR_BACKUP_STATE_DIR      default /var/lib/stslv-amc-backup/state
#   MONITOR_BACKUP_MAX_AGE_HOURS  default 26 (one missed daily run is reported)
#   MONITOR_REPEAT_MINUTES        default 360
#   MONITOR_STATE_DIR             default /var/lib/stslv-amc-monitor

set -u
umask 077

ENVIRONMENT="${MONITOR_ENVIRONMENT:-production}"
WEBHOOK="${MONITOR_ALERT_WEBHOOK_URL:-}"
HEARTBEAT="${MONITOR_HEARTBEAT_URL:-}"
DISK_PATHS="${MONITOR_DISK_PATHS:-/}"
DISK_WARN="${MONITOR_DISK_WARN_PERCENT:-80}"
MEM_MIN="${MONITOR_MEM_MIN_AVAILABLE_PERCENT:-10}"
API_URL="${MONITOR_API_URL:-http://127.0.0.1:3001}"
PUBLIC_URL="${MONITOR_PUBLIC_URL:-}"
CERT_MIN_DAYS="${MONITOR_CERT_MIN_DAYS:-14}"
UNITS="${MONITOR_UNITS:-nginx stslv-amc-api stslv-amc-db-backup stslv-amc-docs-backup}"
BACKUP_STATE_DIR="${MONITOR_BACKUP_STATE_DIR:-/var/lib/stslv-amc-backup/state}"
BACKUP_MAX_AGE_HOURS="${MONITOR_BACKUP_MAX_AGE_HOURS:-26}"
REPEAT_MINUTES="${MONITOR_REPEAT_MINUTES:-360}"
STATE_DIR="${MONITOR_STATE_DIR:-/var/lib/stslv-amc-monitor}"

mkdir -p "$STATE_DIR"
HOST="$(hostname -s 2>/dev/null || echo vps)"
NOW="$(date +%s)"
FAILURES=0

log() { printf '%s monitor %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

json_escape() {
  # Escapes a message for a JSON string (backslash, quote, control characters).
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   '
}

send_alert() {
  local message="[STSLV AMC ${ENVIRONMENT} @ ${HOST}] $1"
  log "ALERT $message"
  [ -z "$WEBHOOK" ] && return 0
  local body
  body="{\"text\":\"$(json_escape "$message")\",\"content\":\"$(json_escape "$message")\"}"
  curl -fsS --max-time 15 -H 'Content-Type: application/json' -d "$body" "$WEBHOOK" >/dev/null 2>&1 \
    || log "could not deliver the alert to the webhook"
}

# record <check id> <ok|fail> <message>: alerts on a change of state and repeats a standing failure.
record() {
  local id="$1" status="$2" message="$3"
  local file="$STATE_DIR/$id.state" previous="ok" since="$NOW" last_alert=0
  if [ -f "$file" ]; then
    read -r previous since last_alert < "$file" || true
  fi
  if [ "$status" = "fail" ]; then
    FAILURES=$((FAILURES + 1))
    if [ "$previous" != "fail" ]; then
      send_alert "FAIL ${id}: ${message}"
      echo "fail $NOW $NOW" > "$file"
    elif [ $((NOW - last_alert)) -ge $((REPEAT_MINUTES * 60)) ]; then
      send_alert "STILL FAILING ${id} (since $(date -u -d "@$since" +%Y-%m-%dT%H:%MZ 2>/dev/null || echo "$since")): ${message}"
      echo "fail $since $NOW" > "$file"
    fi
  else
    if [ "$previous" = "fail" ]; then
      send_alert "RECOVERED ${id}: ${message}"
    fi
    echo "ok $NOW 0" > "$file"
  fi
}

# -- Disk ----------------------------------------------------------------------------------------
for mount in $DISK_PATHS; do
  used="$(df -P "$mount" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
  id="disk$(echo "$mount" | tr '/' '_')"
  if [ -z "$used" ]; then
    record "$id" fail "cannot read disk use of $mount"
  elif [ "$used" -ge "$DISK_WARN" ]; then
    record "$id" fail "$mount is ${used}% full (limit ${DISK_WARN}%)"
  else
    record "$id" ok "$mount is ${used}% full"
  fi
done

# -- Memory --------------------------------------------------------------------------------------
total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
if [ -n "$total_kb" ] && [ -n "$avail_kb" ] && [ "$total_kb" -gt 0 ]; then
  avail_pct=$((avail_kb * 100 / total_kb))
  if [ "$avail_pct" -lt "$MEM_MIN" ]; then
    record memory fail "only ${avail_pct}% memory available (limit ${MEM_MIN}%)"
  else
    record memory ok "${avail_pct}% memory available"
  fi
fi

# -- API and database health (loopback, bypasses Nginx) ------------------------------------------
if curl -fsS --max-time 10 "$API_URL/api/health" >/dev/null 2>&1; then
  record api ok "API answers"
else
  record api fail "API health check failed at the loopback address"
fi
if curl -fsS --max-time 15 "$API_URL/api/health/database" >/dev/null 2>&1; then
  record database ok "database reachable"
else
  record database fail "API reports the database unreachable"
fi

# -- Public address and certificate --------------------------------------------------------------
if [ -n "$PUBLIC_URL" ]; then
  if curl -fsS --max-time 15 "$PUBLIC_URL/api/health" >/dev/null 2>&1; then
    record public ok "public HTTPS address answers"
  else
    record public fail "public HTTPS address does not answer (Nginx, TLS or DNS)"
  fi
  host_only="$(printf '%s' "$PUBLIC_URL" | sed -E 's#^https://([^/:]+).*#\1#')"
  end_date="$(echo | openssl s_client -servername "$host_only" -connect "$host_only:443" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [ -n "$end_date" ]; then
    days_left=$(( ( $(date -d "$end_date" +%s) - NOW ) / 86400 ))
    if [ "$days_left" -lt "$CERT_MIN_DAYS" ]; then
      record certificate fail "TLS certificate expires in ${days_left} days; check certbot renewal"
    else
      record certificate ok "TLS certificate valid for ${days_left} days"
    fi
  else
    record certificate fail "cannot read the TLS certificate"
  fi
fi

# -- systemd units -------------------------------------------------------------------------------
for unit in $UNITS; do
  if systemctl is-failed --quiet "$unit" 2>/dev/null; then
    record "unit_$unit" fail "systemd unit $unit has failed (journalctl -u $unit)"
  else
    record "unit_$unit" ok "unit $unit not failed"
  fi
done
for unit in nginx stslv-amc-api; do
  if ! systemctl is-active --quiet "$unit" 2>/dev/null; then
    record "active_$unit" fail "systemd unit $unit is not running"
  else
    record "active_$unit" ok "unit $unit running"
  fi
done

# -- Backup age (written by dist/ops/cli.js; contains no secrets) --------------------------------
for job in db-backup docs-backup; do
  file="$BACKUP_STATE_DIR/$job.json"
  if [ ! -f "$file" ]; then
    record "backup_$job" fail "no successful $job recorded yet ($file missing)"
    continue
  fi
  last="$(sed -n 's/.*"lastSuccessAt": *"\([^"]*\)".*/\1/p' "$file" | head -1)"
  if [ -z "$last" ]; then
    record "backup_$job" fail "$job has never succeeded"
    continue
  fi
  age_h=$(( (NOW - $(date -d "$last" +%s 2>/dev/null || echo 0)) / 3600 ))
  if [ "$age_h" -ge "$BACKUP_MAX_AGE_HOURS" ]; then
    record "backup_$job" fail "last successful $job was ${age_h} hours ago (limit ${BACKUP_MAX_AGE_HOURS}h)"
  else
    record "backup_$job" ok "last successful $job ${age_h}h ago"
  fi
done

# -- Heartbeat -----------------------------------------------------------------------------------
if [ -n "$HEARTBEAT" ]; then
  if [ "$FAILURES" -eq 0 ]; then
    curl -fsS --max-time 10 "$HEARTBEAT" >/dev/null 2>&1 || log "heartbeat not delivered"
  else
    curl -fsS --max-time 10 "$HEARTBEAT/fail" >/dev/null 2>&1 || log "heartbeat not delivered"
  fi
fi

log "done: $FAILURES failing check(s)"
exit 0
