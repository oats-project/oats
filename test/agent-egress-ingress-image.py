"""Exercise the packaged full ingress CLI against disposable real H1/H2 TLS.
This generic transport fixture is not an AWID/application deployment.
"""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import os
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: agent-egress-ingress-image.py IMAGE")
scratch = Path(tempfile.mkdtemp(prefix="ingress-cli-"))
scratch.chmod(0o755)
network = "ingress-cli-" + str(os.getpid())
front = network + "-front"
image = sys.argv[1]
roles = {"aweb": ("aweb", "/ready"), "secrets": ("secrets", "/ready"), "logs": ("logs", "/ready"), "signer": ("prepare", "/readyz"), "registry": ("registry", "/health")}
hosts = {role: name + ".example.invalid" for role, (name, _) in roles.items()}
human = "approve.example.invalid"
created = False

def run(args, **kw):
    return subprocess.check_output(args, text=True, **kw).strip()

def docker(*args):
    return run(["docker", *args])

def write(name, text):
    path = scratch / name
    path.write_text(text)
    path.chmod(0o644)
    return str(path)

def mount(path, target, readonly=True):
    return ["--mount", "type=bind,source=" + str(path) + ",target=" + target + (",readonly" if readonly else "")]

try:
    logs = scratch / "logs"
    logs.mkdir(mode=0o777)
    logs.chmod(0o777)
    for host in [*hosts.values(), human]:
        write("logs/" + host + ".log", "")
        (logs / (host + ".log")).chmod(0o666)
    conf = write("openssl.cnf", "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=" + hosts["signer"] + "\n[ext]\nsubjectAltName=" + ",".join("DNS:" + h for h in [*hosts.values(), human]) + "\nbasicConstraints=critical,CA:TRUE\n")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1", "-keyout", str(scratch / "key.pem"), "-out", str(scratch / "ca.pem"), "-config", conf], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (scratch / "key.pem").chmod(0o444)
    (scratch / "ca.pem").chmod(0o444)
    paths = {hosts[role]: path for role, (_, path) in roles.items()}
    paths[human] = "/handoff-assets/handoff.css"
    server = write("front.mjs", """import fs from 'node:fs';import h2 from 'node:http2';import tls from 'node:tls';
const paths=JSON.parse(process.argv[2]),ctx=tls.createSecureContext({key:fs.readFileSync('/key.pem'),cert:fs.readFileSync('/ca.pem')});
const server=h2.createSecureServer({allowHTTP1:true,SNICallback:(name,done)=>Object.hasOwn(paths,name)?done(null,ctx):done(new Error('unlisted SNI'))});
server.on('request',(req,res)=>{
 const authority=req.headers[':authority']||req.headers.host,sni=req.socket.servername;
 const matched=authority===sni||authority===sni+':443';
 const pathname=new URL(req.url,'https://example.invalid').pathname;
 const humanAuthority=authority==='approve.example.invalid'||authority==='approve.example.invalid:443';
 const fault='/logs/secrets-fault-sni';
 if(humanAuthority&&fs.existsSync(fault)&&sni===fs.readFileSync(fault,'utf8').trim()){
   fs.appendFileSync('/logs/secrets-delivery.log',pathname+'\\n');
   if(pathname==='/ready'||pathname==='/live')fs.appendFileSync('/logs/secrets.example.invalid.log',req.url+'\\n');
   res.writeHead(421);res.end();return;
 }
 const weak=fs.existsSync('/logs/weak-route')&&sni==='aweb.example.invalid'&&(authority==='approve.example.invalid'||authority==='approve.example.invalid:443');
 if(!matched&&!weak){res.writeHead(421);res.end();return}
 const host=authority.split(':')[0];
 if(!Object.hasOwn(paths,host)){res.writeHead(404);res.end();return}
 if(host!=='secrets.example.invalid'||pathname==='/ready'||pathname==='/live')
   fs.appendFileSync('/logs/'+host+'.log',req.url+'\\n');
 res.writeHead(!matched?421:pathname===paths[host]?200:404);res.end('control');
});
server.listen(443,'0.0.0.0',()=>console.log('TLS_CONTROLS_READY'));
""")
    policy = {"frontAddress": "172.27.95.2", "privateIngressAddresses": ["172.27.94.10"], "deniedAddresses": ["172.27.94.11", "172.27.94.12"], "humanOrigin": "https://" + human, "authorityRecords": [{"name": "_awid.team.example.invalid", "text": "awid=v1; controller=did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7; registry=https://registry.example.invalid;"}], "targets": {role: {"origin": "https://" + host, "addresses": ["172.27.94.10"]} for role, host in hosts.items()}}
    policy_file = write("policy.json", json.dumps(policy))
    route_file = write("route-logs.json", json.dumps({role: {"path": path, "log": "/logs/" + hosts[role] + ".log"} for role, (_, path) in roles.items()}))
    docker("network", "create", "--internal", "--subnet", "172.27.94.0/24", network)
    created = True
    security = ["--user", "10001:10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only"]
    docker("run", "-d", "--name", front, "--network", network, "--ip", "172.27.94.10", *security, "--sysctl", "net.ipv4.ip_unprivileged_port_start=0", *mount(server, "/front.mjs"), *mount(scratch / "key.pem", "/key.pem"), *mount(scratch / "ca.pem", "/ca.pem"), *mount(logs, "/logs", False), "--entrypoint", "node", image, "/front.mjs", json.dumps(paths))
    for _ in range(30):
        if "TLS_CONTROLS_READY" in docker("logs", front):
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("TLS control listener did not become ready")
    args = ["docker", "run", "--rm", "--network", network, *security, *mount(policy_file, "/input/policy.json"), *mount(route_file, "/input/route-logs.json"), *mount(scratch / "ca.pem", "/input/ca.pem"), *mount(logs, "/logs"), "--entrypoint", "node", image, "/opt/egress/probe-ingress.mjs", "--address", "172.27.94.10", "--request-origin", "https://" + hosts["signer"], "--human-origin", "https://" + human, "--human-log", "/logs/" + human + ".log", "--human-path", paths[human], "--ca-file", "/input/ca.pem", "--policy", "/input/policy.json", "--route-logs", "/input/route-logs.json", "--audit-path", "/ready"]
    partial_args = args[:args.index("--policy")] + ["--request-log", "/logs/" + hosts["signer"] + ".log", "--request-path", paths[hosts["signer"]], "--audit-path", "/ready"]
    result = subprocess.run(partial_args, text=True, capture_output=True)
    print("partial packaged probe:", result.returncode, result.stdout.strip(), flush=True)
    assert result.returncode != 0 and "OATS_EGRESS_INGRESS_PASS" not in result.stdout
    assert all(not (logs / (host + ".log")).read_text() for host in [*hosts.values(), human])
    print("PASS signer-only call cannot emit the admission token or send controls", flush=True)
    result = subprocess.run(args[:-2], text=True, capture_output=True)
    assert result.returncode != 0 and "OATS_EGRESS_INGRESS_PASS" not in result.stdout
    assert all(not (logs / (host + ".log")).read_text() for host in [*hosts.values(), human])
    print("PASS missing common audit path cannot emit the admission token or send controls", flush=True)
    result = subprocess.run(args, text=True, capture_output=True)
    print("strict packaged full probe:", result.returncode, result.stdout.strip(), result.stderr.strip(), flush=True)
    assert result.returncode == 0 and result.stdout == "OATS_EGRESS_INGRESS_PASS\n"
    counts = {host: len((logs / (host + ".log")).read_text().splitlines()) for host in [*hosts.values(), human]}
    assert all(counts[host] == 8 for host in hosts.values()) and counts[human] == 6, counts
    human_lines = (logs / (human + ".log")).read_text().splitlines()
    assert sum(line.startswith("/handoff-assets/handoff.css?") for line in human_lines) == 2
    assert sum(line.startswith("/ready?") for line in human_lines) == 4
    print("PASS six backend logs: 22 valid service controls plus 24 common-path coverage controls; human CSS200 retained", flush=True)
    write("logs/weak-route", "aweb-only fixture fault")
    result = subprocess.run(args, text=True, capture_output=True)
    print("forwarded non-signer forbidden authority:", result.returncode, result.stdout.strip(), result.stderr.strip(), flush=True)
    assert result.returncode != 0 and "OATS_EGRESS_INGRESS_PASS" not in result.stdout
    for host in hosts.values():
        assert len((logs / (host + ".log")).read_text().splitlines()) == 16
    assert len((logs / (human + ".log")).read_text().splitlines()) == 16
    print("PASS backend421 cannot hide non-signer domain fronting", flush=True)
    (logs / "weak-route").unlink()
    for role in ["secrets", "registry"]:
        before = {host: len((logs / (host + ".log")).read_text().splitlines()) for host in [*hosts.values(), human]}
        write("logs/secrets-fault-sni", hosts[role])
        write("logs/secrets-delivery.log", "")
        (logs / "secrets-delivery.log").chmod(0o666)
        result = subprocess.run(args, text=True, capture_output=True)
        print(role + " misdelivery into health-only Secrets:", result.returncode, result.stdout.strip(), flush=True)
        assert result.returncode != 0 and "OATS_EGRESS_INGRESS_PASS" not in result.stdout
        assert (logs / "secrets-delivery.log").read_text().splitlines() == ["/ready"] * 4
        for host in hosts.values():
            count = len((logs / (host + ".log")).read_text().splitlines()) - before[host]
            assert count == (12 if host == hosts["secrets"] else 8), (role, host, count)
        assert len((logs / (human + ".log")).read_text().splitlines()) - before[human] == 6
        print("PASS all four H1/H2 human-authority deliveries reach Secrets and are detected despite backend421", flush=True)
    (logs / "secrets-fault-sni").unlink()
    result = subprocess.run(args[:-1] + ["/audit-unlogged"], text=True, capture_output=True)
    assert result.returncode != 0 and "OATS_EGRESS_INGRESS_PASS" not in result.stdout
    print("PASS a common path without the Secrets log witness cannot qualify", flush=True)
finally:
    subprocess.run(["docker", "rm", "-f", front], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if created:
        subprocess.run(["docker", "network", "rm", network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(scratch)
