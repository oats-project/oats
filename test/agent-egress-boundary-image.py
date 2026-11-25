"""CI-only real Compose boundary proof. Own disposable resources, no logins.
The full/default policy and three declared subsets use the same reviewed wrapper,
proxy image and probe. `split` runs plan schema 2 and the services witness from
the deploy copy extracted from the egress image, against a second Compose
project on its own disjoint network. Never run against a deployment or a shared
Mac daemon.
"""
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

if len(sys.argv) != 4 or sys.argv[3] not in ("full", "aweb,registry", "aweb,registry,secrets", "aweb,logs,registry,secrets", "split"):
    raise SystemExit("usage: agent-egress-boundary-image.py PROXY_IMAGE AGENT_IMAGE full|aweb,registry|aweb,registry,secrets|aweb,logs,registry,secrets|split")
split = sys.argv[3] == "split"
root = Path(__file__).resolve().parents[1]
scratch = Path(tempfile.mkdtemp(prefix="egress-boundary-"))
scratch.chmod(0o755)
project = "egress-boundary-" + str(os.getpid())
services_project = project + "-services"
env = dict(os.environ)
compose = []
services_compose = []
created = False
services_created = False
# Unassigned and unrouted: not local to this engine host, and nothing answers.
services_address = "192.0.2.10"
external_database = "192.0.2.11"

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

