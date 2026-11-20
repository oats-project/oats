#!/usr/bin/env bash
# Manual evidence that the additive mount preserves the registry-installed payload.
set -euo pipefail
: "${RUNNER_TEMP:?}" "${AGENT_IMAGE:?}" "${ACCEPTED_IMAGE_ID:?}" "${GITHUB_SHA:?}" "${GITHUB_STEP_SUMMARY:?}"
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]]
fixture=$(mktemp -d "$RUNNER_TEMP/team-image-default.XXXXXX")
legacy="oats-team-agent-default:$GITHUB_SHA"
built=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$built" = 1 ]; then docker image rm "$legacy" || result=1; fi
  node --input-type=commonjs -e 'require("node:fs").rmSync(process.argv[1], {recursive:true, force:true})' "$fixture" || result=1
  exit "$result"
}
trap cleanup EXIT
current=$(docker image inspect --format '{{.Id}}' "$AGENT_IMAGE")
if [ "$current" != "$ACCEPTED_IMAGE_ID" ]; then
  echo '::error::Default proof image differs from the accepted image ID' >&2; exit 1
fi
node --input-type=module - "$fixture" <<'JS'
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { imageInputs } from "./.github/scripts/team-image-release-context.mjs";
const context = join(process.argv[2], "context");
mkdirSync(context, {mode:0o700});
for (const name of imageInputs("container/agent")) copyFileSync(join("container/agent", name), join(context, name));
const file = join(context, "Dockerfile"), source = readFileSync(file, "utf8");
const mount = "RUN --mount=type=bind,source=.,target=/opt/oats-build-inputs,readonly npm ci";
assert.equal(source.split(mount).length, 2, "default proof requires exactly the approved mount line");
writeFileSync(file, source.replace(mount, "RUN npm ci"));
JS
docker build --platform linux/amd64 --tag "$legacy" "$fixture/context"
built=1
previous=$(docker image inspect --format '{{.Id}}' "$legacy")
program=$(cat .github/scripts/team-image-payload.cjs)
docker run --rm --network=none --read-only --entrypoint node "$previous" -e "$program" /opt/agent > "$fixture/previous.json"
docker run --rm --network=none --read-only --entrypoint node "$current" -e "$program" /opt/agent > "$fixture/current.json"
if ! cmp -s "$fixture/previous.json" "$fixture/current.json"; then
  echo '::error::Default installed payload differs with the context mount' >&2; exit 1
fi
hash=$(shasum -a 256 "$fixture/current.json" | cut -d' ' -f1)
printf 'Default installed payload: PASS; payload inventory `sha256:%s`; images `%s` and `%s` (history/IDs may differ).\n' "$hash" "$previous" "$current" | tee -a "$GITHUB_STEP_SUMMARY"
