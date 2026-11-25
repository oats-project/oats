"""CI-only proof that container groups isolate personal credentials. Never run it on a workstation, a shared Docker
daemon or a customer host: it creates unix groups, /srv/oats-team/<run>-* trees, /etc/oats-login/receiver.json and
privileged-free containers on the runner's Docker, and removes them all.

Four groups, shared plus cred-a, cred-b and cred-c, each with its own UID:GID (20001-20004), 0700 state directory and
internal Docker network, started from the reviewed agent image with container/agent/compose.agent.yaml, a credential
group also with compose.agent.credentials.yaml. Each credential group's marker (a random, non-secret string) is
installed through share/oats-login-receive --credential, as root with SSH_ORIGINAL_COMMAND set.

Positive controls, which make the run ERROR when they fail: each group passes the image's acceptance with its mounts;
each credential group reads its own marker; the operator opens an SSH session to each group over the documented
docker-exec relay and runs `oats --version` and `oats status`; each container holds its own tmux and wake broker
sockets; each group writes a marker in each of its writable mounts.

Negatives, for every ordered pair (X, Y) of the four groups, as X's UID: Y's credential and state directory are not
mounted in X and a guess of their host paths fails inside X; Y's sshd and every TCP listener Y has are unreachable from
X, and X and Y share no network or network namespace; no writable mount of X is mounted in Y, and no marker X wrote is
visible in Y. Per group: no Docker socket and no group beyond its own GID. On the host, as X's UID, reading Y's
credential and listing Y's state directory both fail with EACCES.

Each check is CONNECTED/READ, DENIED or ERROR; only DENIED is isolation. The proof then runs four mutant legs, each of
which must make it fail with a named row: cred-b with cred-a's UID, cred-b's credentials mounted into cred-a, cred-a and
cred-b on one network, and the shared group given the Docker socket.
"""
import hashlib
import json
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import os

if len(sys.argv) != 2:
    raise SystemExit("usage: agent-credential-groups-image.py AGENT_IMAGE")
IMAGE = sys.argv[1]
ROOT = Path(__file__).resolve().parents[1]
RECEIVER = ROOT / "share/oats-login-receive"
COMPOSE = ROOT / "container/agent/compose.agent.yaml"
CREDENTIALS_FRAGMENT = ROOT / "container/agent/compose.agent.credentials.yaml"
ACCEPT = ROOT / "container/agent/accept.sh"
RECEIVER_CONFIG = Path("/etc/oats-login/receiver.json")
HOST_ROOT = Path("/srv/oats-team")
RUN = f"cg{os.getpid()}"
SCRATCH = Path(tempfile.mkdtemp(prefix="credential-groups-"))
SCRATCH.chmod(0o755)
WAKE_SOCKET = "/state/home/.config/aw/wake/control.sock"
# The documented operator route (docs/container.md, "OATS over SSH").
RELAY = """node -e 'const s=require("node:net").connect(2222,"127.0.0.1");process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",()=>process.exit(1));'"""
ISOLATED = "DENIED"
# What this run created, and so may remove: cleanup never touches what it found.
CREATED = {"host_root": False, "config_dir": False, "config": False, "groups": [], "dirs": [], "networks": [], "projects": []}


class Group:
    def __init__(self, name, ident, octet, credential):
        self.name, self.uid, self.gid, self.credential = name, ident, ident, credential
        self.team = f"{RUN}-{name}"
        self.dir = HOST_ROOT / self.team
        self.state = self.dir / "state"
        self.login = self.dir / "login"
        # Only a credential group's are created, installed and mounted.
        self.credentials = self.dir / "credentials"
        self.marker_path = self.credentials / "marker"
        self.marker = f"oats-credential-groups-marker-{secrets.token_hex(16)}"
        self.unix_group = f"oats-{RUN}-{name}"
        self.network = f"oats-{RUN}-{name}"
        self.subnet = f"172.30.{octet}.0/24"
        self.ip = f"172.30.{octet}.2"
        self.container = f"oats-agent-{self.team}"
        self.project = f"oats-{self.team}"


GROUPS = [Group("shared", 20001, 101, False), Group("cred-a", 20002, 102, True),
          Group("cred-b", 20003, 103, True), Group("cred-c", 20004, 104, True)]
