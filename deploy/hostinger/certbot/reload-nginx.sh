#!/bin/sh
# STSLV AMC — certbot deploy hook. TEMPLATE.
# Install as /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh (root:root 0755).
# certbot runs it only after a certificate was actually renewed; Nginx then serves the new certificate.
# Renewal itself is scheduled by the certbot package (systemd timer certbot.timer, twice a day).
set -e
nginx -t -q
systemctl reload nginx
