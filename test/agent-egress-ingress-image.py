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
 const weak=fs.existsSync('/logs/weak-route')&&sni==='aweb.example.invalid'&&(authority==='approve.example.invalid'||authority==='approve.example.invalid:443');
 if(!matched&&!weak){res.writeHead(421);res.end();return}
 const host=authority.split(':')[0];
 if(!Object.hasOwn(paths,host)||new URL(req.url,'https://example.invalid').pathname!==paths[host]){res.writeHead(404);res.end();return}
 fs.appendFileSync('/logs/'+host+'.log',req.url+'\\n');
 res.writeHead(matched?200:421);res.end('control');
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
    args = ["docker", "run", "--rm", "--network", network, *security, *mount(policy_file, "/input/policy.json"), *mount(route_file, "/input/route-logs.json"), *mount(scratch / "ca.pem", "/input/ca.pem"), *mount(logs, "/logs"), "--entrypoint", "node", image, "/opt/egress/probe-ingress.mjs", "--address", "172.27.94.10", "--request-origin", "https://" + hosts["signer"], "--human-origin", "https://" + human, "--human-log", "/logs/" + human + ".log", "--human-path", paths[human], "--ca-file", "/input/ca.pem", "--policy", "/input/policy.json", "--route-logs", "/input/route-logs.json"]
    partial_args = args[:args.index("--policy")] + ["--request-log", "/logs/" + hosts["signer"] + ".log", "--request-path", paths[hosts["signer"]]]
    result = subprocess.run(partial_args, text=True, capture_output=True)
    print("partial packaged probe:", result.returncode, result.stdout.strip(), flush=True)
    assert result.returncode != 0 and "OATS_EGRESS_INGRESS_PASS" not in result.stdout
    assert all(not (logs / (host + ".log")).read_text() for host in [*hosts.values(), human])
    print("PASS signer-only call cannot emit the admission token or send controls", flush=True)
    result = subprocess.run(args, text=True, capture_output=True)
    print("strict packaged full probe:", result.returncode, result.stdout.strip(), result.stderr.strip(), flush=True)
    assert result.returncode == 0 and result.stdout == "OATS_EGRESS_INGRESS_PASS\n"
    counts = {host: len((logs / (host + ".log")).read_text().splitlines()) for host in [*hosts.values(), human]}
    assert all(counts[host] == 4 for host in hosts.values()) and counts[human] == 2, counts
    print("PASS six backend logs: exactly twenty-two H1/H2 initial/final matched requests, no forbidden delivery", flush=True)
    write("logs/weak-route", "aweb-only fixture fault")
    result = subprocess.run(args, text=True, capture_output=True)
    print("forwarded non-signer forbidden authority:", result.returncode, result.stdout.strip(), result.stderr.strip(), flush=True)
    assert result.returncode != 0 and "OATS_EGRESS_INGRESS_PASS" not in result.stdout
    for host in hosts.values():
        assert len((logs / (host + ".log")).read_text().splitlines()) == 8
    assert len((logs / (human + ".log")).read_text().splitlines()) == 8
    print("PASS backend421 cannot hide non-signer domain fronting", flush=True)
finally:
    subprocess.run(["docker", "rm", "-f", front], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if created:
        subprocess.run(["docker", "network", "rm", network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(scratch)