BY_NAME = {g.name: g for g in GROUPS}
A, B = BY_NAME["cred-a"], BY_NAME["cred-b"]
UID_MUTANT_STATE = B.dir / "state-uid-mutant"
# Each mutant: the groups it recreates and the row it must fail.
MUTANTS = {
    "uid": (["cred-b"], "cred-a -> cred-b host list state"),
    "mount": (["cred-a"], "cred-a -> cred-b credential mount"),
    "network": (["cred-b"], "cred-a -> cred-b sshd"),
    "docker": (["shared"], "shared docker socket"),
}


def run(args, check=True, input=None, env=None):
    result = subprocess.run([str(a) for a in args], input=input, text=True, capture_output=True, env=env)
    if check and result.returncode != 0:
        raise RuntimeError(f"{' '.join(map(str, args[:6]))} failed ({result.returncode}): {result.stderr.strip()[-2000:]}")
    return result


def sudo(*args, **kwargs):
    return run(["sudo", "-n", *args], **kwargs)


def write(name, text, mode=0o644):
    path = SCRATCH / name
    path.write_text(text)
    path.chmod(mode)
    return path


def deployment(group, mutant):
    """The runtime of group in this leg: UID:GID, state directory, network and address, extra mounts."""
    d = {"uid": group.uid, "gid": group.gid, "state": group.state, "network": group.network, "ip": group.ip, "extra": []}
    if mutant == "uid" and group is B:
        d.update(uid=A.uid, state=UID_MUTANT_STATE)
    if mutant == "network" and group is B:
        d.update(network=A.network, ip="172.30.102.3")
    if mutant == "mount" and group is A:
        d["extra"] = [{"type": "bind", "source": str(B.credentials), "target": "/etc/agent-credentials-cred-b",
                       "read_only": True, "bind": {"create_host_path": False}}]
    if mutant == "docker" and group.name == "shared":
        d["extra"] = [{"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock",
                       "bind": {"create_host_path": False}}]
    return d


def compose_env(group, d):
    env = dict(os.environ)
    env.update(AGENT_IMAGE=IMAGE, TEAM=group.team, AGENT_UID=str(d["uid"]), AGENT_GID=str(d["gid"]),
               AGENT_PIDS="256", AGENT_MEMORY="1g", AGENT_CPUS="1", AGENT_TMP_SIZE="134217728",
               TEAM_STATE_DIR=str(d["state"]), TEAM_LOGIN_DIR=str(group.login),
               AUTHORIZED_KEYS_FILE=str(group.dir / "authorized_keys"), RESOLV_CONF_FILE=str(group.dir / "resolv.conf"),
               AGENTS_NETWORK=d["network"], AGENT_IP=d["ip"])
    for name in ("TEAM_WORK_DIR", "TEAM_INPUT_DIR", "AGENT_CA_FILE", "AGENT_MIRRORS_DIR", "TEAM_OUTBOX_DIR", "TEAM_OUTBOX_GID", "AGENT_CHILD"):
        env.pop(name, None)
    if group.credential:
        env["TEAM_CREDENTIALS_DIR"] = str(group.credentials)
    else:
        env.pop("TEAM_CREDENTIALS_DIR", None)
    return env


def compose(group, d):
    files = ["-f", COMPOSE] + (["-f", CREDENTIALS_FRAGMENT] if group.credential else [])
    if d["extra"]:
        files += ["-f", write(f"mutant-{group.name}.json", json.dumps({"services": {"agent": {"volumes": d["extra"]}}}))]
    return ["docker", "compose", "-p", group.project, *files]


def start(group, mutant):
    d = deployment(group, mutant)
    if group.project not in CREATED["projects"]:
        CREATED["projects"].append(group.project)
    run([*compose(group, d), "up", "-d", "--force-recreate", "--wait", "--wait-timeout", "120"], env=compose_env(group, d))


def stop(group, mutant):
    d = deployment(group, mutant)
    return run([*compose(group, d), "down", "--timeout", "45"], check=False, env=compose_env(group, d))


