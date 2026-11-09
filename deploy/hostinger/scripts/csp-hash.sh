#!/usr/bin/env bash
# Prints the CSP source for each inline <script> in a built index.html, e.g. 'sha256-...='.
# Usage: csp-hash.sh /var/www/stslv-amc/web/current/index.html
# Compare with script-src in /etc/nginx/snippets/stslv-security-headers.conf after every web release.
set -euo pipefail
file="${1:?usage: csp-hash.sh <path to built index.html>}"
python3 - "$file" <<'PY'
import base64, hashlib, re, sys
html = open(sys.argv[1], encoding="utf-8").read()
for body in re.findall(r"<script>(.*?)</script>", html, flags=re.S):
    print("'sha256-" + base64.b64encode(hashlib.sha256(body.encode("utf-8")).digest()).decode() + "'")
PY
