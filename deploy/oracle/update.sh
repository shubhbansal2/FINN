#!/usr/bin/env bash
# Pulls the latest FINN from GitHub, rebuilds and restarts. Data and settings are kept.
#   sudo bash /opt/finn/deploy/oracle/update.sh
set -euo pipefail

APP_DIR=/opt/finn
ENV_FILE=/etc/finn/finn.env
[ "$(id -u)" -eq 0 ] || { echo "error: run with sudo" >&2; exit 1; }

as_finn() { sudo -u finn bash -c "set -a; . '$ENV_FILE'; set +a; cd '$APP_DIR'; $*"; }

as_finn "git pull --ff-only"
as_finn "npm ci --include=dev --no-audit --no-fund"
as_finn "npm run build"
# Applies any new database migrations before the app restarts.
as_finn "npm run finn -- migrate"
systemctl restart finn
echo "Updated to $(sudo -u finn git -C "$APP_DIR" log -1 --format='%h %s')"
