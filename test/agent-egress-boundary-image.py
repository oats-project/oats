"""CI-only real Compose boundary proof. Own disposable resources, no logins.
The full/default policy and two declared subsets use the same reviewed wrapper,
proxy image and probe. Never run against a deployment or a shared Mac daemon.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

if len(sys.argv) != 4 or sys.argv[3] not in ("full", "aweb,registry", "aweb,registry,secrets"):
    raise SystemExit("usage: agent-egress-boundary-image.py PROXY_IMAGE AGENT_IMAGE full|aweb,registry|aweb,registry,secrets")
root = Path(__file__).resolve().parents[1]
scratch = Path(tempfile.mkdtemp(prefix="egress-boundary-"))
scratch.chmod(0o755)
project = "egress-boundary-" + str(os.getpid())
env = dict(os.environ)
compose = []
created = False

def run(args, **kwargs):
    return subprocess.check_output(args, text=True, env=env, **kwargs).strip()

def docker(*args):
    return run(["docker", *args])

def write(name, text):
    path = scratch / name
    path.write_text(text)
    path.chmod(0o644)
    return str(path)

def bind(source, destination, readonly=True):
    return {"type":"bind", "source":str(source), "target":destination, "read_only":readonly, "bind":{"create_host_path":False}}

try:
    proxy_image = json.loads(docker("image", "inspect", sys.argv[1]))[0]["Id"]
    agent_image = json.loads(docker("image", "inspect", sys.argv[2]))[0]["Id"]
    env.update(AGENTS_SUBNET="172.27.90.0/24", AGENTS_GATEWAY="172.27.90.1", AGENT_IP="172.27.90.3",
               EGRESS_ADDRESS="172.27.90.2", SERVICES_SUBNET="172.27.91.0/24", SERVICES_GATEWAY="172.27.91.1")
    # Refuse before creating any network; a failed observation is never ignored.
    admitted = run(["node", str(root / "container/agent/egress/preflight-network.mjs")])
    for line in admitted.splitlines():
        key, value = line.split("=", 1)
        assert env[key] == value
    roles = {"aweb":"aweb", "secrets":"secrets", "logs":"logs", "signer":"prepare", "registry":"registry"}
    if sys.argv[3] != "full":
        roles = {role:roles[role] for role in sys.argv[3].split(",")}
    hosts = [name + ".example.invalid" for name in roles.values()]
    human = "approve.example.invalid"
    certificate_hosts = hosts + ([human] if "signer" in roles else [])
    config = write("openssl.cnf", "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=" + hosts[0] + "\n[ext]\nsubjectAltName=" + ",".join("DNS:" + h for h in certificate_hosts) + "\nbasicConstraints=critical,CA:TRUE\n")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
                    "-keyout", str(scratch / "key.pem"), "-out", str(scratch / "ca.pem"), "-config", config],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (scratch / "key.pem").chmod(0o444)
    policy = {"frontAddress":env["EGRESS_ADDRESS"], "privateIngressAddresses":["172.27.91.10"],
              "deniedAddresses":["172.27.91.11", "172.27.91.12"],
              "targets":{role:{"origin":"https://" + name + ".example.invalid", "addresses":["172.27.91.10"]} for role, name in roles.items()}}
    if sys.argv[3] != "full":
        policy["roles"] = list(roles)
    if "signer" in roles:
        policy["humanOrigin"] = "https://" + human
    if "registry" in roles:
        policy.update(authorityRecords=[{
            "name":"_awid.team.example.invalid",
            "text":"awid=v1; controller=did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7; registry=https://registry.example.invalid;"}])
    policy_file = write("policy.json", json.dumps(policy))
    paths = {role:"/ready" for role in roles}
    front_program = write("front.mjs", """import fs from 'node:fs';import https from 'node:https';import tls from 'node:tls';
const names=JSON.parse(process.argv[2]);
const ctx=tls.createSecureContext({key:fs.readFileSync('/key.pem'),cert:fs.readFileSync('/ca.pem')});
https.createServer({SNICallback:(name,done)=>names.includes(name)?done(null,ctx):done(new Error('unlisted SNI'))},(req,res)=>{
 const matched=req.headers.host===req.socket.servername;
 res.writeHead(matched&&req.url==='/ready'?200:421);res.end('control');
}).listen(443,'0.0.0.0',()=>console.log('TLS_READY'));
""")
    backend_program = write("backend.mjs", """import net from 'node:net';
