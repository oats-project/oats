// Git's version changes cache support, never whether doctor accepts the deployment.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { systemExecutable } from "./helpers/host-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

test("doctor text and JSON report Git's parsed version and cache support as information, using one version probe", (t) => {
  const fx = v2Deployment();
  t.after(() => fx.cleanup());
  const bin = join(fx.base, "git-bin"), calls = join(fx.base, "version-calls");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = --version ]; then
  printf 'probe\\n' >> ${quote(calls)}
  printf '%s\\n' "$FIXTURE_GIT_VERSION"
  exit 0
fi
exec ${quote(systemExecutable("git"))} "$@"
`, { mode: 0o755 });
  const partial = "partial caches supported (a remote or an existing cache may still use whole-tree fetches)";
  const cases = [
    ["git version 2.43.0", "Git 2.43.0; whole-tree fallback (partial caches need Git 2.45 or later)"],
    ["git version 2.45.0", `Git 2.45.0; ${partial}`],
    ["git version 2.54.0", `Git 2.54.0; ${partial}`],
    ["unparseable", "Git version could not be read; partial-cache support unknown"],
  ];
  for (const [version, message] of cases) for (const json of [true, false]) {
    writeFileSync(calls, "");
    const result = fx.cli(["doctor", ...(json ? ["--json"] : [])], {
      env: { PATH: `${bin}${delimiter}${fx.env.PATH}`, FIXTURE_GIT_VERSION: version },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = `git-version: ${message}`;
    if (json) {
      const doc = JSON.parse(result.stdout);
      assert.deepEqual(doc.information.filter((entry) => entry.startsWith("git-version:")), [line]);
      assert.ok(!JSON.stringify(doc.warnings).includes("git-version:"), "no Git warning");
      assert.ok(!JSON.stringify(doc.problems || []).includes("git-version:"), "no Git problem");
    } else {
      assert.ok(result.stdout.includes(`\nINFO: ${line}\n`), result.stdout);
      assert.ok(!result.stdout.includes(`WARNING: ${line}`));
    }
    assert.equal(readFileSync(calls, "utf8"), "probe\n", "doctor reuses the existing version probe");
  }
});
