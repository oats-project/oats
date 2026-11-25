// The older-kernel guarantee for a session-provider home (spec K1, T10; contract item 2).
//
// A session backend supplied by a capability records no tmux endpoint: its home's instance.json
// carries `backend` and `session: { provider, endpoint }`, and its independent receipt
// `runtime: { launched, backend, provider, endpoint, stoppedAt }`. The Desktop bundles its own
// kernel, so a kernel from before that contract can meet such a home on the same machine.
//
// What this pins is the kernel from before the contract, not the one in this checkout: it is
// taken from Git at PRE_CONTRACT (the last commit of main without session providers) and run as a
// child, so the test proves the same thing after the contract lands. Such a kernel only refuses:
//   - every session verb answers E_RUNTIME_ENDPOINT_UNKNOWN before any tmux call;
//   - a stop is refused the same way, and so is a retire, for as long as the record says
//     the home was launched: it never retires the home as one whose session is gone;
//   - its reads (status, the stop and retire plans) show the session as unknown, and their only
//     tmux calls are lookups of its own server: it never sends input to, kills or restarts the
//     agent through tmux.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  execFileSync("tar", ["-xf", tar, "-C", dir]);
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  return join(dir, "bin", "oats.mjs");
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const receiptOf = (home) => join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
const ENDPOINT = { server: "http://127.0.0.1:38886", projectId: "proj_1", threadId: "thr_1" };

/** A home recorded as a launched session-provider home: no tmux endpoint in its record or its receipt. */
async function providerHome(fx, name) {
  const { home } = await fx.spawn("dev", { name });
  const { tmux: _planned, ...meta } = readJson(join(home, "instance.json"));
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...meta, launched: true, backend: "fake", session: { provider: "acme.fake", endpoint: ENDPOINT } }, null, 2) + "\n");
  const receipt = receiptOf(home);
  assert.ok(existsSync(receipt), "the spawn wrote the independent session receipt");
  writeFileSync(receipt, JSON.stringify({ ...readJson(receipt), runtime: { launched: true, backend: "fake", provider: "acme.fake", endpoint: ENDPOINT, stoppedAt: null } }, null, 2) + "\n", { mode: 0o600 });
  return home;
}

/** A `tmux` first on PATH that records each call's arguments and fails. → { path, calls() } */
function recordingTmux(fx) {
  const bin = join(fx.base, "recording-bin"), log = join(fx.base, "tmux-calls.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`);
  chmodSync(join(bin, "tmux"), 0o755);
  return { path: `${bin}:${fx.env.PATH}`, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}
/** The tmux subcommands that only look a server up. */
const LOOKUPS = /^(?:-u )?(?:-L \S+ |-S \S+ )?(?:has-session|list-sessions|list-windows|list-panes|show-environment|display-message)\b|^-V$/;

test("T10: a kernel from before the session-provider contract only refuses a provider home", async (t) => {
  const cli = preContractKernel(t);
  const fx = v2Deployment({ t });
  const home = await providerHome(fx, "provider-home");
  const tmux = recordingTmux(fx);
  const text = join(fx.base, "input.txt");
  writeFileSync(text, "hello\n");
  const run = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: fx.dep, env: { ...fx.env, PATH: tmux.path }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return { ...r, json: () => JSON.parse(r.stdout.trim().split("\n").pop()) };
  };
  const before = { record: readFileSync(join(home, "instance.json"), "utf8"), receipt: readFileSync(receiptOf(home), "utf8") };

  await t.test("it is the kernel from before the contract", () => {
    const version = run("version", "--json").json();
    assert.deepEqual(version.sessionBackends, ["tmux"]);
    assert.equal(version.features.includes("session-providers"), false);
  });

  await t.test("every session verb answers E_RUNTIME_ENDPOINT_UNKNOWN and makes no tmux call", () => {
    const earlier = tmux.calls().length; // the version probe above asks the tmux binary its version
    for (const verb of [
      ["session", "inspect", "--home", home],
      ["session", "input", "--home", home, "--text-file", text],
      ["session", "start", "--home", home],
      ["session", "start", "--resume", "--home", home],
      ["session", "restart", "--home", home],
    ]) {
      const r = run(...verb, "--json");
      assert.equal(r.status, 1, verb.join(" "));
      const answer = r.json();
      assert.equal(answer.ok, false, verb.join(" "));
      assert.equal(answer.error.code, "E_RUNTIME_ENDPOINT_UNKNOWN", verb.join(" "));
    }
    // attach is interactive and has no JSON form: its refusal is the same receipt check's.
    const attach = run("session", "attach", "--home", home);
    assert.equal(attach.status, 1);
    assert.match(attach.stderr, /independent session receipt is missing or invalid/);
    assert.deepEqual(tmux.calls().slice(earlier), [], "no session verb reached tmux");
  });

  await t.test("a stop is refused, and nothing is signalled", () => {
    const plan = run("instance", "stop", "provider-home", "--plan", "--json").json();
    assert.equal(plan.ok, true);
    const target = plan.result.targets.find((row) => row.instance === "provider-home");
    assert.deepEqual(target.session, { state: "unestablished", present: null, backend: null, established: false, reason: "E_RUNTIME_ENDPOINT_UNKNOWN" });
    const applied = run("instance", "stop", "provider-home", "--apply", "--plan-revision", plan.result.planRevision, "--idempotency-key", "t10-stop", "--json");
    const answer = applied.json();
    const row = answer.ok ? answer.result.results?.find((r) => r.instance === "provider-home") : null;
    assert.equal(answer.ok ? row?.code : answer.error.code, "E_RUNTIME_ENDPOINT_UNKNOWN", applied.stdout);
    assert.equal(existsSync(join(home, ".oats-stop.json")), false, "no stop was recorded");
  });

  await t.test("a retire is refused and keeps the home", () => {
    const plan = run("retire", "provider-home", "--plan", "--json").json();
    assert.equal(plan.ok, true);
    assert.equal(plan.result.facts.session.established, false);
    assert.equal(plan.result.facts.session.reason, "E_RUNTIME_ENDPOINT_UNKNOWN");
    const retired = run("retire", "provider-home", "--json");
    assert.equal(retired.status, 1);
    const answer = retired.json();
    assert.equal(answer.error.code, "E_RUNTIME_ENDPOINT_UNKNOWN");
    assert.match(answer.error.message, /instance\.json records a launch but no session endpoint/);
    assert.deepEqual(answer.error.details.reached, { phase: "before-effects", sessionStopAttempted: false, hooksStarted: false, home: "kept", recovery: null });
    assert.ok(existsSync(join(home, "instance.json")), "the home is kept");
  });

  await t.test("status lists the home without reading it as running", () => {
    const status = run("status", "--json");
    assert.equal(status.status, 0, status.stderr);
    const rows = JSON.parse(status.stdout).agents.flatMap((agent) => agent.instances);
    const row = rows.find((r) => r.instance === "provider-home");
    assert.equal(row.backend, "fake");
    assert.deepEqual(row.session, { provider: "acme.fake", endpoint: ENDPOINT });
    assert.notEqual(row.running, true);
  });

  // Over everything above: the older kernel's only tmux calls look its own server up.
  const acted = tmux.calls().filter((call) => !LOOKUPS.test(call));
  assert.deepEqual(acted, [], "no tmux call sends input to, kills or restarts anything");
  assert.equal(readFileSync(join(home, "instance.json"), "utf8"), before.record, "the record is unchanged");
  assert.equal(readFileSync(receiptOf(home), "utf8"), before.receipt, "the receipt is unchanged");
});
