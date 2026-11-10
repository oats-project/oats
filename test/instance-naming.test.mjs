// Feature spawn-suggest-name (awebai/oats#1421 §3): `oats spawn <soul> --preview --suggest-name` names
// the instance for its task through the soul's own harness (lib/instance-naming.mjs), or numbers it and
// says why. CI has no real harness: a fake executable stands in, recording what the call gave it.
//
// What is pinned here:
// - the role: the kernel's soulRole on the clients' very rows (test/client-instance-name.test.mjs
//   ROLE_CASES), and the name built from a reply on NAME_CASES where a reply and a typed name mean the same;
// - the name: first non-empty line, slug, trailing roles stripped, 4 words, the length budget, -2/-3;
// - the prompt (the maintainer's words) and each harness's argv, exactly; codex has none;
// - the call's isolation: the prompt on stdin and never in argv, a fresh empty working directory
//   removed afterwards, no OATS_INSTANCE* variable, its own process group (killed on timeout, what it
//   started included), stdout read up to 4 KiB, a message that never carries the output;
// - the closed reason set, each one, and that a failure is never an error;
// - the CLI: the refusals, the answer's `naming`, a suggested name previewed as --name (the same
//   decision, which an apply with --expect-decision matches), numbered otherwise, the feature;
// - an apply's --suggest-name (feature spawn-apply-suggest-name, awebai/oats#1490 §3): the name placed
//   as --name places it, unique as today, numbered on any failure, within its own 20 s;
// - `oats instance suggest-name` (feature instance-suggest-name, #1490 §2): the preview's name for a
//   soul that needn't exist here, not made unique, through this machine's launch configurations,
//   writing and recording nothing, never routed.
import test from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureBase } from "./helpers/host-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { NAME_CASES, ROLE_CASES } from "./client-instance-name.test.mjs";
import { spawnPreparedData } from "../packages/client/spawn-apply-contract.mjs";
import {
  NAMING_CALLS, NAMING_OUTPUT_MAX, NAMING_PROMPT, NAMING_REASONS, NAMING_TASK_MAX, NAMING_TIMEOUT_MS,
  descriptiveWords, namingCall, namingEnvironment, namingPrompt, soulRole, suggestInstanceName, uniqueName,
} from "../lib/instance-naming.mjs";

const never = () => false;
const named = (reply, soul, taken = never) => { const role = soulRole(soul); return uniqueName(descriptiveWords(reply, role), role, taken); };

/** A fake harness: it records its argv, working directory (and what is in it), environment names,
 *  stdin, pid and process group to $FAKE_RECORD, then prints $FAKE_REPLY (default a name) and exits
 *  $FAKE_EXIT, after $FAKE_SLEEP_MS. With $FAKE_GRANDCHILD it first starts a `sleep` and records its pid.
 *  Asked for Claude's `plugin list --json` (the package probe), it prints $FAKE_PLUGINS (default none). */
