#!/usr/bin/env bash
#
# serve-lxc.sh — serve the gnaveenkumar.com WIP page on port 9000 via nginx.
#
# Usage (as root inside a Debian/Ubuntu LXC container):
#   bash serve-lxc.sh
#
# If the script sits next to index.html (i.e. you copied the whole
# gnaveenkumar.com/ folder into the container), it serves those local files.
# Otherwise it clones the repo and uses the files from there.

set -euo pipefail

PORT=9000
WEB_ROOT=/var/www/gnaveenkumar
SITE_NAME=gnaveenkumar
REPO_URL="https://github.com/gurunave/claude-analytics.git"
BRANCH="claude/gnaveenkumar-wip-page-74kc1t"
CLONE_DIR=/opt/claude-analytics

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (inside the LXC container)." >&2
  exit 1
fi

echo "==> Installing nginx (and git if needed)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx git >/dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Getting site files..."
mkdir -p "$WEB_ROOT"
if [[ -f "$SCRIPT_DIR/index.html" ]]; then
  echo "    Using local files from $SCRIPT_DIR"
  cp -r "$SCRIPT_DIR/." "$WEB_ROOT/"
  rm -f "$WEB_ROOT/$(basename "${BASH_SOURCE[0]}")"
else
  echo "    Cloning $REPO_URL ($BRANCH)"
  if [[ -d "$CLONE_DIR/.git" ]]; then
    git -C "$CLONE_DIR" fetch origin "$BRANCH"
    git -C "$CLONE_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
  else
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$CLONE_DIR"
  fi
  cp -r "$CLONE_DIR/gnaveenkumar.com/." "$WEB_ROOT/"
  rm -f "$WEB_ROOT/serve-lxc.sh"
fi
chown -R www-data:www-data "$WEB_ROOT"

echo "==> Writing nginx site config (port $PORT)..."
cat > "/etc/nginx/sites-available/$SITE_NAME" <<EOF
server {
    listen $PORT;
    listen [::]:$PORT;
    server_name gnaveenkumar.com www.gnaveenkumar.com _;

    root $WEB_ROOT;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    gzip on;
    gzip_types text/html text/css application/javascript image/svg+xml;
}
EOF
ln -sf "/etc/nginx/sites-available/$SITE_NAME" "/etc/nginx/sites-enabled/$SITE_NAME"

echo "==> Validating and starting nginx..."
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "✅ Done. The WIP page is being served on port $PORT."
echo "   Inside the container : http://localhost:$PORT"
[[ -n "${IP:-}" ]] && echo "   From your network     : http://$IP:$PORT"
echo ""
echo "To update the page later, just re-run this script."