def provision():
    if RECEIVER_CONFIG.exists() or RECEIVER_CONFIG.is_symlink():
        raise RuntimeError(f"{RECEIVER_CONFIG} already exists on this runner; the proof never replaces it")
    for g in GROUPS:
        for key in (str(g.gid), g.unix_group):
            if run(["getent", "group", key], check=False).returncode == 0:
                raise RuntimeError(f"group {key} already exists on this runner")
        if g.dir.exists() or g.dir.is_symlink():
            raise RuntimeError(f"{g.dir} already exists on this runner")
        if run(["docker", "network", "inspect", g.network], check=False).returncode == 0:
            raise RuntimeError(f"network {g.network} already exists on this runner")
    if not HOST_ROOT.exists():
        sudo("install", "-d", "-o", "0", "-g", "0", "-m", "755", HOST_ROOT)
        CREATED["host_root"] = True
    run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "oats-credential-groups-operator", "-f", SCRATCH / "operator"])
    write("resolv.conf", "nameserver 127.0.0.1\n")
    for g in GROUPS:
        sudo("groupadd", "-g", g.gid, g.unix_group)
        CREATED["groups"].append(g.unix_group)
        sudo("mkdir", "-m", "755", "--", g.dir)
        CREATED["dirs"].append(g.dir)
        sudo("install", "-d", "-o", g.uid, "-g", g.gid, "-m", "700", g.state)
        sudo("install", "-d", "-o", "0", "-g", g.gid, "-m", "750", g.login)
        sudo("install", "-o", "0", "-g", "0", "-m", "644", SCRATCH / "operator.pub", g.dir / "authorized_keys")
        sudo("install", "-o", "0", "-g", "0", "-m", "644", SCRATCH / "resolv.conf", g.dir / "resolv.conf")
        run(["docker", "network", "create", "--internal", "--ipv6=false", "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
             "--subnet", g.subnet, g.network])
        CREATED["networks"].append(g.network)
    # The uid mutant's cred-b: a provisioner that reused cred-a's UID for cred-b's state.
    sudo("install", "-d", "-o", A.uid, "-g", B.gid, "-m", "700", UID_MUTANT_STATE)
    config = {"credentials": {g.team: {"group": g.unix_group, "path": str(g.marker_path), "access": "read-only"} for g in GROUPS if g.credential}}
    if not RECEIVER_CONFIG.parent.exists():
        sudo("install", "-d", "-o", "0", "-g", "0", "-m", "755", RECEIVER_CONFIG.parent)
        CREATED["config_dir"] = True
    # Exclusive: a configuration that appeared since the preflight is refused, never replaced.
    sudo("/usr/bin/python3", "-I", "-c", "import os, sys\n"
         "fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)\n"
         "os.fchmod(fd, 0o644)\nos.write(fd, sys.stdin.buffer.read())\nos.fsync(fd)\nos.close(fd)",
         RECEIVER_CONFIG, input=json.dumps(config))
    CREATED["config"] = True


def receiver(group, action, value=""):
    """The receiver as the forced command runs it: root, SSH_ORIGINAL_COMMAND, the key's --credential."""
    result = sudo("env", f"SSH_ORIGINAL_COMMAND={action}", "SSH_CLIENT=192.0.2.1 50000 22",
                  "/usr/bin/python3", "-I", RECEIVER, "--credential", group.team, input=value, check=False)
    return result.returncode, json.loads(result.stdout)


def install_markers(controls):
    for g in GROUPS:
        if not g.credential:
            continue
        code, answer = receiver(g, "install", g.marker + "\n")
        expected = "sha256:" + hashlib.sha256(g.marker.encode()).hexdigest()[:16]
        controls.append((f"{g.name} marker installed through the receiver",
                         code == 0 and answer.get("ok") is True and answer.get("entry") == g.team and answer.get("fingerprint") == expected
                         and g.marker not in json.dumps(answer), json.dumps(answer)))
        code, status = receiver(g, "status")
        controls.append((f"{g.name} receiver status answers the marker's fingerprint", code == 0 and status.get("fingerprint") == expected, json.dumps(status)))
        modes = sudo("stat", "-c", "%u:%g %a", g.marker_path, g.credentials).stdout.split("\n")
        controls.append((f"{g.name} credential is root:{g.gid} 0440 in a root:{g.gid} 0750 directory",
                         modes[:2] == [f"0:{g.gid} 440", f"0:{g.gid} 750"], " / ".join(modes[:2])))


def inspect(group):
    return json.loads(run(["docker", "inspect", group.container]).stdout)[0]