def policy_hash(policy):
    """The canonical policy hash, as the spec defines it for other languages."""
    text = json.dumps(policy, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()

def node_json(command):
    result = subprocess.run(command, env=env, text=True, capture_output=True)
    print(result.stderr, end="", flush=True)
    return result.returncode, json.loads(result.stdout)

def run_split(plan, policy, proxy_image, prefix):
    """Plan schema 2 and the services witness, each from the deploy copy
    extracted from the reviewed egress image, never from this checkout."""
    global services_compose, services_created
    deploy = scratch / "deploy"
    container = docker("create", proxy_image)
    try:
        docker("cp", container + ":/opt/oats/deploy", str(deploy))
    finally:
        docker("rm", container)
    source = json.loads((deploy / "manifest.json").read_text())["source"]
    assert source == env["TEAM_IMAGE_SOURCE_SHA"], "deploy copy source differs from the reviewed commit"
    backend_program = scratch / "backend.mjs"
    healthcheck = "require('node:net').connect(Number(process.argv[1]),'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
    services = {"services":{role:{"image":proxy_image,"user":"10001:10001","cap_drop":["ALL"],"security_opt":["no-new-privileges:true"],
                                  "read_only":True,"entrypoint":["node"],"command":["/backend.mjs",str(port)],"expose":[str(port)],
                                  "healthcheck":{"test":["CMD","node","-e",healthcheck,str(port)],"interval":"1s","timeout":"2s","retries":30},
                                  "networks":["backends"],"volumes":[bind(backend_program,"/backend.mjs")]}
                            for role, port in [("postgres",5432),("redis",6379)]},
                "networks":{"backends":{"name":services_project + "-backends","ipam":{"config":[{"subnet":"172.27.92.0/24"}]}}}}
    services_compose = ["docker","compose","-p",services_project,"-f",write("compose.services.json",json.dumps(services))]
    run([*services_compose,"config","--quiet"])
    services_created = True
    run([*services_compose,"up","-d","--wait","--wait-timeout","60"])
    print("Docker engine:", docker("version","--format","{{.Server.Version}} API {{.Server.APIVersion}}"),
          "compose:", run(["docker","compose","version","--short"]), flush=True)
    for service in ("postgres","redis"):
        container_id = run([*services_compose,"ps","-q","--no-trunc",service])
        print("fixture ports", service, docker("inspect","--format","{{json .Config.ExposedPorts}} {{json .HostConfig.PortBindings}} {{json .NetworkSettings.Ports}}",container_id), flush=True)
    redis_id = run([*services_compose,"ps","-q","--no-trunc","redis"])
    redis_address = json.loads(docker("inspect",redis_id))[0]["NetworkSettings"]["Networks"][services_project + "-backends"]["IPAddress"]
    # Disjoint projects: the agent project's outward bridge has no route to them.
    classify = run(["node","--input-type=module","-e","const m=await import(process.argv[1]);process.stdout.write(m.classifyProgram)",
                    (deploy / "egress/canary.mjs").as_uri()])
    answer = docker("run","--rm","--network",env["SERVICES_NETWORK"],"--entrypoint","node",proxy_image,"--input-type=module","-e",classify,redis_address,"6379")
    assert answer == "DENIED", "the agent project reaches the services project"
    print("PASS disjoint Compose projects", flush=True)

    probe = str(deploy / "egress/probe-compose-boundary.mjs")
    witness = str(deploy / "egress/probe-services-backends.mjs")
    run_binding = {"id":project,"policyHash":policy_hash(policy),"servicesDeployment":services_project}
    plan = {**{key:value for key, value in plan.items() if key != "deniedBackends"},"schema":2,"run":run_binding}
    for mode in ("bundled","external"):
        backends = [{"role":"postgres","port":5432},{"role":"redis","port":6379}] if mode == "bundled" \
            else [{"role":"postgres","port":5432,"address":external_database,"external":True},{"role":"redis","port":6379}]
        plan["remoteBackends"] = {"servicesAddress":services_address,"backends":backends}
        code, result = node_json(["node",probe,"--plan",write("split-" + mode + ".json",json.dumps(plan)),"--json"])
        assert code == 0, "split boundary probe failed: " + mode
        receipts = result.pop("receipts")
        assert len(receipts) == 7 and all(r["created"] and r["absentVerified"] and r["name"].startswith(prefix) for r in receipts)
        postgres_address = external_database if mode == "external" else services_address
        rows = [{"role":role,"port":port,"address":address,"vantage":vantage,"result":"DENIED","required":not (mode == "external" and role == "postgres" and vantage == "outward-bridge")}
                for role, port, address in [("postgres",5432,postgres_address),("redis",6379,services_address)] for vantage in ("isolated-agent","outward-bridge")]
        assert [list(row) for row in result["remote"]["results"]] == [["role","port","address","vantage","result","required"]] * 4
        assert result == {"passed":True,"mode":"split","run":run_binding,"sourceCommit":source,
                          "remote":{"servicesAddress":services_address,"vantage":["isolated-agent","outward-bridge"],"results":rows}}, result
        witness_plan = {"schema":1,"run":run_binding,"servicesAddress":services_address,"composeProject":services_project,"policy":policy,
                        "backends":([{"role":"postgres","service":"postgres","port":5432}] if mode == "bundled" else []) + [{"role":"redis","service":"redis","port":6379}],
                        "canaryImage":proxy_image,"namePrefix":prefix}
        code, result = node_json(["node",witness,"--plan",write("witness-" + mode + ".json",json.dumps(witness_plan)),"--json"])
        assert code == 0, "services witness failed: " + mode
        receipts = result.pop("receipts")
        assert len(receipts) == len(witness_plan["backends"]) and all(r["created"] and r["absentVerified"] for r in receipts)
        records = result.pop("backends")
        assert [r["role"] for r in records] == [b["role"] for b in witness_plan["backends"]]
        for record, declared in zip(records, witness_plan["backends"]):
            assert record == {"role":declared["role"],"service":declared["service"],"containerId":run([*services_compose,"ps","-q","--no-trunc",declared["service"]]),
                              "image":proxy_image,"imageId":proxy_image,"networks":[services_project + "-backends"],"port":declared["port"],
                              "health":"healthy","published":False,"control":"CONNECTED"}, record
        assert result["observed"]["addressOnHost"] is False and result["observed"]["composeProject"] == services_project
        del result["observed"]
        assert result == {"passed":True,"run":run_binding,"sourceCommit":source,"servicesAddress":services_address,"canaryImage":proxy_image}, result
        print("PASS split boundary and services witness:", mode, flush=True)

    plan["remoteBackends"] = {"servicesAddress":redis_address,"backends":[{"role":"postgres","port":5432},{"role":"redis","port":6379}]}
    result = subprocess.run(["node",probe,"--plan",write("split-local.json",json.dumps(plan)),"--json"], env=env, text=True, capture_output=True)
    assert result.returncode == 1 and "E_EGRESS_REMOTE_LOCAL" in result.stderr, result.stderr
    assert json.loads(result.stdout) == {"passed":False,"receipts":[],"error":"boundary probe refused"}
    print("PASS local services address mutant", flush=True)

    published = write("compose.published.json", json.dumps({"services":{"redis":{"ports":["127.0.0.1::6379"]}}}))
    run([*services_compose,"-f",published,"up","-d","--wait","--wait-timeout","60","redis"])
    result = subprocess.run(["node",witness,"--plan",str(scratch / "witness-external.json"),"--json"], env=env, text=True, capture_output=True)
    assert result.returncode == 1 and "redis publishes a port on the services host" in result.stderr, result.stderr
    assert json.loads(result.stdout) == {"passed":False,"receipts":[],"error":"services witness refused"}
    print("PASS published port mutant", flush=True)

    # The proxy compiled its policy at startup. Rewrite the mounted file in place
    # (same inode, so the bind mount shows it) and regenerate the plan from it:
    # the file comparison now agrees, and only the proxy's loaded record refuses.
    changed = {**policy, "deniedAddresses":[*policy["deniedAddresses"], "192.0.2.12"]}
    assert write("policy.json", json.dumps(changed)) == policy_file
    plan.update(policy=changed, run={**run_binding, "policyHash":policy_hash(changed)},
                remoteBackends={"servicesAddress":services_address,"backends":[{"role":"postgres","port":5432},{"role":"redis","port":6379}]})
    result = subprocess.run(["node",probe,"--plan",write("split-stale.json",json.dumps(plan)),"--json"], env=env, text=True, capture_output=True)
    assert result.returncode == 1 and "E_EGRESS_POLICY_STALE" in result.stderr, result.stderr
    assert json.loads(result.stdout) == {"passed":False,"receipts":[],"error":"boundary probe refused"}
    print("PASS stale proxy policy mutant", flush=True)

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
    if sys.argv[3] not in ("full", "split"):
        roles = {role:roles[role] for role in sys.argv[3].split(",")}
    hosts = [name + ".example.invalid" for name in roles.values()]
    human = "approve.example.invalid"
    secrets_anchor = sys.argv[3] == "aweb,logs,registry,secrets"
    certificate_hosts = hosts + ([human] if "signer" in roles or secrets_anchor else [])
    config = write("openssl.cnf", "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=" + hosts[0] + "\n[ext]\nsubjectAltName=" + ",".join("DNS:" + h for h in certificate_hosts) + "\nbasicConstraints=critical,CA:TRUE\n")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
                    "-keyout", str(scratch / "key.pem"), "-out", str(scratch / "ca.pem"), "-config", config],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (scratch / "key.pem").chmod(0o444)
    policy = {"frontAddress":env["EGRESS_ADDRESS"], "privateIngressAddresses":["172.27.91.10"],
              "deniedAddresses":[external_database] if split else ["172.27.91.11", "172.27.91.12"],
              "targets":{role:{"origin":"https://" + name + ".example.invalid", "addresses":["172.27.91.10"]} for role, name in roles.items()}}
    if sys.argv[3] not in ("full", "split"):
        policy["roles"] = list(roles)
    if secrets_anchor:
        policy["humanRole"] = "secrets"
    if "signer" in roles or secrets_anchor:
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
        **({} if split else {role:{**security,"command":["/backend.mjs",str(port)],
                 "networks":{"services":{"ipv4_address":address}}, "volumes":[bind(backend_program,"/backend.mjs")]}
           for role,address,port in [("postgres","172.27.91.11",5432),("redis","172.27.91.12",6379)]})}}
    overlay_file = write("compose.probe.json", json.dumps(overlay))
    compose = ["docker", "compose", "-p", project, "-f", str(root / "container/agent/egress/compose.minimal.yaml"), "-f", overlay_file]
    run([*compose,"config","--quiet"])
    created = True
    # Scope --wait to the proxy: the inert agent deliberately disables the
    # inherited SSH healthcheck, which Compose may otherwise still wait for.
    run([*compose,"up","-d","--wait","--wait-timeout","60","egress"])
    fixtures = [("front","TLS_READY")] + ([] if split else [("postgres","BACKEND_READY"),("redis","BACKEND_READY")])
    run([*compose,"up","-d","agent",*[service for service, _ in fixtures]])
    for service, token in fixtures:
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
    plan = {"schema":1,"policy":policy,"allowedPaths":paths,"probeContainer":"oats-agent-" + project,"proxyContainer":proxy,
            "agentsNetwork":env["AGENTS_NETWORK"],"servicesNetwork":env["SERVICES_NETWORK"],
            "probeImage":agent_image,"proxyImage":proxy_image,"uid":20001,"gid":20001,
            "approvedProbeMounts":approved,"protectedSources":[str(scratch / "key.pem")],"caFile":"/input/ca.pem",
            "deniedBackends":[{"role":"postgres","address":"172.27.91.11","port":5432},{"role":"redis","address":"172.27.91.12","port":6379}]}
    custom_prefix = None if sys.argv[3] == "full" else "lab.fixture-" + str(os.getpid()) + "-"
    if custom_prefix:
        plan["namePrefix"] = custom_prefix
    if split:
        run_split(plan, policy, proxy_image, custom_prefix)
        raise SystemExit(0)
    probe = ["node", str(root / "container/agent/egress/probe-compose-boundary.mjs"), "--plan", write("runtime.json",json.dumps(plan))]
    if custom_prefix:
        probe.append("--json")
    result = subprocess.run(probe, env=env, text=True, capture_output=True)
    print(result.stderr, end="", flush=True)
    assert result.returncode == 0, "real Compose boundary probe failed"
    receipts = [json.loads(line[len("egress boundary receipt: "):]) for line in result.stderr.splitlines()
                if line.startswith("egress boundary receipt: ")]
    assert len(receipts) == 9 and len({r["name"] for r in receipts}) == 9
    for receipt in receipts:
        assert set(receipt) == {"name", "image", "network", "created", "absentVerified"}
        assert receipt["created"] is True and receipt["absentVerified"] is True
        assert receipt["image"] == proxy_image and receipt["network"] in ("host", env["SERVICES_NETWORK"])
        prefix = custom_prefix or ("oats-egress-canary-" if receipt["network"] == "host" else "oats-egress-tcp-")
        assert receipt["name"].startswith(prefix)
        assert docker("ps", "-a", "--filter", "name=^" + re.escape(receipt["name"]) + "$", "--format", "{{.ID}}") == ""
    assert sum(r["network"] == "host" for r in receipts) == 1
    if custom_prefix:
        assert json.loads(result.stdout) == {"passed":True, "receipts":receipts}
    else:
        assert result.stdout == "OATS_EGRESS_BOUNDARY_PASS\n"
    print("PASS container receipts:", "custom JSON" if custom_prefix else "default token", sys.argv[3], flush=True)
    if "registry" in roles:
        assert "egress boundary declared: registry: exact namespace authority TXT\n" in result.stderr
        print("PASS registry authority TXT:",sys.argv[3],flush=True)
    if secrets_anchor:
        assert "egress boundary declared: secrets: human DNS/TLS refusal; separate ingress admission required\n" in result.stderr
    print("PASS real Compose boundary:",sys.argv[3],flush=True)
    # An alternate network is refused on every declaration, even if all service
    # controls still answer. Restore only our endpoint before normal cleanup.
    docker("network","connect",env["SERVICES_NETWORK"],plan["probeContainer"])
    result = subprocess.run(probe, env=env, text=True, capture_output=True)
    assert result.returncode != 0 and "OATS_EGRESS_BOUNDARY_PASS" not in result.stdout
    assert "exactly one isolated network" in result.stderr
    if custom_prefix:
        assert json.loads(result.stdout) == {"passed":False, "receipts":[], "error":"boundary probe refused"}
    else:
        assert result.stdout == ""
    docker("network","disconnect",env["SERVICES_NETWORK"],plan["probeContainer"])
    print("PASS alternate-network mutant:",sys.argv[3],flush=True)
finally:
    if services_created:
        subprocess.run([*services_compose,"down","--timeout","5"],env=env,check=True)
    if created:
        subprocess.run([*compose,"down","--timeout","5"],env=env,check=True)
    shutil.rmtree(scratch)
