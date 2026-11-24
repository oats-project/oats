#!/usr/bin/env bash
# Disposable Linux-runner fixture for the image owner's unmodified acceptance.
set -euo pipefail
: "${AGENT_IMAGE:?Set AGENT_IMAGE to the image built from this checkout}"

fixture=$(mktemp -d)
export TEAM="ci-$(basename "$fixture" | tr '[:upper:].' '[:lower:]-')"
export AGENT_UID=20001 AGENT_GID=20001
# A derived image's child may need more than the base image does.
export AGENT_PIDS="${AGENT_PIDS:-256}" AGENT_MEMORY="${AGENT_MEMORY:-1g}" AGENT_CPUS=1
export AGENT_TMP_SIZE=134217728
export TEAM_STATE_DIR="$fixture/state" TEAM_LOGIN_DIR="$fixture/login"
export AUTHORIZED_KEYS_FILE="$fixture/authorized_keys" RESOLV_CONF_FILE="$fixture/resolv.conf"
export AGENTS_NETWORK="oats-$TEAM" AGENT_IP=172.30.88.2
# The base service intentionally has no optional /work mount.
unset TEAM_WORK_DIR TEAM_INPUT_DIR AGENT_CA_FILE AGENT_MIRRORS_DIR TEAM_OUTBOX_DIR TEAM_OUTBOX_GID
compose=(docker compose -p "oats-$TEAM" -f container/agent/compose.agent.yaml)
# AGENT_CHILD=<name> runs the same fixture with a declared child's switch, on a
# derived image: AGENT_CHILD_FRAGMENT is that image's Compose fragment, which
# may come from another checkout (an absolute path then).
if [ -n "${AGENT_CHILD:-}" ]; then
  compose+=(-f "${AGENT_CHILD_FRAGMENT:?Set AGENT_CHILD_FRAGMENT to the Compose fragment that sets AGENT_CHILD}")
fi

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

# Admission must read the resolver as the runtime UID, not container root.
# These are synthetic root-owned fixture files; no service credential is used.
sudo chmod 600 "$RESOLV_CONF_FILE"
if container/agent/accept.sh "oats-agent-$TEAM" --evidence target-amd64 > "$fixture/unreadable-resolver.log" 2>&1; then
  echo 'Acceptance admitted a root-only resolver' >&2
  exit 1
fi
grep -F 'E_AGENT_RESOLVER: /etc/resolv.conf must be readable and non-empty by the runtime UID' "$fixture/unreadable-resolver.log"
sudo chmod 644 "$RESOLV_CONF_FILE"
sudo truncate -s 0 "$RESOLV_CONF_FILE"
if container/agent/accept.sh "oats-agent-$TEAM" --evidence target-amd64 > "$fixture/empty-resolver.log" 2>&1; then
  echo 'Acceptance admitted an empty resolver' >&2
  exit 1
fi
grep -F 'E_AGENT_RESOLVER: /etc/resolv.conf must be readable and non-empty by the runtime UID' "$fixture/empty-resolver.log"
printf 'nameserver 127.0.0.1\n' | sudo tee "$RESOLV_CONF_FILE" > /dev/null

# The source is operator-provisioned synthetic data, outside writable state.
# Accept the base first: it must have no /inputs, then accept the fragment.
export TEAM_INPUT_DIR="$fixture/inputs"
sudo install -d -o 0 -g "$AGENT_GID" -m 750 "$TEAM_INPUT_DIR"
printf 'synthetic input\n' | sudo tee "$TEAM_INPUT_DIR/example.txt" > /dev/null
sudo chown "0:$AGENT_GID" "$TEAM_INPUT_DIR/example.txt"
sudo chmod 640 "$TEAM_INPUT_DIR/example.txt"
compose+=(-f container/agent/compose.agent.inputs.yaml)
"${compose[@]}" up -d --wait --wait-timeout 120
container/agent/accept.sh "oats-agent-$TEAM" --evidence target-amd64
docker exec "oats-agent-$TEAM" node -e '
  require("node:assert/strict").equal(require("node:fs").readFileSync("/inputs/example.txt", "utf8"), "synthetic input\n");
