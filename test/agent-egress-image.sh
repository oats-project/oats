#!/bin/sh
# Native image regression; build the image separately, then pass its local ID.
set -eu
image=${1:?Usage: agent-egress-image.sh IMAGE}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
scratch=$(mktemp -d)
name="oats-egress-smoke-$$"
cleanup() {
  docker logs "$name" > "$scratch/container.log" 2>&1 || true
  if test -n "${EGRESS_SMOKE_EVIDENCE:-}"; then cp "$scratch/container.log" "$EGRESS_SMOKE_EVIDENCE"; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
node -e 'const fs=require("node:fs");const s=fs.readFileSync(process.argv[1],"utf8");const m=s.match(/```json\n([\s\S]*?)\n```/);fs.writeFileSync(process.argv[2],JSON.stringify(JSON.parse(m[1])),{mode:0o644})' "$root/container/agent/egress/README.md" "$scratch/policy.json"
chmod 755 "$scratch"
docker run --detach --name "$name" --network none --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m,mode=1777 --pids-limit 64 --memory 256m --cpus 1 --sysctl net.ipv4.ip_forward=0 --sysctl net.ipv4.ip_unprivileged_port_start=0 --mount "type=bind,source=$scratch/policy.json,target=/etc/egress/policy.json,readonly" "$image" >/dev/null
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
