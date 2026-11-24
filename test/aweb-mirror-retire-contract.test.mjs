// Keep the released provider's real answer coupled to the kernel classifier.
// The lifecycle runner paths remain in retire-hook-contract.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hookCleanupComplete } from "../lib/hook-outcome.mjs";

const hook = fileURLToPath(new URL("../mirrors/oats-aweb/bin/oats-aweb.mjs", import.meta.url));
test("mirrored aweb no-grant retire is complete under the kernel hook contract", t => {
  const root = mkdtempSync(join(tmpdir(), "oats-mirror-retire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "instance"), bin = join(root, "bin");
  mkdirSync(home); mkdirSync(bin);
  const calls = join(root, "aw-calls");
  writeFileSync(join(bin, "aw"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_AW_LOG"\nprintf "unexpected aw %s\\n" "$*" >&2\nexit 2\n', { mode: 0o755 });
  // Satisfy CLI discovery, but reject every native call. The no-grant path
  // must produce its own answer without any identity/service interaction.
  const result = spawnSync(process.execPath, [hook, "retire"], {
    cwd: home, encoding: "utf8", timeout: 10000,
    env: { PATH: bin, HOME: root, FIXTURE_AW_LOG: calls, OATS_EVENT: "retire", OATS_INSTANCE: "fixture", OATS_HOME: home, OATS_INSTANCE_HOME: home,
      OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_SETTINGS: "{}",
      OATS_META: JSON.stringify({ identity: { mode: "global", resident: "fixture" } }) },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(calls), false, "the no-grant path needs no native aw call");
  const answer = JSON.parse(result.stdout.trim());
  assert.equal(answer.meta.retired, false, "the fixture exercises a no-op, not a claimed revocation");
  assert.equal(hookCleanupComplete(answer.meta), true, "the mirror's no-grant answer completes kernel cleanup");
});
