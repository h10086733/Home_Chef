#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a;source .env;set +a
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
node scripts/configure-wechat.mjs
bash scripts/pnpm.sh --filter @home-chef/miniapp build