def mounts(info):
    """(source, target, writable) of every bind and volume, and the private writable tmpfs and shm targets."""
    found = [(m.get("Source") or "", m["Destination"], bool(m.get("RW"))) for m in info["Mounts"]]
    found += [("", target, True) for target in (info["HostConfig"].get("Tmpfs") or {})]
    return found + [("", "/dev/shm", True)]


def overlaps(a, b):
    if not a or not b:
        return False
    a, b = a.rstrip("/") + "/", b.rstrip("/") + "/"
    return a.startswith(b) or b.startswith(a)


def exec_node(group, program, payload):
    result = run(["docker", "exec", "-i", group.container, "node", "-e", program], input=json.dumps(payload), check=False)
    if result.returncode != 0:
        raise RuntimeError(f"probe in {group.name} failed: {result.stderr.strip()[-2000:]}")
    return json.loads(result.stdout)


SSH_CONFIG_LINES = """Host {alias}
  HostName oats-agent
  User agent
  Port 2222
  IdentityFile {key}
  IdentitiesOnly yes
  UserKnownHostsFile {known}
  StrictHostKeyChecking yes
  HostKeyAlias {alias}
  BatchMode yes
  ConnectTimeout 20
  ProxyCommand docker exec -i {container} {relay}
"""


def ssh_config(legs):
    known = []
    config = []
    for g in GROUPS:
        alias = f"oats-cg-{g.name}"
        state = legs[g.name]["state"]
        known.append(f"{alias} " + sudo("cat", state / "ssh/ssh_host_ed25519_key.pub").stdout.strip())
        config.append(SSH_CONFIG_LINES.format(alias=alias, key=SCRATCH / "operator", known=SCRATCH / "known_hosts",
                                              container=g.container, relay=RELAY))
    write("known_hosts", "\n".join(known) + "\n")
    return write("ssh_config", "\n".join(config))


def operator_ssh(config, group, command):
    return run(["ssh", "-F", config, f"oats-cg-{group.name}", command], check=False)


WRITE_MARKERS = r"""
const fs = require("node:fs"), path = require("node:path");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const written = [];
for (const target of input.targets) {
  // A writable file bind (a socket, say) holds no marker; every writable directory must take one.
  try { if (!fs.statSync(target).isDirectory()) { written.push([target, "not a directory"]); continue; } }
  catch (error) { written.push([target, error.code]); continue; }
  try { fs.writeFileSync(path.join(target, input.name), "credential-groups marker", {flag: "wx", mode: 0o600}); written.push([target, "written"]); }
  catch (error) { written.push([target, error.code]); }
}
console.log(JSON.stringify(written));
"""

