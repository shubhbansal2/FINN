#!/usr/bin/env bash
# Sets up FINN on an Oracle Cloud Always Free Ampere A1 VM running Ubuntu 22.04 or 24.04.
#
#   sudo git clone https://github.com/shubhbansal2/FINN.git /opt/finn
#   sudo bash /opt/finn/deploy/oracle/setup.sh <domain|auto> [fixture|live]
#
# <domain>  a hostname whose DNS points at this VM, for HTTPS (e.g. finn.example.com),
#           or "auto" to use <public-ip>.sslip.io, which needs no DNS setup.
# mode      fixture (default): recorded demo data, no keys needed.
#           live: real providers; put GEMINI_API_KEY in /etc/finn/finn.env afterwards.
#
# Safe to re-run: it updates packages, rebuilds and restarts.
set -euo pipefail

DOMAIN_ARG="${1:-}"
MODE="${2:-fixture}"
APP_DIR=/opt/finn
DATA_DIR=/var/lib/finn
ENV_DIR=/etc/finn
ENV_FILE="$ENV_DIR/finn.env"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
[ -n "$DOMAIN_ARG" ] || die "usage: sudo bash $0 <domain|auto> [fixture|live]"
[ "$MODE" = fixture ] || [ "$MODE" = live ] || die "mode must be fixture or live"
[ -f "$APP_DIR/package.json" ] || die "clone the repository to $APP_DIR first"

step "System packages (Node.js 22, build tools, Caddy)"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git build-essential python3 debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
echo "node $(node -v), npm $(npm -v), $(caddy version | head -1)"

step "Service user and directories"
id finn >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin finn
mkdir -p "$DATA_DIR" "$ENV_DIR"
chown -R finn:finn "$APP_DIR" "$DATA_DIR"

step "Environment file ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# FINN server settings. Secrets live only here, never in the repository.
NODE_ENV=production
FINN_DATA_MODE=$MODE
FINN_DATA_DIR=$DATA_DIR
# Live mode with a model: a free key from https://aistudio.google.com/apikey
FINN_LLM_PROVIDER=gemini
GEMINI_API_KEY=
EOF
else
  sed -i "s/^FINN_DATA_MODE=.*/FINN_DATA_MODE=$MODE/" "$ENV_FILE"
fi
chown root:finn "$ENV_FILE"
chmod 640 "$ENV_FILE"

# Runs a command as the finn user with the server environment loaded.
as_finn() { sudo -u finn bash -c "set -a; . '$ENV_FILE'; set +a; cd '$APP_DIR'; $*"; }

step "Install dependencies and build (a few minutes on the first run)"
as_finn "npm ci --include=dev --no-audit --no-fund"
as_finn "npm run build"

step "Data ($MODE mode)"
if [ "$MODE" = fixture ]; then
  as_finn "npm run setup:demo"
else
  as_finn "npm run finn -- universe:sync && npm run finn -- ingest:prices && npm run finn -- ingest:filings && npm run finn -- ingest:results && npm run finn -- ingest:people"
fi

step "Services"
install -m 644 "$HERE/finn.service" /etc/systemd/system/finn.service
install -m 644 "$HERE/finn-refresh.service" /etc/systemd/system/finn-refresh.service
install -m 644 "$HERE/finn-refresh.timer" /etc/systemd/system/finn-refresh.timer
systemctl daemon-reload
systemctl enable finn.service
systemctl restart finn.service
if [ "$MODE" = live ]; then
  systemctl enable --now finn-refresh.timer
else
  systemctl disable --now finn-refresh.timer 2>/dev/null || true
fi

step "Firewall (Oracle's Ubuntu images reject ports 80/443 by default)"
for port in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
    reject_line="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')"
    if [ -n "$reject_line" ]; then
      iptables -I INPUT "$reject_line" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    else
      iptables -A INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    fi
  fi
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; else echo "note: install iptables-persistent to keep these rules after a reboot"; fi

step "HTTPS reverse proxy (Caddy)"
if [ "$DOMAIN_ARG" = auto ]; then
  public_ip="$(curl -fsS https://api.ipify.org)"
  DOMAIN="${public_ip//./-}.sslip.io"
else
  DOMAIN="$DOMAIN_ARG"
fi
sed "s/{DOMAIN}/$DOMAIN/" "$HERE/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

step "Checking FINN responds locally"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/watchlist; then ok=1; break; fi
  sleep 2
done
[ "${ok:-}" = 1 ] || die "FINN did not start; see: journalctl -u finn -n 50"

echo
echo "FINN is running in $MODE mode."
echo "Open: https://$DOMAIN  (the certificate can take a minute on the first visit)"
[ "$MODE" = live ] && echo "Add GEMINI_API_KEY to $ENV_FILE, then: sudo systemctl restart finn"
echo "Logs: journalctl -u finn -f    Update later: sudo bash $APP_DIR/deploy/oracle/update.sh"
