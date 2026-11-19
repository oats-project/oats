#!/bin/sh
# Runs inside the container: the typecheck, the unit tests (vitest) and the plugin build.
set -eu
cd "$(dirname "$0")/.."
echo "== typecheck"
npx tsc --noEmit
echo "== unit tests"
npx vitest run
if [ -f app.tsx ]; then
  echo "== build"
  npx bb plugin build
else
  echo "== build: skipped, app.tsx is not in this tree yet (the live tests build the backend)"
fi
