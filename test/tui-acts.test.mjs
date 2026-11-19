// `oats tui` stops, starts, restarts and retires an agent (awebai/oats#855, PR 5; docs/tui.md,
// "Stopping, starting, restarting and retiring"), with real processes: an act it sent is a change,
// and the TUI never ends a change. Spec 5, "Tests", real processes 1 to 4; and (test 5) spawns one
// (Spec 6-spawn, "Tests", tui-terminal), with the real kernel.
//
// RUN ON CI ONLY, never on a shared host. Real tmux throughout, never the operator's: the terminal
// is a pane of a private server on a socket in this file's own temp dir (`-S`), the kernel's tmux is
// the fixture's (host-fixture.mjs isolateSessionEnvironment: a private TMUX_TMPDIR, TMUX and
// TMUX_PANE gone from every child's environment), and the last test checks that the default tmux
// server's sessions are what they were before this file ran.
//
// Tests 1 and 4 need a kernel whose stop apply waits: the TUI runs the kernel of its own install
// (packages/tui/lib/read.mjs KERNEL_BIN, `../../../bin/oats.mjs`), so the TUI and the shared readers
// are copied under a directory whose `bin/oats.mjs` is a fake that hands every command to the real
// kernel but a stop apply. That apply writes its pid, records any signal it is sent (and does not
// end on it), waits for a file of the test's, then (test 1) writes to stdout and to stderr after the
// TUI has gone and only then its completion marker, or (test 2) runs the real kernel's apply, which
// prints its envelope after the TUI's terminal was killed. Test 3 is the real TUI and the real
// kernel end to end. A signal goes only to a pid the test's own wrapper or the fake wrote down.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:os";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { assertNoFixtureProcesses, fixtureBase, isolateSessionEnvironment, systemExecutable, waitUntil } from "./helpers/host-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { backKeyLabel } from "../packages/tui/lib/actions.mjs";
import { defaultDetachKey } from "../packages/tui/lib/config.mjs";
import { instanceDisplayName } from "../packages/client/instance-display-name.mjs";

/** The leader: the default (C-x, Ctrl+X, on every platform), as tmux's
 *  send-keys names it too, and as the cheat sheet spells it. */
const LEADER_KEY = defaultDetachKey(), LEADER = backKeyLabel(LEADER_KEY);
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A row of the cheat sheet in the sidebar (docs/tui.md, "The cheat sheet"): the key at the
 *  margin, what it does in a column after it, and the rest of the row the sidebar's (its rule, or
 *  the main area beside it). */
const hintRow = (key, word) => new RegExp(`^ ${literal(key)} +${literal(word)}(?: |$)`);
/** Rows of the cheat sheet: `q quit`, in the list's sheet and a confirmation's; `n spawn`, in the
 *  list's and not a confirmation's; and the one the open terminal's focus alone draws, the leader
 *  then Esc, which gives the list the focus. */
const QUIT_ROW = hintRow("q", "quit"), SPAWN_ROW = hintRow("n", "spawn"), BACK_ROW = hintRow(`${LEADER} Esc`, "the list");
/** The main area of a row: from two cells after the rule between it and the sidebar, where a
 *  confirmation and the spawn prompt stand (the row as it is when it has no rule). */
const mainOf = (row) => { const at = row.indexOf("│"); return at < 0 ? row : row.slice(at + 2); };

const REPOSITORY = resolve(new URL("..", import.meta.url).pathname);
const CLI = join(REPOSITORY, "bin", "oats.mjs");
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const hostTool = (name) => { try { return systemExecutable(name); } catch { return null; } };

// The host's own tools and the default server's sessions, read before the environment is isolated.
const REAL_TMUX = hostTool("tmux");
const SLEEP = hostTool("sleep");
/** Test 5 opens the new agent's terminal: the panel makes its keeper's FIFO with the base system's
 *  `mkfifo` (packages/tui/lib/panel.mjs, THE KEEPER), which the fixture's PATH does not link: the
 *  host's is linked there for this file, as test/tui-panel.test.mjs does. */