PROBE = r"""
const fs = require("node:fs"), net = require("node:net"), path = require("node:path");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const rows = [];
const row = (label, result, detail) => rows.push({label, result, detail});
const denied = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR"]);
const attempt = (fn) => { try { fn(); return ["READ", "succeeded"]; } catch (e) { return [denied.has(e.code) ? "DENIED" : "ERROR", e.code || String(e)]; } };
const connect = (host, port) => new Promise((resolve) => {
  const socket = net.connect({host, port});
  const done = (result, detail) => { socket.destroy(); resolve([result, `${host}:${port} ${detail}`]); };
  socket.setTimeout(3000, () => done("DENIED", "timeout"));
  socket.once("connect", () => done("CONNECTED", "connected"));
  socket.once("error", (e) => done(["ECONNREFUSED", "ECONNRESET"].includes(e.code) ? "CONNECTED"
    : ["ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"].includes(e.code) ? "DENIED" : "ERROR", e.code));
});
const worst = (results) => results.find(([r]) => r === "CONNECTED") || results.find(([r]) => r === "ERROR") || results[0] || ["DENIED", "nothing to reach"];
(async () => {
  for (const y of input.targets) {
    if (y.credentialPath) row(`${input.self} -> ${y.name} credential path`, ...attempt(() => fs.readFileSync(y.credentialPath)));
    row(`${input.self} -> ${y.name} state path`, ...attempt(() => fs.readdirSync(y.statePath)));
    row(`${input.self} -> ${y.name} sshd`, ...await connect(y.ip, 2222));
    row(`${input.self} -> ${y.name} services`, ...worst(await Promise.all(y.ports.filter((p) => p !== 2222).map((p) => connect(y.ip, p)))));
    const seen = [];
    for (const name of y.markers) for (const target of input.targets_here) if (fs.existsSync(path.join(target, name))) seen.push(path.join(target, name));
    row(`${y.name} -> ${input.self} writable marker`, seen.length ? "READ" : "DENIED", seen.join(", ") || "no marker of theirs here");
  }
  // Every Docker or container-runtime socket anywhere this UID can see, and the well-known paths themselves.
  const sockets = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isSocket() && /docker|containerd|podman|buildkit/i.test(entry.name)) sockets.push(file);
      else if (entry.isDirectory() && !["/proc", "/sys"].includes(file)) walk(file);
    }
  };
  walk("/");
  for (const known of ["/var/run/docker.sock", "/run/docker.sock", "/run/containerd/containerd.sock"]) {
    try { fs.lstatSync(known); if (!sockets.includes(known)) sockets.push(known); } catch (e) { if (e.code !== "ENOENT") sockets.push(`${known} (${e.code})`); }
  }
  row(`${input.self} docker socket`, sockets.length ? "CONNECTED" : "DENIED", sockets.join(", ") || "none");
  // The GID and supplementary groups of every process this UID can read.
  const groups = new Set();
  for (const pid of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    let status;
    try { status = fs.readFileSync(`/proc/${pid}/status`, "utf8"); } catch { continue; }
    for (const line of status.split("\n")) {
      if (line.startsWith("Gid:") || line.startsWith("Groups:")) for (const g of line.split(/\s+/).slice(1).filter(Boolean)) groups.add(Number(g));
    }
  }
  const extra = [...groups].filter((g) => g !== input.gid);
  row(`${input.self} groups`, groups.size === 0 ? "ERROR" : extra.length ? "READ" : "DENIED", `gids ${[...groups].join(" ")}`);
  console.log(JSON.stringify(rows));
})().catch((e) => { console.error(e); process.exit(1); });
"""

HOST_PROBE = r"""
import errno, json, os, sys
rows = []
for label, op, path in json.loads(sys.argv[1]):
    try:
        if op == "read":
            open(path, "rb").close()
        else:
            os.listdir(path)
        rows.append([label, "READ", "succeeded"])
    except OSError as e:
        rows.append([label, "DENIED" if e.errno == errno.EACCES else "ERROR", errno.errorcode.get(e.errno, str(e.errno))])
print(json.dumps(rows))
"""


def listeners(group):
    """Every TCP port the group listens on, on any address: from its own /proc/net/tcp and tcp6."""
    ports = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        text = run(["docker", "exec", group.container, "cat", table]).stdout
        for line in text.splitlines()[1:]:
            fields = line.split()
            if len(fields) > 3 and fields[3] == "0A":
                ports.add(int(fields[1].rsplit(":", 1)[1], 16))
    return sorted(ports)


