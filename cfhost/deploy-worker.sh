#!/usr/bin/env bash
# Bump the version (worker APP_VERSION + embed_widget/emloader.js DEFAULT_VERSION), then deploy the chatboxy-api Worker
# (e.g. after editing vars such as ALLOWED_ORIGINS in worker/wrangler.jsonc), the client-agent app
# (build + wrangler pages deploy to the chatboxy-agent Pages project) and the embed widget
# (build + wrangler pages deploy to the chatboxy-embed Pages project).
# Usage: ./deploy-worker.sh [version]   (default: current version + 1)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

node "$ROOT/scripts/bump-version.mjs" "$@"

cd "$ROOT/worker"

if [ ! -d node_modules ]; then
  npm install
fi

npm run typecheck
npx wrangler deploy

echo "Worker deployed."

cd "$ROOT/client-agent"

if [ ! -d node_modules ]; then
  npm install
fi

npm run deploy

echo "client-agent deployed."

cd "$ROOT/embed_widget"

if [ ! -d node_modules ]; then
  npm install
fi

npm run build
"$ROOT/client-agent/node_modules/.bin/wrangler" pages deploy dist --project-name chatboxy-embed --branch main --commit-dirty=true

echo "embed widget deployed."