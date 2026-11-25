// The older-kernel fact for a manifest's `sandboxDomains` (spec K2; D11 "Rollout cost").
//
// `sandboxDomains` is a top-level manifest key a capability declares so that a session provider may
// widen its harness sandbox by the hosts of that capability's own URL settings. A package that adds
// the line can meet a kernel from before the session-provider contract (the Desktop bundles its own
// kernel; a deployment upgrades its packages before OATS).
//
// What this pins is the kernel from before the contract, not the one in this checkout: it is taken
// from Git at PRE_CONTRACT and run as a child, so the test proves the same thing after K2 lands.
// Such a kernel IGNORES the key, silently: it neither refuses the manifest nor acts on the line,
// whether the capability fills no slot, fills the messaging slot because a soul composes it (a
// composed capability that declares a layer is that slot's provider), or fills it as the
// workspace's default. So the line costs an older deployment nothing, and protects nothing
// there either: a package's OATS floor, not a refusal by the older kernel, is what keeps the line
// from being relied on with a kernel that does not read it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
/** awebai/oats main before the session-provider contract. */
const PRE_CONTRACT = "e5b6c5ac4f3eabbb73990d9c2a4c0c3ca14ca422";
/** What a kernel runs from: the directories and files the published package ships (package.json `files`). */
const KERNEL_PATHS = ["bin", "lib", "share", "skills", "injects", "docs", "package.json", "package-catalog.json", "packages/record", "packages/client", "packages/tui"];

/** The kernel at PRE_CONTRACT, extracted from this repository's history → its CLI. Its
 *  dependencies are this checkout's: the contract adds none. */
function preContractKernel(t) {
  const dir = mkdtempSync(join(tmpdir(), "oats-pre-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tar = join(dir, "kernel.tar");
  try { execFileSync("git", ["-C", REPO, "archive", "--format=tar", "-o", tar, PRE_CONTRACT, "--", ...KERNEL_PATHS], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { assert.fail(`this test runs the kernel at ${PRE_CONTRACT}, which this clone's history must hold (a shallow clone does not: git fetch --unshallow): ${String(e.stderr ?? e.message).trim()}`); }
  const kernel = join(dir, "kernel");
  mkdirSync(kernel);
  execFileSync("tar", ["-xf", tar, "-C", kernel]);
  if (existsSync(join(REPO, "node_modules"))) symlinkSync(join(REPO, "node_modules"), join(kernel, "node_modules"), "dir");
  return join(kernel, "bin", "oats.mjs");
}

const LINE = [{ setting: "server" }];
const SETTINGS = { server: { type: "string", default: "https://app.example.org/x" } };

for (const [what, capability, bound] of [
  ["a composed capability that fills no slot", { manifest: { settings: SETTINGS, sandboxDomains: LINE } }, false],
  ["the messaging provider a soul composes", { manifest: { layer: "messaging", settings: SETTINGS, sandboxDomains: LINE } }, false],
  ["the messaging provider the workspace's default names", { manifest: { layer: "messaging", settings: SETTINGS, sandboxDomains: LINE } }, true],
]) {
  test(`a kernel from before the contract ignores a top-level sandboxDomains: ${what}`, async (t) => {
    const cli = preContractKernel(t);
    const fx = v2Deployment({
      t, name: "acme",
      souls: { dev: { soul: bound ? {} : { capabilities: { "acme.hosts": { from: "here" } } } } },
      capabilities: { "acme.hosts": { ...capability, files: {} } },
    });
    // The messaging slot's binding is the workspace's: a default that names the member's capability.
    if (bound) fx.commit({ "oats-workspace.yaml": { yaml: { schemaVersion: 2, name: "acme", members: [fx.ref], teams: { global: { description: "Fixture team" } }, defaults: { knowledge: "none", messaging: { "acme.hosts": { from: fx.key } }, tasks: "none" } } } });
    const older = (args) => {
      const r = spawnSync(process.execPath, [cli, ...args], { cwd: fx.dep, env: fx.env, encoding: "utf8" });
      return { answer: JSON.parse(r.stdout.trim().split("\n").pop()), stderr: r.stderr };
    };
    // The manifest is accepted, and the line is neither refused nor named anywhere.
    const shown = older(["capabilities", "show", "acme.hosts", "--json"]);
    assert.equal(shown.answer.ok, true, JSON.stringify(shown.answer));
    const preview = older(["spawn", "dev", "--preview", "--json"]);
    assert.equal(preview.answer.ok, true, JSON.stringify(preview.answer));
    assert.deepEqual(preview.answer.result.modules.map((m) => m.name), ["acme.hosts"]);
    const spawned = older(["spawn", "dev", "--name", "one", "--no-launch", "--json"]);
    assert.equal(spawned.answer.ok, true, JSON.stringify(spawned.answer));
    for (const said of [shown, preview, spawned]) {
      assert.equal(JSON.stringify(said.answer).includes("sandboxDomains"), false, "no answer names the key");
      assert.equal(/sandbox/i.test(said.stderr), false, "nor does a warning");
    }
  });
}