def proof(leg, legs, accept, controls):
    """One leg: the positive controls, then every negative. Answers (verdict, rows)."""
    rows = []
    infos = {g.name: inspect(g) for g in GROUPS}
    if accept:
        for g in GROUPS:
            result = run([ACCEPT, g.container, "--evidence", "target-amd64"], check=False, env=compose_env(g, legs[g.name]))
            print(result.stdout, end="", flush=True)
            controls.append((f"{g.name} passes the image's acceptance with its mounts", result.returncode == 0, result.stderr.strip()[-2000:]))
    for g in GROUPS:
        if g.credential:
            seen = run(["docker", "exec", g.container, "cat", "/etc/agent-credentials/marker"], check=False)
            controls.append((f"{g.name} reads its own credential", seen.returncode == 0 and seen.stdout.strip() == g.marker, seen.stderr.strip()))
    config = ssh_config(legs)
    for g in GROUPS:
        version = operator_ssh(config, g, "oats --version")
        controls.append((f"operator SSH to {g.name}: oats --version", version.returncode == 0 and bool(version.stdout.strip()), (version.stdout + version.stderr).strip()[-500:]))
        status = operator_ssh(config, g, "mkdir -p /state/deploy/agents && cd /state/deploy && oats status --json")
        try:
            status_ok = status.returncode == 0 and json.loads(status.stdout).get("root") == "/state/deploy/agents"
        except ValueError:
            status_ok = False
        controls.append((f"operator SSH to {g.name}: oats status", status_ok, (status.stdout + status.stderr).strip()[-500:]))
        tmux = operator_ssh(config, g, "tmux has-session -t credential-groups 2>/dev/null || tmux new-session -d -s credential-groups; tmux display-message -p -t credential-groups '#{socket_path}'")
        socket = tmux.stdout.strip()
        own = tmux.returncode == 0 and socket.startswith("/tmp/") and run(["docker", "exec", g.container, "test", "-S", socket], check=False).returncode == 0
        controls.append((f"{g.name} holds its own tmux socket", own, socket or tmux.stderr.strip()))
        wake = run(["docker", "exec", g.container, "test", "-S", WAKE_SOCKET], check=False)
        controls.append((f"{g.name} holds its own wake broker socket", wake.returncode == 0, WAKE_SOCKET))

    marker_names = {g.name: f".oats-credential-groups-{g.name}-{secrets.token_hex(6)}" for g in GROUPS}
    targets_here = {g.name: [target for _, target, _ in mounts(infos[g.name])] for g in GROUPS}
    for g in GROUPS:
        writable = [target for _, target, rw in mounts(infos[g.name]) if rw]
        written = exec_node(g, WRITE_MARKERS, {"name": marker_names[g.name], "targets": writable})
        controls.append((f"{g.name} writes a marker in each of its writable mounts",
                         [t for t, _ in written] == writable and all(r in ("written", "not a directory") for _, r in written), json.dumps(written)))
    ports = {g.name: listeners(g) for g in GROUPS}
    netns = {g.name: sudo("readlink", f"/proc/{infos[g.name]['State']['Pid']}/ns/net").stdout.strip() for g in GROUPS}
    for x in GROUPS:
        others = [y for y in GROUPS if y is not x]
        payload = {"self": x.name, "gid": legs[x.name]["gid"], "targets_here": targets_here[x.name], "targets": [
            {"name": y.name, "ip": legs[y.name]["ip"], "ports": ports[y.name], "statePath": str(legs[y.name]["state"]),
             "credentialPath": str(y.marker_path) if y.credential else None, "markers": [marker_names[y.name]]} for y in others]}
        rows += [(r["label"], r["result"], r["detail"]) for r in exec_node(x, PROBE, payload)]
        x_mounts = mounts(infos[x.name])
        for y in others:
            y_mounts = mounts(infos[y.name])
            if y.credential:
                hit = [t for s, t, _ in x_mounts if overlaps(s, str(y.credentials))]
                rows.append((f"{x.name} -> {y.name} credential mount", "READ" if hit else "DENIED", ", ".join(hit) or "not mounted"))
            hit = [t for s, t, _ in x_mounts if overlaps(s, str(legs[y.name]["state"]))]
            rows.append((f"{x.name} -> {y.name} state mount", "READ" if hit else "DENIED", ", ".join(hit) or "not mounted"))
            shared = [f"{t} ~ {u}" for s, t, rw in x_mounts if rw for r, u, _ in y_mounts if overlaps(s, r)]
            rows.append((f"{x.name} -> {y.name} shared writable mount", "CONNECTED" if shared else "DENIED", ", ".join(shared) or "none"))
            networks = set(infos[x.name]["NetworkSettings"]["Networks"]) & set(infos[y.name]["NetworkSettings"]["Networks"])
            rows.append((f"{x.name} -> {y.name} shared network", "CONNECTED" if networks else "DENIED", ", ".join(sorted(networks)) or "none"))
            rows.append((f"{x.name} -> {y.name} network namespace", "CONNECTED" if netns[x.name] == netns[y.name] else "DENIED", f"{netns[x.name]} / {netns[y.name]}"))
        checks = [(f"{x.name} -> {y.name} host read credential", "read", str(y.marker_path)) for y in others if y.credential]
        checks += [(f"{x.name} -> {y.name} host list state", "list", str(legs[y.name]["state"])) for y in others]
        d = legs[x.name]
        host = sudo("setpriv", f"--reuid={d['uid']}", f"--regid={d['gid']}", "--clear-groups", "--",
                    "/usr/bin/python3", "-I", "-c", HOST_PROBE, json.dumps(checks))
        rows += [tuple(r) for r in json.loads(host.stdout)]
    for g in GROUPS:
        run(["docker", "exec", g.container, "sh", "-c", 'for t in "$@"; do rm -f "$t/$0"; done', marker_names[g.name],
             *[target for _, target, rw in mounts(infos[g.name]) if rw]], check=False)

    for label, ok, detail in controls:
        print(f"[{leg}] CONTROL {'PASS' if ok else 'ERROR'} {label}" + ("" if ok else f": {detail}"), flush=True)
    for label, result, detail in rows:
        print(f"[{leg}] {result} {label}: {detail}", flush=True)
    if not all(ok for _, ok, _ in controls) or any(result == "ERROR" for _, result, _ in rows):
        return "ERROR", rows
    if any(result != ISOLATED for _, result, _ in rows):
        return "FAIL", rows
    return "PASS", rows