net.createServer(socket=>socket.end()).listen(Number(process.argv[2]),'0.0.0.0',()=>console.log('BACKEND_READY'));
""")
    for name in ("state", "login"):
        (scratch / name).mkdir(mode=0o755)
    # /state is empty and writable for UID20001, without a single credential.
    (scratch / "state").chmod(0o777)
    keys_file = write("authorized_keys", "")
    resolver_file = write("resolv.conf", "nameserver " + env["EGRESS_ADDRESS"] + "\n")
    env.update(TEAM=project, AGENTS_NETWORK=project + "-agents", SERVICES_NETWORK=project + "-services",
               AGENT_IMAGE=agent_image, EGRESS_IMAGE=proxy_image, EGRESS_POLICY_FILE=policy_file,
               TEAM_STATE_DIR=str(scratch / "state"), TEAM_LOGIN_DIR=str(scratch / "login"),
               AUTHORIZED_KEYS_FILE=keys_file, RESOLV_CONF_FILE=resolver_file,
               AGENT_UID="20001", AGENT_GID="20001", AGENT_TMP_SIZE="64m", AGENT_PIDS="128", AGENT_MEMORY="512m", AGENT_CPUS="1")
    security = {"image":proxy_image, "user":"10001:10001", "cap_drop":["ALL"],
                "security_opt":["no-new-privileges:true"], "read_only":True, "privileged":False,
                "entrypoint":["node"]}
    overlay = {"services":{
        "agent":{"entrypoint":["sleep"], "command":["infinity"], "healthcheck":{"disable":True},
                 "volumes":[bind(scratch / "ca.pem", "/input/ca.pem")]},
        "front":{**security,"command":["/front.mjs",json.dumps(certificate_hosts)],
                 "sysctls":{"net.ipv4.ip_unprivileged_port_start":"0"},
                 "networks":{"services":{"ipv4_address":"172.27.91.10"}},
                 "volumes":[bind(front_program,"/front.mjs"),bind(scratch / "key.pem","/key.pem"),bind(scratch / "ca.pem","/ca.pem")]},
        **{role:{**security,"command":["/backend.mjs",str(port)],
                 "networks":{"services":{"ipv4_address":address}}, "volumes":[bind(backend_program,"/backend.mjs")]}
           for role,address,port in [("postgres","172.27.91.11",5432),("redis","172.27.91.12",6379)]}}}
    overlay_file = write("compose.probe.json", json.dumps(overlay))
    compose = ["docker", "compose", "-p", project, "-f", str(root / "container/agent/egress/compose.minimal.yaml"), "-f", overlay_file]
    run([*compose,"config","--quiet"])
    created = True
    # Scope --wait to the proxy: the inert agent deliberately disables the
    # inherited SSH healthcheck, which Compose may otherwise still wait for.
    run([*compose,"up","-d","--wait","--wait-timeout","60","egress"])
    run([*compose,"up","-d","agent","front","postgres","redis"])
    for service, token in [("front","TLS_READY"),("postgres","BACKEND_READY"),("redis","BACKEND_READY")]:
        container = run([*compose,"ps","-q",service])
        for _ in range(50):
            if token in docker("logs",container):
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("fixture control did not start: " + service)
    proxy = run([*compose,"ps","-q","egress"])
    approved = [{"Type":"bind","Source":source,"Destination":target,"RW":writable} for source,target,writable in [
        (env["TEAM_STATE_DIR"],"/state",True),(env["TEAM_LOGIN_DIR"],"/etc/agent-login",False),
        (keys_file,"/etc/agent-ssh/authorized_keys",False),(resolver_file,"/etc/resolv.conf",False),
        (str(scratch / "ca.pem"),"/input/ca.pem",False)]]
    plan = {"policy":policy,"allowedPaths":paths,"probeContainer":"oats-agent-" + project,"proxyContainer":proxy,
            "agentsNetwork":env["AGENTS_NETWORK"],"servicesNetwork":env["SERVICES_NETWORK"],
            "probeImage":agent_image,"proxyImage":proxy_image,"uid":20001,"gid":20001,
            "approvedProbeMounts":approved,"protectedSources":[str(scratch / "key.pem")],"caFile":"/input/ca.pem",
            "deniedBackends":[{"role":"postgres","address":"172.27.91.11","port":5432},{"role":"redis","address":"172.27.91.12","port":6379}]}
    probe = ["node", str(root / "container/agent/egress/probe-compose-boundary.mjs"), "--plan", write("runtime.json",json.dumps(plan))]
    result = subprocess.run(probe, env=env, text=True, capture_output=True)
    print(result.stderr, end="", flush=True)
    assert result.returncode == 0 and result.stdout == "OATS_EGRESS_BOUNDARY_PASS\n", "real Compose boundary probe failed"
    if "registry" in roles:
        assert "egress boundary declared: registry: exact namespace authority TXT\n" in result.stderr
        print("PASS registry authority TXT:",sys.argv[3],flush=True)
    print("PASS real Compose boundary:",sys.argv[3],flush=True)
    # An alternate network is refused on every declaration, even if all service
    # controls still answer. Restore only our endpoint before normal cleanup.
    docker("network","connect",env["SERVICES_NETWORK"],plan["probeContainer"])
    result = subprocess.run(probe, env=env, text=True, capture_output=True)
    assert result.returncode != 0 and "OATS_EGRESS_BOUNDARY_PASS" not in result.stdout
    assert "exactly one isolated network" in result.stderr
    docker("network","disconnect",env["SERVICES_NETWORK"],plan["probeContainer"])
    print("PASS alternate-network mutant:",sys.argv[3],flush=True)
finally:
    if created:
        subprocess.run([*compose,"down","--timeout","5"],env=env,check=True)
    shutil.rmtree(scratch)
