#!/bin/sh
# Explicit public-host QA. No model request, login, seat, or API credential.
set -eu
image=${1:?Usage: agent-external-egress-image.sh EGRESS_IMAGE AGENT_IMAGE}
agent_image=${2:?Pass the existing agent image for its shipped Node and git}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
scratch=$(mktemp -d)
prefix="external-egress-$$"
proxy="$prefix-proxy"
client="$prefix-client"
agents="$prefix-agents"
services="$prefix-services"
cleanup() {
  docker logs "$proxy" > "$scratch/proxy.log" 2>&1 || true
  if test -n "${EGRESS_EXTERNAL_EVIDENCE:-}"; then cp "$scratch/proxy.log" "$EGRESS_EXTERNAL_EVIDENCE"; fi
  docker rm -f "$client" "$proxy" >/dev/null 2>&1 || true
  docker network rm "$agents" "$services" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
chmod 755 "$scratch"
docker network create "$services" >/dev/null
# Retain an explicit gateway while isolated mode removes its host address.
docker network create --internal "$agents" >/dev/null
subnet=$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "$agents")
gateway=$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$agents")
docker network rm "$agents" >/dev/null
docker network create --internal --ipv6=false --subnet "$subnet" --gateway "$gateway" --opt com.docker.network.bridge.gateway_mode_ipv4=isolated "$agents" >/dev/null
proxy_ip=$(node -e 'let p=process.argv[1].split(".");p[3]="2";console.log(p.join("."))' "$gateway")
client_ip=$(node -e 'let p=process.argv[1].split(".");p[3]="3";console.log(p.join("."))' "$gateway")
node --input-type=module - "$root" "$scratch" "$proxy_ip" <<'JS'
import fs from "node:fs";
const [root,dir,frontAddress]=process.argv.slice(2);
const {compilePolicy}=await import(root+"/container/agent/egress/policy.mjs");
const text=fs.readFileSync(root+"/container/agent/egress/README.md","utf8");
const policy={...JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]),frontAddress,
  externalTargets:{model:{origin:"https://api.anthropic.com"},source:{origin:"https://github.com"}},
  externalResolverAddresses:["1.1.1.1","8.8.8.8"]};
compilePolicy(policy);
fs.writeFileSync(dir+"/policy.json",JSON.stringify(policy),{mode:0o644});
fs.writeFileSync(dir+"/resolv.conf","nameserver "+frontAddress+"\n",{mode:0o644});
JS
docker run -d --name "$proxy" --network "$agents" --ip "$proxy_ip" --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m,mode=1777 --pids-limit 64 --memory 256m --cpus 1 --sysctl net.ipv4.ip_forward=0 --sysctl net.ipv4.ip_unprivileged_port_start=0 --mount "type=bind,source=$scratch/policy.json,target=/etc/egress/policy.json,readonly" "$image" >/dev/null
docker network connect "$services" "$proxy"
attempt=0
until docker exec "$proxy" node /opt/egress/health.mjs >/dev/null 2>&1; do
  attempt=$((attempt+1));test "$attempt" -lt 15 || exit 1
  sleep 1
done
docker run -d --name "$client" --network "$agents" --ip "$client_ip" --user 20001:20001 --cap-drop ALL --security-opt no-new-privileges:true --read-only --tmpfs /tmp:rw,nosuid,nodev,size=32m,mode=1777 --pids-limit 128 --memory 256m --cpus 1 --mount "type=bind,source=$scratch/resolv.conf,target=/etc/resolv.conf,readonly" --entrypoint sleep "$agent_image" infinity >/dev/null
docker exec -i "$client" node --input-type=module - "$proxy_ip" <<'JS'
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import {spawnSync} from "node:child_process";
const front=process.argv[2];
for(const host of ["github.com","api.anthropic.com"]) {
  assert.deepEqual(await dns.resolve4(host),[front]);
  const code=await new Promise((resolve,reject)=>{
    const req=https.get("https://"+host+"/",{family:4,agent:false},res=>{
      const code=res.statusCode;res.destroy();resolve(code);
    });
    const timer=setTimeout(()=>req.destroy(new Error("public TLS control timeout")),10000);
    req.once("close",()=>clearTimeout(timer));req.once("error",reject);
  });
  assert.ok(code>=200&&code<500);
  console.log(JSON.stringify({host,verifiedTLS:true,status:code}));
}
for(const host of ["api.github.com","human.egress-proof.invalid","unlisted.egress-proof.invalid"]) {
  await assert.rejects(dns.resolve4(host),{code:"ENOTFOUND"});
  await new Promise((resolve,reject)=>{
    let established=false;
    const socket=tls.connect({host:front,port:443,servername:host,rejectUnauthorized:true});
    const timer=setTimeout(()=>{socket.destroy();reject(new Error("refusal timeout"));},3000);
    socket.once("secureConnect",()=>{established=true;socket.destroy();reject(new Error("unlisted SNI accepted"));});
    socket.once("error",error=>{
      clearTimeout(timer);
      if(!established&&["ECONNRESET","EPIPE","ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR","ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE"].includes(error.code))resolve();
      else reject(new Error("unlisted SNI did not establish refusal"));
    });
  });
}
fs.mkdirSync("/tmp/git-home",{mode:0o700});
const git=spawnSync("git",["-c","credential.helper=","ls-remote","--exit-code","https://github.com/oats-project/oats.git","HEAD"],{
  timeout:20000,maxBuffer:65536,encoding:"utf8",stdio:["ignore","pipe","pipe"],
  env:{PATH:process.env.PATH,HOME:"/tmp/git-home",GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0"},
});
assert.equal(git.status,0,"shipped git public HTTPS failed (output withheld)");
assert.match(git.stdout,/^[0-9a-f]{40}\s+HEAD\s*$/);
console.log("PASS shipped Git HTTPS and source/model verified TLS; undeclared DNS/SNI refused");
JS
docker stop --time 5 "$proxy" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$proxy")" = 0
test "$(docker inspect --format '{{.State.OOMKilled}}' "$proxy")" = false
docker logs "$proxy" > "$scratch/proxy.log" 2>&1
grep -q 'sni_refused.*unlisted.egress-proof.invalid' "$scratch/proxy.log"
grep -q 'unlisted.egress-proof.invalid.*NXDOMAIN' "$scratch/proxy.log"
printf '%s\n' 'PASS proxy refusal-name logs and clean stop; no model/wake or public-backend non-delivery claim'