const HOST_MKFIFO = hostTool("mkfifo");
const NO_TMUX = REAL_TMUX ? false : "tmux is not on PATH: these tests drive `oats tui` in a real tmux (test/tmux-in-ci.test.mjs fails for this in CI)";
const ORIGINAL_ENV = { ...process.env };
/** The sessions of the default tmux server (the one a plain `tmux` reaches from the environment this
 *  file was started in), or [] when none runs. Read only. */
function defaultSessions() {
  try { return execFileSync(REAL_TMUX, ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], env: ORIGINAL_ENV }).split("\n").filter(Boolean).sort(); } catch { return []; }
}
/** Where that plain tmux keeps its sockets (tmux's own layout: TMUX_TMPDIR, else /tmp), and whether
 *  it was there before. Under the root run it is this file's own temporary directory, and the probe
 *  makes it: the file removes it at its end when the probe made it and it is empty, never one that
 *  was there before or that holds a socket. */
const PROBED = join(ORIGINAL_ENV.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid()}`);
const PROBED_BEFORE = existsSync(PROBED);
const DEFAULT_BEFORE = REAL_TMUX ? defaultSessions() : [];
for (const name of ["TMUX", "TMUX_PANE"]) delete process.env[name];
const base = fixtureBase("oats-ta-"); // short: a socket path lives in it
/** Set by the setup (test.before below); test.after undoes what of it was done. */
let restoreEnvironment = () => {}, fx = null;
const TERM = join(base, "term.sock");

/** Every test starts the real CLI or the copied TUI, which read the fixture with the real kernel,
 *  and every act runs the real kernel's plan: on a loaded host each takes seconds. Once the budget
 *  is spent every further wait fails at once. */
const BUDGET_MS = 300000;
const FILE_DEADLINE = Date.now() + BUDGET_MS;

const tmuxRaw = (...args) => execFileSync("tmux", ["-u", "-S", TERM, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
const tmuxOn = (...args) => tmuxRaw(...args).trim();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

// ---- the fixture: one deployment, three throwaway agents, and the copied TUI over the fake ---------
/** The harness of the agent test 3 restarts, stops and starts: the fixture's inert harnesses exit
 *  at once, which leaves a shell in the pane (the state `shell`), so that agent runs this stand-in
 *  instead, through a launch configuration that names it by its path (a declared path is never
 *  looked up again at a start). It runs until the kernel's stop sends it SIGTERM. */
const STANDIN = join(base, "standin-harness");
const world = { homes: {} };
const SHADOW = join(base, "shadow");
const CONTROL = join(base, "control");
/** The fake kernel of the copied TUI (see the top of the file). `control/round` names the round
 *  its files are for, `control/mode` is `fake` (test 1, 4) or `real` (test 2). */
const FAKE_KERNEL = `import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REAL = ${JSON.stringify(CLI)}, CONTROL = ${JSON.stringify(CONTROL)};
const args = process.argv.slice(2);
const apply = args[0] === "instance" && args[1] === "stop" && args.includes("--apply");
if (!apply) {
  const r = spawnSync(process.execPath, [REAL, ...args], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const round = readFileSync(join(CONTROL, "round"), "utf8").trim(), mode = readFileSync(join(CONTROL, "mode"), "utf8").trim();
const at = (name) => join(CONTROL, round + "." + name);
for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP", "SIGPIPE"]) process.on(name, () => appendFileSync(at("signals"), name + "\\n"));
writeFileSync(at("pid"), String(process.pid));
const wait = () => {
  if (!existsSync(at("gate"))) return setTimeout(wait, 50);
  if (mode === "real") {
    const r = spawnSync(process.execPath, [REAL, ...args], { stdio: "inherit" });
    writeFileSync(at("status"), String(r.status));
    process.exitCode = r.status ?? 1;
  } else {
    process.stdout.write('{"schemaVersion":1,"ok":true,"result":{"written":"after the TUI has gone"}}\\n');
    process.stderr.write("the fake kernel writes to stderr after the TUI has gone\\n");
  }
  writeFileSync(at("done"), "done");
};
wait();
`;
// The setup runs in a hook: when a step of it fails, test.after still ends what the steps before it
// made. A file that fails while it loads runs no hook at all.
test.before(async () => {
  if (!REAL_TMUX) return;
  restoreEnvironment = isolateSessionEnvironment(base);
  assert.ok(HOST_MKFIFO, "mkfifo is on the host's PATH");
  symlinkSync(HOST_MKFIFO, join(process.env.PATH.split(delimiter)[0], "mkfifo"));
  writeFileSync(STANDIN, `#!/bin/sh\nexec ${shq(SLEEP)} 86400\n`);
  chmodSync(STANDIN, 0o755);
  // A second soul, scribe, for test 5's spawn from the TUI: this machine launches it on the stand-in
  // (souls.launch), since the prompt offers no harness, and an inert one leaves no running session.
  fx = v2Deployment({ souls: { dev: {}, scribe: {} }, local: { "launch-configs": { standin: { harness: "pi", executable: STANDIN } }, souls: { launch: { scribe: "standin" } } } });
  // The TUI and the readers it shares, as the install holds them, under the fake kernel.
  for (const dir of ["tui", "client"]) cpSync(join(REPOSITORY, "packages", dir), join(SHADOW, "packages", dir), { recursive: true, filter: (from) => !from.includes(`${join("packages", dir, "test")}`) });
  mkdirSync(join(SHADOW, "bin"), { recursive: true });
  writeFileSync(join(SHADOW, "bin", "oats.mjs"), FAKE_KERNEL);
  // The package's manifest, as the install holds it beside bin/: the TUI judges its kernel against that
  // version (read.mjs KERNEL_VERSION), and the fake answers `version --json` through the real kernel.
  cpSync(join(REPOSITORY, "package.json"), join(SHADOW, "package.json"));
  mkdirSync(CONTROL, { recursive: true });
  // Three agents, spawned in the fixture (its inert harnesses first on PATH) and started for real
  // on the fixture's tmux server. alpha and beta run an inert harness, which exits and leaves a
  // shell in the pane (stop and retire are offered there too); gamma runs the stand-in.
  const saved = process.env.PATH;
  process.env.PATH = fx.env.PATH;
  try {
    for (const name of ["alpha", "beta", "gamma"]) world.homes[name] = (await fx.spawn("dev", { name, ...(name === "gamma" ? { launchConfig: "standin" } : {}) })).home;
  } finally { process.env.PATH = saved; }
  for (const name of ["alpha", "beta", "gamma"]) {
    const r = fx.cli(["session", "start", "--home", world.homes[name], "--json"]);
    assert.equal(r.status, 0, `fixture premise: ${name} starts\n${r.stdout}\n${r.stderr}`);
  }
  // A terminal's shell is started through this: the fixture's environment, then its arguments.
  world.enter = join(base, "enter.sh");
  writeFileSync(world.enter, `#!/bin/sh\n${Object.entries(fx.env).map(([name, value]) => `export ${name}=${shq(value)}`).join("\n")}\nunset TMUX TMUX_PANE\nexec "$@"\n`);
  tmuxOn("new-session", "-d", "-s", "hold", "-n", "hold", "-x", "100", "-y", "30", "-c", base, "cat");
  tmuxOn("set-option", "-g", "default-terminal", "screen");
});

