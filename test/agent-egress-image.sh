#!/bin/sh
# Native image regression; build the image separately, then pass its local ID.
set -eu
image=${1:?Usage: agent-egress-image.sh IMAGE}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
scratch=$(mktemp -d)
name="gateway-correction-smoke-$$"
control="gateway-correction-control-$$"
plain="gateway-correction-plain-$$"
isolated="gateway-correction-isolated-$$"
probe="gateway-correction-probe-$$"
cleanup() {
  docker logs "$name" > "$scratch/container.log" 2>&1 || true
  if test -n "${EGRESS_SMOKE_EVIDENCE:-}"; then cp "$scratch/container.log" "$EGRESS_SMOKE_EVIDENCE"; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker rm -f "$probe" >/dev/null 2>&1 || true
  docker network rm "$control" "$plain" "$isolated" >/dev/null 2>&1 || true
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

# Test each agents bridge's own on-link gateway, with a separate live control.
docker network create --internal "$control" >/dev/null
docker network create --internal "$plain" >/dev/null
# Reserve a free Docker subnet, then retain an explicit IPAM gateway even
# though isolated mode removes that address from the host bridge.
docker network create --internal "$isolated" >/dev/null
isolated_subnet=$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "$isolated")
isolated_gateway=$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$isolated")
docker network rm "$isolated" >/dev/null
docker network create --internal --subnet "$isolated_subnet" --gateway "$isolated_gateway" --opt com.docker.network.bridge.gateway_mode_ipv4=isolated "$isolated" >/dev/null
control_gateway=$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$control")
plain_gateway=$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$plain")
test "$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$isolated")" = "$isolated_gateway"
docker run -d --name "$probe" --network "$plain" --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true --read-only --entrypoint sleep "$image" infinity >/dev/null
node --input-type=module -e 'const {default:assert}=await import("node:assert/strict");const {checkDockerGateway}=await import(process.argv[1]);const options={image:process.argv[2],controlNetwork:process.argv[3],controlAddress:process.argv[4],gatewayAddress:process.argv[5],probeContainer:process.argv[6]};await checkDockerGateway({...options,expectedReachable:true});await assert.rejects(checkDockerGateway(options),{code:"ERR_ASSERTION",message:/^probe can reach the host gateway(?:\n|$)/,actual:"CONNECTED",expected:"DENIED"})' "$root/container/agent/egress/canary.mjs" "$image" "$control" "$control_gateway" "$plain_gateway" "$probe"
docker rm -f "$probe" >/dev/null
printf '%s\n' 'PASS plain host gateway: reachable on-link canary; boundary refused'
docker run -d --name "$probe" --network "$isolated" --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true --read-only --entrypoint sleep "$image" infinity >/dev/null
node --input-type=module -e 'const {checkDockerGateway}=await import(process.argv[1]);await checkDockerGateway({image:process.argv[2],controlNetwork:process.argv[3],controlAddress:process.argv[4],gatewayAddress:process.argv[5],probeContainer:process.argv[6]})' "$root/container/agent/egress/canary.mjs" "$image" "$control" "$control_gateway" "$isolated_gateway" "$probe"
printf '%s\n' 'PASS host gateway: live positive controls; isolated agent bridge denied'
