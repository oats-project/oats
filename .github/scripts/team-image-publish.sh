#!/usr/bin/env bash
# Verify registry preparation, or publish by digest with an exact release retention tag.
set -euo pipefail
: "${AGENT_IMAGE:?}" "${RUNNER_TEMP:?}" "${ACCEPTED_IMAGE_ID:?}"
: "${GITHUB_OUTPUT:?}" "${GITHUB_STEP_SUMMARY:?}"
if [ "$#" -gt 1 ]; then echo 'usage: team-image-publish.sh [--verify]' >&2; exit 1; fi
case "${1:-}" in
  ''|--verify) ;;
  *) echo 'usage: team-image-publish.sh [--verify]' >&2; exit 1 ;;
esac

receipt=$(mktemp -d "$RUNNER_TEMP/team-image.XXXXXX")
trap 'rm -rf -- "$receipt"' EXIT
layout="$receipt/image"
authfile="$receipt/auth.json"

# Docker's CLI negotiates the Engine API; the distro Skopeo's daemon client
# does not. Export the immutable local ID, then give Skopeo only archive bytes.
tested=$(docker image inspect --format '{{.Id}}' "$AGENT_IMAGE")
if [ "$tested" != "$ACCEPTED_IMAGE_ID" ]; then
  echo '::error::Local image differs from the accepted image ID' >&2
  exit 1
fi
docker save "$tested" --output "$receipt/image.tar"
skopeo inspect --config --raw "docker-archive:$receipt/image.tar" > "$receipt/config.json"
expected="sha256:$(shasum -a 256 "$receipt/config.json" | cut -d' ' -f1)"
# Keep the Docker v2s2 manifest type: converting to another format can rewrite
# configuration bytes. Compress layers now so the registry copy preserves them.
skopeo copy --dest-compress "docker-archive:$receipt/image.tar" "dir:$layout"
manifest="$layout/manifest.json"
digest=$(skopeo manifest-digest "$manifest")
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
config=$(jq -er '.config.digest' "$manifest")
# The config is bound to the exported archive, independent of whether Docker
# uses a config digest (classic store) or manifest/index digest (containerd) ID.
if [ "$config" != "$expected" ]; then
  echo '::error::Prepared image configuration differs from the accepted Docker image' >&2
  exit 1
fi

# PR verification executes the complete preparation with real tools, without
# registry credentials or a registry/release target.
if [ "${1:-}" = --verify ]; then
  printf 'digest=%s\n' "$digest" >> "$GITHUB_OUTPUT"
  printf 'Verified team agent manifest: `%s`\n' "$digest" | tee -a "$GITHUB_STEP_SUMMARY"
  exit 0
fi
: "${IMAGE_REPOSITORY:?}" "${GITHUB_TOKEN:?}" "${GITHUB_REF_NAME:?}" "${GITHUB_ACTOR:?}"

version=${GITHUB_REF_NAME#v}
[[ "$GITHUB_REF_NAME" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
# Prepare the evidence-scoped receipt before any registry write. Invalid or
# incomplete runtime/build evidence fails even if the image itself is valid.
export GH_TOKEN="$GITHUB_TOKEN"
gh release view "$GITHUB_REF_NAME" --json body | jq -jr '.body // ""' > "$receipt/notes.md"
node .github/scripts/team-image-receipt.mjs "$receipt/notes.md" "$IMAGE_REPOSITORY@$digest"

# Only GITHUB_TOKEN is provided, on this step, with job-scoped packages: write.
printf '%s' "$GITHUB_TOKEN" | skopeo login --authfile "$authfile" \
  --username "$GITHUB_ACTOR" --password-stdin ghcr.io
# Inspect raw manifest bytes: formatted inspect can select a platform and report
# a different digest for an index. Only an explicit manifest-unknown permits a
# new tag. Pinned Skopeo redirects logrus fatal output as a quoted message;
# auth, transport, name-unknown and other lookup errors remain failures.
existing=
if skopeo inspect --authfile "$authfile" --raw "docker://$IMAGE_REPOSITORY:$version" \
    > "$receipt/tag.json" 2> "$receipt/tag-error"; then
  existing=$(skopeo manifest-digest "$receipt/tag.json")
  if [ "$existing" != "$digest" ]; then
    echo '::error::Release image tag already points at another digest; refusing overwrite' >&2
    exit 1
  fi
elif ! grep -Eq '^time="[^"]+" level=fatal msg=".*: manifest unknown"$' "$receipt/tag-error"; then
  cat "$receipt/tag-error" >&2
  exit 1
fi
skopeo copy --preserve-digests --authfile "$authfile" \
  "dir:$layout" "docker://$IMAGE_REPOSITORY@$digest"
# The release workflow serializes its own writes. This preflight is not a
# registry compare-and-swap against independently authorized registry writers.
if [ -z "$existing" ]; then
  skopeo copy --preserve-digests --authfile "$authfile" \
    "dir:$layout" "docker://$IMAGE_REPOSITORY:$version"
fi
skopeo inspect --authfile "$authfile" --raw "docker://$IMAGE_REPOSITORY:$version" > "$receipt/tag.json"
resolved=$(skopeo manifest-digest "$receipt/tag.json")
if [ "$resolved" != "$digest" ]; then
  echo '::error::Release image tag does not resolve to the published digest' >&2
  exit 1
fi
printf 'digest=%s\n' "$digest" >> "$GITHUB_OUTPUT"
printf 'Team agent image: `%s@%s`\n' "$IMAGE_REPOSITORY" "$digest" | tee -a "$GITHUB_STEP_SUMMARY"
# Always replace our block with observed evidence, preserving other release prose.
gh release edit "$GITHUB_REF_NAME" --notes-file "$receipt/notes.md"
