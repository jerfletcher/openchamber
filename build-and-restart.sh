#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/jeremy/develop/openchamber"
cd "$REPO_DIR"

echo "==> Building web assets..."
bun run build:web

echo "==> Ensuring global @openchamber/web symlink points to local repo..."
cd /home/jeremy/.bun/install/global/node_modules/@openchamber
if [ ! -L "web" ] || [ "$(readlink -f web)" != "$REPO_DIR/packages/web" ]; then
  rm -rf web
  ln -s "$REPO_DIR/packages/web" web
fi

echo "==> Restarting openchamber.service..."
systemctl --user restart openchamber.service

echo "==> Waiting for service health..."
until curl -s -f -m 2 http://127.0.0.1:4096/health >/dev/null 2>&1; do
  sleep 1
done

echo "==> OpenChamber updated and running!"
