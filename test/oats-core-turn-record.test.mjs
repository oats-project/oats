// oats.core's turn record for Claude Code (KP-5, oats-project/oats#2122): its hooks write each
// turn's boundary into <home>/.oats/turn.json, which the kernel reads to show a tmux row as
// `activity: "working"` or `"idle"` (feature status-activity, lib/turn-activity.mjs).
//   UserPromptSubmit            turn-start   (a launch prompt's included)
//   Stop, StopFailure           turn-end
//   Notification idle_prompt    turn-end, only over a turn whose end no hook reported
// Nothing for Codex, nothing for a subagent's stop. Every case runs the command the launch hook
// wrote, as Claude Code runs it (/bin/sh -c, the hook's JSON on stdin), through the real
// claude-waiting.sh and claude-turn.mjs, and reads the record through the kernel's own reader.
// The claims those same events set and clear are test/oats-core-waiting-emitter.test.mjs's.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { storedTreeDigest } from "../lib/core.mjs";
import { CLAUDE_OPEN_TURN_MAX_MS, TURN_EVENT, TURN_FILE, tmuxActivity } from "../lib/turn-activity.mjs";
import { TURN_END, TURN_END_IDLE, TURN_START, boundaryOf, fromSubagent, isIdleNotice, recordedEvent, turnPath, writeTurn } from "../oats-package/capabilities/oats-core/bin/claude-turn.mjs";
import { claudeWaitingSettings } from "../oats-package/capabilities/oats-core/bin/oats-core.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CAP = join(ROOT, "oats-package", "capabilities", "oats-core");
const HOOK = join(CAP, "bin", "oats-core.mjs");
const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-core-turn-")));
test.after(() => rmSync(base, { recursive: true, force: true }));
const TMP = join(base, "tmp"); mkdirSync(TMP);

// A kernel CLI that records its argv: the claim's own commands call it, and no turn command does.
const FAKE_CLI = join(base, "fake-cli.mjs");
writeFileSync(FAKE_CLI, `import { appendFileSync } from "node:fs";\nif (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write('{"ok":true}\\n');\n`);
// The executable the kernel hands the launch hook, asked for its version.
const CLAUDE = join(base, "claude");
writeFileSync(CLAUDE, '#!/bin/sh\nprintf "%s (Claude Code)\\n" "${FAKE_CLAUDE_VERSION:-2.1.332}"\n', { mode: 0o755 });

function cleanEnv(extra) {
  const env = { ...process.env, TMPDIR: TMP, XDG_RUNTIME_DIR: undefined, OATS_INSTANCE: undefined, OATS_NODE_BIN: undefined, OATS_LAUNCH_PREVIEW: undefined, TMUX: undefined, ...extra };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}
let n = 0;
/** A Claude Code instance home whose settings the launch hook wrote: its record and its `.oats`. */
function home({ harness = "claude", version } = {}) {
  const h = join(base, `home-${++n}`);
  mkdirSync(join(h, ".oats"), { recursive: true });
  writeFileSync(join(h, "instance.json"), "{}\n");
  const r = spawnSync(process.execPath, [HOOK, "launch"], { cwd: base, encoding: "utf8", timeout: 20000, env: cleanEnv({ OATS_EVENT: "launch", OATS_HARNESS: harness, OATS_HARNESS_EXECUTABLE: CLAUDE, OATS_INSTANCE_HOME: h, OATS_CLI_BIN: FAKE_CLI, FAKE_CLAUDE_VERSION: version }) });
  assert.equal(r.status, 0, r.stderr);
  return h;
}
const settingsOf = (h) => JSON.parse(readFileSync(join(h, ".claude", "settings.json"), "utf8"));
/** The hook input Claude Code 2.1.332 gives each event (the keys a hook here reads). */
const INPUT = {
  UserPromptSubmit: { session_id: "s-1", hook_event_name: "UserPromptSubmit", prompt: "@TASK.md" },
  Stop: { session_id: "s-1", hook_event_name: "Stop", stop_hook_active: false },
  StopFailure: { session_id: "s-1", hook_event_name: "StopFailure", error: "server_error", error_details: "529 overloaded" },
  idle: { session_id: "s-1", hook_event_name: "Notification", message: "Claude is waiting for your input", notification_type: "idle_prompt" },
  permission: { session_id: "s-1", hook_event_name: "Notification", message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" },
  SubagentStop: { session_id: "s-1", agent_id: "a-1", hook_event_name: "SubagentStop" },
};
/** Every command home `h`'s settings hold for a Claude Code event whose matcher takes `subject`
 *  (a Notification's type; none for an event with no matcher), run as Claude Code runs them, in a
 *  session whose environment names `session` as its instance home (default: the home's own). → how
 *  many ran. */
function fire(h, event, input, options = {}) {
  const { subject, env = {} } = options;
  // (`session: undefined` is a session with no instance environment at all.)
  const session = Object.hasOwn(options, "session") ? options.session : h;
  const groups = (settingsOf(h).hooks[event] ?? []).filter((group) => group.matcher === undefined || group.matcher === "*" || group.matcher === subject);
  const commands = groups.flatMap((group) => group.hooks.map((hook) => hook.command));
  for (const command of commands) {
    const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 30000, input: typeof input === "string" ? input : JSON.stringify(input), cwd: base, env: cleanEnv({ OATS_INSTANCE_HOME: session, ...env }) });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], `${event}: a hook never prints and never fails`);
  }
  return commands.length;
}
const prompt = (h, { input = INPUT.UserPromptSubmit, ...options } = {}) => fire(h, "UserPromptSubmit", input, options);
const stop = (h, options) => fire(h, "Stop", INPUT.Stop, options);
const idleNotice = (h, options) => fire(h, "Notification", INPUT.idle, { subject: "idle_prompt", ...options });
const recordOf = (h) => (existsSync(join(h, TURN_FILE)) ? JSON.parse(readFileSync(join(h, TURN_FILE), "utf8")) : null);
/** What the kernel reads of the home, for a start at `startedAt` (default: an hour ago). */
const activityOf = (h, { startedAt = new Date(Date.now() - 3_600_000).toISOString(), now } = {}) => tmuxActivity(h, { startedAt, harness: "claude", ...(now === undefined ? {} : { now }) });

