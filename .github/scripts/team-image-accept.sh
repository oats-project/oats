#!/usr/bin/env bash
# Disposable Linux-runner fixture for the image owner's unmodified acceptance.
set -euo pipefail
: "${AGENT_IMAGE:?Set AGENT_IMAGE to the image built from this checkout}"

fixture=$(mktemp -d)
export TEAM="ci-$(basename "$fixture" | tr '[:upper:].' '[:lower:]-')"
export AGENT_UID=20001 AGENT_GID=20001
export AGENT_PIDS=256 AGENT_MEMORY=1g AGENT_CPUS=1
export AGENT_TMP_SIZE=134217728
export TEAM_STATE_DIR="$fixture/state" TEAM_LOGIN_DIR="$fixture/login"
export AUTHORIZED_KEYS_FILE="$fixture/authorized_keys" RESOLV_CONF_FILE="$fixture/resolv.conf"
export AGENTS_NETWORK="oats-$TEAM" AGENT_IP=172.30.88.2
# The base service intentionally has no optional /work mount.
unset TEAM_WORK_DIR
compose=(docker compose -p "oats-$TEAM" -f container/agent/compose.agent.yaml)

cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    "${compose[@]}" logs --no-color || echo 'Could not collect fixture logs' >&2
  fi
  # Cleanup failures must remain visible and turn a successful check red.
  "${compose[@]}" down --timeout 45 || result=1
  docker network rm "$AGENTS_NETWORK" || result=1
  sudo rm -rf -- "$fixture" || result=1
  exit "$result"
}
trap cleanup EXIT

# These are private fixture paths, never a developer's home, login or deployment.
chmod 755 "$fixture"
sudo install -d -o "$AGENT_UID" -g "$AGENT_GID" -m 700 "$TEAM_STATE_DIR"
sudo install -d -o 0 -g "$AGENT_GID" -m 750 "$TEAM_LOGIN_DIR"
# No inference credential is provisioned. Acceptance records those checks NOT RUN.
ssh-keygen -q -t ed25519 -N '' -f "$fixture/key"
cp "$fixture/key.pub" "$AUTHORIZED_KEYS_FILE"
printf 'nameserver 127.0.0.1\n' > "$RESOLV_CONF_FILE"
chmod 644 "$AUTHORIZED_KEYS_FILE" "$RESOLV_CONF_FILE"
sudo chown 0:0 "$AUTHORIZED_KEYS_FILE" "$RESOLV_CONF_FILE"

engine_major=$(docker version --format '{{.Server.Version}}' | cut -d. -f1)
if ! [[ "$engine_major" =~ ^[0-9]+$ ]] || [ "$engine_major" -lt 28 ]; then
  echo 'Docker Engine 28+ is required for isolated bridge gateway mode' >&2
  exit 1
fi
# Internal network: the fixture needs only loopback SSH and local broker state.
# A subnet collision fails the check rather than selecting an unreviewed network.
docker network create --internal --ipv6=false \
  --opt com.docker.network.bridge.gateway_mode_ipv4=isolated \
  --subnet 172.30.88.0/24 "$AGENTS_NETWORK"
"${compose[@]}" up -d --wait --wait-timeout 120
container/agent/accept.sh "oats-agent-$TEAM" --evidence target-amd64

# This assertion runs in the accepted container, before cleanup or any registry
# credential. Version metadata alone is not runtime evidence.
accepted=$(docker inspect --format '{{.Image}}' "oats-agent-$TEAM")
if [ -n "${EXPECTED_OATS_VERSION:-}" ]; then
  installed=$(docker exec "oats-agent-$TEAM" oats version --json |
    node .github/scripts/check-team-image-release.mjs --installed "$EXPECTED_OATS_VERSION")
  printf 'kernel-version=%s\n' "$installed" >> "${GITHUB_OUTPUT:?}"
fi
printf 'image-id=%s\n' "$accepted" >> "${GITHUB_OUTPUT:?}"
