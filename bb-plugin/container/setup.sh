#!/bin/sh
# Runs inside the container, as node, in the plugin's directory: installs bb at the version the
# plugin pins and the plugin's dependencies. Inside the container so that the installs run under
# its CPU and memory limits and never touch the host.
set -eu
cd "$(dirname "$0")/.."
BB_VERSION=$(node -p 'require("./package.json").devDependencies["bb-app"]')
if [ "$(bb --version 2>/dev/null || true)" != "$BB_VERSION" ]; then
  npm install -g "bb-app@$BB_VERSION"
fi
npm ci
echo "setup: bb-app $(bb --version), plugin SDK $(node -p 'require("@get-bb/plugin-sdk/package.json").version')"
