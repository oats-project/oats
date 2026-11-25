// `oats session input` on a tmux home, one input at a time (#2124), and never over a permission
// prompt (#2125). The CLI runs for real against a fake tmux on its PATH that keeps one pane: every
// paste and every Enter is a line of its log, and `messages` folds the log into what the agent's
// harness would have been handed (the input line at each Enter). No tmux server and no model.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setWaiting } from "../lib/instance-events.mjs";
import { KERNEL_FEATURES, SESSION_INPUT_PERMISSION_REFUSAL_FEATURE } from "../lib/kernel-features.mjs";

const cli = fileURLToPath(new URL("../bin/oats.mjs", import.meta.url));
const lib = (name) => new URL(`../lib/${name}`, import.meta.url).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-input-lock-")));
  const children = [];
  t.after(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(base, { recursive: true, force: true });
  });
  // A home where a deployment has it, so its claims have their two logs.
  const home = join(base, "dep", "agents", "dev", "instances", "seat"), bin = join(base, "bin"), log = join(base, "pane.jsonl");
  const baselines = join(base, "dep", "agents", "dev", "instances", ".oats-retirement", "baselines");
  for (const dir of [home, bin, baselines]) mkdirSync(dir, { recursive: true });
  const tmux = { socket: join(base, "inert.sock"), session: "fixture", window: "seat" };
  writeFileSync(join(home, "instance.json"), JSON.stringify({ launched: true, tmux, createdAt: "2026-11-25T10:00:00.000Z" }));
  writeFileSync(join(baselines, `${createHash("sha256").update(home).digest("hex")}.json`), JSON.stringify({ version: 2, home, runtime: { launched: true, tmux } }));
  // The fake tmux. `HOLD_AT_LOOK`: its first look at the pane writes that file and then stays
  // for 4 s, so a test can end the input that waits on it between its paste and its Enter.
  writeFileSync(join(bin, "tmux"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== '-u' || args[1] !== '-S' || args[2] !== ${JSON.stringify(tmux.socket)}) process.exit(90);
const command = args[3], log = ${JSON.stringify(log)}, buffers = ${JSON.stringify(join(base, "buffers"))};
const put = (event) => fs.appendFileSync(log, JSON.stringify(event) + '\\n');
fs.mkdirSync(buffers, { recursive: true });
if (command === 'list-panes') process.stdout.write('%12\\t0\\tcodex\\t' + (process.env.PANE_PID || '123') + '\\n');
else if (command === 'load-buffer') fs.writeFileSync(buffers + '/' + args[5], fs.readFileSync(0, 'utf8'));
else if (command === 'paste-buffer') put({ paste: fs.readFileSync(buffers + '/' + args[args.indexOf('-b') + 1], 'utf8') });
else if (command === 'send-keys') put({ enter: true });
else if (args.includes('capture-pane')) {
  const hold = process.env.HOLD_AT_LOOK;
  if (hold && !fs.existsSync(hold)) { fs.writeFileSync(hold, String(process.pid)); setTimeout(() => {}, 4000); }
  else process.stdout.write('80x24\\n' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0) + ' bytes typed\\n80x24\\n');
}
else if (command === 'display-message') process.stdout.write((process.env.PANE_PID || '123') + '\\n');
`);
  chmodSync(join(bin, "tmux"), 0o755);
  const oatsHome = join(base, "oats-home");
  const env = { PATH: bin, HOME: base, OATS_HOME_DIR: oatsHome };
  const args = [cli, "session", "input", "--home", home, "--json"];
  const events = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { home, base, oatsHome, events,
    /** The kinds of what was typed, oldest first: "paste" and "enter". */
    typed: () => events().map((e) => (e.enter ? "enter" : "paste")),
    /** What the harness was handed: the input line at each Enter (what is typed with no Enter yet is not a message). */
    messages() {
      const out = []; let line = "";
      for (const e of events()) { if (e.enter) { out.push(line); line = ""; } else line += e.paste; }
      return out;
    },
    /** One input, awaited → `{ status, signal, envelope, ms }`. */
    run(text, extra = {}) {
      const started = Date.now();
      const r = spawnSync(process.execPath, args, { cwd: base, env: { ...env, ...extra }, input: text, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
      return { status: r.status, signal: r.signal, envelope: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr, ms: Date.now() - started };
    },
    /** One input, started and not awaited → the child, with `done`: a promise of `{ status, signal, envelope }`. */
    start(text, extra = {}) {
      const child = spawn(process.execPath, args, { cwd: base, env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stdin.end(text);
      child.done = new Promise((done) => child.on("close", (status, signal) => done({ status, signal, envelope: out.trim() ? JSON.parse(out) : null })));
      return child;
    },
    /** A process that takes this home's input lock and keeps it until it is killed → the child, once it holds the lock. */
    async holder() {
      const script = `import { acquireDirLock } from ${JSON.stringify(lib("dir-lock.mjs"))};
