#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -d "$HOME/.nvm/versions/node/v22.12.0/bin" ]; then export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"; fi
chmod +x scripts/bin/pnpm
export PATH="$PWD/scripts/bin:$PATH"
exec corepack pnpm@9.15.0 "$@"
