#!/usr/bin/env bash
# STSLV AMC — host firewall (UFW). TEMPLATE: review, then run ONCE by hand as root. NOT YET APPLIED.
#
# Opens only SSH, HTTP (redirect + certificate renewal) and HTTPS. The API (3001) listens on 127.0.0.1
# and is never opened. PostgreSQL is not on this server (Neon is used), so no database port is opened.
#
# Optional: SSH_ALLOWED_FROM="<office IP or range>" limits SSH to that source. Leave unset until the
# administrators' fixed addresses are confirmed; a wrong value locks everyone out of SSH (the Hostinger
# browser console still works). Hostinger's own panel firewall, if enabled, must allow the same ports.
set -euo pipefail

SSH_PORT="${SSH_PORT:-22}"
SSH_ALLOWED_FROM="${SSH_ALLOWED_FROM:-}"

ufw --force reset
ufw default deny incoming
ufw default allow outgoing

if [ -n "$SSH_ALLOWED_FROM" ]; then
  ufw allow from "$SSH_ALLOWED_FROM" to any port "$SSH_PORT" proto tcp comment 'SSH (restricted)'
else
  # "limit" refuses an address that opens 6 or more connections in 30 seconds.
  ufw limit "$SSH_PORT"/tcp comment 'SSH'
fi
ufw allow 80/tcp comment 'HTTP: redirect and ACME renewal'
ufw allow 443/tcp comment 'HTTPS'

ufw logging low
ufw --force enable
ufw status verbose
