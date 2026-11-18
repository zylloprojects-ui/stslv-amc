#!/usr/bin/env bash
# STSELV AMC — build one release archive for the Hostinger VPS from a checked-out commit.
#
#   deploy/hostinger/deploy/package-release.sh <output.tar.gz>
#
# Run from the repository root AFTER the tests have passed. Produces:
#   RELEASE                       the full 40-character commit id (checked by the server)
#   api/dist api/migrations       the built API and its migrations
#   api/assets                    the company artwork read by every Excel and PDF export (assets/branding)
#   api/package.json api/package-lock.json api/node_modules   production dependencies only
#   web/                          the built web application (stslv-web/dist), source maps removed
# The archive holds no secrets: the server keeps its own /etc/stslv-amc/api.env.
set -euo pipefail

out="${1:?usage: package-release.sh <output.tar.gz>}"
commit="$(git rev-parse HEAD)"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "not a git checkout" >&2; exit 1; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# API: build with dev dependencies, then ship only the production ones.
(cd stslv-api && npm ci --include=dev --no-audit --no-fund --loglevel=error && npm run build)
mkdir -p "$stage/api"
cp -r stslv-api/dist stslv-api/migrations stslv-api/assets stslv-api/package.json stslv-api/package-lock.json "$stage/api/"
# The exports read their artwork from api/assets/branding (dist/shared/export/branding.js); a release without it
# would fail every Excel and PDF download, so refuse to package one.
for art in report-header.png report-footer.png report-logo.png; do
  [[ -s "$stage/api/assets/branding/$art" ]] || { echo "missing export artwork: assets/branding/$art" >&2; exit 1; }
done
(cd "$stage/api" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

# Web: same-origin API (/api through Nginx), so VITE_API_BASE_URL stays empty.
(cd stslv-web && npm ci --no-audit --no-fund --loglevel=error && VITE_API_BASE_URL= npm run build)
cp -r stslv-web/dist "$stage/web"
find "$stage/web" -name '*.map' -delete

printf '%s\n' "$commit" > "$stage/RELEASE"
tar -C "$stage" -czf "$out" RELEASE api web
echo "release $commit -> $out ($(du -h "$out" | cut -f1))"
