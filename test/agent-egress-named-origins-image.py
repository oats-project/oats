"""Live public-host check of deployment-named external egress roles.

Two hosted-services policies (no internal role) run in turn behind one
isolated agents network: one names ms-graph and ms-login, the other only
ms-login. From a client in the agent image, a named origin resolves to the
proxy and completes a TLS handshake through it, with the client verifying the
certificate chain and name; an undeclared origin is refused at DNS and at SNI,
and the proxy logs the refused name. No credentials, logins or API requests.
The private-answer refusal is proved in test/agent-egress.test.mjs.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

if len(sys.argv) != 3:
    raise SystemExit("usage: agent-egress-named-origins-image.py EGRESS_IMAGE AGENT_IMAGE")
egress_image, agent_image = sys.argv[1:]
root = Path(__file__).resolve().parent.parent
prefix = "named-origins-" + str(os.getpid())
proxy, client, agents, services = (prefix + suffix for suffix in ("-proxy", "-client", "-agents", "-services"))
scratch = Path(tempfile.mkdtemp(prefix="named-origins-"))
scratch.chmod(0o755)
GRAPH, LOGIN = "graph.microsoft.com", "login.microsoftonline.com"

CLIENT = r"""
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import tls from "node:tls";
const front=process.argv[2], plan=JSON.parse(process.argv[3]);
const refusals=["ECONNRESET","EPIPE","ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR","ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE"];
// By name: the agent's resolver is the proxy, and the client checks the chain and the name.
const handshake=host=>new Promise((resolve,reject)=>{
  const socket=tls.connect({host,port:443,servername:host,rejectUnauthorized:true});
  const timer=setTimeout(()=>{socket.destroy();reject(new Error(host+": handshake timeout"));},10000);
  socket.once("secureConnect",()=>{
    clearTimeout(timer);
    const cert=socket.getPeerCertificate();
    resolve({authorized:socket.authorized,identityError:tls.checkServerIdentity(host,cert)?.message??null,
      address:socket.remoteAddress,subject:cert.subject?.CN??null,issuer:cert.issuer?.CN??null,validTo:cert.valid_to});
    socket.end();
  });
  socket.once("error",error=>{clearTimeout(timer);reject(new Error(host+": handshake failed: "+error.code));});
});
const refusal=host=>new Promise((resolve,reject)=>{
  let established=false;
  const socket=tls.connect({host:front,port:443,servername:host,rejectUnauthorized:true});
  const timer=setTimeout(()=>{socket.destroy();reject(new Error(host+": refusal timeout"));},5000);
  socket.once("secureConnect",()=>{established=true;clearTimeout(timer);socket.destroy();reject(new Error(host+": undeclared SNI completed a handshake"));});
  socket.once("error",error=>{
    clearTimeout(timer);
    if(!established&&refusals.includes(error.code))resolve(error.code);
    else reject(new Error(host+": refusal was not established: "+error.code));
  });
});
for(const [host,expected] of Object.entries(plan)) {
  if(expected==="verified") {
    assert.deepEqual(await dns.resolve4(host),[front],host+": DNS answer bypasses the proxy");
    const result=await handshake(host);
    assert.equal(result.authorized,true,host+": certificate chain not verified");
    assert.equal(result.identityError,null,host+": certificate name mismatch");
    assert.equal(result.address,front,host+": connection bypassed the proxy");
    console.log(JSON.stringify({host,result:"VERIFIED",...result}));
  } else {
    await assert.rejects(dns.resolve4(host),{code:"ENOTFOUND"},host+": undeclared name resolved");
    console.log(JSON.stringify({host,result:"REFUSED",code:await refusal(host)}));
  }
}
"""


def run(args, input=None):
    result = subprocess.run(args, text=True, capture_output=True, input=input)
    if result.returncode:
        raise SystemExit("ERROR " + " ".join(args[:3]) + ": exit " + str(result.returncode) + "\n" + result.stderr.strip())
    return result.stdout.strip()


def docker(*args):
    return run(["docker", *args])


def expect(ok, label, logs=""):
    if not ok:
        raise SystemExit("FAIL " + label + ("\n--- proxy log ---\n" + logs if logs else ""))


def policy(front, roles):
    return {"roles": [], "frontAddress": front, "privateIngressAddresses": [], "deniedAddresses": [], "targets": {},
            "externalTargets": {role: {"origin": "https://" + host} for role, host in roles.items()},
            "externalResolverAddresses": ["1.1.1.1", "8.8.8.8"]}


def start_proxy(label, document):
    path = scratch / (label + ".json")
    path.write_text(json.dumps(document))
    path.chmod(0o644)
    # The component's own compiler accepts the policy before the image sees it.
    run(["node", "--input-type=module", "-e",
         "const {compilePolicy}=await import(process.argv[1]);compilePolicy(JSON.parse(process.argv[2]));",
         (root / "container/agent/egress/policy.mjs").as_uri(), json.dumps(document)])
    docker("run", "-d", "--name", proxy, "--network", agents, "--ip", document["frontAddress"], "--user", "10001:10001",
           "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
           "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m,mode=1777", "--pids-limit", "64", "--memory", "256m", "--cpus", "1",
           "--sysctl", "net.ipv4.ip_forward=0", "--sysctl", "net.ipv4.ip_unprivileged_port_start=0",
           "--mount", "type=bind,source=" + str(path) + ",target=/etc/egress/policy.json,readonly", egress_image)
    docker("network", "connect", services, proxy)
    # health.mjs probes the first external host here: the policy names no internal role.
    for _ in range(15):
        if subprocess.run(["docker", "exec", proxy, "node", "/opt/egress/health.mjs"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            return
        time.sleep(1)
    raise SystemExit("ERROR " + label + ": proxy health did not pass")


def stop_proxy():
    docker("stop", "--time", "5", proxy)
    expect(docker("inspect", "--format", "{{.State.ExitCode}} {{.State.OOMKilled}}", proxy) == "0 false", "proxy clean stop")
    logs = subprocess.run(["docker", "logs", proxy], text=True, capture_output=True, check=True)
    docker("rm", proxy)
    return logs.stdout + logs.stderr


try:
    docker("network", "create", services)
    # Retain an explicit gateway while isolated mode removes its host address.
    docker("network", "create", "--internal", agents)
    subnet = docker("network", "inspect", "--format", "{{(index .IPAM.Config 0).Subnet}}", agents)
    gateway = docker("network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", agents)
    docker("network", "rm", agents)
    docker("network", "create", "--internal", "--ipv6=false", "--subnet", subnet, "--gateway", gateway,
           "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated", agents)
    front, client_ip = (gateway.rsplit(".", 1)[0] + "." + octet for octet in ("2", "3"))
    resolv = scratch / "resolv.conf"
    resolv.write_text("nameserver " + front + "\n")
    resolv.chmod(0o644)
    docker("run", "-d", "--name", client, "--network", agents, "--ip", client_ip, "--user", "20001:20001",
           "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
           "--tmpfs", "/tmp:rw,nosuid,nodev,size=32m,mode=1777", "--pids-limit", "128", "--memory", "256m", "--cpus", "1",
           "--mount", "type=bind,source=" + str(resolv) + ",target=/etc/resolv.conf,readonly",
           "--entrypoint", "sleep", agent_image, "infinity")
    expect(docker("inspect", "--format", "{{len .NetworkSettings.Networks}}", client) == "1", "client joins only the agents network")
    for label, roles, plan in [
        ("with-graph", {"ms-graph": GRAPH, "ms-login": LOGIN}, {GRAPH: "verified", LOGIN: "verified"}),
        ("without-graph", {"ms-login": LOGIN}, {GRAPH: "refused", LOGIN: "verified"}),
    ]:
        start_proxy(label, policy(front, roles))
        print(run(["docker", "exec", "-i", client, "node", "--input-type=module", "-", front, json.dumps(plan)], input=CLIENT))
        logs = stop_proxy()
        refused = [line for line in logs.splitlines() if '"sni_refused"' in line]
        expect("external connection refused" not in logs, label + ": a declared origin's connector refused", logs)
        for host, expected in plan.items():
            named = any('"name":"' + host + '"' in line for line in refused)
            expect(named == (expected == "refused"), label + ": sni_refused log for " + host + " is " + str(named), logs)
            denied = re.search(re.escape(host) + r".*NXDOMAIN", logs) is not None
            expect(denied == (expected == "refused"), label + ": DNS denial log for " + host + " is " + str(denied), logs)
        print("PASS " + label + ": " + ", ".join(host + " " + expected for host, expected in plan.items()))
    print("OATS_EGRESS_NAMED_ORIGINS_PASS policies=2")
finally:
    subprocess.run(["docker", "rm", "-f", client, proxy], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["docker", "network", "rm", agents, services], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(scratch, ignore_errors=True)