test("the record is the kernel's: the same file and the same two events, and the settings name a turn for exactly four events", () => {
  assert.deepEqual([TURN_START, TURN_END], [TURN_EVENT.START, TURN_EVENT.END]);
  assert.equal(turnPath("/h"), join("/h", TURN_FILE));
  const turns = (stopFailure) => Object.entries(claudeWaitingSettings({ script: "/m/claude-waiting.sh", node: "/n", cli: "/c", home: "/h", stopFailure }).hooks)
    .flatMap(([event, groups]) => groups.flatMap((group) => group.hooks.map((hook) => [event, group.matcher ?? null, / turn (\S+) /.exec(hook.command)?.[1] ?? null])))
    .filter(([, , boundary]) => boundary !== null);
  assert.deepEqual(turns(true), [["Notification", "idle_prompt", "turn-end-idle"], ["UserPromptSubmit", null, "turn-start"], ["Stop", null, "turn-end"], ["StopFailure", null, "turn-end"]]);
  // A Claude Code from before StopFailure gets no such key, and the other three all the same.
  assert.deepEqual(turns(false), [["Notification", "idle_prompt", "turn-end-idle"], ["UserPromptSubmit", null, "turn-start"], ["Stop", null, "turn-end"]]);
  // Nothing is written for a subagent's stop, a compaction or the session's start or end.
  const events = Object.keys(claudeWaitingSettings({ script: "/m/claude-waiting.sh", node: "/n", cli: "/c", home: "/h", stopFailure: true }).hooks);
  for (const event of ["SubagentStop", "PreCompact", "SessionStart"]) assert.equal(events.includes(event), false, event);
});

