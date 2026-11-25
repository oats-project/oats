import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const receiver = fileURLToPath(new URL("../share/oats-login-receive", import.meta.url));
// Invoke the shipped run() with a private config path, without main()'s syslog
// or root-owned install paths. The source itself remains byte-identical.
const invoke = `import json, os, runpy, sys
assert os.geteuid() != 0, "receiver conformance tests must run as a non-root user"
assert sys.flags.isolated == 1
module = runpy.run_path(sys.argv[1], run_name="oats_login_receive_test")
out = module["run"](sys.argv[3], sys.stdin.buffer, config_path=sys.argv[2])
print(json.dumps(out))
sys.exit(0 if out["ok"] else 1)
`;

for (const [label, command, error, harness, name] of [
  ["malformed command", "install codex", "usage: install|remove|status <harness> <name>", null, null],
  ["unknown harness", "install unknown team", "unknown harness", null, null],
  ["bad name", "install codex bad/name", "bad name", null, null],
  ["absent config", "install codex team", "receiver config absent", "codex", "team"],
]) {
  test(`the isolated receiver refuses ${label} without echoing stdin`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "oats-receiver-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const input = Buffer.from("private-receiver-stdin-fixture-value");
    const result = spawnSync("python3", ["-I", "-c", invoke, receiver, join(home, "absent-config.json"), command], {
      input, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home }, timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.split("\n").length, 2, "the reply is exactly one JSON line");
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, harness, name, fingerprint: null, replacedAt: null, error });
    assert.equal(Buffer.from(result.stdout + result.stderr).includes(input), false);
  });
}

// --credential <entry-id> mode: the key decides the entry, SSH_ORIGINAL_COMMAND
// only the action. These are the refusals reachable without root: every later
// one needs the root-owned config and tree of test/credential-receiver-root.py,
// which the team-image workflow runs as root.
const invokeCredential = `import json, os, pty, runpy, sys
assert os.geteuid() != 0, "receiver conformance tests must run as a non-root user"
assert sys.flags.isolated == 1
module = runpy.run_path(sys.argv[1], run_name="oats_login_receive_test")
stdin = sys.stdin.buffer
if sys.argv[5] == "terminal":
    _, terminal = pty.openpty()
    stdin = os.fdopen(terminal, "rb")
out = module["run_credential"](json.loads(sys.argv[3]), sys.argv[4], stdin, config_path=sys.argv[2])
print(json.dumps(out))
sys.exit(0 if out["ok"] else 1)
`;

const credentialCases = [
  ["a malformed entry id", ["--credential", "Bad_Entry"], "install", "pipe", "bad entry id", null],
  ["an entry id that is too long", ["--credential", "a".repeat(64)], "install", "pipe", "bad entry id", null],
  ["--credential without an entry id", ["--credential"], "install", "pipe", "usage: oats-login-receive [--credential <entry-id>]", null],
  ["another argument", ["--harness", "cred-a"], "install", "pipe", "usage: oats-login-receive [--credential <entry-id>]", null],
  ["an extra argument", ["--credential", "cred-a", "extra"], "install", "pipe", "usage: oats-login-receive [--credential <entry-id>]", null],
  ["an empty command", ["--credential", "cred-a"], "", "pipe", "usage: install|remove|status", "cred-a"],
  ["a command that names a harness", ["--credential", "cred-a"], "install codex cred-a", "pipe", "usage: install|remove|status", "cred-a"],
  ["a command that names a path", ["--credential", "cred-a"], "install /etc/shadow", "pipe", "usage: install|remove|status", "cred-a"],
  ["an unknown action", ["--credential", "cred-a"], "replace", "pipe", "usage: install|remove|status", "cred-a"],
  ["a terminal on stdin", ["--credential", "cred-a"], "install", "terminal", "stdin is a terminal", "cred-a"],
  ["an absent config", ["--credential", "cred-a"], "install", "pipe", "receiver config absent", "cred-a"],
];

for (const [label, argv, command, stdin, error, entry] of credentialCases) {
  test(`the credential receiver refuses ${label} without echoing stdin`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "oats-receiver-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const input = Buffer.from("private-credential-stdin-fixture-value");
    const result = spawnSync("python3", ["-I", "-c", invokeCredential, receiver, join(home, "absent-config.json"), JSON.stringify(argv), command, stdin], {
      input, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home }, timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.split("\n").length, 2, "the reply is exactly one JSON line");
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, entry, fingerprint: null, replacedAt: null, error });
    assert.equal(Buffer.from(result.stdout + result.stderr).includes(input), false);
  });
}

test("the credential receiver refuses a config its caller could have written", (t) => {
  const home = mkdtempSync(join(tmpdir(), "oats-receiver-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = join(home, "receiver.json");
  writeFileSync(config, JSON.stringify({ credentials: { "cred-a": { group: "staff", path: join(home, "credentials", "marker"), access: "read-only" } } }), { mode: 0o600 });
  const input = Buffer.from("private-credential-stdin-fixture-value");
  const result = spawnSync("python3", ["-I", "-c", invokeCredential, receiver, config, JSON.stringify(["--credential", "cred-a"]), "install", "pipe"], {
    input, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home }, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, entry: "cred-a", fingerprint: null, replacedAt: null, error: `${config} is not root-owned or is group/other-writable` });
  assert.equal(Buffer.from(result.stdout).includes(input), false);
  assert.equal(existsSync(join(home, "credentials")), false, "nothing is created");
});