'

# A dedicated setgid export queue is the only extra writable bind.
export TEAM_OUTBOX_DIR="$fixture/outbox" TEAM_OUTBOX_GID=20002
sudo install -d -o "$AGENT_UID" -g "$TEAM_OUTBOX_GID" -m 2750 "$TEAM_OUTBOX_DIR"
compose+=(-f container/agent/compose.agent.outbox.yaml)
"${compose[@]}" up -d --wait --wait-timeout 120
# umask077-style subdirectories must be scanned as the agent, not root without DAC capabilities.
docker exec "oats-agent-$TEAM" node -e 'require("node:fs").mkdirSync("/outbox/private", {mode: 0o700});'
container/agent/accept.sh "oats-agent-$TEAM" --evidence target-amd64
if [ -n "${AGENT_CHILD:-}" ]; then
  # The switch is the deployment's: acceptance that was not told of it refuses.
  if env -u AGENT_CHILD container/agent/accept.sh "oats-agent-$TEAM" --evidence target-amd64 > "$fixture/unselected-child.log" 2>&1; then
    echo 'Acceptance without AGENT_CHILD unexpectedly admitted a container that has it' >&2
    exit 1
  fi
  grep -F 'AGENT_CHILD is set in the container' "$fixture/unselected-child.log"
  printf 'PASS unselected child: acceptance without AGENT_CHILD refused the container\n'
fi

# This assertion runs in the accepted container, before cleanup or any registry
# credential. Version metadata alone is not runtime evidence.
accepted=$(docker inspect --format '{{.Image}}' "oats-agent-$TEAM")
if [ -n "${TEAM_IMAGE_PACKED_INVENTORY:-}" ]; then
  node .github/scripts/check-team-image-packed-kernel.mjs "oats-agent-$TEAM" "$TEAM_IMAGE_PACKED_INVENTORY"
fi
if [ -n "${EXPECTED_OATS_VERSION:-}" ]; then
  installed=$(docker exec "oats-agent-$TEAM" oats version --json |
    node .github/scripts/check-team-image-release.mjs --installed "$EXPECTED_OATS_VERSION")
  printf 'kernel-version=%s\n' "$installed" >> "${GITHUB_OUTPUT:?}"
fi
# Recreate with an absent source: Compose must fail, without making it.
"${compose[@]}" down --timeout 45
export TEAM_INPUT_DIR="$fixture/missing-inputs"
test ! -e "$TEAM_INPUT_DIR"
test ! -L "$TEAM_INPUT_DIR"
if "${compose[@]}" up -d --wait --wait-timeout 120 > "$fixture/missing-inputs.log" 2>&1; then
  echo 'Missing input source unexpectedly started' >&2
  exit 1
fi
# Require the failure to name the bind source, rather than an unrelated error.
grep -F "$TEAM_INPUT_DIR" "$fixture/missing-inputs.log"
test ! -e "$TEAM_INPUT_DIR"
test ! -L "$TEAM_INPUT_DIR"
printf 'PASS missing input source: startup refused without host-path creation\n'
# Restore the input source so a missing outbox is tested independently.
"${compose[@]}" down --timeout 45
export TEAM_INPUT_DIR="$fixture/inputs"
export TEAM_OUTBOX_DIR="$fixture/missing-outbox"
test ! -e "$TEAM_OUTBOX_DIR"
test ! -L "$TEAM_OUTBOX_DIR"
if "${compose[@]}" up -d --wait --wait-timeout 120 > "$fixture/missing-outbox.log" 2>&1; then
  echo 'Missing outbox source unexpectedly started' >&2
  exit 1
fi
grep -F "$TEAM_OUTBOX_DIR" "$fixture/missing-outbox.log"
test ! -e "$TEAM_OUTBOX_DIR"
test ! -L "$TEAM_OUTBOX_DIR"
printf 'PASS missing outbox source: startup refused without host-path creation\n'
printf 'image-id=%s\n' "$accepted" >> "${GITHUB_OUTPUT:?}"
