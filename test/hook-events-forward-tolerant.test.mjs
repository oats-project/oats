// Forward-tolerant hook events (0.49.0, lab-oats-workspace#22). A capability declaring a hook event this
// kernel does not run (a newer kernel's) still composes: the event never runs, and every reader that
// shows the capability carries the warning `hook-event-unsupported` (capabilities show, inspect, doctor,
// readiness, spawn --preview and the spawn itself). The same event declared `required: true` is refused
// as before, and a malformed declaration of it is refused as for a known event. Each JSON answer that
// gains `warnings` is read by the Desktop's current reader for it (packages/client, unchanged).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { startInstanceSession } from "../lib/core.mjs";
import { APPROVED_HOOKS } from "../lib/capability-contract.mjs";
import { isolateSessionEnvironment, oatsSocket, waitUntil } from "./helpers/host-fixture.mjs";
import { CLI, v2Deployment } from "./helpers/v2-deployment.mjs";
import { packageRepo } from "./helpers/package-repo.mjs";
import { capabilityShowData, capabilityFileData } from "../packages/client/capability-show-contract.mjs";
import { inspectData } from "../packages/client/inspect-contract.mjs";
import { readinessData } from "../packages/client/readiness-contract.mjs";
import { previewData } from "../packages/client/spawn-preview-contract.mjs";
import { spawnCreationReceipt } from "../packages/client/spawn-apply-contract.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-hook-events-")));
const session = "h";
const restoreEnvironment = isolateSessionEnvironment(base);
const socket = oatsSocket();
const tmux = (...args) => execFileSync("tmux", ["-u", "-S", socket, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
function write(p, c) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }
// A harness that records its pid, then idles.
const binDir = join(base, "bin");
write(join(binDir, "polite"), `#!/bin/sh\necho $$ > "$OATS_INSTANCE_HOME/pid.txt"\nexec sleep 86400\n`);
chmodSync(join(binDir, "polite"), 0o755);
const env = () => { const e = { ...process.env, PATH: `${binDir}:${process.env.PATH}` }; for (const k of ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_HOME", "OATS_LAUNCH_PREVIEW", "PI_AGENT_INSTANCE", "PI_AGENT_HOME", "PI_AGENTS_ROOT"]) delete e[k]; return e; };
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// Every run of the capability's hook, by the event its command names, appended to one log outside every
// home (retire removes the home).
const MARKS = join(base, "hook-runs.log");
const mark = `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(MARKS)}, process.argv[2] + "\\n");\nprocess.stdout.write("{}\\n");\n`;
const runs = () => (existsSync(MARKS) ? readFileSync(MARKS, "utf8").split("\n").filter(Boolean) : []);
const UNKNOWN = ["future-event", "future-other"];

// The events this kernel runs, as its messages list them (a later kernel adds to them).
const KERNEL_EVENTS = [...APPROVED_HOOKS].join(", ");
const warningMessage = (id, event) => `capability ${id} declares hook "${event}", which this kernel does not run; it is ignored (this kernel runs ${KERNEL_EVENTS})`;

const pkg = packageRepo({
  manifest: { capabilities: ["capabilities/acme-tool", "capabilities/fut"] },
  files: {
    "capabilities/fut/oats.json": { capability: "acme.pkgfut", version: "1.0.0", description: "package fut", compatibility: { oats: ">=0.24.0" }, hooks: { "future-event": "bin/mark.mjs future-event" } },
    "capabilities/fut/bin/mark.mjs": mark,
  },
  souls: { keeper: { soul: { capabilities: { "acme-tool": { from: "here" }, "acme.pkgfut": { from: "here" } } } } },
});
const fx = v2Deployment({
  souls: {
    dev: { soul: { capabilities: { "acme.fut": { from: "here" } } } },
    req: { soul: { capabilities: { "acme.req": { from: "here" } } } },
    plain: {},
  },
  capabilities: {
    "acme.fut": { manifest: { launchPreview: true, inject: "inject.md", hooks: {
      spawn: "bin/mark.mjs spawn", launch: "bin/mark.mjs launch", retire: "bin/mark.mjs retire",
      "future-event": "bin/mark.mjs future-event", "future-other": { command: "bin/mark.mjs future-other", required: false },
    } }, files: { "bin/mark.mjs": mark, "inject.md": "## acme.fut\n" } },
    "acme.req": { manifest: { hooks: { "future-other": { command: "bin/mark.mjs future-other", required: true } } }, files: { "bin/mark.mjs": mark } },
    "acme.bad": { manifest: { hooks: { "future-event": { command: "bin/mark.mjs", when: "always" } } }, files: { "bin/mark.mjs": mark } },
    "acme.empty": { manifest: { hooks: { "future-event": { command: " " } } }, files: {} },
    "acme.flag": { manifest: { hooks: { "future-event": { command: "bin/mark.mjs", required: "yes" } } }, files: { "bin/mark.mjs": mark } },
    "acme.esc": { manifest: { hooks: { "future-event": "../outside.mjs" } }, files: {} },
  },
  workspace: { packages: { "acme.pkg": `${pkg.ref}@v1.0.0` } },
  local: { "launch-configs": { polite: { harness: "claude", executable: join(binDir, "polite") } } },
});
test.after(() => { try { tmux("kill-server"); } catch { /* gone */ } finally { restoreEnvironment(); fx.cleanup(); pkg.cleanup(); rmSync(base, { recursive: true, force: true }); } });

const at = (event) => `${fx.key}:capabilities/acme.fut/oats.json#/hooks/${event}`;
const memberWarnings = UNKNOWN.map((event) => ({ code: "hook-event-unsupported", capability: "acme.fut", path: at(event), message: warningMessage("acme.fut", event) }));
const packageWarning = { code: "hook-event-unsupported", capability: "acme.pkgfut", path: "package:acme.pkg:oats-package/capabilities/fut/oats.json#/hooks/future-event", message: warningMessage("acme.pkgfut", "future-event") };
const ok = (r) => { assert.equal(r.status, 0, r.stdout + r.stderr); return r; };
const json = (args, opts) => ok(fx.cli([...args, "--json"], opts)).json().result;
const root = () => fx.root;

test.before(() => { ok(fx.cli(["sync", "--json"])); });

test("discovery lists a capability with an unknown, non-required event, and warns; a required or malformed one stays a problem", () => {
  const status = json(["workspace", "status"]);
  assert.deepEqual(status.warnings.filter((w) => w.code === "hook-event-unsupported"), memberWarnings, "one warning per unknown event, at its pointer");
  const problems = (id) => status.problems.filter((p) => p.path.startsWith(`capabilities/${id}/`)).map((p) => ({ code: p.code, path: p.path, message: p.message }));
  assert.deepEqual(problems("acme.fut"), [], "not a problem");
  assert.deepEqual(problems("acme.req"), [{ code: "E_WORKSPACE_SCHEMA", path: "capabilities/acme.req/oats.json#/hooks/future-other", message: `capability acme.req declares unsupported hook "future-other" (${KERNEL_EVENTS})` }],
    "required: refused exactly as before 0.49.0");
  assert.match(problems("acme.bad").map((p) => p.message).join(), /hook "future-event" must be a command string or \{ command, required, inputs \} \(unknown: when\)/);
  assert.match(problems("acme.empty").map((p) => p.message).join(), /hook "future-event" must be a command string/);
  assert.deepEqual(problems("acme.flag").map((p) => p.path), ["capabilities/acme.flag/oats.json#/hooks/future-event/required"]);
  assert.match(problems("acme.esc").map((p) => p.message).join(), /hook "future-event" script "\.\.\/outside\.mjs" escapes the capability directory/);
  const text = ok(fx.cli(["workspace", "status"])).stdout;
  for (const w of memberWarnings) assert.ok(text.includes(w.message), text);
});

test("a soul composing the required unknown event is refused with the manifest problem, as before", async () => {
  const r = fx.cli(["spawn", "req", "--purpose", "x", "--no-launch", "--json"]);
  assert.notEqual(r.status, 0);
  const e = r.json().error;
  assert.equal(e.code, "E_WORKSPACE_SCHEMA");
  assert.equal(e.details.reason, "manifest-contract");
  assert.match(e.message, /capabilities\/acme\.req\/oats\.json#\/hooks\/future-other: capability acme\.req declares unsupported hook "future-other"/);
});

test("capabilities show: a member's and a package's warnings, in JSON and text, and the Desktop reads both answers", () => {
  const member = json(["capabilities", "show", "acme.fut"]);
  assert.deepEqual(member.warnings, memberWarnings);
  assert.ok(capabilityShowData(member, { selector: { name: "acme.fut", kind: "member", repoKey: fx.key } }), "the Desktop's show reader tolerates warnings");
  const pkgShow = json(["capabilities", "show", "acme.pkgfut", "--package", "acme.pkg"]);
  assert.deepEqual(pkgShow.warnings, [packageWarning]);
  assert.ok(capabilityShowData(pkgShow, { selector: { name: "acme.pkgfut", kind: "package", package: "acme.pkg" } }));
  // A repo key or package id, then a path relative to the repository: never an absolute host path.
  for (const w of [...member.warnings, ...pkgShow.warnings]) assert.match(w.path.startsWith(`${fx.key}:`) ? w.path.slice(fx.key.length + 1) : w.path.replace(/^package:acme\.pkg:/, ""), /^[^/][^:]*#\/hooks\//, w.path);
  const text = ok(fx.cli(["capabilities", "show", "acme.fut"])).stdout;
  for (const w of memberWarnings) assert.ok(text.includes(`warning  hook-event-unsupported  ${w.message}`), text);
  // The `oats capabilities` facts name only the events this kernel runs.
  const listed = json(["capabilities"]).capabilities;
  assert.deepEqual(listed.find((c) => c.name === "acme.fut").hooks, ["launch", "retire", "spawn"]);
  assert.deepEqual(listed.find((c) => c.name === "acme.pkgfut").hooks, []);
});

test("a capabilities show --file answer carries the warnings too, and the Desktop reads it", () => {
  const file = json(["capabilities", "show", "acme.fut", "--file", "inject.md"]);
  assert.equal(file.file.text, "## acme.fut\n");
  assert.deepEqual(file.warnings, memberWarnings);
  assert.ok(capabilityFileData(file, { selector: { name: "acme.fut", kind: "member", repoKey: fx.key }, path: "inject.md" }), "the Desktop's file reader tolerates warnings");
  const r = ok(fx.cli(["capabilities", "show", "acme.fut", "--file", "inject.md"]));
  assert.equal(r.stdout, "## acme.fut\n", "stdout is the file's text alone");
  for (const w of memberWarnings) assert.ok(r.stderr.includes(`warning  hook-event-unsupported  ${w.message}`), r.stderr);
});

test("inspect --soul and readiness --soul: the soul's composition warns, in JSON and text, and the Desktop reads both", () => {
  const inspected = json(["inspect", "--soul", "dev"]);
  assert.deepEqual(inspected.warnings, memberWarnings);
  assert.ok(inspectData(inspected, { agent: { name: "dev" } }), "the Desktop's inspect reader tolerates warnings");
  assert.ok(ok(fx.cli(["inspect", "--soul", "dev"])).stdout.includes(`warning  hook-event-unsupported  ${memberWarnings[0].message}`));
  const pkgSoul = json(["inspect", "--soul", "acme.pkg/keeper"]);
  assert.deepEqual(pkgSoul.warnings, [packageWarning], "a package capability's warning, at its package path");
  const ready = json(["readiness", "--dir", fx.dep, "--soul", "dev", "--agents-root", root(), "--policy"]);
  assert.deepEqual(ready.warnings, memberWarnings);
  assert.ok(readinessData(ready, { workspace: fx.key, context: fx.dep, observedAs: "soul", selector: { kind: "soul", soul: "dev", agentsRoot: root() } }), "the Desktop's readiness reader tolerates warnings");
  assert.ok(ok(fx.cli(["readiness", "--soul", "dev"])).stdout.includes(`warning  hook-event-unsupported  ${memberWarnings[1].message}`));
  // A soul whose capabilities declare nothing ignored: the key is there, empty.
  assert.deepEqual(json(["inspect", "--soul", "plain"]).warnings, []);
  assert.deepEqual(json(["readiness", "--soul", "plain"]).warnings, []);
});

test("doctor: the deployment's warnings without --soul, the soul's with it, in JSON and text", () => {
  const all = JSON.parse(ok(fx.cli(["doctor", "--json"])).stdout);
  assert.deepEqual(all.warnings, [...memberWarnings, packageWarning], "every member capability discovery lists, then every locked package's");
  assert.equal(all.information.some((l) => l.startsWith("hook-events-unchecked")), false, all.information.join("\n"));
  const soul = JSON.parse(ok(fx.cli(["doctor", "--soul", "dev", "--json"])).stdout);
  assert.deepEqual(soul.warnings, memberWarnings);
  const text = ok(fx.cli(["doctor"])).stdout;
  for (const w of [...memberWarnings, packageWarning]) assert.ok(text.includes(`warning  hook-event-unsupported  ${w.message}`), text);
});

test("doctor says what this machine's cache cannot answer is unchecked, never that it has no warning", () => {
  const r = fx.cli(["doctor", "--json"], { env: { OATS_REMOTE_CACHE: join(base, "empty-cache") } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.warnings, [], "nothing could be read: no warning claimed");
  const unchecked = doc.information.filter((l) => l.startsWith("hook-events-unchecked: "));
  assert.equal(unchecked.length, 2, doc.information.join("\n"));
  assert.match(unchecked[0], /^hook-events-unchecked: member capabilities were not checked for hook events this kernel does not run: this machine's cache cannot answer \(.*\); oats sync, then run doctor again$/);
  assert.match(unchecked[1], /^hook-events-unchecked: package acme\.pkg's capabilities were not checked for hook events this kernel does not run: this machine's cache cannot answer \(.*\); oats sync, then run doctor again$/);
  const text = fx.cli(["doctor"], { env: { OATS_REMOTE_CACHE: join(base, "empty-cache") } }).stdout;
  assert.ok(text.includes(`INFO: ${unchecked[1]}`), text);
});

test("spawn --preview and the spawn warn, and the Desktop reads both; the unknown events never run through spawn, launch and retire", async () => {
  rmSync(MARKS, { force: true });
  const target = { workspace: fx.key, context: fx.dep, selector: { soul: "dev", agentsRoot: root() } };
  const preview = json(["spawn", "dev", "--dir", fx.dep, "--agents-root", root(), "--preview", "--purpose", "fut"]);
  // No OATS tmux server runs for this fixture: the preview says whose PATH its lookup read, after the capabilities' warnings.
  const noServer = "the harness lookup: the pane's environment is not established until a spawn starts the OATS tmux server (none runs); read instead: this process's PATH";
  assert.deepEqual(preview.warnings, [...memberWarnings.map((w) => w.message), noServer], "the preview's warnings are strings");
  assert.ok(previewData(preview, target), "the Desktop's preview reader tolerates them");
  const previewText = ok(fx.cli(["spawn", "dev", "--preview", "--purpose", "fut"])).stdout;
  for (const w of memberWarnings) assert.ok(previewText.includes(`WARNING: ${w.message}`), previewText);
  assert.deepEqual(runs(), [], "a preview runs no hook");

  const spawned = json(["spawn", "dev", "--dir", fx.dep, "--agents-root", root(), "--purpose", "fut", "--no-launch", "--expect-decision", preview.decision.revision]);
  for (const w of memberWarnings) assert.ok(spawned.warnings.includes(w.message), JSON.stringify(spawned.warnings));
  assert.ok(spawnCreationReceipt(spawned, { target, preview }), "the Desktop's apply receipt reader tolerates them");
  assert.deepEqual(runs(), ["spawn"], "the spawn hook ran; no unknown event did");
  const home = spawned.home;
  const meta = readJson(join(home, "instance.json"));
  assert.deepEqual(Object.keys(meta.capabilityRuntime.find((c) => c.id === "acme.fut").hooks).sort(), ["launch", "retire", "spawn"], "no recorded hook carries an unknown event");
  assert.deepEqual(meta.capabilities.find((c) => c.id === "acme.fut").hooks.sort(), ["launch", "retire", "spawn"]);

  // inspect --home and readiness --home: the module copy actually read, relative to the home.
  const homeWarnings = UNKNOWN.map((event) => ({ ...memberWarnings.find((w) => w.path.endsWith(event)), path: `.oats/modules/acme.fut/oats.json#/hooks/${event}` }));
  const inspected = json(["inspect", "--home", home]);
  assert.deepEqual(inspected.warnings, homeWarnings);
  assert.ok(inspectData(inspected, { instance: true, selector: { home } }), "the Desktop's inspect reader tolerates warnings on a home");
  const ready = json(["readiness", "--home", home, "--soul", "dev", "--agents-root", root(), "--policy"], { cwd: home, env: { OATS_INSTANCE_HOME: home } });
  assert.deepEqual(ready.warnings, homeWarnings);
  assert.ok(readinessData(ready, { workspace: fx.key, context: fx.dep, observedAs: "instance", home, selector: { kind: "instance", instance: meta.instance, agent: "dev", agentsRoot: root(), server: null } }));
  for (const w of [...inspected.warnings, ...ready.warnings]) assert.ok(!w.path.startsWith("/"), w.path);

  // Launch: a preview of the start and a real start run the launch hook, never an unknown event.
  write(join(home, "instance.json"), JSON.stringify({ ...meta, harness: "claude", tmux: { session, window: meta.instance, socket } }, null, 2) + "\n");
  const baselinePath = join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
  if (existsSync(baselinePath)) write(baselinePath, JSON.stringify({ ...readJson(baselinePath), runtime: { launched: false, tmux: { session, window: meta.instance, socket } } }, null, 2) + "\n");
  const lp = spawnSync(process.execPath, [CLI, "launch-config", "preview", "--home", home, "--launch-config", "polite", "--json"], { encoding: "utf8", env: env() });
  assert.equal(JSON.parse(lp.stdout.trim()).ok, true, lp.stdout + lp.stderr);
  try { tmux("has-session", "-t", session); } catch { tmux("new-session", "-d", "-s", session, "-n", "hq", "-c", home); }
  startInstanceSession(home, { launchConfig: "polite", env: env() });
  assert.ok(await waitUntil(() => existsSync(join(home, "pid.txt")), "harness up"));
  assert.deepEqual(runs(), ["spawn", "launch", "launch", "launch"], "the launch hook ran for the launch preview, the start's preview pass and the start");

  // Retire: the retire hook runs; still no unknown event.
  const retired = fx.cli(["retire", meta.instance, "--force", "--json"], { env: env() });
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.ok(runs().includes("retire"), `the retire hook ran: ${runs()}`);
  for (const event of UNKNOWN) assert.equal(runs().includes(event), false, `${event} never ran: ${runs()}`);
});

// Each source doctor reads is read on its own: an unrelated cache miss (a package soul) leaves the member
// capabilities' warnings, and a standalone deployment reads its own repository's cached enumeration.
test("doctor keeps what the cache can answer: a partial cache, and a standalone deployment", (t) => {
  const own = packageRepo({});
  const part = v2Deployment({ capabilities: { "acme.fut": { manifest: { hooks: { "future-other": "bin/mark.mjs" } }, files: { "bin/mark.mjs": mark } } },
    workspace: { packages: { "acme.pkg": `${own.ref}@v1.0.0` } } });
  t.after(() => { part.cleanup(); own.cleanup(); });
  ok(part.cli(["sync", "--json"]));
  const doctor = () => JSON.parse(ok(part.cli(["doctor", "--json"])).stdout);
  const summary = (d) => ({ warnings: d.warnings.map((w) => w.path), unchecked: d.information.filter((l) => l.startsWith("hook-events-unchecked:")) });
  const expected = { warnings: [`${part.key}:capabilities/acme.fut/oats.json#/hooks/future-other`], unchecked: [] };
  assert.deepEqual(summary(doctor()), expected);
  const parsed = join(part.base, "cache", ".parsed");
  let removed = 0;
  for (const rel of readdirSync(parsed, { recursive: true })) {
    if (!String(rel).endsWith(".json")) continue;
    const file = join(parsed, String(rel));
    if (String(readJson(file).item).startsWith("package-soul\0")) { rmSync(file); removed++; }
  }
  assert.ok(removed > 0, "the package soul's cache item was there to remove");
  assert.deepEqual(summary(doctor()), expected, "an unrelated miss does not hide the member's warnings");
  writeFileSync(join(part.dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${part.ref}\nstandalone: ${part.ref}\n`);
  ok(part.cli(["sync", "--json"]));
  assert.deepEqual(summary(doctor()), expected, "standalone: its own repository's capabilities");
});

// The spawn's warnings are strings the Desktop reads as at most 512 of at most 4096 characters, and a
// hook event's name is unbounded: the spawn clips each message and caps how many it carries; inspect
// lists every one, unclipped. A same-key retry answers the same warnings, from the home's module copies.
test("spawn warnings stay inside the Desktop receipt's bounds, and a same-key replay carries them", (t) => {
  const long = "e".repeat(5000);
  const events = Object.fromEntries([long, ...Array.from({ length: 39 }, (_, i) => `future-${String(i).padStart(2, "0")}`)].map((e) => [e, "bin/mark.mjs"]));
  const many = v2Deployment({ souls: { dev: { soul: { capabilities: { "acme.many": { from: "here" } } } } },
    capabilities: { "acme.many": { manifest: { hooks: events }, files: { "bin/mark.mjs": mark } } },
    local: { "launch-configs": { polite: { harness: "claude", executable: join(binDir, "polite") } } } });
  t.after(() => many.cleanup());
  ok(many.cli(["sync", "--json"]));
  const target = { workspace: many.key, context: many.dep, selector: { soul: "dev", agentsRoot: many.root } };
  const run = (args) => ok(many.cli([...args, "--json"])).json().result;
  const preview = run(["spawn", "dev", "--dir", many.dep, "--agents-root", many.root, "--preview", "--purpose", "many", "--launch-config", "polite"]);
  assert.ok(previewData(preview, target));
  assert.equal(preview.warnings.length, 32, "31 messages, then one line naming the rest");
  assert.equal(preview.warnings[31], "9 more hook events this kernel does not run are ignored (oats inspect lists every one)");
  assert.ok(preview.warnings.every((w) => w.length <= 1000), "each message clipped");
  const apply = ["spawn", "dev", "--dir", many.dep, "--agents-root", many.root, "--purpose", "many", "--launch-config", "polite", "--no-launch", "--expect-decision", preview.decision.revision, "--idempotency-key", "k-1"];
  const spawned = run(apply);
  assert.deepEqual(spawned.warnings.slice(0, 32), preview.warnings, "the preview's messages, before the spawn's own (a harness's folder trust)");
  assert.ok(spawnCreationReceipt(spawned, { target, preview }), "the Desktop's apply reader accepts the receipt");
  const inspected = run(["inspect", "--home", spawned.home]);
  assert.equal(inspected.warnings.length, 40, "inspect lists every one");
  assert.ok(inspected.warnings.some((w) => w.message.includes(long)), "unclipped");
  const replayed = run(apply);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.warnings.length, 32);
  assert.deepEqual(replayed.warnings, spawned.warnings.slice(0, 32), "the replay answers the same contract warnings (it runs nothing again)");
  assert.ok(spawnCreationReceipt(replayed, { target, preview }));
});

// `workspace:` may name a member (docs/workspaces.md): doctor follows its cached backlink to the host, as
// discovery does; with no host this machine has read, the member's own capabilities, and the other members
// unchecked.
test("doctor follows a member named as the workspace to its host, from the cache", (t) => {
  const pair = ({ hostReadable }) => {
    const member = v2Deployment({ capabilities: { "acme.fut": { manifest: { hooks: { "future-other": "bin/mark.mjs" } }, files: { "bin/mark.mjs": mark } } } });
    const host = v2Deployment({ workspace: { members: [member.ref] } });
    t.after(() => { member.cleanup(); host.cleanup(); });
    member.commit({ "oats-workspace.yaml": null, "oats-membership.yaml": { yaml: { schemaVersion: 2, workspace: host.ref } } });
    if (!hostReadable) rmSync(host.repo, { recursive: true, force: true });
    const at = `${member.key}:capabilities/acme.fut/oats.json#/hooks/future-other`;
    assert.deepEqual(ok(member.cli(["sync", "--json"])).json().result.warnings.map((w) => w.path), [at], "discovery lists the member's capability");
    const d = JSON.parse(ok(member.cli(["doctor", "--json"])).stdout);
    return { at, warnings: d.warnings.map((w) => w.path), unchecked: d.information.filter((l) => l.startsWith("hook-events-unchecked:")) };
  };
  const followed = pair({ hostReadable: true });
  assert.deepEqual({ warnings: followed.warnings, unchecked: followed.unchecked }, { warnings: [followed.at], unchecked: [] }, "the host's members, as discovery reads them");
  const alone = pair({ hostReadable: false });
  assert.deepEqual(alone.warnings, [alone.at], "the member's own capabilities");
  assert.equal(alone.unchecked.length, 1, alone.unchecked.join("\n"));
  assert.match(alone.unchecked[0], /^hook-events-unchecked: the workspace's other members' capabilities were not checked for hook events this kernel does not run: /);
});
