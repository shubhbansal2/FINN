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
# Picks up changes to the service and timer definitions (e.g. a new refresh step).
for unit in finn.service finn-refresh.service finn-refresh.timer; do
  install -m 644 "$APP_DIR/deploy/oracle/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl restart finn
echo "Updated to $(sudo -u finn git -C "$APP_DIR" log -1 --format='%h %s')"
