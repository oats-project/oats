import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