test.after(() => {
  // Every gate opened, so no fake waits for ever; then the terminals' server, by its socket.
  for (const file of readdirSafe(CONTROL)) if (file.endsWith(".pid")) quietly(() => writeFileSync(join(CONTROL, file.replace(/\.pid$/, ".gate")), ""));
  if (REAL_TMUX) quietly(() => execFileSync(REAL_TMUX, ["-S", TERM, "kill-server"], { stdio: "ignore", timeout: 10000 }));
  // The agents' sessions: the fixture's own `oats` server, in the private TMUX_TMPDIR (through the
  // fixture's tmux, which admits that server alone), before the fixture checks for its processes.
  // Only once the setup has made the fixture: before that the environment may not be isolated yet.
  if (fx) quietly(() => execFileSync("tmux", ["-L", "oats", "kill-server"], { stdio: "ignore", timeout: 10000 }));
  const errors = [];
  if (REAL_TMUX) { try { assertNoFixtureProcesses(base, { settleMs: 8000 }); } catch (error) { errors.push(error); } }
  try { fx?.cleanup(); } catch (error) { errors.push(error); }
  restoreEnvironment();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (!PROBED_BEFORE) quietly(() => rmdirSync(PROBED));
  if (errors.length) throw errors[0];
});
function readdirSafe(dir) { try { return readdirSync(dir); } catch { return []; } }
function quietly(act) { try { return act(); } catch { return undefined; } }