def main():
    legs = {g.name: deployment(g, None) for g in GROUPS}
    provision()
    # The credentials directories exist before Compose binds them: the receiver creates them.
    controls = []
    install_markers(controls)
    for g in GROUPS:
        start(g, None)
    verdict, rows = proof("base", legs, accept=True, controls=controls)
    pairs = {tuple(label.split(" ")[0:3:2]) for label, _, _ in rows if " -> " in label}
    if verdict != "PASS" or len(pairs) != 12:
        print(f"OATS_CREDENTIAL_GROUPS_{verdict} groups={len(GROUPS)} pairs={len(pairs)}", flush=True)
        return 1
    print(f"OATS_CREDENTIAL_GROUPS_PASS groups={len(GROUPS)} pairs={len(pairs)}", flush=True)
    for mutant, (names, required) in MUTANTS.items():
        changed = [BY_NAME[n] for n in names]
        for g in changed:
            stop(g, None)
            start(g, mutant)
        verdict, rows = proof(mutant, {g.name: deployment(g, mutant) for g in GROUPS}, accept=False, controls=[])
        named = [(label, result) for label, result, _ in rows if label == required]
        caught = verdict == "FAIL" and named and all(result in ("READ", "CONNECTED") for _, result in named)
        print(f"OATS_CREDENTIAL_GROUPS_MUTANT {mutant} {'FAILED THE PROOF' if caught else 'NOT CAUGHT'}: "
              f"verdict {verdict}, row {required!r} {named[0][1] if named else 'missing'}", flush=True)
        for g in changed:
            stop(g, mutant)
            start(g, None)
        if not caught:
            return 1
    print(f"OATS_CREDENTIAL_GROUPS_MUTANTS_CAUGHT {len(MUTANTS)}", flush=True)
    return 0


def cleanup():
    """Remove what this run created, and nothing it found. Answers whether any removal failed."""
    failed = False
    for g in GROUPS:
        if g.project in CREATED["projects"]:
            result = stop(g, None)
            if result.returncode != 0:
                print(f"cleanup: compose down {g.name}: {result.stderr.strip()}", file=sys.stderr)
                failed = True
    for network in CREATED["networks"]:
        failed |= run(["docker", "network", "rm", network], check=False).returncode != 0
    for directory in CREATED["dirs"]:
        failed |= sudo("rm", "-rf", "--", directory, check=False).returncode != 0
    for name in CREATED["groups"]:
        failed |= sudo("groupdel", name, check=False).returncode != 0
    if CREATED["config"]:
        failed |= sudo("rm", "-f", "--", RECEIVER_CONFIG, check=False).returncode != 0
    if CREATED["config_dir"]:
        failed |= sudo("rmdir", RECEIVER_CONFIG.parent, check=False).returncode != 0
    if CREATED["host_root"]:
        failed |= sudo("rmdir", HOST_ROOT, check=False).returncode != 0
    run(["rm", "-rf", "--", SCRATCH], check=False)
    return failed


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    except Exception as error:
        print(f"OATS_CREDENTIAL_GROUPS_ERROR {type(error).__name__}: {error}", flush=True)
        for g in GROUPS:
            print(run(["docker", "logs", "--tail", "80", g.container], check=False).stdout[-6000:], flush=True)
        code = 1
    finally:
        if cleanup():
            print("cleanup failed", file=sys.stderr)
            code = 1
    sys.exit(code)