import { inputLock } from ${JSON.stringify(lib("session-input-lock.mjs"))};
acquireDirLock(inputLock(${JSON.stringify(home)}), { what: "a test's input" }, { busy: (why) => new Error(why) });
process.stdout.write("held\\n");
setInterval(() => {}, 1000);`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: base, env, stdio: ["ignore", "pipe", "inherit"] });
      children.push(child);
      await new Promise((held, failed) => { child.stdout.once("data", held); child.once("exit", () => failed(new Error("the lock's holder ended before it held the lock"))); });
      return child;
    },
    children };
}
const ok = { present: true, state: "unknown", paneId: "%12", submitted: true };

test("two inputs to one home at the same moment are two messages, in order, each with its own Enter (#2124)", async (t) => {
  const fx = fixture(t);
  const [a, b] = await Promise.all([fx.start("PAR-A").done, fx.start("PAR-B").done]);
  for (const r of [a, b]) {
    assert.equal(r.status, 0, JSON.stringify(r));
    assert.deepEqual({ ...r.envelope.result, verified: undefined }, { home: fx.home, backend: "tmux", ...ok, verified: undefined }, "the answer's shape is as it was");
  }
  // Never one message of the two texts: each paste is followed by its own Enter.
  assert.deepEqual(fx.typed(), ["paste", "enter", "paste", "enter"]);
  assert.deepEqual(fx.messages().sort(), ["PAR-A", "PAR-B"]);
  // And a third and a fourth beside them, the same way.
  const more = await Promise.all(["C", "D", "E"].map((text) => fx.start(text).done));
  assert.deepEqual(more.map((r) => r.status), [0, 0, 0]);
  assert.deepEqual(fx.typed().slice(4), ["paste", "enter", "paste", "enter", "paste", "enter"]);
  assert.deepEqual(fx.messages().slice(2).sort(), ["C", "D", "E"]);
});

test("an input that waits on another past its bound is refused E_SESSION_INPUT_FAILED with nothing pasted; once the holder is done it goes (#2124)", async (t) => {
  const fx = fixture(t);
  const holder = await fx.holder();
  const refused = fx.run("late");
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual([refused.envelope.ok, refused.envelope.error.code], [false, "E_SESSION_INPUT_FAILED"]);
  assert.match(refused.envelope.error.message, /^cannot submit session input: another input to seat was still being sent after 8 s \(pid \d+ holds it, the lock .*\); send it again; nothing was sent$/);
  assert.ok(refused.ms >= 8000, `it waited its bound first (${refused.ms} ms)`);
  assert.deepEqual(fx.typed(), [], "nothing was pasted and no key was sent");
  // The holder ends (here: is killed): the same input is then sent.
  holder.kill("SIGKILL");
  await new Promise((r) => holder.once("exit", r));
  const sent = fx.run("late");
  assert.equal(sent.status, 0, JSON.stringify(sent));
  assert.deepEqual([fx.typed(), fx.messages()], [["paste", "enter"], ["late"]]);
});

test("the lock of a holder that was killed is taken over at once, never waited for (#2124)", async (t) => {
  const fx = fixture(t);
  const holder = await fx.holder();
  holder.kill("SIGKILL");
  await new Promise((r) => holder.once("exit", r));
  const sent = fx.run("after a dead holder");
  assert.equal(sent.status, 0, JSON.stringify(sent));
  assert.ok(sent.ms < 6000, `no wait for a holder that is gone (${sent.ms} ms)`);
  assert.deepEqual([fx.typed(), fx.messages()], [["paste", "enter"], ["after a dead holder"]]);
  // And a lock that is no claim at all (a directory, an earlier kernel's kind of lock) refuses at once, by name, with nothing sent.
  const { inputLock } = await import("../lib/session-input-lock.mjs");
  const before = process.env.OATS_HOME_DIR;
  process.env.OATS_HOME_DIR = fx.oatsHome;
  let lock;
  try { lock = inputLock(fx.home); } finally { if (before === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = before; }
  rmSync(lock, { force: true });
  mkdirSync(lock);
  const stuck = fx.run("x");
  assert.deepEqual([stuck.status, stuck.envelope.error.code], [1, "E_SESSION_INPUT_FAILED"]);
  assert.match(stuck.envelope.error.message, /the input lock of seat, .*, could not be taken \(.*is a lock directory written by an earlier kernel\).*; nothing was sent$/);
  assert.ok(stuck.ms < 6000);
  assert.deepEqual(fx.typed(), ["paste", "enter"], "nothing more was typed");
});

test("text pasted by an input that died before its Enter is submitted on its own before the next input's text, never run into it (#2124)", async (t) => {
  const fx = fixture(t);
  // The first input is ended between its paste and its Enter: while it looks at the pane.
  const held = join(fx.base, "held-at-look");
  const dying = fx.start("LEFT", { HOLD_AT_LOOK: held });
  for (let i = 0; i < 200 && !existsSync(held); i++) await sleep(50);
  assert.equal(existsSync(held), true, "the first input reached its look at the pane");
  dying.kill("SIGKILL");
  assert.equal((await dying.done).signal, "SIGKILL");
  assert.deepEqual([fx.typed(), fx.messages()], [["paste"], []], "its text is in the input line, with no Enter");
  // The next input: an Enter for what was left, then its own paste and its own Enter.
  const next = fx.run("NEXT");
  assert.equal(next.status, 0, JSON.stringify(next));
  assert.deepEqual(fx.typed(), ["paste", "enter", "paste", "enter"]);
  assert.deepEqual(fx.messages(), ["LEFT", "NEXT"], "two messages: what was left, as it was, then the new one");
  // Nothing is left noted: a third input sends no Enter of anybody else's.
  assert.equal(fx.run("THIRD").status, 0);
  assert.deepEqual(fx.typed().slice(4), ["paste", "enter"]);
});

test("a paste left in a pane whose process is gone (the session was restarted since) gets no Enter (#2124)", async (t) => {
  const fx = fixture(t);
  const held = join(fx.base, "held-at-look");
  const dying = fx.start("LEFT", { HOLD_AT_LOOK: held });
  for (let i = 0; i < 200 && !existsSync(held); i++) await sleep(50);
  dying.kill("SIGKILL");
  await dying.done;
  // The pane now runs another process: the line that held the text is gone with the old one.
  const next = fx.run("NEXT", { PANE_PID: "456" });
  assert.equal(next.status, 0, JSON.stringify(next));
  assert.deepEqual(fx.typed(), ["paste", "paste", "enter"], "one Enter: its own");
  assert.equal(fx.run("THIRD", { PANE_PID: "456" }).status, 0);
  assert.deepEqual(fx.typed().slice(3), ["paste", "enter"], "and the note is gone");
});

test("an input to a home whose session holds a permission claim is refused E_SESSION_PROMPT_OPEN with nothing typed; a question or an attention claim is typed to as before (#2125)", (t) => {
  const fx = fixture(t);
  assert.equal(SESSION_INPUT_PERMISSION_REFUSAL_FEATURE, "session-input-permission-refusal");
  assert.ok(KERNEL_FEATURES.includes("session-input-permission-refusal"));
  setWaiting(fx.home, { producer: "oats.core", waiting: true, reason: "permission", message: "Claude needs your permission to use Bash" });
  const refused = fx.run("go on");
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual(refused.envelope, { schemaVersion: 1, ok: false, error: { code: "E_SESSION_PROMPT_OPEN", message: `seat has a permission prompt open (the oats.core claim): an input's Enter would answer it, so nothing was sent. Answer it in the agent's terminal (oats session attach --home ${fx.home}) or in your client's own prompt card, then send the input again` } });
  assert.deepEqual(fx.events(), [], "no paste, no Enter, no key of any kind");
  // An attention claim with text beside it does not hide the permission one.
  setWaiting(fx.home, { producer: "agent", waiting: true, reason: "attention", message: "Which branch?" });
  assert.equal(fx.run("go on").envelope.error.code, "E_SESSION_PROMPT_OPEN");
  assert.deepEqual(fx.events(), []);
  // The prompt is answered (its claim cleared): the agent's own request for input is answered by typing.
  setWaiting(fx.home, { producer: "oats.core", waiting: false });
  const answered = fx.run("the main branch");
  assert.equal(answered.status, 0, JSON.stringify(answered));
  assert.deepEqual([fx.typed(), fx.messages()], [["paste", "enter"], ["the main branch"]]);
  // A question claim: typed to, as before (the text may be the answer).
  setWaiting(fx.home, { producer: "agent", waiting: false });
  setWaiting(fx.home, { producer: "oats.core", waiting: true, reason: "question", message: "Which one?" });
  const asked = fx.run("the second");
  assert.equal(asked.status, 0, JSON.stringify(asked));
  assert.deepEqual(fx.messages(), ["the main branch", "the second"]);
  // Another producer's permission claim refuses the same way, by its name.
  setWaiting(fx.home, { producer: "oats.pi", waiting: true, reason: "permission" });
  const again = fx.run("x");
  assert.equal(again.envelope.error.code, "E_SESSION_PROMPT_OPEN");
  assert.match(again.envelope.error.message, /\(the oats\.pi claim\)/);
  assert.deepEqual(fx.typed().length, 4);
});