// ---- a terminal and a TUI in it --------------------------------------------------------------------
const PROMPT = "tui-acts$";
let opened = 0, started = 0;

/** Wait for a condition, within the file's budget; a timeout says what the pane shows. */
async function until(term, predicate, what, ms = 20000) {
  const left = Math.max(0, FILE_DEADLINE - Date.now());
  try { await waitUntil(predicate, what, Math.min(ms, left)); } catch (error) {
    if (!/^timed out waiting for /.test(error?.message ?? "")) throw error;
    assert.fail(`${error.message}${left === 0 ? ` (the file's budget of ${BUDGET_MS / 1000}s was spent)` : ""}; ${term.id} shows:\n${term.shows()}`);
  }
}

/** A terminal of 100x30: a session of the private server whose pane runs an interactive bash in
 *  the fixture's environment. Removed after the test. */
async function terminal(t) {
  const id = `t${++opened}`;
  const shell = `sh ${shq(world.enter)} env LC_ALL=C.UTF-8 LANG=C.UTF-8 HISTFILE=/dev/null PS1=${shq(`${PROMPT} `)} bash --norc --noprofile -i`;
  const [pane, session] = tmuxOn("new-session", "-d", "-P", "-F", "#{pane_id} #{session_id}", "-s", id, "-x", "100", "-y", "30", "-c", base, shell).split(" ");
  const term = {
    id, pane, session,
    /** The screen: one string per row, as `capture-pane` prints them (no trailing spaces). */
    screen() { return tmuxRaw("capture-pane", "-p", "-t", pane).split("\n").slice(0, -1); },
    /** The screen with wrapped rows joined (`-J` keeps a row's trailing spaces: trimmed here). */
    joined() { return tmuxRaw("capture-pane", "-p", "-J", "-t", pane).split("\n").map((row) => row.trimEnd()).filter(Boolean); },
    shows() { try { return term.screen().map((row) => `  |${row}`).join("\n"); } catch (error) { return `  (no pane: ${error.message})`; } },
    has(text) { try { return term.joined().some((row) => row.includes(text)); } catch { return false; } },
    press(...keys) { tmuxOn("send-keys", "-t", pane, ...keys); },
    atPrompt() { return term.screen().filter(Boolean).at(-1) === PROMPT; },
    async prompt(why) { await until(term, () => term.atPrompt(), `the shell's prompt in ${id}, ${why}`); },
    async command(text, why) { await term.prompt(`before ${why}`); tmuxOn("send-keys", "-l", "-t", pane, text); term.press("Enter"); },
    kill() { quietly(() => tmuxOn("kill-session", "-t", session)); },
  };
  t.after(term.kill);
  await term.prompt("when its shell has started");
  return term;
}

/** `oats tui --dir <the deployment>`: the real CLI, or (`shadow`) the copied TUI over the fake
 *  kernel; through a wrapper that writes its pid and then becomes it. `stderr: "closed"` starts it
 *  with standard error closed. Each run has a temp dir of its own, so the run's private directory
 *  can be looked for. Resolves once the list is drawn. */
async function tui(term, { shadow = false, stderr = "pane" } = {}) {
  const n = ++started;
  const pidFile = join(base, `tui-${n}.pid`), statusFile = join(base, `tui-${n}.status`), tmp = join(base, `tmp-${n}`);
  mkdirSync(tmp);
  const program = shadow ? `${shq(process.execPath)} ${shq(join(SHADOW, "packages", "tui", "bin", "tui.mjs"))}` : `${shq(process.execPath)} ${shq(CLI)} tui`;
  const line = `echo $$ > ${shq(pidFile)}; exec env TMPDIR=${shq(tmp)} ${program} --dir ${shq(fx.dep)}${stderr === "closed" ? " 2>&-" : ""}`;
  await term.command(`sh -c ${shq(line)}; echo $? > ${shq(statusFile)}`, "the oats tui command");
  const run = {
    n, tmp, statusFile,
    status() { const text = existsSync(statusFile) ? readFileSync(statusFile, "utf8") : ""; return /^\d+\n$/.test(text) ? Number(text) : null; },
    /** The status the run ended with: the one read that showed it (a second read could meet the
     *  file being written again by a later `echo $? >`). */
    async ended(why) { let status = null; await until(term, () => (status = run.status()) !== null, `oats tui in ${term.id} to end ${why}`); return status; },
    /** A frame is on the screen: the title names the fixture's workspace, and the cheat sheet
     *  offers `q quit`. */
    drawn() { const screen = term.screen(); return /^ {2}fixture(?: |│|$)/.test(screen[0] ?? "") && screen.some((row) => QUIT_ROW.test(row)); },
    /** The list of instances is on the screen: drawn, with the list's cheat sheet (`n spawn`)
     *  and no confirmation's buttons. A confirmation draws no such sheet, so a row's absence means
     *  nothing then. */
    listed() { return run.drawn() && term.screen().some((row) => SPAWN_ROW.test(row)) && run.buttons() === ""; },
    /** The list's row of `name`, drawn as words: `{ selected, mark }`, or null when it is not listed. */
    row(name) {
      const text = term.screen().map((row) => [...row].slice(0, 48).join("")).find((row) => new RegExp(`^[> ] +[●○◌?◆] ${instanceDisplayName(name)}\\b`).test(row));
      return text ? { selected: text.startsWith(">"), mark: /^[> ] +(\S)/.exec(text)[1], text } : null;
    },
    /** The place of the selected row among the list's rows of instances, top to bottom (0 the first),
     *  or -1 while none is drawn selected. A place, not a row's words: a read again can redraw the
     *  words beside a name (`Stopping…`, `state unknown`) without any move. */
    selectedAt() {
      return term.screen().map((row) => row.split("│")[0]).filter((row) => /^[> ] +[●○◌?◆] \S/.test(row)).findIndex((row) => row.startsWith(">"));
    },
    /** The confirmation's buttons row, as drawn in the main area: `> Label <` has the focus. */
    buttons() { return term.screen().map(mainOf).find((row) => /^ {2}(> .* <|\[ .* \])/.test(row)) ?? ""; },
    focused() { return /> (.*?) </.exec(run.buttons())?.[1] ?? null; },
    /** `g`, then `j` until `name` is selected, each key once the move of the one before is drawn:
     *  a key decided on a frame from before the last move moves once too often, and the list does
     *  not wrap (a run that saw Gamma selected waiting for Beta). */
    async select(name) {
      await until(term, () => run.row(name) !== null, `${name} listed`);
      if (!run.row(name)?.selected) {
        term.press("g");
        await until(term, () => run.drawn() && run.selectedAt() === 0, `the list's first row selected after g, on the way to ${name}`);
      }
      for (let i = 0; i < 10 && !run.row(name)?.selected; i++) {
        let was = -1;
        await until(term, () => (was = run.selectedAt()) >= 0, `a row selected, on the way to ${name}`);
        term.press("j");
        await until(term, () => run.drawn() && run.selectedAt() > was, `the selection moved down from row ${was + 1}, on the way to ${name}`);
      }
      await until(term, () => run.row(name)?.selected === true, `${name} selected`);
    },
    /** Esc closes the confirmation; resolves once the list is drawn again. The next key then
     *  arrives on its own, never inside the key parser's wait after an ESC (where ESC and a
     *  letter read as one Alt+letter). */
    async close(why) {
      term.press("Escape");
      await until(term, () => run.listed(), `the list again after Esc, ${why}`);
    },
    /** Open the act with `key` and press its button: a move with Tab (seen drawn), then Enter. */
    async act(key, label, why) {
      term.press(key);
      await until(term, () => run.buttons().includes(`[ ${label} ]`) && run.focused() === "Cancel", `the confirmation of ${label}, the focus on Cancel, ${why}`, 60000);
      for (let i = 0; i < 3 && run.focused() !== label; i++) {
        const was = run.focused();
        term.press("Tab");
        await until(term, () => run.focused() !== was, `the focus moved from ${was}, ${why}`);
      }
      assert.equal(run.focused(), label, `the focus on ${label} ${why}`);
      term.press("Enter");
    },
  };
  await until(term, () => run.drawn() && run.row("alpha") !== null, "the list, drawn, with alpha", 60000);
  run.pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(run.pid) && run.pid > 1, `the wrapper wrote the pid (${run.pid})`);
  return run;
}

/** The files of one round of the fake's stop apply. */
function round(name, mode) {
  writeFileSync(join(CONTROL, "round"), name);
  writeFileSync(join(CONTROL, "mode"), mode);
  const at = (what) => join(CONTROL, `${name}.${what}`);
  return {
    pid: () => (existsSync(at("pid")) ? Number(readFileSync(at("pid"), "utf8")) : null),
    signals: () => (existsSync(at("signals")) ? readFileSync(at("signals"), "utf8").split("\n").filter(Boolean) : []),
    open: () => writeFileSync(at("gate"), ""),
    done: () => existsSync(at("done")),
    status: () => (existsSync(at("status")) ? Number(readFileSync(at("status"), "utf8")) : null),
  };
}
const leaving = (name) => `oats: the stop of ${name} is still running; \`oats status\` shows its result.`;
/** What is left of a run's private directory under its temp dir. */
const privateDirs = (run) => readdirSafe(run.tmp).filter((name) => name.startsWith("oats-tui-"));

// ---- 1: a change survives every way out, and writes after the TUI has gone ------------------------
const WAYS_OUT = [
  { id: "q", status: 0, out: (term) => term.press("q") },
  { id: "SIGINT to its process group", status: 130, out: (_term, run) => process.kill(-run.pid, "SIGINT") },
  { id: "SIGTERM", status: 143, out: (_term, run) => process.kill(run.pid, "SIGTERM") },
  { id: "SIGHUP", status: 129, out: (_term, run) => process.kill(run.pid, "SIGHUP") },
  { id: "Ctrl+Z, fg, then q", status: 0, suspend: true },
];

for (const way of WAYS_OUT) {
  test(`1. a stop apply in flight survives ${way.id}: it is never signalled, the leaving line names it, and after the TUI has gone it writes to stdout and stderr and then its marker`, { skip: NO_TMUX }, async (t) => {
    const r = round(`one-${WAYS_OUT.indexOf(way)}`, "fake");
    t.after(() => { quietly(r.open); });
    const term = await terminal(t);
    const run = await tui(term, { shadow: true });
    await run.select("alpha");
    await run.act("X", "Stop", "of alpha");
    await until(term, () => r.pid() !== null && run.focused() === "Close (the stop goes on)", "the apply under way, and the view offering Close (the stop goes on)", 60000);
    const pid = r.pid();
    if (way.suspend) {
      term.press("C-z");
      await term.prompt("after Ctrl+Z");
      // bash runs the rest of the line when a job stops: the run's own `echo $?` has written
      // 128 + SIGTSTP (148 on Linux, 146 on macOS). Take it away, so the status read below is
      // fg's, never this one.
      assert.equal(run.status(), 128 + constants.signals.SIGTSTP, `the TUI stopped as a job on Ctrl+Z\n${term.shows()}`);
      rmSync(run.statusFile);
      assert.equal(alive(pid), true, "the change runs on while the TUI is stopped");
      await term.command("fg", "fg");
      await until(term, () => run.drawn(), "the TUI again after fg");
      term.press("q");
      await term.command(`echo $? > ${shq(run.statusFile)}`, "the status of fg");
    } else way.out(term, run);
    assert.equal(await run.ended(`after ${way.id}`), way.status, term.shows());
    await until(term, () => term.has(leaving("alpha")), "the leaving line on the terminal");
    assert.equal(alive(pid), true, `the change outlives the TUI after ${way.id}`);
    assert.deepEqual(privateDirs(run), [], "the run's private directory is gone: the change's files were unlinked");
    r.open();
    await until(term, () => r.done(), "the fake's completion marker, written after its writes to stdout and stderr", 30000);
    await until(term, () => !alive(pid), "the change to end on its own");
    assert.deepEqual(r.signals(), [], `no signal reached the change (${way.id})`);
  });
}

// ---- 2: a real stop survives its terminal, and prints its envelope after it --------------------------
test("2. a stop apply survives its pane being killed: the real kernel's apply runs after the kill and prints its envelope, leaves no .oats-stop-pending.json, and the next stop apply is accepted", { skip: NO_TMUX }, async (t) => {
  const r = round("two", "real");
  t.after(() => { quietly(r.open); });
  const term = await terminal(t);
  const run = await tui(term, { shadow: true });
  await run.select("beta");
  await run.act("X", "Stop", "of beta");
  await until(term, () => r.pid() !== null, "the apply under way", 60000);
  const pid = r.pid();
  term.kill(); // the terminal closes: SIGHUP to the TUI, and its pty gone
  await waitUntil(() => !alive(run.pid), "the TUI to be gone with its terminal", 20000);
  assert.equal(alive(pid), true, "the change outlives its terminal");
  r.open(); // only now does the real kernel run the apply, and print its envelope to the change's file
  await waitUntil(() => r.done(), "the real apply to finish", 60000);
  assert.equal(r.status(), 0, "the real kernel's stop apply answered ok");
  assert.deepEqual(r.signals(), [], "no signal reached the change");
  assert.equal(existsSync(join(world.homes.beta, ".oats-stop-pending.json")), false, "no stop marker left in the home");
  const plan = fx.cli(["instance", "stop", "beta", "--plan", "--json"]);
  assert.equal(plan.status, 0, plan.stdout);
  const revision = plan.json().result.planRevision;
  const next = fx.cli(["instance", "stop", "beta", "--apply", "--plan-revision", revision, "--idempotency-key", "after-the-kill", "--json"]);
  assert.equal(next.status, 0, `the next stop apply is accepted\n${next.stdout}\n${next.stderr}`);
  assert.equal(next.json().ok, true);
});

// ---- 3: end to end, the real TUI and the real kernel ----------------------------------------------
test("3. a real restart, stop, start and retire of a throwaway agent from the TUI: each answers in the view, and the list is read again after each", { skip: NO_TMUX }, async (t) => {
  const term = await terminal(t);
  const run = await tui(term);
  await run.select("gamma");
  await until(term, () => run.row("gamma")?.mark === "●", "gamma running");

  await run.act("R", "Restart", "of gamma");
  await until(term, () => term.has("gamma restarted."), "the restart's answer", 90000);
  await run.close("after the restart");
  await until(term, () => run.row("gamma")?.mark === "●", "gamma running after the restart");

  await run.act("X", "Stop", "of gamma");
  await until(term, () => run.focused() === "Close" && !run.buttons().includes("[ Stop ]"), "the stop settled", 90000);
  await run.close("after the stop");
  // Stopped: the harness ended and the launcher's shell stays in the pane (◌), or the pane is gone (○).
  await until(term, () => ["◌", "○"].includes(run.row("gamma")?.mark), "gamma stopped, read again after the stop", 30000);

  await run.act("S", "Start", "of gamma");
  await until(term, () => term.has("gamma started."), "the start's answer", 90000);
  await run.close("after the start");
  await until(term, () => run.row("gamma")?.mark === "●", "gamma running after the start", 30000);

  await run.act("D", "Retire", "of gamma");
  await until(term, () => run.focused() === "Close" && !run.buttons().includes("[ Retire ]"), "the retire settled", 90000);
  await run.close("after the retire");
  await until(term, () => run.listed() && run.row("gamma") === null, "gamma gone from the list after the retire", 30000);
  assert.equal(existsSync(world.homes.gamma), false, "its home is gone");

  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
  assert.deepEqual(privateDirs(run), [], "no private directory left");
});

// ---- 4: standard error closed ----------------------------------------------------------------------
test("4. with standard error closed at the start, a change in flight at q writes no leaving line, and the status is 0", { skip: NO_TMUX }, async (t) => {
  const r = round("four", "fake");
  t.after(() => { quietly(r.open); });
  const term = await terminal(t);
  const run = await tui(term, { shadow: true, stderr: "closed" });
  await run.select("alpha");
  await run.act("X", "Stop", "of alpha");
  await until(term, () => r.pid() !== null, "the apply under way", 60000);
  const pid = r.pid();
  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
  await term.prompt("after q");
  assert.equal(term.has("is still running"), false, `no leaving line:\n${term.shows()}`);
  assert.equal(alive(pid), true, "the change outlives the TUI");
  r.open();
  await until(term, () => r.done(), "the fake's completion marker", 30000);
  await until(term, () => !alive(pid), "the change to end on its own");
  assert.deepEqual(r.signals(), []);
});

// ---- 5: a spawn from the TUI, end to end ----------------------------------------------------------
test("5. a spawn from the TUI with the real kernel: a pasted n, a soul's name and two Enters spawn nothing; n, the name, Enter and Enter spawn one, and its terminal opens with the focus", { skip: NO_TMUX }, async (t) => {
  const term = await terminal(t);
  const run = await tui(term);
  const scribes = () => (JSON.parse(fx.cli(["status", "--json"]).stdout).agents.find((agent) => agent.name === "scribe")?.instances ?? []).map((row) => row.instance);
  assert.deepEqual(scribes(), [], "premise: no scribe yet");
  const prompt = () => term.has("Spawn: pick a soul") || term.has("Spawn scribe");
  // One write, so one read of input: the Enters come in the read that opened the prompt, or before
  // its preview was read. Either way nothing is spawned.
  tmuxOn("send-keys", "-l", "-t", term.pane, "nscribe\r\r");
  await until(term, prompt, "the prompt, after the paste", 60000);
  // The picker as the paste left it: once the souls are read (its row, under the query's line,
  // which says `> scribe` from the paste on), Enter picks scribe, in a read of its own.
  if (term.has("Spawn: pick a soul")) {
    await until(term, () => term.screen().map(mainOf).filter((line) => /^>\s+scribe\b/.test(line)).length === 2, "scribe's row in the picker", 60000);
    term.press("Enter");
  }
  // The preview read: its facts drawn, and no read under way.
  await until(term, () => term.has("Spawn scribe") && term.has("Harness") && !term.has("Reading the preview"), "scribe's preview", 90000);
  assert.equal(term.has("Spawning"), false, `the paste spawned nothing:\n${term.shows()}`);
  term.press("Enter");
  await until(term, () => term.screen().some((row) => BACK_ROW.test(row)), "the new agent's terminal, with the focus: the cheat sheet says the leader then Esc gives the list the focus", 180000);
  const made = scribes();
  assert.equal(made.length, 1, `one scribe: ${made.join(", ")}`);
  assert.equal(run.row(made[0])?.selected, true, "its row is selected");
  // The leader then Esc gives the focus back to the list; q there quits.
  term.press(LEADER_KEY); term.press("Escape");
  await until(term, () => run.listed(), "the list again, after the leader then Esc");
  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
  assert.deepEqual(scribes(), made, "and no second spawn on the way out");
});

// ---- last: nothing of the operator's tmux was touched ---------------------------------------------
test("afterwards the default tmux server's sessions are what they were before this file ran", { skip: NO_TMUX }, () => {
  assert.deepEqual(defaultSessions(), DEFAULT_BEFORE);
});
