#!/bin/sh
# Runs on the host (a developer's machine or a CI runner) and does everything else in a container:
#   container/ci.sh [all|unit|live]        (default: all)
# The container gets 2 CPUs and 6 GB, no mount, no port, no Docker socket and nothing of the host's
# home: the checkout is copied in with tar, and the artefacts (test output, logs, screenshots) are
# copied out to container/out/. bb runs sovereign: no account, BB_TELEMETRY=false, loopback only.
#   KEEP=1            leave the container running afterwards, to work in it (docker exec -it …)
#   NAME=<name>       the container's name (default: bb-plugin-oats-ci-<pid>)
#   DOCKER_RUN_ARGS   extra arguments for docker run (for example "--dns 1.1.1.1")
set -eu
STAGE=${1:-all}
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN=$(dirname "$HERE")
IMAGE=${IMAGE:-bb-plugin-oats-test}
NAME=${NAME:-bb-plugin-oats-ci-$$}
OUT=$HERE/out

docker build -q -t "$IMAGE" "$HERE" > /dev/null
# shellcheck disable=SC2086 # DOCKER_RUN_ARGS is a list of arguments
docker run -d --name "$NAME" --init --cpus 2 --memory 6g -e BB_TELEMETRY=false ${DOCKER_RUN_ARGS:-} "$IMAGE" sleep infinity > /dev/null
cleanup() {
  status=$?
  rm -rf "$OUT"
  mkdir -p "$OUT"
  docker cp "$NAME:/home/node/out/." "$OUT/" > /dev/null 2>&1 || echo "ci: no artefacts to copy out"
  if [ "${KEEP:-0}" = 1 ]; then echo "ci: container $NAME kept"; else docker rm -f "$NAME" > /dev/null; fi
  exit $status
}
trap cleanup EXIT

run() { docker exec -u node -e BB_TELEMETRY=false -w /home/node/plugin "$NAME" "$@"; }
(cd "$PLUGIN" && tar -c --exclude node_modules --exclude dist --exclude ./container/out .) | docker exec -i -u node "$NAME" tar -x -C /home/node/plugin
run mkdir -p /home/node/out
run sh container/setup.sh
case "$STAGE" in
  unit) run sh container/unit.sh ;;
  live) run bash container/live.sh ;;
  all)
    run sh container/unit.sh
    run bash container/live.sh
    ;;
  *)
    echo "usage: container/ci.sh [all|unit|live]" >&2
    exit 2
    ;;
esac
