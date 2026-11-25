"""The receiver's --credential mode against a real root-owned tree. CI-only: the team-image workflow runs it as root
(`sudo -n python3 -I`) on a disposable runner. It creates one unix group and one private directory under /run, and
removes both. Never run it on a workstation or a customer host.

The non-root refusals (argv, command, terminal, absent or caller-owned config) are in
test/harness-token-receiver.test.mjs.
"""
import grp
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import stat
import subprocess
import sys
import tempfile

if os.geteuid() != 0:
    raise SystemExit("credential-receiver-root.py must run as root, in CI only")
assert sys.flags.isolated == 1, "run with python3 -I"

receiver = runpy.run_path(str(Path(__file__).resolve().parents[1] / "share/oats-login-receive"), run_name="oats_login_receive_test")
run_credential = receiver["run_credential"]
group = f"oats-crt-{os.getpid()}"
absent_group = f"oats-crt-absent-{os.getpid()}"
failures = []


def check(label, condition):
    print(("PASS " if condition else "FAIL ") + label, flush=True)
    if not condition:
        failures.append(label)


def mode(path):
    st = os.lstat(path)
    return st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode)


subprocess.run(["groupadd", group], check=True)
base = Path(tempfile.mkdtemp(prefix="oats-credential-receiver-", dir="/run"))
try:
    base.chmod(0o755)
    gid = grp.getgrnam(group).gr_gid
    config_dir = base / "etc"
    config_dir.mkdir(mode=0o755)
    config = config_dir / "receiver.json"
    team = base / "srv" / "team-a"
    path = str(team / "credentials" / "mail")

    def configure(entries, extra=None):
        config.write_text(json.dumps({"credentials": entries, **(extra or {})}))
        config.chmod(0o644)

    def entry(**fields):
        return {"group": group, "path": path, "access": "read-only", **fields}

    def call(action, value=b"", entry_id="cred-a"):
        return run_credential(["--credential", entry_id], action, io.BytesIO(value), config_path=str(config))

    def refused(label, out, error, value=None):
        check(f"{label}: refused with {error!r} (got {out.get('error')!r})",
              out == {"ok": False, "entry": "cred-a", "fingerprint": None, "replacedAt": None, "error": error})
        if value is not None:
            check(f"{label}: the answer does not echo the value", value not in json.dumps(out).encode())

    def no_leftovers(label):
        directory = os.path.dirname(path)
        leftovers = [n for n in os.listdir(directory) if n.endswith(".new")] if os.path.isdir(directory) else []
        check(f"{label}: no temporary file is left", leftovers == [])

    # Install: a multi-line JSON bundle, opaque to the receiver.
    configure({"cred-a": entry()})
    value = b'{"tenant": "fixture-tenant", "client_id": "fixture-client",\n "client_secret": "fixture-not-a-secret"}'
    out = call("install", b"\n  " + value + b"\n\n")
    check("install answers ok with the fingerprint of the stripped value",
          out.get("ok") is True and out["entry"] == "cred-a" and out["fingerprint"] == "sha256:" + hashlib.sha256(value).hexdigest()[:16]
          and isinstance(out["replacedAt"], str) and set(out) == {"ok", "entry", "fingerprint", "replacedAt"})
    check("install's answer never holds the value", b"fixture-not-a-secret" not in json.dumps(out).encode())
    check("the file is root:<group> 0440", mode(path) == (0, gid, 0o440))
    check("the file holds the stripped value and a newline", Path(path).read_bytes() == value + b"\n")
    check("a fresh credentials directory is root:<group> 0750", mode(os.path.dirname(path)) == (0, gid, 0o750))
    check("fresh parents are root:root 0755", mode(team) == (0, 0, 0o755) and mode(base / "srv") == (0, 0, 0o755))
    no_leftovers("install")
    out = call("status")
    check("status answers the installed fingerprint",
          out.get("ok") is True and out["fingerprint"] == "sha256:" + hashlib.sha256(value).hexdigest()[:16])

    # Replacement is atomic and keeps the mode.
    replacement = "fixture-value-é中".encode() * 10
    out = call("install", replacement)
    check("a replacement answers ok", out.get("ok") is True)
    check("a replacement keeps root:<group> 0440", mode(path) == (0, gid, 0o440) and Path(path).read_bytes() == replacement + b"\n")
    no_leftovers("replacement")

    # The value: size, emptiness, NUL and UTF-8.
    out = call("install", b"x" * 65536)
    check("a value of exactly 65,536 bytes is accepted", out.get("ok") is True)
    for label, data, error in [
        ("an oversize value", b"x" * 65537, "credential too large"),
        ("an empty value", b"", "empty credential"),
        ("a whitespace-only value", b" \n\t\n", "empty credential"),
        ("a value with NUL", b"fixture\0value", "credential contains NUL"),
        ("a value that is not UTF-8", b"fixture-\xff-value", "credential is not UTF-8"),
    ]:
        before = Path(path).read_bytes()
        refused(label, call("install", data), error, data or None)
        check(f"{label}: the installed file is unchanged", Path(path).read_bytes() == before)
        no_leftovers(label)

    # Remove, then status.
    out = call("remove")
    check("remove answers ok and deletes the file", out.get("ok") is True and not os.path.lexists(path))
    refused("status after remove", call("status"), "no credential installed")
    check("remove of an absent file answers ok", call("remove").get("ok") is True)

    # The config.
    for label, entries, error in [
        ("an unknown entry", {"cred-b": entry()}, "entry not configured on this host"),
        ("an entry that is not an object", {"cred-a": "read-only"}, "entry not configured on this host"),
        ("absent access", {"cred-a": {"group": group, "path": path}}, "access not supported by this receiver"),
        ("read-write access", {"cred-a": entry(access="read-write")}, "access not supported by this receiver"),
        ("rotating access", {"cred-a": entry(access="rotating")}, "access not supported by this receiver"),
        ("an absent group", {"cred-a": entry(group=absent_group)}, "configured group absent"),
        ("no group", {"cred-a": {"path": path, "access": "read-only"}}, "configured group absent"),
        ("no path", {"cred-a": {"group": group, "access": "read-only"}}, "configured path is not absolute and normalized"),
        ("a relative path", {"cred-a": entry(path="srv/team-a/credentials/mail")}, "configured path is not absolute and normalized"),
        ("a path with ..", {"cred-a": entry(path=str(team / "credentials" / ".." / "credentials" / "mail"))}, "configured path is not absolute and normalized"),
        ("a path with //", {"cred-a": entry(path=str(team) + "//credentials/mail")}, "configured path is not absolute and normalized"),
        ("a path with a trailing slash", {"cred-a": entry(path=path + "/")}, "configured path is not absolute and normalized"),
        ("a path outside a credentials directory", {"cred-a": entry(path=str(team / "login" / "mail"))}, "configured path is not in a credentials directory"),
        ("a path that is the credentials directory", {"cred-a": entry(path=str(team / "credentials"))}, "configured path is not in a credentials directory"),
    ]:
        configure(entries)
        refused(label, call("install", b"fixture-value"), error, b"fixture-value")
    check("nothing was written by a refused config", not os.path.lexists(path))
    # A destination shared with another entry would let one person's key overwrite or remove another's credential.
    other_path = str(team / "credentials" / "other")
    shared = "configured path is shared with another entry"
    for label, extra_entries, teams in [
        ("another entry with the same path", {"cred-b": entry()}, None),
        ("another entry in the same credentials directory", {"cred-b": entry(path=other_path)}, None),
        ("another entry whose path is not normalized but resolves to the same file", {"cred-b": entry(path=str(team) + "//credentials/mail")}, None),
        ("a teams destination at the same path", {}, {"team-a": {"group": group, "harnesses": ["codex"], "path": path}}),
        ("a teams destination in the same directory", {}, {"team-a": {"group": group, "harnesses": ["claude", "codex"], "path": str(team / "credentials" / "{harness}-token")}}),
        ("a teams destination whose {name} and {harness} resolve into the same directory", {},
         {"team-a": {"group": group, "harnesses": ["pi"], "path": str(base / "srv" / "{name}" / "credentials" / "{harness}-token")}}),
    ]:
        configure({"cred-a": entry(), **extra_entries}, {"teams": teams} if teams else None)
        for action in ("install", "status", "remove"):
            refused(f"{label} ({action})", call(action, b"fixture-value" if action == "install" else b""), shared, b"fixture-value")
        check(f"{label}: nothing was written", not os.path.lexists(path) and not os.path.lexists(other_path))
    configure({"cred-a": entry(), "cred-b": entry(path=str(base / "srv" / "team-b" / "credentials" / "mail"))},
              {"teams": {"team-a": {"group": group, "harnesses": ["codex"]}}})
    out = call("install", b"fixture-value")
    check("an entry that shares nothing with another entry or a teams destination installs", out.get("ok") is True)
    call("remove")
    shutil.rmtree(base / "srv", ignore_errors=True)
    config.write_text(json.dumps({"teams": {}}))
    refused("a config with no credentials object", call("install", b"fixture-value"), "receiver config has no credentials")
    config.write_text(json.dumps({"credentials": {"cred-a": entry()}}))
    harness = receiver["run"]("install codex team-a", io.BytesIO(b"fixture-value"), config_path=str(config))
    check("harness mode still refuses a config with no teams",
          harness == {"ok": False, "harness": "codex", "name": "team-a", "fingerprint": None, "replacedAt": None, "error": "receiver config has no teams"})

    # The tree: symlinks and writable components are refused, and an existing directory is never changed.
    configure({"cred-a": entry()})
    credentials = Path(os.path.dirname(path))

    def tree_case(label, prepare, error, actions=("install", "status", "remove")):
        shutil.rmtree(team, ignore_errors=True)
        if os.path.lexists(team):
            os.unlink(team)
        snapshot = prepare()
        before = mode(snapshot) if snapshot else None
        for action in actions:
            refused(f"{label} ({action})", call(action, b"fixture-value" if action == "install" else b""), error, b"fixture-value")
            if snapshot:
                check(f"{label} ({action}): the existing component is unchanged", mode(snapshot) == before)
        no_leftovers(label)

    def existing(directory, uid, gid_, perms):
        directory.mkdir(parents=True, exist_ok=True)
        for parent in (base / "srv", team):
            os.chown(parent, 0, 0)
            parent.chmod(0o755)
        os.chown(directory, uid, gid_)
        directory.chmod(perms)
        return directory

    tree_case("an existing credentials directory owned by root:root", lambda: existing(credentials, 0, 0, 0o750),
              f"credentials directory is not root:{group} 0750")
    tree_case("an existing credentials directory of mode 0755", lambda: existing(credentials, 0, gid, 0o755),
              f"credentials directory is not root:{group} 0750")
    tree_case("an existing credentials directory of mode 0700", lambda: existing(credentials, 0, gid, 0o700),
              f"credentials directory is not root:{group} 0750")
    tree_case("a group-writable credentials directory", lambda: existing(credentials, 0, gid, 0o770),
              f"{credentials} is not root-owned or is group/other-writable")
    tree_case("a credentials directory not owned by root", lambda: existing(credentials, 1, gid, 0o750),
              f"{credentials} is not root-owned or is group/other-writable")
    tree_case("a group-writable parent", lambda: existing(team, 0, gid, 0o775),
              f"{team} is not root-owned or is group/other-writable")
    tree_case("an other-writable parent", lambda: existing(team, 0, 0, 0o757),
              f"{team} is not root-owned or is group/other-writable")

    def symlinked_credentials():
        target = base / "elsewhere"
        target.mkdir(exist_ok=True)
        os.chown(target, 0, gid)
        target.chmod(0o750)
        team.mkdir(parents=True)
        team.chmod(0o755)
        credentials.symlink_to(target)
        return None

    tree_case("a symlinked credentials directory", symlinked_credentials, f"{credentials} is a symlink")
    check("nothing was written through the symlink", os.listdir(base / "elsewhere") == [])

    def symlinked_parent():
        target = base / "elsewhere-team"
        (target / "credentials").mkdir(parents=True, exist_ok=True)
        os.chown(target / "credentials", 0, gid)
        (target / "credentials").chmod(0o750)
        team.symlink_to(target)
        return None

    tree_case("a symlinked parent", symlinked_parent, f"{team} is a symlink")
    check("nothing was written through the symlinked parent", os.listdir(base / "elsewhere-team" / "credentials") == [])

    def file_case(label, prepare, error):
        shutil.rmtree(team, ignore_errors=True)
        if os.path.lexists(team):
            os.unlink(team)
        team.mkdir(parents=True)
        team.chmod(0o755)
        credentials.mkdir()
        os.chown(credentials, 0, gid)
        credentials.chmod(0o750)
        prepare()
        before = os.lstat(path)
        for action in ("install", "status", "remove"):
            refused(f"{label} ({action})", call(action, b"fixture-value" if action == "install" else b""), error, b"fixture-value")
            after = os.lstat(path)
            check(f"{label} ({action}): the file is unchanged", (after.st_ino, after.st_mode, after.st_uid, after.st_gid) == (before.st_ino, before.st_mode, before.st_uid, before.st_gid))
        no_leftovers(label)

    def writable_file():
        Path(path).write_bytes(b"old\n")
        os.chown(path, 0, gid)
        os.chmod(path, 0o460)

    def symlinked_file():
        target = base / "target-file"
        target.write_bytes(b"old\n")
        os.symlink(target, path)

    file_case("a group-writable existing file", writable_file, f"{path} is not root-owned or is group/other-writable")
    file_case("a symlinked existing file", symlinked_file, f"{path} is a symlink")
    check("nothing was written through the symlinked file", (base / "target-file").read_bytes() == b"old\n")
finally:
    shutil.rmtree(base, ignore_errors=True)
    subprocess.run(["groupdel", group], check=False)

if failures:
    print(f"FAIL credential receiver: {len(failures)} check(s) failed", flush=True)
    sys.exit(1)
print("OATS_CREDENTIAL_RECEIVER_PASS", flush=True)
