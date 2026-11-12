#!/usr/bin/env bash
# Publish the already-accepted local image without creating a registry tag.
set -euo pipefail
: "${AGENT_IMAGE:?}" "${IMAGE_REPOSITORY:?}" "${GITHUB_TOKEN:?}"
: "${GITHUB_REF_NAME:?}" "${GITHUB_ACTOR:?}" "${RUNNER_TEMP:?}"
: "${GITHUB_OUTPUT:?}" "${GITHUB_STEP_SUMMARY:?}"

receipt=$(mktemp -d "$RUNNER_TEMP/team-image.XXXXXX")
trap 'rm -rf -- "$receipt"' EXIT
layout="$receipt/image"
authfile="$receipt/auth.json"

# Docker's CLI negotiates the Engine API; the distro Skopeo's daemon client
# does not. Export the immutable local ID, then give Skopeo only archive bytes.
tested=$(docker image inspect --format '{{.Id}}' "$AGENT_IMAGE")
docker save "$tested" --output "$receipt/image.tar"
skopeo inspect --config --raw "docker-archive:$receipt/image.tar" > "$receipt/config.json"
expected="sha256:$(shasum -a 256 "$receipt/config.json" | cut -d' ' -f1)"
# OCI fixes the registry manifest and layer digests before authentication.
skopeo copy "docker-archive:$receipt/image.tar" "oci:$layout:accepted"
digest=$(jq -er '.manifests | select(length == 1) | .[0].digest' "$layout/index.json")
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
manifest="$layout/blobs/sha256/${digest#sha256:}"
config=$(jq -er '.config.digest' "$manifest")
# The config is bound to the exported archive, independent of whether Docker
# uses a config digest (classic store) or manifest/index digest (containerd) ID.
if [ "$config" != "$expected" ]; then
  echo '::error::OCI image configuration differs from the accepted Docker image' >&2
  exit 1
fi

# Only GITHUB_TOKEN is provided, on this step, with job-scoped packages: write.
printf '%s' "$GITHUB_TOKEN" | skopeo login --authfile "$authfile" \
  --username "$GITHUB_ACTOR" --password-stdin ghcr.io
skopeo copy --preserve-digests --authfile "$authfile" \
  "oci:$layout:accepted" "docker://$IMAGE_REPOSITORY@$digest"
printf 'digest=%s\n' "$digest" >> "$GITHUB_OUTPUT"
printf 'Team agent image: `%s@%s`\n' "$IMAGE_REPOSITORY" "$digest" | tee -a "$GITHUB_STEP_SUMMARY"

# Preserve the release's existing notes. A same-digest retry is idempotent;
# another accepted build appends its own immutable receipt.
export GH_TOKEN="$GITHUB_TOKEN"
gh release view "$GITHUB_REF_NAME" --json body --jq .body > "$receipt/notes.md"
if ! grep -qF "$IMAGE_REPOSITORY@$digest" "$receipt/notes.md"; then
  printf '\nTeam agent image (linux/amd64): `%s@%s`\n' "$IMAGE_REPOSITORY" "$digest" >> "$receipt/notes.md"
  gh release edit "$GITHUB_REF_NAME" --notes-file "$receipt/notes.md"
fi