test("a prompt, then Stop, reads idle; and the first turn of a start reads working before its first end", () => {
  const h = home();
  const startedAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(activityOf(h, { startedAt }), null, "no boundary yet: the launch hook writes none");
  // The launch prompt (`claude '@TASK.md'`) fires UserPromptSubmit like any other (Claude Code 2.1.332).
  assert.equal(prompt(h), 2, "the claim's clear and the turn's start");
  const started = recordOf(h);
  assert.deepEqual(Object.keys(started), ["event", "at"]);
  assert.equal(started.event, "turn-start");
  assert.equal(new Date(started.at).toISOString(), started.at, "an ISO instant, to the millisecond");
  assert.ok(Date.parse(started.at) >= Date.parse(startedAt) && Date.parse(started.at) <= Date.now());
  assert.equal(activityOf(h, { startedAt }), "working");
  assert.equal(stop(h), 2);
  assert.equal(recordOf(h).event, "turn-end");
  assert.ok(Date.parse(recordOf(h).at) >= Date.parse(started.at));
  assert.equal(activityOf(h, { startedAt }), "idle");
  // The next prompt, and a turn an API error ended (StopFailure fires instead of Stop).
  prompt(h);
  assert.equal(activityOf(h, { startedAt }), "working");
  assert.equal(fire(h, "StopFailure", INPUT.StopFailure), 2);
  assert.equal(activityOf(h, { startedAt }), "idle");
  // The record is whole after every write, and no temporary file is left.
  assert.match(readFileSync(join(h, TURN_FILE), "utf8"), /^\{"event":"turn-end","at":"[^"]+"\}\n$/);
  assert.deepEqual(readdirSync(join(h, ".oats")), ["turn.json"]);
});

test("a prompt with no Stop, then the idle notice, reads idle; the notice writes nothing over a turn that already ended", () => {
  const h = home();
  prompt(h);
  assert.equal(activityOf(h), "working");
  assert.equal(idleNotice(h), 1);
  assert.equal(recordOf(h).event, "turn-end");
  assert.equal(activityOf(h), "idle");
  // After a Stop the notice comes a minute later: the record keeps the turn's own end.
  prompt(h);
  stop(h);
  const ended = readFileSync(join(h, TURN_FILE), "utf8");
  idleNotice(h);
  assert.equal(readFileSync(join(h, TURN_FILE), "utf8"), ended);
  // With no record at all (a session whose first prompt has not come), the notice writes none.
  rmSync(join(h, TURN_FILE));
  idleNotice(h);
  assert.equal(recordOf(h), null);
});

test("only the idle notice ends a turn: a permission prompt's notification, another type under the idle matcher, and an input that is no notification write nothing", () => {
  const h = home();
  prompt(h);
  const open = readFileSync(join(h, TURN_FILE), "utf8");
  // A permission prompt opens inside the turn: its own entries run (the claim's), and the turn goes on.
  assert.equal(fire(h, "Notification", INPUT.permission, { subject: "permission_prompt" }), 1);
  assert.equal(readFileSync(join(h, TURN_FILE), "utf8"), open);
  // Claude can run an entry for a class its matcher does not name (#1670): the writer reads the type itself.
  for (const input of [INPUT.permission, { ...INPUT.idle, notification_type: "elicitation_dialog" }, { ...INPUT.idle, notification_type: undefined }, { message: "notification_type: idle_prompt" }, [INPUT.idle], "idle_prompt", null]) {
    fire(h, "Notification", input, { subject: "idle_prompt" });
    assert.equal(readFileSync(join(h, TURN_FILE), "utf8"), open, JSON.stringify(input));
  }
  assert.equal(activityOf(h), "working");
  // The pure rule.
  assert.equal(isIdleNotice(JSON.stringify(INPUT.idle)), true);
  for (const text of ["", "{", "null", "[]", JSON.stringify(INPUT.permission), JSON.stringify({ message: "\"notification_type\":\"idle_prompt\"" })]) assert.equal(isIdleNotice(text), false, text);
  assert.equal(boundaryOf(TURN_END_IDLE, h, JSON.stringify(INPUT.idle)), "turn-end");
  assert.equal(boundaryOf(TURN_END_IDLE, h, JSON.stringify(INPUT.permission)), null);
  assert.deepEqual([boundaryOf("turn-start", h), boundaryOf("turn-end", h), boundaryOf("turn-pause", h), boundaryOf(undefined, h)], ["turn-start", "turn-end", null, null]);
  assert.equal(recordedEvent(h), "turn-start");
});

test("a subagent's event writes nothing: an input that carries agent_id leaves the record as the main turn left it, whatever the hook", () => {
  const h = home();
  // No record yet: a subagent's prompt starts no turn of the home's.
  prompt(h, { input: { ...INPUT.UserPromptSubmit, agent_id: "a-1", agent_type: "general-purpose" } });
  assert.equal(recordOf(h), null);
  prompt(h);
  const open = readFileSync(join(h, TURN_FILE), "utf8");
  // A background subagent stops, fails or sits idle while the main turn goes on.
  for (const [event, input, subject] of [["Stop", INPUT.Stop], ["StopFailure", INPUT.StopFailure], ["Notification", INPUT.idle, "idle_prompt"], ["UserPromptSubmit", INPUT.UserPromptSubmit]]) {
    fire(h, event, { agent_id: "a-1", ...input }, { subject });
    assert.equal(readFileSync(join(h, TURN_FILE), "utf8"), open, event);
  }
  assert.equal(activityOf(h), "working");
  // The main thread's own events carry none, and an input that is no JSON object is the main thread's.
  for (const input of ["not json", "", [], { ...INPUT.Stop, agent_id: "" }, { ...INPUT.Stop, agent_id: 7 }, { ...INPUT.Stop, message: "\"agent_id\":\"a-1\"" }]) {
    prompt(h);
    fire(h, "Stop", input);
    assert.equal(recordOf(h).event, "turn-end", JSON.stringify(input));
  }
  // An input over the 64 KiB the script reads arrives cut, and no longer parses: a Stop's last
  // message can be that long. The keys before `hook_event_name` still say whose event it is.
  const long = "x".repeat(70000);
  prompt(h);
  const working = readFileSync(join(h, TURN_FILE), "utf8");
  fire(h, "Stop", { session_id: "s-1", agent_id: "a-1", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: long });
  assert.equal(readFileSync(join(h, TURN_FILE), "utf8"), working, "a subagent's long Stop writes nothing");
  fire(h, "Stop", { session_id: "s-1", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: `"agent_id":"a-1" ${long}` });
  assert.equal(recordOf(h).event, "turn-end", "the main thread's long Stop ends the turn, whatever its message says");
  const cut = (event) => JSON.stringify(event).slice(0, 65536);
  assert.equal(fromSubagent(cut({ session_id: "s", agent_id: "a-1", hook_event_name: "Stop", last_assistant_message: long })), true);
  assert.equal(fromSubagent(cut({ session_id: "s", agent_id: "a-1", agent_type: "x", cwd: "/w", hook_event_name: "Stop", last_assistant_message: long })), true);
  for (const event of [
    { session_id: "s", hook_event_name: "Stop", last_assistant_message: long },
    { session_id: "s", hook_event_name: "Stop", last_assistant_message: `"agent_id":"a-1" ${long}` },
    // A key order with nothing before hook_event_name to read, and an input cut before it.
    { hook_event_name: "Stop", agent_id: "a-1", last_assistant_message: long },
    { prompt: long, agent_id: "a-1", hook_event_name: "UserPromptSubmit" },
    { session_id: "s", agent_id: "", hook_event_name: "Stop", last_assistant_message: long },
  ]) assert.equal(fromSubagent(cut(event)), false, JSON.stringify(event).slice(0, 80));
  assert.equal(fromSubagent(JSON.stringify({ agent_id: "a-1", hook_event_name: "Stop" })), true);
  for (const text of ["", "{", "null", "[]", JSON.stringify(INPUT.Stop), JSON.stringify({ agent_id: "" }), JSON.stringify({ agent_id: null })]) assert.equal(fromSubagent(text), false, text);
  assert.equal(boundaryOf(TURN_END, h, JSON.stringify({ agent_id: "a-1" })), null);
});

test("a boundary dated before startedAt reads null: a record a killed session left is not the next start's", () => {
  const h = home();
  prompt(h);
  const at = Date.parse(recordOf(h).at);
  assert.equal(activityOf(h, { startedAt: new Date(at).toISOString() }), "working", "at startedAt");
  assert.equal(activityOf(h, { startedAt: new Date(at + 1).toISOString() }), null, "a start one millisecond later");
  stop(h);
  assert.equal(activityOf(h, { startedAt: new Date(Date.parse(recordOf(h).at) + 1).toISOString() }), null);
  // The new start's launch prompt counts again.
  const startedAt = new Date().toISOString();
  prompt(h);
  assert.equal(activityOf(h, { startedAt }), "working");
});

test("an interrupted turn (Esc fires no hook: neither Stop nor the idle notice) reads working until 30 minutes after its start, then null", () => {
  const h = home();
  prompt(h);
  const at = Date.parse(recordOf(h).at);
  assert.equal(activityOf(h, { now: at + CLAUDE_OPEN_TURN_MAX_MS }), "working");
  assert.equal(activityOf(h, { now: at + CLAUDE_OPEN_TURN_MAX_MS + 1 }), null);
  // The next prompt is a turn start again.
  prompt(h);
  assert.equal(activityOf(h), "working");
});

test("nothing for Codex or pi: the launch hook writes no settings for them, and so no record", () => {
  for (const harness of ["codex", "pi"]) {
    const h = home({ harness });
    assert.equal(existsSync(join(h, ".claude")), false, harness);
    assert.equal(recordOf(h), null, harness);
  }
});

test("a Claude Code from before StopFailure writes the other three boundaries all the same", () => {
  const h = home({ version: "2.1.61" });
  assert.equal(Object.hasOwn(settingsOf(h).hooks, "StopFailure"), false);
  prompt(h);
  assert.equal(activityOf(h), "working");
  idleNotice(h);
  assert.equal(activityOf(h), "idle");
  prompt(h);
  stop(h);
  assert.equal(activityOf(h), "idle");
});

test("the hooks speak for their own home only: a session that carries another home's environment, or none, writes nothing in either home", () => {
  const a = home(), b = home();
  prompt(a);
  const mine = readFileSync(join(a, TURN_FILE), "utf8");
  // A Claude process that loaded B's settings while carrying A's environment (a nested `claude -p` started in B).
  for (const session of [a, undefined, "relative/home", join(base, "no-such-home")]) {
    prompt(b, { session });
    stop(b, { session });
    idleNotice(b, { session });
    assert.equal(recordOf(b), null, String(session));
    assert.equal(readFileSync(join(a, TURN_FILE), "utf8"), mine, String(session));
  }
  // Any spelling of the home is the home: its settings bake the real path.
  const link = join(base, `link-${n}`);
  symlinkSync(b, link);
  prompt(b, { session: link });
  assert.equal(recordOf(b).event, "turn-start");
});

test("the write can never hurt the session or the home: no .oats directory, a linked one, a record's name taken by a directory, and a failing node all end quietly, with nothing left behind", () => {
  // No `.oats` (a home no kernel shim was written in): nothing is made.
  const bare = home();
  rmSync(join(bare, ".oats"), { recursive: true });
  prompt(bare);
  assert.equal(existsSync(join(bare, ".oats")), false);
  // A linked `.oats` is never written through.
  const elsewhere = join(base, `elsewhere-${n}`);
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(bare, ".oats"));
  prompt(bare);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(writeTurn(bare, TURN_START), false);

  // The record's own name taken by a directory: the rename fails and the temporary file goes.
  const h = home();
  mkdirSync(join(h, TURN_FILE));
  writeFileSync(join(h, TURN_FILE, "x"), "");
  prompt(h);
  stop(h);
  assert.deepEqual(readdirSync(join(h, ".oats")), ["turn.json"]);
  assert.equal(activityOf(h), null);
  rmSync(join(h, TURN_FILE), { recursive: true });
  // A temporary file a killed write left under this writer's own pid is replaced, not a refusal.
  writeFileSync(`${turnPath(h)}.tmp-${process.pid}`, "{\"event\":");
  assert.equal(writeTurn(h, TURN_END), true);
  assert.deepEqual(readdirSync(join(h, ".oats")), ["turn.json"]);

  // A node that fails, and one that hangs (killed at 2 s): the hook still exits 0, silently, in bounded time.
  for (const [what, script] of [["fails", "#!/bin/sh\nexit 1\n"], ["hangs", "#!/bin/sh\ntrap '' TERM\nsleep 20 & wait\n"]]) {
    const node = join(base, `node-${what}`);
    writeFileSync(node, script, { mode: 0o755 });
    const command = settingsOf(h).hooks.Stop[0].hooks[1].command.replace(`'${process.execPath}'`, `'${node}'`);
    assert.match(command, new RegExp(`claude-waiting\\.sh' turn turn-end '${node}' `));
    const before = readFileSync(join(h, TURN_FILE), "utf8"), began = Date.now();
    const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 15000, input: JSON.stringify(INPUT.Stop), cwd: base, env: cleanEnv({ OATS_INSTANCE_HOME: h }) });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], what);
    assert.ok(Date.now() - began < 4500, `${what}: ${Date.now() - began} ms, under Claude's 5 s`);
    assert.equal(readFileSync(join(h, TURN_FILE), "utf8"), before, what);
  }
});

