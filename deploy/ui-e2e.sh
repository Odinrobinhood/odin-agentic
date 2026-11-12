#!/usr/bin/env bash
# Browser click-through of the staging web app (deploy/ui-e2e.mjs). Run as root on the staging host.
# Installs Playwright + Chromium once under /opt/odin-uitest (outside the app tree); screenshots in /tmp/odin-ui.
set -euo pipefail
DIR=/opt/odin-uitest
mkdir -p "$DIR" /tmp/odin-ui && rm -f /tmp/odin-ui/*.png
if [ ! -d "$DIR/node_modules/playwright" ]; then
  (cd "$DIR" && echo '{"name":"odin-uitest","private":true,"type":"module"}' > package.json \
    && npm install --silent --no-audit --no-fund playwright@1.65.0 viem@2.21.54 \
    && npx --yes playwright@1.65.0 install --with-deps chromium >/tmp/odin-uitest-install.log 2>&1)
fi
cp /opt/odin/app/deploy/ui-e2e.mjs "$DIR/ui-e2e.mjs"
cd "$DIR" && OUT=/tmp/odin-ui node ui-e2e.mjs
