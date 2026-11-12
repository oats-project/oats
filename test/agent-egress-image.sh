#!/bin/sh
# Native image regression; build the image separately, then pass its local ID.
set -eu
image=${1:?Usage: agent-egress-image.sh IMAGE}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
scratch=$(mktemp -d)
name="oats-egress-smoke-$$"
plain="oats-egress-plain-$$"
isolated="oats-egress-isolated-$$"
probe="oats-egress-network-probe-$$"
cleanup() {
  docker logs "$name" > "$scratch/container.log" 2>&1 || true
  if test -n "${EGRESS_SMOKE_EVIDENCE:-}"; then cp "$scratch/container.log" "$EGRESS_SMOKE_EVIDENCE"; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker rm -f "$probe" >/dev/null 2>&1 || true
  docker network rm "$plain" "$isolated" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
node -e 'const fs=require("node:fs");const s=fs.readFileSync(process.argv[1],"utf8");const m=s.match(/```json\n([\s\S]*?)\n```/);fs.writeFileSync(process.argv[2],JSON.stringify(JSON.parse(m[1])),{mode:0o644})' "$root/container/agent/egress/README.md" "$scratch/policy.json"
chmod 755 "$scratch"
docker run --detach --name "$name" --network none --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m,mode=1777 --pids-limit 64 --memory 256m --cpus 1 --sysctl net.ipv4.ip_forward=0 --sysctl net.ipv4.ip_unprivileged_port_start=0 --mount "type=bind,source=$scratch/policy.json,target=/etc/egress/policy.json,readonly" "$image" >/dev/null
if docker run --rm --network none --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true --read-only --entrypoint node "$image" /opt/egress/probe-ingress.mjs > "$scratch/probe-out" 2> "$scratch/probe-error"; then
  printf '%s\n' 'FAIL ingress probe accepted missing arguments' >&2
  exit 1
fi
test ! -s "$scratch/probe-out"
grep -q '^egress: ingress authority or backend non-delivery proof failed (values withheld)$' "$scratch/probe-error"
attempt=0
until result=$(docker exec "$name" node /opt/egress/health.mjs 2>/dev/null); do
  attempt=$((attempt+1))
  if test "$attempt" -ge 10; then docker logs "$name"; exit 1; fi
  sleep 1
done
test "$result" = EGRESS_READY
docker exec "$name" node -e 'const fs=require("node:fs");if(process.getuid()!==10001)throw new Error("uid differs");for(const path of ["/opt/denied","/run/denied"]){try{fs.writeFileSync(path,"x");throw new Error("root was writable")}catch(e){if(e.code!=="EROFS")throw e}}'
docker stop --time 5 "$name" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$name")" = 0
test "$(docker inspect --format '{{.State.OOMKilled}}' "$name")" = false
printf '%s\n' 'PASS proxy image: UID 10001, dropped capabilities, read-only root, DNS and TLS readiness, clean stop'

# A live host listener distinguishes a closed boundary from an absent service.
docker network create --internal "$plain" >/dev/null
docker network create --internal --opt com.docker.network.bridge.gateway_mode_ipv4=isolated "$isolated" >/dev/null
gateway=$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$plain")
docker run -d --name "$probe" --network "$isolated" --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true --read-only --entrypoint sleep "$image" infinity >/dev/null
node --input-type=module -e 'const {checkDockerGateway}=await import(process.argv[1]);await checkDockerGateway({image:process.argv[2],controlNetwork:process.argv[3],gatewayAddress:process.argv[4],probeContainer:process.argv[5]})' "$root/container/agent/egress/canary.mjs" "$image" "$plain" "$gateway" "$probe"
printf '%s\n' 'PASS host gateway: live positive controls; isolated agent bridge denied'