test("a turn command calls no kernel CLI, and an unknown boundary does nothing", () => {
  const h = home(), log = join(base, `cli-${n}.log`);
  const turnOnly = settingsOf(h).hooks.UserPromptSubmit[0].hooks[1].command;
  const run = (command) => spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 15000, input: JSON.stringify(INPUT.UserPromptSubmit), cwd: base, env: cleanEnv({ OATS_INSTANCE_HOME: h, FAKE_LOG: log }) });
  assert.equal(run(turnOnly).status, 0);
  assert.equal(recordOf(h).event, "turn-start");
  assert.equal(existsSync(log), false, "the turn's write starts no CLI");
  rmSync(join(h, TURN_FILE));
  for (const boundary of ["turn-pause", "working", "", "turn-start; touch /tmp/x"]) {
    const r = run(turnOnly.replace(" turn turn-start ", ` turn '${boundary}' `));
    assert.deepEqual([r.status, r.stdout], [0, ""], boundary);
    assert.equal(recordOf(h), null, boundary);
  }
});

test("the record and a write's temporary file are not work to the kernel's retire digest", () => {
  const h = home();
  const digest = () => storedTreeDigest(h, 2, { instanceHome: true });
  const before = digest();
  prompt(h);
  stop(h);
  writeFileSync(`${turnPath(h)}.tmp-4242`, "{\"event\":");
  assert.equal(digest(), before);
});