function fakeHarness(t) {
  const dir = fixtureBase("oats-naming-fake-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "harness");
  writeFileSync(bin, `#!${process.execPath}
const fs = require("fs"), cp = require("child_process");
if (process.argv.slice(2, 5).join(" ") === "plugin list --json") { process.stdout.write(process.env.FAKE_PLUGINS ?? "[]"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  let pgid = null;
  try { pgid = Number(fs.readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[2]); } catch {}
  if (process.env.FAKE_GRANDCHILD) { const g = cp.spawn("sleep", ["30"], { stdio: "ignore" }); fs.writeFileSync(process.env.FAKE_GRANDCHILD, String(g.pid)); }
  if (process.env.FAKE_RECORD) fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), stdin: input, env: Object.keys(process.env), pid: process.pid, pgid }));
  const finish = () => { process.stdout.write(process.env.FAKE_REPLY ?? "fix-login-bug\\n"); process.exitCode = Number(process.env.FAKE_EXIT ?? 0); };
  if (process.env.FAKE_SLEEP_MS) setTimeout(finish, Number(process.env.FAKE_SLEEP_MS)); else finish();
});
`);
  chmodSync(bin, 0o755);
  return { bin, dir, record: join(dir, "record.json"), read: () => JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("soulRole is the clients' rule: every ROLE_CASES row", () => {
  for (const [soul, role] of ROLE_CASES) assert.equal(soulRole(soul), role, soul);
  for (const v of [undefined, null, 7, {}]) assert.equal(soulRole(v), "");
});

test("a reply's name agrees with the clients' nameWithRole wherever a reply means what a typed name does", () => {
  // A reply is a model's answer, not a typed name: it is slugged first (case is not the operator's),
  // and one that is only the role, or empty, describes no work (invalid-reply, never a name).
  const kernelOwn = new Map([["expert · oats-desktop-expert", null], ["cloner · cloner", null], ["Desktop-Expert · oats-desktop-expert", "desktop-expert"], [" · oats-desktop-expert", null]]);
  for (const [typed, soul, final] of NAME_CASES) {
    const key = `${typed} · ${soul}`;
    assert.equal(named(typed, soul), kernelOwn.has(key) ? kernelOwn.get(key) : final, key);
  }
});

test("the name: the first non-empty line as a slug, trailing roles stripped, at most 4 words, within 64, -2 and -3 when taken", () => {
  assert.equal(named("\n  \nFix the Login Bug!\nsecond line", "oats-developer"), "fix-the-login-bug-developer");
  assert.equal(named("desktop-improvements-expert-expert", "oats-desktop-expert"), "desktop-improvements-expert", "one or more trailing roles");
  assert.equal(named("one-two-three-four-five-six", "code-reviewer"), "one-two-three-four-reviewer", "4 words");
  assert.equal(named("`release-notes`", "oats-maintainer"), "release-notes-maintainer");
  for (const reply of ["", "   \n\n", "!!!", "reviewer", "reviewer-reviewer"]) assert.equal(named(reply, "code-reviewer"), null, JSON.stringify(reply));
  // The budget: 64 − 1 − len(role), cut at a word boundary.
  const long = ["a".repeat(30), "b".repeat(20), "c".repeat(20)].join("-");
  assert.equal(named(long, "code-reviewer"), `${"a".repeat(30)}-${"b".repeat(20)}-reviewer`);
  assert.ok(named(long, "code-reviewer").length <= 64);
  assert.equal(named("x".repeat(70), "code-reviewer"), null, "one word past the budget leaves nothing");
  // Taken (an instance, a soul, a live window): -2, -3; a suffix past 64 drops a word first.
  const taken = new Set(["fix-login-developer", "fix-login-developer-2"]);
  assert.equal(named("fix-login", "oats-developer", (n) => taken.has(n)), "fix-login-developer-3");
  const full = `${"a".repeat(30)}-${"b".repeat(22)}`; // 53 + "-developer" (10) = 63
  const fullName = `${full}-developer`;
  assert.equal(fullName.length, 63);
  assert.equal(named(full, "oats-developer", (n) => n === fullName), `${"a".repeat(30)}-developer-2`);
  // No role: the descriptive name alone.
  assert.equal(named("mirror-sync", "trailing-"), "mirror-sync");
});

test("the prompt is the maintainer's words, the task cut to 4000 characters", () => {
  assert.equal(NAMING_PROMPT, "Name an agent for this task: 2–4 lowercase words joined by hyphens, describing the work, not the role. Reply with the name only.");
  assert.equal(namingPrompt("Fix it."), `${NAMING_PROMPT}\n\nTask:\nFix it.`);
  assert.equal(NAMING_TASK_MAX, 4000);
  const task = "🙂".repeat(5000);
  assert.equal(namingPrompt(task), `${NAMING_PROMPT}\n\nTask:\n${"🙂".repeat(4000)}`, "characters, not UTF-16 units");
  assert.deepEqual([NAMING_TIMEOUT_MS, NAMING_OUTPUT_MAX], [20000, 4096]);
  assert.deepEqual([...NAMING_REASONS], ["no-task", "unsupported-harness", "timeout", "harness-failed", "invalid-reply"]);
});

test("each harness's argv, exactly (proven by scripts/naming-isolation-proof.mjs); codex has none", () => {
  assert.deepEqual(Object.keys(NAMING_CALLS), ["claude", "pi"]);
  assert.equal(NAMING_CALLS.claude.model("claude-opus-5-5"), "haiku");
  assert.deepEqual(NAMING_CALLS.claude.argv("haiku"), ["-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--output-format", "text", "--model", "haiku"]);
  assert.equal(NAMING_CALLS.pi.model("github-copilot/gpt-6-astra"), "github-copilot/gpt-6-astra");
  assert.equal(NAMING_CALLS.pi.model(null), null);
  assert.deepEqual(NAMING_CALLS.pi.argv("github-copilot/gpt-6-astra"), ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--model", "github-copilot/gpt-6-astra"]);
  assert.deepEqual(NAMING_CALLS.pi.argv(null), ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve"]);
  for (const call of Object.values(NAMING_CALLS)) assert.equal(call.argv("m").some((a) => a.includes("Task:")), false, "the prompt is never in argv");
  // No tools on either harness (the maintainer's condition on the stated exceptions, awebai/oats#1421).
  const claude = NAMING_CALLS.claude.argv("haiku"), at = claude.indexOf("--tools");
  assert.ok(at >= 0 && claude[at + 1] === "", 'claude: --tools ""');
  for (const m of ["github-copilot/gpt-6-astra", null]) assert.ok(NAMING_CALLS.pi.argv(m).includes("--no-tools"), "pi: --no-tools");
});

test("namingEnvironment passes no OATS_INSTANCE* variable", () => {
  assert.deepEqual(namingEnvironment({ PATH: "/bin", HOME: "/h", OATS_INSTANCE: "a", OATS_INSTANCE_HOME: "/x", OATS_INSTANCE_FOO: "y", OATS_HOME: "/o" }), { PATH: "/bin", HOME: "/h", OATS_HOME: "/o" });
});

test("the call: stdin carries the prompt, argv the harness's flags, a fresh empty cwd removed afterwards, no OATS_INSTANCE*, its own process group", async (t) => {
  const fake = fakeHarness(t);
  const env = () => ({ ...process.env, FAKE_RECORD: fake.record, OATS_INSTANCE: "caller", OATS_INSTANCE_HOME: "/somewhere" });
  const r = await namingCall({ harness: "claude", bin: fake.bin, instanceModel: "claude-opus-5-5", env, task: "Fix the login bug" });
  assert.equal(r.answer.source, "suggested");
  assert.deepEqual({ ...r.answer, ms: 0 }, { source: "suggested", ms: 0, harness: "claude", model: "haiku" });
  assert.equal(r.reply, "fix-login-bug\n");
  const seen = fake.read();
  assert.deepEqual(seen.argv, NAMING_CALLS.claude.argv("haiku"));
  assert.equal(seen.stdin, namingPrompt("Fix the login bug"));
  assert.deepEqual(seen.cwdEntries, [], "an empty working directory");
  assert.equal(existsSync(seen.cwd), false, "removed afterwards");
  assert.equal(seen.env.some((n) => n.startsWith("OATS_INSTANCE")), false);
  if (process.platform === "linux") assert.equal(seen.pgid, seen.pid, "the leader of its own process group");
});

test("the closed reasons: no-task and unsupported-harness make no call; harness-failed, timeout and invalid-reply; never the output in a message", async (t) => {
  const fake = fakeHarness(t);
  const call = (o) => namingCall({ harness: "claude", bin: fake.bin, instanceModel: null, task: "Fix the login bug", ...o, env: () => ({ ...process.env, FAKE_RECORD: fake.record, ...o.env }) });
  for (const task of ["", "  \n\t"]) {
    const r = await call({ task });
    assert.deepEqual(r.answer, { source: "numbered", reason: "no-task", message: "the task is empty: there is nothing to name the instance from", ms: 0 });
  }
  const codex = await call({ harness: "codex" });
  assert.deepEqual(codex.answer, { source: "numbered", reason: "unsupported-harness", message: "codex has no naming call that is proven to start nothing (suggested names work on claude and pi)", ms: 0 });
  assert.equal(existsSync(fake.record), false, "no call was made for either");

  const failed = await call({ env: { FAKE_EXIT: "3", FAKE_REPLY: "secret-output" } });
  assert.equal(failed.answer.reason, "harness-failed");
  assert.equal(failed.answer.message, "claude exited with 3");
  assert.equal(JSON.stringify(failed).includes("secret-output"), false, "never the output");
  const missing = await call({ bin: join(fake.dir, "absent") });
  assert.deepEqual([missing.answer.reason, missing.answer.message], ["harness-failed", "claude could not be run (ENOENT)"]);

  // Timeout: the group is killed, what the harness started included.
  const grandchild = join(fake.dir, "grandchild.pid");
  const slow = await call({ timeoutMs: 400, env: { FAKE_SLEEP_MS: "10000", FAKE_GRANDCHILD: grandchild } });
  assert.deepEqual([slow.answer.source, slow.answer.reason, slow.answer.message], ["numbered", "timeout", "claude gave no name within 400 ms"]);
  assert.ok(slow.answer.ms >= 350 && slow.answer.ms < 5000, `${slow.answer.ms} ms`);
  const sleeper = Number(readFileSync(grandchild, "utf8"));
  for (let i = 0; i < 40 && alive(sleeper); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(sleeper), false, "the harness's own child was killed with its group");
  const spent = await call({ timeoutMs: 0 });
  assert.equal(spent.answer.reason, "timeout", "no budget left: no call");

  // stdout is read up to 4 KiB.
  const big = await call({ env: { FAKE_REPLY: `fix-login\n${"x".repeat(10000)}` } });
  assert.equal(Buffer.byteLength(big.reply), NAMING_OUTPUT_MAX);
  const invalid = await suggestInstanceName({ soulName: "code-reviewer", taken: never, harness: "claude", bin: fake.bin, instanceModel: null, task: "Review it", env: () => ({ ...process.env, FAKE_REPLY: "Reviewer.\n" }) });
  assert.deepEqual([invalid.naming.source, invalid.naming.reason, invalid.naming.message, invalid.name], ["numbered", "invalid-reply", "claude's reply holds no name", undefined]);
  const good = await suggestInstanceName({ soulName: "code-reviewer", taken: never, harness: "pi", bin: fake.bin, instanceModel: "github-copilot/gpt-6-astra", task: "Review it", env: () => ({ ...process.env, FAKE_REPLY: "pr-42-review\n" }) });
  assert.equal(good.name, "pr-42-review-reviewer");
  assert.deepEqual({ ...good.naming, ms: 0 }, { source: "suggested", ms: 0, harness: "pi", model: "github-copilot/gpt-6-astra" });
  // An environment that cannot be built is a failure of the call, not an error.
  const noEnv = await namingCall({ harness: "claude", bin: fake.bin, task: "x", env: () => { throw Object.assign(new Error("no"), { code: "E_RUNTIME_ENDPOINT_UNKNOWN" }); } });
  assert.deepEqual([noEnv.answer.reason, noEnv.answer.message], ["harness-failed", "claude could not be run: its launch's environment is not known (E_RUNTIME_ENDPOINT_UNKNOWN)"]);
});

function okResult(r, what) {
  assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.ok, true, `${what}: ${r.stdout}`);
  return j.result;
}
function refused(r, what) {
  assert.notEqual(r.status, 0, what);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.ok, false, what);
  return j.error;
}

test("oats spawn --preview --suggest-name: the suggested name previewed as --name (its decision, matched by an apply), numbered otherwise, never an error", async (t) => {
  const fake = fakeHarness(t);
  const local = { "launch-configs": { fake: { harness: "claude", executable: fake.bin }, fakecodex: { harness: "codex", executable: fake.bin } } };
  const fx = v2Deployment({ t, local });
  const taskFile = join(fake.dir, "task.md");
  writeFileSync(taskFile, "Fix the flaky login test in the auth service.\n");
  const env = { FAKE_RECORD: fake.record, FAKE_REPLY: "fix-flaky-login\n", OATS_INSTANCE: "caller-x" };
  const preview = (extra = [], e = env) => fx.cli(["spawn", "dev", "--preview", "--suggest-name", "--launch-config", "fake", "--task-file", taskFile, ...extra, "--json"], { env: e });

  const suggested = okResult(preview(), "suggest");
  assert.equal(suggested.instance, "fix-flaky-login-dev");
  assert.deepEqual({ ...suggested.naming, ms: 0 }, { source: "suggested", ms: 0, harness: "claude", model: "haiku" });
  assert.equal(fake.read().stdin, namingPrompt("Fix the flaky login test in the auth service.\n"));
  assert.equal(fake.read().env.includes("OATS_INSTANCE"), false);
  // Exactly the preview of --name <suggested>: the same instance, home, branch and decision.
  const plain = okResult(fx.cli(["spawn", "dev", "--preview", "--name", suggested.instance, "--launch-config", "fake", "--task-file", taskFile, "--json"]), "plain");
  for (const key of ["instance", "home", "branch", "decision"]) assert.deepEqual(suggested[key], plain[key], key);
  assert.equal("naming" in plain, false, "a preview without --suggest-name has no naming");
  // An apply of that decision matches it.
  const applied = okResult(fx.cli(["spawn", "dev", "--name", suggested.instance, "--launch-config", "fake", "--task-file", taskFile, "--expect-decision", suggested.decision.revision, "--no-launch", "--json"]), "apply");
  assert.equal(applied.instance, "fix-flaky-login-dev");
  // The name is now taken: -2.
  assert.equal(okResult(preview(), "again").instance, "fix-flaky-login-dev-2");

  // Numbered, with its reason, never an error: the name is today's numbered one.
  const numberedName = okResult(fx.cli(["spawn", "dev", "--preview", "--launch-config", "fake", "--json"]), "numbered").instance;
  const failed = okResult(preview([], { ...env, FAKE_EXIT: "1" }), "failed");
  assert.equal(failed.instance, numberedName);
  assert.deepEqual([failed.naming.source, failed.naming.reason, failed.naming.message], ["numbered", "harness-failed", "claude exited with 1"]);
  const timedOut = okResult(preview([], { ...env, FAKE_SLEEP_MS: "5000", OATS_TEST_NAMING_TIMEOUT_MS: "300" }), "timeout");
  assert.deepEqual([timedOut.instance, timedOut.naming.reason], [numberedName, "timeout"]);
  assert.equal(okResult(preview([], { ...env, FAKE_REPLY: "dev\n" }), "invalid").naming.reason, "invalid-reply");
  const codex = okResult(fx.cli(["spawn", "dev", "--preview", "--suggest-name", "--launch-config", "fakecodex", "--task-file", taskFile, "--json"], { env }), "codex");
  assert.deepEqual([codex.instance, codex.naming.reason], [numberedName, "unsupported-harness"]);
  const empty = join(fake.dir, "empty.md");
  writeFileSync(empty, "  \n");
  rmSync(fake.record, { force: true });
  const noTask = okResult(fx.cli(["spawn", "dev", "--preview", "--suggest-name", "--launch-config", "fake", "--task-file", empty, "--json"], { env }), "no task");
  assert.deepEqual([noTask.instance, noTask.naming.reason, noTask.naming.ms], [numberedName, "no-task", 0]);
  assert.equal(okResult(fx.cli(["spawn", "dev", "--preview", "--suggest-name", "--launch-config", "fake", "--json"], { env }), "no task given").naming.reason, "no-task");
  assert.equal(existsSync(fake.record), false, "no call without a task");

  // The refusals, before anything is read.
  for (const [argv, words] of [[["--preview", "--suggest-name", "--expect-decision", "r1"], "already binds one"], [["--preview", "--suggest-name", "--name", "x-dev"], "takes no --name or --purpose"], [["--preview", "--suggest-name", "--purpose", "x"], "takes no --name or --purpose"], [["--preview", "--suggest-name", "--purpose=x"], "takes no --name or --purpose"]]) {
    const e = refused(fx.cli(["spawn", "dev", ...argv, "--json"]), argv.join(" "));
    assert.equal(e.code, "E_BAD_ARGS", argv.join(" "));
    assert.match(e.message, new RegExp(words.replace(/[-]/g, "\\-")));
  }
  // Human output says how the name was chosen.
  const human = fx.cli(["spawn", "dev", "--preview", "--suggest-name", "--launch-config", "fake", "--task-file", taskFile], { env });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^name: suggested by claude \(haiku\) in \d+ ms$/m);
  assert.ok(JSON.parse(fx.cli(["version", "--json"]).stdout).features.includes("spawn-suggest-name"));
});

test("the name is chosen before anything that depends on it, within the preview's one preflight budget", async (t) => {
  const fake = fakeHarness(t);
  const local = { "launch-configs": { fake: { harness: "claude", executable: fake.bin } } };
  const fx = v2Deployment({ t, local, souls: { dev: { soul: { work: "worktree" } } } });
  // The numbered name's branch is retained (dev-1 retired, its branch kept): the plain preview is
  // refused for it, the suggestion is not, since it never uses that name.
  execFileSync("git", ["-C", fx.member, "branch", "agents/dev-1"], { stdio: "ignore" });
  const refusedPlain = refused(fx.cli(["spawn", "dev", "--preview", "--launch-config", "fake", "--json"]), "plain");
  assert.equal(refusedPlain.code, "E_BRANCH_EXISTS");
  const env = { FAKE_REPLY: "fix-login\n" };
  const r = okResult(fx.cli(["spawn", "dev", "--preview", "--suggest-name", "--launch-config", "fake", "--task", "Fix login", "--json"], { env }), "suggest");
  assert.deepEqual([r.instance, r.branch, r.naming.source], ["fix-login-dev", "agents/fix-login-dev", "suggested"]);
  // One budget: the naming call's time is in the preview's preflight, and the budget bounds the call.
  assert.equal(r.preflight.budgetMs, 20000);
  assert.ok(r.preflight.elapsedMs >= r.naming.ms, `${r.preflight.elapsedMs} ≥ ${r.naming.ms}`);
  // Numbered after all, the numbered placement's own refusals apply, as in a plain preview.
  assert.equal(refused(fx.cli(["spawn", "dev", "--preview", "--suggest-name", "--launch-config", "fake", "--task", "Fix login", "--json"], { env: { FAKE_EXIT: "1" } }), "numbered").code, "E_BRANCH_EXISTS");
  execFileSync("git", ["-C", fx.member, "branch", "-D", "agents/dev-1"], { stdio: "ignore" });
  const slow = okResult(fx.cli(["spawn", "dev", "--preview", "--suggest-name", "--launch-config", "fake", "--task", "Fix login", "--json"], { env: { ...env, FAKE_SLEEP_MS: "8000", OATS_PREVIEW_PREFLIGHT_BUDGET_MS: "700" } }), "budget");
  assert.equal(slow.naming.reason, "timeout");
  assert.ok(slow.naming.ms < 3000, `the call ended with the budget (${slow.naming.ms} ms)`);
  assert.equal(slow.preflight.budgetMs, 700);
  assert.equal(slow.preflight.status, "complete", "the checks completed: the naming call's timeout is naming's");
});

test("the naming call takes what the harness package probes leave of the budget: a slow call ends numbered, after the probes answered", async (t) => {
  const fake = fakeHarness(t);
  const plugin = join(fake.dir, "plugins", "chat");
  mkdirSync(plugin, { recursive: true });
  const local = { "launch-configs": { fake: { harness: "claude", executable: fake.bin } } };
  const fx = v2Deployment({ t, local,
    souls: { dev: { soul: { capabilities: { "test.chat": { from: "here" } } } } },
    capabilities: { "test.chat": { manifest: { requires: [{ harness: "claude", package: "chat@acme-market", why: "the fixture's" }] } } },
  });
  const installed = JSON.stringify([{ id: "chat@acme-market", version: "1.0.0", scope: "user", enabled: true, installPath: plugin }]);
  const preview = (env, extra = []) => fx.cli(["spawn", "dev", "--preview", "--suggest-name", "--launch-config", "fake", "--task", "Fix login", ...extra, "--json"], { env: { FAKE_REPLY: "fix-login\n", ...env } });
  // Premises: the package is required (missing, the preview is refused), and installed it passes.
  assert.equal(refused(preview({ FAKE_PLUGINS: "[]" }), "missing").code, "E_HARNESS_RESOURCE_MISSING");
  assert.equal(okResult(preview({ FAKE_PLUGINS: installed }), "installed").instance, "fix-login-dev");
  const numberedName = okResult(fx.cli(["spawn", "dev", "--preview", "--launch-config", "fake", "--json"], { env: { FAKE_PLUGINS: installed } }), "numbered").instance;
  // A naming call slower than the budget: the probes ran first, so the preview is the numbered one.
  const slow = okResult(preview({ FAKE_PLUGINS: installed, FAKE_SLEEP_MS: "8000", OATS_PREVIEW_PREFLIGHT_BUDGET_MS: "1500" }), "slow");
  assert.deepEqual([slow.instance, slow.naming.source, slow.naming.reason], [numberedName, "numbered", "timeout"]);
  assert.ok(slow.naming.ms < 3000, `the call ended with the budget (${slow.naming.ms} ms)`);
  assert.equal(slow.preflight.status, "complete", "the probes completed: the naming call's timeout is naming's");
  // The numbered preview a timed-out call leaves is a confirmable one, by the clients' own admission
  // (packages/client/spawn-apply-contract.mjs), as a plain preview and a suggested one are. A client
  // previews with the subject it targets (--dir, --agents-root).
  const asClient = ["--dir", fx.dep, "--agents-root", fx.root];
  const target = (r) => ({ workspace: r.workspace, context: fx.dep, selector: { soul: "dev", agentsRoot: fx.root } });
  const admitted = (r) => spawnPreparedData(r, target(r));
  assert.ok(admitted(okResult(fx.cli(["spawn", "dev", "--preview", "--launch-config", "fake", ...asClient, "--json"], { env: { FAKE_PLUGINS: installed } }), "plain")), "premise: a plain preview is admitted");
  assert.ok(admitted(okResult(preview({ FAKE_PLUGINS: installed }, asClient), "suggested")), "a suggested one");
  const slowAsClient = okResult(preview({ FAKE_PLUGINS: installed, FAKE_SLEEP_MS: "8000", OATS_PREVIEW_PREFLIGHT_BUDGET_MS: "1500" }, asClient), "slow, as a client");
  assert.equal(slowAsClient.naming.reason, "timeout");
  assert.ok(admitted(slowAsClient), "and the numbered one after a timeout");
});

test("the naming call runs the executable the preview reports: a relative PATH entry resolves from where the home will be", async (t) => {
  const fake = fakeHarness(t);
  // `../../../../bin` from a home (agents/dev/instances/<name>) is the deployment's bin/; from the soul's
  // instances/ directory it would be the directory above the deployment.
  const fx = v2Deployment({ t, local: { "launch-configs": { rel: { harness: "claude", env: { PATH: "../../../../bin:/usr/bin:/bin" } } } } });
  const right = join(fx.dep, "bin", "claude"), wrong = join(fx.base, "bin", "claude");
  for (const bin of [right, wrong]) mkdirSync(join(bin, ".."), { recursive: true });
  writeFileSync(right, readFileSync(fake.bin));
  writeFileSync(wrong, `#!/bin/sh\necho wrong > ${JSON.stringify(join(fake.dir, "wrong"))}\necho wrong-harness\n`);
  for (const bin of [right, wrong]) chmodSync(bin, 0o755);
  const r = okResult(fx.cli(["spawn", "dev", "--preview", "--suggest-name", "--launch-config", "rel", "--task", "Fix login", "--json"], { env: { FAKE_RECORD: fake.record, FAKE_REPLY: "fix-login\n" } }), "relative");
  assert.equal(r.executable, right, "the preview's executable, looked up from the home");
  assert.deepEqual([r.instance, r.naming.source], ["fix-login-dev", "suggested"]);
  assert.deepEqual(fake.read().argv, NAMING_CALLS.claude.argv("haiku"), "the naming call ran that executable");
  assert.equal(existsSync(join(fake.dir, "wrong")), false, "and not the one instances/ would find");
});

test("oats spawn --suggest-name on an apply (#1490 §3): named <descriptive>-<role> and placed as --name, unique as today, numbered on any failure, with its own time limit", async (t) => {
  const fake = fakeHarness(t);
  const local = { "launch-configs": { fake: { harness: "claude", executable: fake.bin } } };
  const fx = v2Deployment({ t, local });
  const env = { FAKE_RECORD: fake.record, FAKE_REPLY: "fix-login\n" };
  const apply = (extra = [], e = env) => fx.cli(["spawn", "dev", "--suggest-name", "--launch-config", "fake", "--task", "Fix the login bug", "--no-launch", ...extra, "--json"], { env: e });

  const first = okResult(apply(), "apply");
  assert.equal(first.instance, "fix-login-dev");
  assert.equal(first.home, join(fx.root, "dev", "instances", "fix-login-dev"));
  assert.ok(existsSync(join(first.home, "instance.json")), "placed");
  assert.deepEqual({ ...first.naming, ms: 0 }, { source: "suggested", ms: 0, harness: "claude", model: "haiku" });
  assert.equal(fake.read().stdin, namingPrompt("Fix the login bug"));
  assert.deepEqual(fake.read().argv, NAMING_CALLS.claude.argv("haiku"));
  // Taken now: made unique as today.
  assert.equal(okResult(apply(), "again").instance, "fix-login-dev-2");
  // The preview's budget is not the apply's: an apply's call takes its own NAMING_TIMEOUT_MS.
  assert.equal(okResult(apply([], { ...env, FAKE_REPLY: "budget-free\n", OATS_PREVIEW_PREFLIGHT_BUDGET_MS: "1" }), "no preview budget").instance, "budget-free-dev");
  // Any failure numbers the instance as today, and says why; never an error.
  const numberedName = () => okResult(fx.cli(["spawn", "dev", "--preview", "--launch-config", "fake", "--json"]), "numbered preview").instance;
  for (const [e, reason] of [[{ FAKE_EXIT: "1" }, "harness-failed"], [{ FAKE_SLEEP_MS: "5000", OATS_TEST_NAMING_TIMEOUT_MS: "300" }, "timeout"], [{ FAKE_REPLY: "dev\n" }, "invalid-reply"]]) {
    const expected = numberedName();
    const r = okResult(apply([], { ...env, ...e }), reason);
    assert.deepEqual([r.instance, r.naming.source, r.naming.reason], [expected, "numbered", reason], reason);
    assert.ok(existsSync(r.home), `${reason}: the numbered instance exists`);
  }
  const expected = numberedName();
  const noTask = okResult(fx.cli(["spawn", "dev", "--suggest-name", "--launch-config", "fake", "--no-launch", "--json"], { env }), "no task");
  assert.deepEqual([noTask.instance, noTask.naming.reason], [expected, "no-task"]);
  // Without --suggest-name an apply is today's: numbered, no naming, no call.
  rmSync(fake.record, { force: true });
  const plain = okResult(fx.cli(["spawn", "dev", "--launch-config", "fake", "--task", "Fix the login bug", "--no-launch", "--json"], { env }), "plain");
  assert.equal("naming" in plain, false);
  assert.equal(existsSync(fake.record), false, "no naming call without --suggest-name");
  // Its human answer says how the name was chosen.
  const human = fx.cli(["spawn", "dev", "--suggest-name", "--launch-config", "fake", "--task", "Fix the login bug", "--no-launch"], { env: { ...env, FAKE_REPLY: "human-answer\n" } });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^Spawned human-answer-dev /m);
  assert.match(human.stdout, /^ {2}name: {3}suggested by claude \(haiku\) in \d+ ms$/m);

  // --suggest-name chooses the name: with --name, --purpose or --expect-decision it is refused, by the
  // CLI before anything is read and by the kernel for its other callers.
  for (const [argv, words] of [[["--name", "x-dev"], "takes no --name or --purpose"], [["--purpose", "x"], "takes no --name or --purpose"], [["--expect-decision", "r1"], "already binds one"], [["--expect-decision=r1"], "already binds one"]]) {
    const e = refused(fx.cli(["spawn", "dev", "--suggest-name", ...argv, "--no-launch", "--json"]), argv.join(" "));
    assert.deepEqual([e.code, words.length > 0], ["E_BAD_ARGS", true], argv.join(" "));
    assert.ok(e.message.includes(words), `${argv.join(" ")}: ${e.message}`);
  }
  for (const [opts, words] of [[{ name: "x-dev" }, "takes no --name or --purpose"], [{ purpose: "x" }, "takes no --name or --purpose"], [{ expectDecision: "r1" }, "already binds one"]]) {
    await assert.rejects(fx.spawn("dev", { suggestName: true, task: "Fix it", ...opts }), (e) => e.code === "E_BAD_ARGS" && e.message.includes(words), JSON.stringify(opts));
  }
  assert.ok(JSON.parse(fx.cli(["version", "--json"]).stdout).features.includes("spawn-apply-suggest-name"));
});

test("oats instance suggest-name (#1490 §2): the preview's name for a soul that needn't exist here, not made unique, by this machine's launch configurations; numbered with a reason, never an error", async (t) => {
  const fake = fakeHarness(t);
  const missing = join(fake.dir, "not-there");
  const local = { "launch-configs": {
    fake: { harness: "claude", executable: fake.bin, default: true },
    fakepi: { harness: "pi", executable: fake.bin, model: "acme/pi-model" },
    fakecodex: { harness: "codex", executable: fake.bin },
    gone: { harness: "claude", executable: missing },
    unset: { harness: "claude", executable: fake.bin, env: { ACME_TOKEN: { fromEnv: "OATS_TEST_SURELY_UNSET" } } },
  } };
  const fx = v2Deployment({ t, local });
  const env = { FAKE_RECORD: fake.record, FAKE_REPLY: "fix-flaky-login\n" };
  const suggest = (extra, e = env) => fx.cli(["instance", "suggest-name", ...extra, "--json"], { env: e });

  // The soul is only a name: oats-developer is no soul of this deployment. claude, through the
  // machine's default configuration for it.
  const r = okResult(suggest(["--soul", "oats-developer", "--task", "Fix the flaky login test"]), "suggest");
  assert.deepEqual(Object.keys(r).sort(), ["name", "naming"]);
  assert.equal(r.name, "fix-flaky-login-developer");
  assert.deepEqual({ ...r.naming, ms: 0 }, { source: "suggested", ms: 0, harness: "claude", model: "haiku" });
  assert.deepEqual(fake.read().argv, NAMING_CALLS.claude.argv("haiku"));
  assert.equal(fake.read().stdin, namingPrompt("Fix the flaky login test"));
  // A package-qualified soul gives its role; the words, role and length rules are the preview's.
  assert.equal(okResult(suggest(["--soul", "acme/pkg--ops-lead", "--task", "x"]), "qualified").name, "fix-flaky-login-lead");
  const long = okResult(suggest(["--soul", "oats-developer", "--task", "x"], { ...env, FAKE_REPLY: `${"abcdefghijklmnop-".repeat(6)}\n` }), "long").name;
  assert.equal(long, named(`${"abcdefghijklmnop-".repeat(6)}\n`, "oats-developer"));
  assert.ok(long.length <= 64 && long.endsWith("-developer"), long);
  // Not made unique: a name taken in this deployment is answered as it is (the landing host decides).
  okResult(fx.cli(["spawn", "dev", "--name", "fix-login-dev", "--launch-config", "fake", "--no-launch", "--json"]), "premise: taken");
  assert.equal(okResult(suggest(["--soul", "dev", "--task", "x"], { ...env, FAKE_REPLY: "fix-login\n" }), "taken").name, "fix-login-dev");
  // pi: the configuration's model, else --model; --harness agrees with the configuration or is refused.
  const pi = okResult(suggest(["--soul", "dev", "--task", "x", "--launch-config", "fakepi"]), "pi");
  assert.deepEqual([pi.naming.harness, pi.naming.model], ["pi", "acme/pi-model"]);
  assert.deepEqual(fake.read().argv, NAMING_CALLS.pi.argv("acme/pi-model"));
  assert.equal(okResult(suggest(["--soul", "dev", "--task", "x", "--harness", "pi", "--launch-config", "fakepi", "--model", "acme/other"]), "pi model").naming.model, "acme/other");
  // The model: @native-default is none, and a preference list names its first entry with no catalogue
  // probe: the naming call is the only process started (a `pi` on PATH that a probe would run, and hang
  // on, is never run).
  const trap = join(fake.dir, "trap");
  mkdirSync(trap);
  writeFileSync(join(trap, "pi"), `#!/bin/sh\necho ran > ${JSON.stringify(join(fake.dir, "trap-ran"))}\nsleep 30\n`);
  chmodSync(join(trap, "pi"), 0o755);
  const trapped = { ...env, PATH: `${trap}:${fx.env.PATH}` };
  for (const [list, first] of [["first-model,second-model", "first-model"], ["acme/first,acme/second", "acme/first"], ["acme/first:high, acme/second", "acme/first:high"]]) {
    const listed = okResult(suggest(["--soul", "dev", "--task", "x", "--launch-config", "fakepi", "--model", list], trapped), list);
    assert.deepEqual([listed.naming.source, listed.naming.model, fake.read().argv], ["suggested", first, NAMING_CALLS.pi.argv(first)], list);
  }
  assert.equal(existsSync(join(fake.dir, "trap-ran")), false, "no catalogue probe ran");
  const native = okResult(suggest(["--soul", "dev", "--task", "x", "--launch-config", "fakepi", "--model", "@native-default"]), "pi native");
  assert.deepEqual([native.naming.model, fake.read().argv], [null, NAMING_CALLS.pi.argv(null)]);

  // Each reachable reason, ok:true and no name.
  const numbered = (extra, e, reason) => {
    const n = okResult(suggest(["--soul", "dev", ...extra], { ...env, ...e }), reason);
    assert.equal("name" in n, false, reason);
    assert.deepEqual([n.naming.source, n.naming.reason], ["numbered", reason], reason);
    return n.naming;
  };
  rmSync(fake.record, { force: true });
  numbered(["--task", ""], {}, "no-task");
  const empty = join(fake.dir, "empty.md");
  writeFileSync(empty, " \n");
  numbered(["--task-file", empty], {}, "no-task");
  assert.equal(existsSync(fake.record), false, "no call without a task");
  numbered(["--task", "x", "--launch-config", "fakecodex"], {}, "unsupported-harness");
  numbered(["--task", "x", "--harness", "codex", "--launch-config", "none"], {}, "unsupported-harness");
  assert.equal(numbered(["--task", "x"], { FAKE_EXIT: "1" }, "harness-failed").message, "claude exited with 1");
  numbered(["--task", "x"], { FAKE_SLEEP_MS: "5000", OATS_TEST_NAMING_TIMEOUT_MS: "300" }, "timeout");
  numbered(["--task", "x"], { FAKE_REPLY: "dev\n" }, "invalid-reply");
  // No executable, or a reference not set here: harness-failed, naming the cause, never a value.
  assert.match(numbered(["--task", "x", "--launch-config", "gone"], {}, "harness-failed").message, /^claude could not be run: launch configuration gone: .*does not exist$/);
  assert.equal(numbered(["--task", "x", "--launch-config", "unset"], {}, "harness-failed").message, "claude could not be run: launch configuration unset references OATS_TEST_SURELY_UNSET, not set in this environment");
  // Outside any deployment: no configurations, the harness's own executable on this PATH.
  const outside = fixtureBase("oats-suggest-outside-");
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(outside, "bin"));
  writeFileSync(join(outside, "bin", "claude"), readFileSync(fake.bin));
  chmodSync(join(outside, "bin", "claude"), 0o755);
  const bare = fx.cli(["instance", "suggest-name", "--soul", "dev", "--task", "x", "--dir", outside, "--json"], { cwd: outside, env: { ...env, PATH: `${join(outside, "bin")}:${fx.env.PATH}` } });
  assert.equal(okResult(bare, "outside").name, "fix-flaky-login-dev");

  // It writes nothing and reserves nothing in the deployment (this computer's deployments list:
  // test/deployments.test.mjs, outside the temporary directories).
  const tree = () => execFileSync("find", [fx.dep, "-not", "-path", "*/.git/*"], { encoding: "utf8" });
  const before = tree();
  okResult(suggest(["--soul", "dev", "--task", "x"]), "writes nothing");
  assert.equal(tree(), before);

  // Refusals: bad arguments are errors.
  for (const [argv, code, words] of [
    [["--soul", "dev", "--task", "x", "--server", "build"], "E_BAD_ARGS", "takes no --server"],
    [["--task", "x"], "E_BAD_ARGS", "--soul is required"],
    [["--soul", "Bad Soul", "--task", "x"], "E_BAD_ARGS", "is not a soul name"],
    [["--soul", "dev"], "E_BAD_ARGS", "one of --task or --task-file"],
    [["--soul", "dev", "--task", "x", "--task-file", empty], "E_BAD_ARGS", "one of --task or --task-file"],
    [["--soul", "dev", "--task"], "E_BAD_ARGS", "--task needs a value"],
    [["--soul", "dev", "--task", "x", "--harness", "gpt"], "E_BAD_ARGS", "--harness must be one of pi|claude|codex"],
    [["--soul", "dev", "--task", "x", "--harness", "claude", "--launch-config", "fakepi"], "E_BAD_ARGS", "a named configuration is a unit"],
    [["--soul", "dev", "--task", "x", "--launch-config", "nope"], "E_LAUNCH_CONFIG_UNKNOWN", "\"nope\""],
    [["--soul", "dev", "--task", "x", "--name", "y"], "E_BAD_ARGS", "unexpected flag \"--name\""],
    [["--soul", "dev", "--task", "x", "extra"], "E_BAD_ARGS", "unexpected argument \"extra\""],
  ]) {
    const e = refused(suggest(argv), argv.join(" "));
    assert.equal(e.code, code, `${argv.join(" ")}: ${e.message}`);
    assert.ok(e.message.includes(words), `${argv.join(" ")}: ${e.message}`);
  }
  // Text: the name, or how it was numbered.
  const text = fx.cli(["instance", "suggest-name", "--soul", "dev", "--task", "x"], { env });
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, "fix-flaky-login-dev\n");
  const textNumbered = fx.cli(["instance", "suggest-name", "--soul", "dev", "--task", " "], { env });
  assert.equal(textNumbered.stdout, "numbered (no-task: the task is empty: there is nothing to name the instance from)\n");
  assert.ok(JSON.parse(fx.cli(["version", "--json"]).stdout).features.includes("instance-suggest-name"));
});
