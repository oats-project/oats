// A home an earlier (0.25) kernel spawned records no `modules` (lead decision c3 Q2):
// session start, restart and capability-command dispatch refuse it with
// E_UNSUPPORTED_MODE ("re-spawn it from the deployment") and change nothing;
// retire of a home also lacking capabilityRuntime requires explicit --force and
// says that no retire hook ran. Lacking modules alone does not imply this debt.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

/** Every entry under `dir` (path, kind, bytes or link target) → one digest. */
function treeDigest(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name), st = lstatSync(p), rel = relative(dir, p);
      if (st.isSymbolicLink()) h.update(`L ${rel} ${readlinkSync(p)}\n`);
      else if (st.isDirectory()) { h.update(`D ${rel}\n`); walk(p); }
      else h.update(`F ${rel} ${st.mode & 0o777} `).update(readFileSync(p)).update("\n");
    }
  };
  walk(dir);
  return h.digest("hex");
}

/** A pre-workspace fixture whose instance.json also lacks capabilityRuntime:
 *  neither modules nor capability hooks were recorded. Its independent
 *  session receipt (the retirement baseline) beside the instances. */
function preWorkspaceHome(fx, name) {
  const home = join(fx.root, "dev", "instances", name);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "TASK.md"), "task\n");
  writeFileSync(join(home, "AGENTS.md"), "# dev\n");
  writeFileSync(join(home, "instance.json"), JSON.stringify({
    agent: "dev", kind: "persistent", instance: name, home, repo: fx.member, work: "checkout", branch: null, harness: "claude",
    tmux: { session: `none-${process.pid}`, window: name }, command: `claude -- "$(cat TASK.md)"`, launched: false,
    capabilities: [], createdAt: "2026-09-01T00:00:00.000Z",
  }, null, 2) + "\n");
  const baselines = join(fx.root, "dev", "instances", ".oats-retirement", "baselines");
  mkdirSync(baselines, { recursive: true });
  writeFileSync(join(baselines, `${createHash("sha256").update(home).digest("hex")}.json`), JSON.stringify({ version: 2, home, homeFingerprint: { files: 3, digest: "fp" }, disposableReceipts: [], generatedWorkFingerprint: { digest: "fp-work" }, runtime: { launched: false, tmux: { session: `none-${process.pid}`, window: name } } }, null, 2) + "\n");
  return home;
}

const refusal = (r, what) => {
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  const doc = r.json();
  assert.equal(doc.ok, false, r.stdout);
  assert.equal(doc.error.code, "E_UNSUPPORTED_MODE", doc.error.message);
  assert.match(doc.error.message, /not a workspace-model home/);
  assert.match(doc.error.message, /re-spawn it from the deployment/);
  assert.match(doc.error.message, new RegExp(what));
};

test("a pre-workspace home: session start, session restart and capability dispatch from inside it are E_UNSUPPORTED_MODE and change nothing", () => {
  const fx = v2Deployment();
  try {
    const home = preWorkspaceHome(fx, "old-1");
    const before = treeDigest(home);
    refusal(fx.cli(["session", "start", "--home", home, "--json"]), "nothing was started");
    assert.equal(treeDigest(home), before, "start changed nothing in the home");
    refusal(fx.cli(["session", "restart", "--home", home, "--json"]), "nothing was started");
    assert.equal(treeDigest(home), before, "restart changed nothing in the home");
    // A capability command run by the agent inside that home (its identity names the home).
    refusal(fx.cli(["acme", "hello", "--json"], { cwd: home, env: { OATS_INSTANCE_HOME: home } }), "nothing was dispatched");
    assert.equal(treeDigest(home), before, "dispatch changed nothing in the home");
  } finally { fx.cleanup(); }
});

test("a pre-workspace home also lacking capabilityRuntime refuses before effects; explicit force removes it with the no-hook warning", () => {
  const fx = v2Deployment();
  try {
    const home = preWorkspaceHome(fx, "old-2");
    const meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
    assert.equal(Object.hasOwn(meta, "modules"), false, "fixture premise: a pre-workspace home");
    assert.equal(Object.hasOwn(meta, "capabilityRuntime"), false, "fixture premise: no recorded hook bindings, not just no workspace modules");
    const before = treeDigest(home);
    for (const flags of [["--plan"], []]) {
      const refused = fx.cli(["retire", "old-2", "--json", ...flags]);
      assert.equal(refused.status, 1, refused.stdout + refused.stderr);
      const doc = refused.json();
      assert.equal(doc.ok, false);
      assert.equal(doc.error.code, "E_UNIDENTIFIED_INSTANCE_HOME", doc.error.message);
      assert.match(doc.error.message, /does not record capabilityRuntime/);
      assert.match(doc.error.message, /Nothing was stopped, run or removed, including children/);
      assert.match(doc.error.message, /oats retire old-2 --force/);
      assert.equal(treeDigest(home), before, "refusal leaves the whole home unchanged");
    }
    const r = fx.cli(["retire", "old-2", "--force", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const result = JSON.parse(r.stdout); // retire --json prints its result document
    assert.equal(result.retired, "old-2");
    assert.equal(result.removedDir, true);
    assert.equal(existsSync(home), false, "the home is gone");
    assert.ok((result.warnings || []).some((w) => /this home records no capability hooks \(an earlier kernel spawned it\): no retire hook ran/.test(w)), JSON.stringify(result.warnings));
  } finally { fx.cleanup(); }
});
