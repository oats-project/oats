"""CI-only packaged four-role ingress proof with a shared console/API backend."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

if len(sys.argv) != 2:
    raise SystemExit("usage: agent-egress-humanrole-ingress-image.py IMAGE")
root = Path(__file__).resolve().parents[1]
scratch = Path(tempfile.mkdtemp(prefix="humanrole-ingress-"))
scratch.chmod(0o755)
network = "humanrole-ingress-" + str(os.getpid())
front = network + "-front"
created = False
roles = ["aweb", "logs", "registry", "secrets"]
human = "console.example.invalid"


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def mount(source, target, readonly=True):
    return ["--mount", "type=bind,source=" + str(source) + ",target=" + target + (",readonly" if readonly else "")]


try:
    logs = scratch / "logs"
    logs.mkdir(mode=0o777)
    logs.chmod(0o777)
    for role in roles:
        path = logs / (role + ".log")
        path.write_text("")
        path.chmod(0o666)
    config = scratch / "openssl.cnf"
    config.write_text("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=secrets.example.invalid\n[ext]\nsubjectAltName="
                      + ",".join("DNS:" + host for host in [*(role + ".example.invalid" for role in roles), human])
                      + "\nbasicConstraints=critical,CA:TRUE\n")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
                    "-keyout", str(logs / "key.pem"), "-out", str(logs / "ca.pem"), "-config", str(config)],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for name in ("key.pem", "ca.pem"):
        (logs / name).chmod(0o444)
    policy = {"roles": roles, "humanRole": "secrets", "humanOrigin": "https://" + human,
              "frontAddress": "172.27.95.2", "privateIngressAddresses": ["172.27.94.10"],
              "deniedAddresses": ["172.27.94.11", "172.27.94.12"],
              "authorityRecords": [{"name": "_awid.team.example.invalid", "text": "awid=v1; controller=did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7; registry=https://registry.example.invalid;"}],
              "targets": {role: {"origin": "https://" + role + ".example.invalid", "addresses": ["172.27.94.10"]} for role in roles}}
    route_logs = {role: {"path": "/health" if role == "registry" else "/ready", "log": "/logs/" + role + ".log"} for role in roles}
    for name, data in [("policy.json", policy), ("route-logs.json", route_logs)]:
        (scratch / name).write_text(json.dumps(data))
        (scratch / name).chmod(0o644)
    docker("network", "create", "--internal", "--subnet", "172.27.94.0/24", network)
    created = True
    security = ["--user", "10001:10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only"]
    docker("run", "-d", "--name", front, "--network", network, "--ip", "172.27.94.10", *security,
           "--sysctl", "net.ipv4.ip_unprivileged_port_start=0",
           *mount(root / "test/fixtures/egress-humanrole/front.mjs", "/front.mjs"), *mount(logs, "/logs", False),
           "--entrypoint", "node", sys.argv[1], "/front.mjs", "/logs")
    for _ in range(50):
        if "TLS_CONTROLS_READY" in docker("logs", front):
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("TLS controls did not start")
    args = ["docker", "run", "--rm", "--network", network, *security,
            *mount(scratch / "policy.json", "/input/policy.json"), *mount(scratch / "route-logs.json", "/input/route-logs.json"),
            *mount(logs, "/logs"), "--entrypoint", "node", sys.argv[1], "/opt/egress/probe-ingress.mjs",
            "--address", "172.27.94.10", "--request-origin", policy["targets"]["secrets"]["origin"],
            "--human-origin", policy["humanOrigin"], "--human-log", "/logs/secrets.log", "--human-path", "/console.css",
            "--request-log", "/logs/secrets.log", "--request-path", "/ready", "--audit-path", "/ready",
            "--ca-file", "/logs/ca.pem", "--policy", "/input/policy.json", "--route-logs", "/input/route-logs.json"]
    result = subprocess.run(args, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout == "OATS_EGRESS_INGRESS_PASS\n"
    assert result.stderr == "egress: human anchor: secrets\n"
    assert len((logs / "secrets.log").read_text().splitlines()) == 14
    assert all(len((logs / (role + ".log")).read_text().splitlines()) == 8 for role in roles if role != "secrets")
    print("PASS four-role CLI: secrets anchor, H1/H2 controls, shared console/API backend and log", flush=True)
    for mutant in ("human-forwarded", "role-misdelivery", "backend-421"):
        (logs / "mutant").write_text(mutant)
        (logs / "mutant").chmod(0o644)
        result = subprocess.run(args, text=True, capture_output=True)
        assert result.returncode != 0 and result.stdout == ""
        assert "proof failed (values withheld)" in result.stderr
        print("PASS refused mutant:", mutant, flush=True)
finally:
    subprocess.run(["docker", "rm", "-f", front], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if created:
        subprocess.run(["docker", "network", "rm", network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(scratch)
