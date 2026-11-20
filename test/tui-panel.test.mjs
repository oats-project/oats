// `oats tui` opens an agent's terminal in a panel beside the list: Enter on a running instance
// starts the kernel's own viewer, `oats session attach --home <home>` with no key of its own, in a
// pane of a private tmux server the run owns, and the TUI draws that pane's screen where the detail
// was (docs/tui.md, "Open an agent's terminal"). Typing goes to the agent; the leader (by default
// Ctrl+X) then Esc gives the focus to the list, z zooms, c closes.
//
// Real tmux throughout, never the operator's (the conventions of test/tui-terminal.test.mjs): the
// fixture owns a private TMUX_TMPDIR, and every server here is a socket inside the fixture. AGENTS
// is the server the homes record: the agent's window runs a small program that shows every byte it
// reads. TERM plays the user's terminal: its pane runs an interactive shell, the real `oats tui` is
// typed there through the checkout's CLI with TMPDIR a short directory of the fixture's, so the
// run's private directory, and the socket of its private server in it, are inside the fixture too
// (the fixture's tmux refuses any other socket, and a socket path has a short limit). A signal goes
// only to the pid the command's own wrapper wrote down. Every wait is on what a pane shows or on a
// file, within the file's budget. The panel's tabs (up to four viewers, up to two of them displayed
// at once, each in its own window at its own size, one of them shown) are proved on the panel
// itself over the same real tmux, and every way out with four tabs open and two displayed under the
// TUI's own guard (the tests after "the tabs" below); q and kill -9 with four agents' terminals open
// as tabs of the real `oats tui` close the file ("four agents, four tabs").
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { assertNoFixtureProcesses, fixtureBase, isolateSessionEnvironment, systemExecutable, waitUntil } from "./helpers/host-fixture.mjs";
import { leaderPairs } from "./helpers/leader-pairs.mjs";
import { markStopped, v2Deployment } from "./helpers/v2-deployment.mjs";
import { backKeyLabel } from "../packages/tui/lib/actions.mjs";
import { defaultDetachKey } from "../packages/tui/lib/config.mjs";
import { instanceDisplayName } from "../packages/client/instance-display-name.mjs";
import { STATUS_WAIT_MS, createPanel } from "../packages/tui/lib/panel.mjs";
import { tmuxForwardsBoundKey } from "../lib/session-viewer.mjs";
import { captureRows } from "../packages/tui/lib/term/capture.mjs";
import { ESC_TIMEOUT_MS } from "../packages/tui/lib/term/keys.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const hostTool = (name) => { try { return systemExecutable(name); } catch { return null; } };

// The host's own tools, found before the environment is isolated (PATH is then the fixture's).
const REAL_TMUX = hostTool("tmux");
/** Whether this tmux's viewer takes C-b [ (3.3 and later, lib/session-viewer.mjs tmuxForwardsBoundKey),
 *  as the kernel the TUI runs answers in its version --json `sessionViewer`: the fixture's PATH
 *  links this tmux. */
const FORWARDS = REAL_TMUX ? tmuxForwardsBoundKey(execFileSync(REAL_TMUX, ["-V"], { encoding: "utf8", timeout: 10000 })) : false;
/** The panel makes its keeper's FIFO with the base system's `mkfifo` (packages/tui/lib/panel.mjs,
 *  THE KEEPER), which the fixture's PATH does not link: the host's is linked there for this file. */
const HOST_MKFIFO = hostTool("mkfifo");
/** Outside CI a host without tmux skips these tests; in CI test/tmux-in-ci.test.mjs fails. */
const NO_TMUX = REAL_TMUX ? false : "tmux is not on PATH: these tests drive `oats tui`, its private tmux server and the kernel's viewer in a real tmux (test/tmux-in-ci.test.mjs fails for this in CI)";
const base = fixtureBase("oats-tp-"); // short: the sockets of three servers live in it
/** Set by the setup (test.before below); test.after undoes what of it was done. */
let restoreEnvironment = () => {}, fx = null;
const AGENTS = join(base, "agents.sock");
const TERM = join(base, "term.sock");
const SESSION = "team";
const NAME = "alpha";

/** Every test starts the real CLI, which reads the fixture with the real kernel before it draws,
 *  and every open starts the real kernel's viewer: on a loaded host each takes seconds. Once the
 *  budget is spent every further wait fails at once, so a program that hangs cannot hold a shard. */
const BUDGET_MS = 240000;
const FILE_DEADLINE = Date.now() + BUDGET_MS;

const tmuxRaw = (socket, ...args) => execFileSync("tmux", ["-u", "-S", socket, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
const tmuxOn = (socket, ...args) => tmuxRaw(socket, ...args).trim();
const lines = (text) => text.split("\n").filter(Boolean);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
/** Past the key parser's wait after a lone ESC (term/keys.mjs ESC_TIMEOUT_MS), with room to spare: a
 *  key pressed after it is a key of its own, never Alt with it. */
const ESC_WAIT_MS = ESC_TIMEOUT_MS * 4;

// ---- the agents' server ------------------------------------------------------------------------
const sessionsOf = (socket) => { try { return lines(tmuxOn(socket, "list-sessions", "-F", "#{session_name}")); } catch { return []; } };
const viewerSessions = () => sessionsOf(AGENTS).filter((s) => s.startsWith("oatsview-"));
/** The sessions that have a client attached, one entry per client. */
const attached = () => { try { return lines(tmuxOn(AGENTS, "list-clients", "-F", "#{session_name}")); } catch { return []; } };
/** Every key table of a server, from the UNFILTERED list: `list-keys -T <table>` prints nothing for
 *  a table that holds exactly one binding. */
const keyTableNames = (socket) => [...new Set(lines(tmuxOn(socket, "list-keys")).map((line) => /^bind-key\s+(?:-r\s+)?-T\s+(\S+)/.exec(line)?.[1]).filter(Boolean))].sort();
/** The tables viewers made: every viewer's own, named as its session, and its C-b table,
 *  `<session>-prefix` (lib/session-viewer.mjs PREFIX_TABLE_SUFFIX), removed with it (#1502 part D). */
const viewerTables = () => keyTableNames(AGENTS).filter((name) => name.startsWith("oatsview-"));
/** What is wrong with the agents' server's viewer tables after a viewer closed: any table a viewer
 *  made is left. No viewer shares a table, so a closed one leaves none. */
function viewerTableFaults() {
  const left = viewerTables();
  return left.length ? [`a viewer's key table is left: ${JSON.stringify(left)}`] : [];
}
/** After a test, whatever it left on the agents' server: a failed test must not fail the ones after it. */
function sweepAgents() {
  for (const session of viewerSessions()) { try { tmuxOn(AGENTS, "kill-session", "-t", `=${session}`); } catch { /* gone */ } }
  for (const table of viewerTables()) { try { tmuxOn(AGENTS, "unbind-key", "-a", "-q", "-T", table); } catch { /* gone */ } }
}

// ---- a run's private directory and server (packages/tui/lib/panel.mjs) ---------------------------
/** The run directories `oats-tui-*` in a TMPDIR the TUI was given. */
const runDirs = (tmp) => (existsSync(tmp) ? readdirSync(tmp).filter((name) => name.startsWith("oats-tui-")).sort().map((name) => join(tmp, name)) : []);
const panelSocket = (dir) => join(dir, "tmux");
/** Whether a server answers on a socket. */
const answers = (socket) => { try { tmuxOn(socket, "list-sessions"); return true; } catch { return false; } };
/** The windows of the panel's one session: its keeper, and one per viewer. */
const panelWindows = (socket) => { try { return lines(tmuxOn(socket, "list-windows", "-t", "=oats-tui", "-F", "#{window_id}")); } catch { return []; } };
/** The command line of each pane's own process (`#{pane_pid}`) in the panel's session, as ps says. */
const paneProcesses = (socket) => lines(tmuxOn(socket, "list-panes", "-s", "-t", "=oats-tui", "-F", "#{pane_pid}"))
  .map((pid) => { try { return execFileSync("ps", ["-o", "args=", "-p", pid], { encoding: "utf8", timeout: 10000 }).trim(); } catch { return `(no process ${pid})`; } });
/** After a test, every private server a run left (a failed test's): killed by its socket. */
function sweepPanels() {
  for (const tmp of tmps) for (const dir of runDirs(tmp)) if (existsSync(panelSocket(dir))) { try { tmuxOn(panelSocket(dir), "kill-server"); } catch { /* gone */ } }
}

// What runs in the agent's pane: it fills some history, puts the terminal in raw mode and shows
// every byte it reads, control bytes in caret notation (C-\ is `^\`). A key that reaches the agent
// is on its screen.
const paneProgram = join(base, "agent-pane.mjs");
const world = {};
/** TERM as the setup left it, before any test (termServer below). */
let TERM_BEFORE = null;
/** Every TMPDIR a run was given. */
const tmps = [];
// The setup runs in a hook: when a step of it fails, test.after still ends what the steps before it
// made. A file that fails while it loads runs no hook at all.
test.before(async () => {
  if (!REAL_TMUX) return;
  restoreEnvironment = isolateSessionEnvironment(base);
  assert.ok(HOST_MKFIFO, "mkfifo is on the host's PATH");
  symlinkSync(HOST_MKFIFO, join(process.env.PATH.split(delimiter)[0], "mkfifo"));
  fx = v2Deployment();
  writeFileSync(paneProgram, `for (let i = 0; i < 50; i++) console.log("history " + i);
process.stdin.setRawMode(true);
// F starts a flood: the agent prints without pause, as a busy agent does, until its window goes.
process.stdin.on("data", (data) => {
  if (data.includes(70)) setInterval(() => process.stdout.write("flood ".repeat(12) + "\\n"), 1);
  process.stdout.write([...data].map((b) => (b < 32 ? "^" + String.fromCharCode(b + 64) : b === 127 ? "^?" : String.fromCharCode(b))).join(""));
});
process.stdout.write("pane-ready:");
`);
  tmuxOn(AGENTS, "new-session", "-d", "-s", SESSION, "-n", "hq", "-x", "100", "-y", "30", "-c", base, "cat");
  // One session that only keeps the terminals' server: every test makes, and removes, its own.
  tmuxOn(TERM, "new-session", "-d", "-s", "hold", "-n", "hold", "-x", "80", "-y", "24", "-c", base, "cat");
  tmuxOn(TERM, "set-option", "-g", "default-terminal", "screen");

  // The one instance: a real workspace-model home recorded as launched in the window `alpha` of
  // AGENTS (launchedAgent).
  world.home = await launchedAgent(NAME);
  // A terminal's shell is started through this: the fixture's environment, then its arguments.
  world.enter = join(fx.base, "enter.sh");
  writeFileSync(world.enter, `#!/bin/sh\n${Object.entries(fx.env).map(([name, value]) => `export ${name}=${shq(value)}`).join("\n")}\nexec "$@"\n`);
  TERM_BEFORE = termServer();
});
/** A real workspace-model home spawned as `name`, recorded as launched in the window `name` of
 *  AGENTS, receipt included. The kernel then reads it as running while that window is there, and
 *  its viewer attaches to that window. Resolves with the home. */
async function launchedAgent(name) {
  const saved = process.env.PATH;
  process.env.PATH = fx.env.PATH;
  let home;
  try { home = (await fx.spawn("dev", { name, harness: "claude" })).home; } finally { process.env.PATH = saved; }
  const baselineOf = (h) => join(dirname(h), ".oats-retirement", "baselines", `${createHash("sha256").update(h).digest("hex")}.json`);
  const { launch: _recipe, ...spawned } = readJson(join(home, "instance.json"));
  const tmux = { session: SESSION, window: name, socket: AGENTS };
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...spawned, tmux, command: "true", launched: true }, null, 2) + "\n");
  writeFileSync(baselineOf(home), JSON.stringify({ ...readJson(baselineOf(home)), runtime: { launched: true, tmux } }, null, 2) + "\n", { mode: 0o600 });
  // A window a test kills is a lost session to the kernel, which the TUI's machine sweep would take up
  // and say something of: these tests are not about resuming, so the home reads stopped once its window goes.
  markStopped(home);
  return home;
}
// The agent is alpha unless a name is given (the agents beside it: "four agents, four tabs" below).
const agentTarget = (name = NAME) => `=${SESSION}:=${name}`;
const AGENT_TARGET = agentTarget();
/** What the agent's pane has read since it started, as it shows it; null before it reads, or with
 *  no window. */
function typed(name = NAME) {
  let screen;
  try { screen = tmuxOn(AGENTS, "capture-pane", "-p", "-J", "-t", agentTarget(name)).replace(/\n/g, ""); } catch { return null; }
  const at = screen.lastIndexOf("pane-ready:");
  return at < 0 ? null : screen.slice(at + "pane-ready:".length).trimEnd();
}
const agentWindowThere = (name = NAME) => { try { tmuxOn(AGENTS, "display-message", "-p", "-t", agentTarget(name), "#{window_id}"); return true; } catch { return false; } };
/** The agent's window, new: its screen holds the history and nothing it read. */
async function agentWindow(name = NAME) {
  try { tmuxOn(AGENTS, "kill-window", "-t", agentTarget(name)); } catch { /* not there */ }
  tmuxOn(AGENTS, "new-window", "-d", "-t", `=${SESSION}:`, "-n", name, "-c", base, `${shq(process.execPath)} ${shq(paneProgram)}`);
  await waitUntil(() => typed(name) !== null, `the pane of ${name} reads its terminal`, Math.min(10000, Math.max(1, FILE_DEADLINE - Date.now())));
}
const killAgentWindow = (name = NAME) => tmuxOn(AGENTS, "kill-window", "-t", agentTarget(name));

/** The terminals' server as a person's own tmux would notice a change in it: its sessions and
 *  windows, its key bindings and its options. */
function termServer() {
  return {
    windows: lines(tmuxOn(TERM, "list-windows", "-a", "-F", "#{session_name}:#{window_index}:#{window_name}")).sort(),
    keys: tmuxOn(TERM, "list-keys"),
    global: tmuxOn(TERM, "show-options", "-g"), server: tmuxOn(TERM, "show-options", "-s"), windowGlobal: tmuxOn(TERM, "show-options", "-gw"),
    window: tmuxOn(TERM, "show-options", "-w", "-t", "=hold:"),
  };
}

test.after(() => {
  if (REAL_TMUX) {
    try { sweepPanels(); } catch { /* nothing left */ }
    for (const socket of [TERM, AGENTS]) { try { execFileSync(REAL_TMUX, ["-S", socket, "kill-server"], { stdio: "ignore", timeout: 10000 }); } catch { /* not running */ } }
  }
  const errors = [];
  // Every TUI, private server, viewer and agent of this file ran in `base`: none is left.
  if (REAL_TMUX) { try { assertNoFixtureProcesses(base, { settleMs: 6000 }); } catch (error) { errors.push(error); } }
  try { fx?.cleanup(); } catch (error) { errors.push(error); }
  restoreEnvironment();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (errors.length) throw errors[0];
});

// ---- what the program says, as docs/tui.md and packages/tui/lib give it --------------------------
const TUI = `${shq(process.execPath)} ${shq(CLI)} tui`;
const PROMPT = "tui-panel$";
/** The leader: the default (C-x, Ctrl+X, on every platform), as tmux's
 *  send-keys names it too, and as the cheat sheet and the help spell it. */
const LEADER_KEY = defaultDetachKey(), LEADER = backKeyLabel(LEADER_KEY);
// The cheat sheet (docs/tui.md, "The cheat sheet") as run.sheet() reads it: its rows, each a key
// and what it does, one space between them and three between two rows.
/** The leader and the palette, which the sheet names first in every focus of the list. */
const LEAD = `${LEADER} commands   Ctrl+K palette   `;
const OPEN_HINT = `${LEAD}Enter open   `;
/** The viewer's scroll key after the leader's (docs/tui.md, "Tabs"): the short form beside the
 *  terminal, the 30 cells of the sidebar holding one key. */
const SCROLL = FORWARDS ? "Ctrl+B [ scroll back" : "Shift+PageUp scroll back";
/** The same in a zoomed terminal's title row, 120 columns wide: both keys fit beside the tab. */
const ZOOMED_SCROLL = FORWARDS ? "Shift+PageUp or Ctrl+B [ scroll back" : "Shift+PageUp scroll back";
/** A zoomed terminal's title row ends with the leader's keys and, where it still has room, the scroll
 *  keys, the first given up: on Linux and Windows the Alt family's chords lead the row, and at these
 *  120 columns they leave the scroll keys no room; on macOS, with one tab, there are no chords to show. */
const ZOOMED_KEYS = `${LEADER} commands   ${LEADER} Esc the list${process.platform === "darwin" ? `   ${ZOOMED_SCROLL}` : ""}`;
/** The whole sheet while the terminal has the focus, with `tabs` tabs open: on Linux and Windows the
 *  Alt family's chords first, as every one is read in any terminal, the protocol or not (docs/tui.md,
 *  "Chords"): the palette, the instance before or after, the tab before or after with two tabs or
 *  more, close and zoom; then the leader, the leader then Esc (the list's focus), the leader
 *  twice (the leader typed into the terminal) and the viewer's scroll key. On macOS the TUI's chords are the Alt arrows alone,
 *  so the sheet names the tab before or after, with two tabs or more. */
const backWith = (tabs) => [...(process.platform === "darwin" ? (tabs > 1 ? ["Alt+Left/Right tab"] : []) : ["Alt+K palette", "Alt+Shift+Up/Down agent", ...(tabs > 1 ? ["Alt+Left/Right tab"] : []), "Alt+W close", "Alt+Z zoom"]),
  `${LEADER} commands   ${LEADER} Esc the list   ${LEADER} ${LEADER} types ${LEADER}   ${SCROLL}`].join("   ");
const BACK = backWith(1);
/** Whether the tabs carry their numbers: not on macOS, where no chord reaches them (docs/tui.md, "Tabs"). */
const NUMBERED = process.platform !== "darwin";
/** The shown tab of agent `name` alone, as its bar draws it. */
const oneTab = (name) => `[${name}${NUMBERED ? " 1" : ""}]`;
/** The whole sheet while the list has the focus beside the open terminal: Enter goes to it; the
 *  terminal's own keys (zoom, close, the tabs) are the leader's and the help's, not the sheet's. */
const LIST_HINTS = `${LEAD}Enter focus terminal   n spawn   w workspaces   ? help   q quit`;
const FAILED = `${NAME} could not be opened.`;
/** The agent's row in the list, selected and running: the green mark and its name, and nothing
 *  after it (the harness is the detail's). */
/** The list draws a row's name as words (packages/client/instance-display-name.mjs): "Alpha". */
const RUNNING_ROW = new RegExp(`^> +● ${instanceDisplayName(NAME)}$`);
const ROW = new RegExp(`^[> ] +[●○◌?◆] ${instanceDisplayName(NAME)}\\b`);
/** The columns the sidebar keeps beside an open terminal (docs/tui.md); the panel starts after the
 *  sidebar and its rule, from the first row. The agent's row is read from as many columns of the
 *  list: its name is short, and the row has no word, so it is whole there with the detail beside
 *  the list too. */
const LIST_BESIDE = 30;
const COLS = 120, ROWS = 40;
const PANEL_COL = LIST_BESIDE + 1;
/** The sidebar's columns with no terminal open, the detail beside them (docs/tui.md). */
const LIST_COLS = Math.min(60, Math.max(36, Math.floor(COLS * 0.48)));

// ---- a terminal ---------------------------------------------------------------------------------
let opened = 0, started = 0;

/** Wait for what a terminal shows (or for a file), within the file's budget. A timeout says what
 *  was waited for, what is missing and what the pane shows instead, then what the last run's
 *  private server holds now (panelState). */
async function until(term, predicate, what, faults = () => [], ms = 15000) {
  const left = Math.max(0, FILE_DEADLINE - Date.now());
  try { await waitUntil(predicate, what, Math.min(ms, left)); } catch (error) {
    if (!/^timed out waiting for /.test(error?.message ?? "")) throw error;
    const missing = faults();
    assert.fail(`${error.message}${left === 0 ? ` (this file's budget of ${BUDGET_MS / 1000}s was spent before the wait began)` : ""}${missing.length ? `: ${missing.join("; ")}` : ""}; ${term.id} shows:\n${term.shows()}${panelState(lastRun, lastWatch)}`);
  }
}

/** The leader, then a key in a later read, pressed until what the key does is seen (helpers/leader-pairs.mjs). */
const pairs = leaderPairs({ leaderKey: LEADER_KEY, pause, waitUntil, deadline: FILE_DEADLINE, until });

/** The run `until` reports on, the last one started, and the watch of its server, while one runs. */
let lastRun = null, lastWatch = null;
/** What a run's private server holds now: each pane, dead or not, with the status and signal tmux
 *  has for it, and the processes of the pane, under it and on its terminal, as ps says. With a
 *  watch of that server (watchPanel), what tmux reported meanwhile. */
function panelState(run, watch = null) {
  if (!run) return "";
  const out = [""];
  if (watch) out.push(`what the panel's server said of its panes, asked every ${WATCH_MS} ms, ms after the watch began:`, ...(watch.lines().length ? watch.lines().map((line) => `  | ${line}`) : ["  (nothing)"]));
  const dir = (() => { try { return run.dir(); } catch { return null; } })();
  if (!dir || !answers(panelSocket(dir))) return [...out, "the panel's server: none answers"].join("\n");
  out.push("the panel's server, its panes now:");
  let panes = [];
  try { panes = lines(tmuxOn(panelSocket(dir), "list-panes", "-a", "-F", "#{window_id} #{pane_id} dead=#{pane_dead} status=#{pane_dead_status} signal=#{pane_dead_signal} pid=#{pane_pid} tty=#{pane_tty}")); } catch (error) { out.push(`  (list-panes failed: ${String(error?.stderr || error?.message).trim()})`); }
  out.push(...panes.map((pane) => `  | ${pane}`));
  let table = [];
  try { table = lines(execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat=,etime=,tty=,args="], { encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 })); } catch { /* none */ }
  const pids = new Set(panes.map((pane) => /pid=(\d+)/.exec(pane)?.[1]).filter(Boolean));
  const ttys = new Set(panes.map((pane) => /tty=\/dev\/(\S+)/.exec(pane)?.[1]).filter(Boolean));
  const mine = table.filter((row) => { const [pid, ppid, , , tty] = row.trim().split(/\s+/); return pids.has(pid) || pids.has(ppid) || ttys.has(tty); });
  out.push("their processes (pid ppid stat etime tty args):", ...(mine.length ? mine.map((row) => `  | ${row.trim().slice(0, 200)}`) : ["  (none)"]));
  return out.join("\n");
}
/** What the host says of a process, for a test's diagnostics (awebai/oats#1277): ps of it, of its
 *  threads, and of every process that is its child or in its group or its session; its state, its
 *  threads and its signals from /proc, each thread's state and wait channel, and its open files.
 *  Lines, each read on its own: a process that has gone says so where it was read. */
function processState(pid) {
  const run = (args) => { try { return lines(execFileSync("ps", args, { encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 })); } catch (error) { return [`(ps ${args.join(" ")}: ${String(error?.stderr || error?.message).trim() || `exit ${error?.status}`})`]; } };
  const proc = (path) => { try { return readFileSync(`/proc/${pid}/${path}`, "utf8"); } catch (error) { return `(${error.code})`; } };
  const out = [...run(["-o", "pid,ppid,pgid,sid,stat,wchan:20,etime,args", "-p", String(pid)]), ...run(["-L", "-o", "pid,lwp,stat,wchan:30,comm", "-p", String(pid)])];
  const related = run(["-A", "-o", "pid=,ppid=,pgid=,sid=,stat=,wchan:20=,etime=,args="]).filter((row) => { const [own, ...ids] = row.trim().split(/\s+/); return own !== String(pid) && ids.slice(0, 3).includes(String(pid)); });
  out.push(`its children, group and session (pid ppid pgid sid stat wchan etime args): ${related.length ? "" : "none"}`, ...related.map((row) => `  ${row.trim().slice(0, 200)}`));
  out.push(`status: ${proc("status").split("\n").filter((line) => /^(State|Threads|SigQ|SigPnd|ShdPnd|SigBlk|SigIgn|SigCgt):/.test(line)).join("; ")}`);
  let tasks = [];
  try { tasks = readdirSync(`/proc/${pid}/task`); } catch (error) { tasks = []; out.push(`threads: (${error.code})`); }
  for (const task of tasks) { const stat = proc(`task/${task}/stat`); out.push(`thread ${task} ${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]} ${proc(`task/${task}/comm`).trim()} wchan=${proc(`task/${task}/wchan`)}`); }
  let fds = [];
  try { fds = readdirSync(`/proc/${pid}/fd`).map((fd) => { try { return `${fd}->${readlinkSync(`/proc/${pid}/fd/${fd}`)}`; } catch { return `${fd}->?`; } }); } catch (error) { fds = [`(${error.code})`]; }
  out.push(`files: ${fds.join(" ")}`);
  return out;
}
/** A watch of a run's private server, for a test's diagnostics: every WATCH_MS, a `list-panes` of
 *  the panel's session, each pane's dead flag, status, signal and process, a line kept with its
 *  time whenever that changes. Plain commands, never a control client of the test's own: tmux 3.4
 *  marks a control client as one before it has its state, and a `%paste-buffer-changed` of the
 *  panel's capture sent to it in that moment crashes the server (control_write; awebai/oats#1277).
 *  A pane seen dead with no status yet has its process's state kept then, and again DEAD_LOOK_MS
 *  later, with what the viewers wrote on stderr so far. stop() it before the run is ended. */
const WATCH_MS = 100, DEAD_LOOK_MS = 3000;
function watchPanel(socket) {
  const began = Date.now(), seen = [], last = new Map(), looked = new Set(), later = new Set();
  let stopped = false, tick = null, lastError = null;
  const stderrs = () => { try { return readdirSync(dirname(socket)).filter((name) => /\.view\.err$/.test(name)).map((name) => `${name}: ${JSON.stringify(readFileSync(join(dirname(socket), name), "utf8").slice(-500))}`); } catch (error) { return [`(${error.code})`]; } };
  const look = (pane, pid, when) => seen.push(`${Date.now() - began} ${pane} pid ${pid}, ${when}:`, ...[...processState(pid), ...stderrs()].map((line) => `    ${line}`));
  const poll = () => {
    tick = null;
    if (stopped) return;
    execFile(REAL_TMUX, ["-u", "-f", "/dev/null", "-S", socket, "list-panes", "-s", "-t", "=oats-tui", "-F", "#{pane_id} dead=#{pane_dead} status=#{pane_dead_status} signal=#{pane_dead_signal} pid=#{pane_pid}"], { encoding: "utf8", timeout: 5000 }, (error, stdout, stderr) => {
      if (stopped) return;
      const at = Date.now() - began;
      if (error) {
        const why = String(stderr || error.message).trim().split("\n")[0];
        if (why !== lastError) seen.push(`${at} list-panes failed: ${why}`);
        lastError = why;
      } else {
        lastError = null;
        const now = new Map(lines(stdout).map((row) => [row.split(" ", 1)[0], row]));
        for (const [pane, row] of now) {
          if (last.get(pane) !== row) seen.push(`${at} ${row}`);
          const dead = /^(%\d+) dead=1 status= signal= pid=(\d+)$/.exec(row);
          if (dead && !looked.has(pane)) {
            looked.add(pane);
            look(pane, dead[2], "dead with no status");
            const timer = setTimeout(() => { later.delete(timer); if (!stopped) look(pane, dead[2], `${DEAD_LOOK_MS} ms after it was seen dead`); }, DEAD_LOOK_MS);
            later.add(timer);
          }
        }
        for (const pane of last.keys()) if (!now.has(pane)) seen.push(`${at} ${pane} gone`);
        last.clear();
        for (const [pane, row] of now) last.set(pane, row);
      }
      tick = setTimeout(poll, WATCH_MS);
    });
  };
  poll();
  const watch = {
    lines: () => [...seen],
    stop() {
      stopped = true;
      if (lastWatch === watch) lastWatch = null;
      if (tick !== null) clearTimeout(tick);
      for (const timer of later) clearTimeout(timer);
      later.clear();
    },
  };
  lastWatch = watch;
  return watch;
}

/** A terminal of `cols`x`rows`: a new session of TERM, removed after the test, whose pane runs an
 *  interactive bash with a known prompt, in the fixture's environment. Resolves at the first prompt. */
async function terminal(t, { cols = COLS, rows = ROWS } = {}) {
  const id = `t${++opened}`;
  const shell = `sh ${shq(world.enter)} env LC_ALL=C.UTF-8 LANG=C.UTF-8 HISTFILE=/dev/null PS1=${shq(`${PROMPT} `)} bash --norc --noprofile -i`;
  const [pane, session] = tmuxOn(TERM, "new-session", "-d", "-P", "-F", "#{pane_id} #{session_id}", "-s", id, "-x", String(cols), "-y", String(rows), "-c", base, shell).split(" ");
  const term = {
    id, pane, session,
    /** The screen: one string per row, as `capture-pane` prints them (no trailing spaces). */
    screen() { return tmuxRaw(TERM, "capture-pane", "-p", "-t", pane).split("\n").slice(0, -1); },
    shows() { try { return term.screen().map((row) => `  |${row}`).join("\n"); } catch (error) { return `  (no pane: ${error.message})`; } },
    /** Keys, as tmux names them, typed at the terminal. */
    press(...keys) { tmuxOn(TERM, "send-keys", "-t", pane, ...keys); },
    /** Text typed at the terminal, each character as itself. */
    type(text) { tmuxOn(TERM, "send-keys", "-l", "-t", pane, text); },
    atPrompt() { return term.screen().filter(Boolean).at(-1) === PROMPT; },
    async prompt(why) { await until(term, () => term.atPrompt(), `the shell's prompt in ${id}, ${why}`); },
    /** A command line typed at the shell's prompt, and Enter. */
    async command(text, why) {
      await term.prompt(`before typing ${why}`);
      term.type(text);
      term.press("Enter");
    },
    kill() { try { tmuxOn(TERM, "kill-session", "-t", session); } catch { /* gone */ } },
  };
  t.after(term.kill); // a failed test leaves nothing for the next one
  t.after(sweepAgents);
  t.after(sweepPanels);
  await term.prompt("when its shell has started");
  return term;
}

/** A new TMPDIR for a run, short and inside the fixture. */
function tmpFor() {
  const tmp = join(base, `d${tmps.length + 1}`);
  mkdirSync(tmp, { mode: 0o700 });
  tmps.push(tmp);
  return tmp;
}

/** `oats tui --dir <the deployment>`, the real CLI with TMPDIR `tmp`, typed at a terminal's prompt
 *  through a wrapper that writes its own pid and then becomes the CLI. The shell records the exit
 *  status. Resolves once the agent's row is selected and can be opened: the cheat sheet offers Enter. */
async function tui(term, { tmp = tmpFor(), first = NAME } = {}) {
  const n = ++started;
  const pidFile = join(base, `tui-${n}.pid`), statusFile = join(base, `tui-${n}.status`);
  await term.command(`sh -c ${shq(`echo $$ > ${shq(pidFile)}; TMPDIR=${shq(tmp)} exec ${TUI} --dir ${shq(fx.dep)}`)}; echo $? > ${shq(statusFile)}`, "the oats tui command");
  const run = {
    tmp,
    /** The exit status the pane's shell recorded; null while the command runs. */
    status() { const text = existsSync(statusFile) ? readFileSync(statusFile, "utf8") : ""; return /^\d+\n$/.test(text) ? Number(text) : null; },
    async ended(why) { await until(term, () => run.status() !== null, `oats tui in ${term.id} to end ${why}`); return run.status(); },
    /** The list pane's row of the agent, with the selection's mark and its state's mark; null when
     *  no list is drawn (a zoomed terminal). */
    row() { return term.screen().map((text) => [...text].slice(0, LIST_BESIDE).join("").trimEnd()).find((text) => ROW.test(text)) ?? null; },
    /** The sidebar's rows: each row of the screen up to the rule after the sidebar, trimmed (the
     *  whole row on a screen with no sidebar: a zoomed terminal's). */
    sidebar() { return term.screen().map((text) => text.split("│")[0].trim()); },
    /** The cheat sheet, as the constants above spell it: its rows from the leader's (`commands`)
     *  to the first empty one, each with its run of blanks made one space; "" when none is drawn
     *  (a zoomed terminal has no sidebar). */
    sheet() {
      const side = run.sidebar().map((text) => text.replace(/ {2,}/g, " "));
      let first = side.findIndex((text) => text === `${LEADER} commands`);
      if (first < 0) return "";
      // The chords that lead it stand right above the leader's row, under the rule over the sheet.
      while (first > 0 && side[first - 1] !== "" && !/^[─-]+$/.test(side[first - 1].trim())) first--;
      const end = side.indexOf("", first);
      return side.slice(first, end < 0 ? undefined : end).join("   ");
    },
    /** The panel's rows: each row of the screen from the panel's first column. */
    panel() { return term.screen().map((text) => [...text].slice(PANEL_COL).join("")); },
    /** The agent's screen is in the panel, beside the list: the marker after the panel's first column. */
    beside(after = "") { return run.panel().some((text) => text.startsWith(`pane-ready:${after}`)); },
    /** The agent's screen has the whole screen: the marker at the first column, and no list. */
    zoomed(after = "") { return term.screen().some((text) => text.startsWith(`pane-ready:${after}`)) && run.row() === null; },
    /** Enter would open the agent now: its row is selected and running, and the cheat sheet says so. */
    openable() { return RUNNING_ROW.test(run.row() ?? "") && run.sheet().startsWith(OPEN_HINT); },
    /** The leader then Esc from the terminal, which gives the focus to the list: its cheat sheet,
     *  the leader then the palette, is drawn. From the list the pair again changes nothing, so it
     *  repeats safely. */
    async back() {
      await pairs.repeatable(term, "Escape", () => run.sheet().startsWith(LEAD), "the list's focus, its cheat sheet drawn");
    },
    async ready(why) {
      // `first`: the row the list starts on, its top one (alpha's, unless a test spawned newer agents).
      const opens = () => (first === NAME ? run.openable() : selectedRunning(term, first) && run.sheet().startsWith(OPEN_HINT));
      await until(term, opens, `the agent's row, selected and running, with "Enter open" in the cheat sheet after the leader and the palette, ${why}`);
      assert.equal(run.status(), null, `oats tui still runs ${why}`);
    },
    /** The line after an open, in the sidebar under the title, or null when nothing stands there:
     *  then the row under the title is the empty one, and the Instances view's heading follows it. */
    outcome() { const side = run.sidebar(); return side[1] === "" && /^Instances +1$/.test(side[2] ?? "") ? null : side[1] ?? ""; },
    /** What stands under that line: the text the viewer printed, in quotation marks. */
    under() { return run.sidebar()[2] ?? ""; },
    /** The detail beside the sidebar, as it stands with no terminal open: the rule after the
     *  sidebar's full width, and the agent's detail from the first row. */
    detailBeside() { const row = [...(term.screen()[0] ?? "")]; return row[LIST_COLS] === "│" && row.slice(LIST_COLS + 1).join("") === `   ${NAME}`; },
    /** The time of the last read, as the help shows it on its top row (docs/tui.md, "The help"),
     *  while the help is open; null else. */
    readAt() { return /│ +read (\d\d:\d\d:\d\d)(?: |$)/.exec(term.screen()[0] ?? "")?.[1] ?? null; },
    /** The run's private directory, once it has one (made at the first open). */
    dir() { const dirs = runDirs(tmp); assert.ok(dirs.length <= 1, `one run directory in ${tmp}: ${dirs}`); return dirs[0] ?? null; },
    /** Enter: the kernel's viewer starts in the panel, its client attached to a viewer session of
     *  AGENTS, and the agent's screen beside the list. Resolves with that session's name. */
    async open(why) {
      const before = new Set(viewerSessions());
      term.press("Enter");
      let session = null;
      await until(term, () => {
        assert.equal(run.status(), null, `oats tui ended after Enter ${why}`);
        session = viewerSessions().find((s) => !before.has(s)) ?? null;
        return session !== null && attached().includes(session) && run.beside() && RUNNING_ROW.test(run.row() ?? "");
      }, `the viewer, attached, with the agent's screen in the panel beside the list ${why}`);
      return session;
    },
    /** Two reads after now, seen on the help's top row: the help is opened, two reads are waited
     *  for and it is closed again. A read is every five seconds while the TUI is used (lib/read.mjs). */
    async twoReadsLater(why) {
      term.press("?");
      await until(term, () => run.readAt() !== null, `the help, with the time of the last read, after ${why}`);
      for (const k of [1, 2]) {
        const at = run.readAt();
        await until(term, () => run.readAt() !== null && run.readAt() !== at, `read number ${k} after ${why}`, () => [], 20000);
      }
      term.press("Escape");
      await until(term, () => run.readAt() === null && run.sheet().startsWith(LEAD) && run.sheet().includes("   n spawn   "), `the help closed again, the list's cheat sheet back, after two reads after ${why}`);
    },
  };
  lastRun = run;
  await run.ready("after the start");
  run.pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(run.pid) && run.pid > 1, `the wrapper wrote the pid (${run.pid})`);
  return run;
}

// ---- on a terminal ------------------------------------------------------------------------------
const TMUX_VERSION = REAL_TMUX ? execFileSync(REAL_TMUX, ["-V"], { encoding: "utf8", timeout: 10000 }).trim() : "none";

test(`Enter on the running agent shows its terminal in the panel beside the list, the list still on screen and the cheat sheet naming the leader; c closes it, the detail comes back, and no viewer session and no viewer's key table is left on the agents' server (${TMUX_VERSION})`, { skip: NO_TMUX }, async (t) => {
  await agentWindow();
  const term = await terminal(t);
  const run = await tui(term);
  // Before the first open the run may have made its directory already: the add of the deployment
  // to this computer's list is a change, whose output goes there (awebai/oats#1390). It holds no
  // panel until the first open, which takes that directory.
  const early = run.dir();
  assert.equal(early === null || !existsSync(join(early, "owner.json")), true, "no panel's directory before the first open");
  await run.open("on the running agent");
  assert.equal(run.sheet(), BACK, `the cheat sheet names the leader, the leader then Esc and the leader twice:\n${term.shows()}`);
  assert.equal(run.panel()[0].trim(), oneTab(NAME), "the panel's top row, the screen's first, is the tab bar: the agent's tab, the shown one, bracketed, with its number (none on macOS)");
  const dir = run.dir();
  assert.ok(dir, "the run directory, made at the first open or at the add before it");
  if (early !== null) assert.equal(dir, early, "the open takes the run's directory the add made");
  assert.deepEqual(readJson(join(dir, "owner.json")).tool, "oats-tui");
  assert.equal(readJson(join(dir, "owner.json")).pid, run.pid, "owner.json names the run");
  assert.equal(answers(panelSocket(dir)), true, "the private server answers on its socket in the run directory");
  // The viewer is its pane's own process, not a shell's child: the pane's hang-up (c, or the
  // server killed) then reaches it at once, and it removes its session. A shell between them
  // passed it on only when the shell died, late on a busy machine (CI, tmux 3.4).
  const viewers = paneProcesses(panelSocket(dir)).filter((args) => !args.includes("oats-tui-keeper"));
  assert.equal(viewers.length, 1, `one viewer pane: ${JSON.stringify(viewers)}`);
  assert.match(viewers[0], /\bsession attach\b/, "the pane's process is the viewer itself");
  assert.doesNotMatch(viewers[0], /^\S*sh -c /, "no shell between the pane and the viewer");

  await run.back();
  await until(term, () => run.sheet().startsWith(LIST_HINTS), "the list's focus, with Enter focus terminal in the cheat sheet");
  term.press("c");
  await until(term, () => !run.beside() && run.detailBeside() && viewerSessions().length === 0,
    "the terminal closed: the detail beside the list again, and no viewer session", () => [`viewer sessions: ${JSON.stringify(viewerSessions())}`]);
  assert.equal(run.outcome(), null, "a close the person asked for says nothing");
  assert.deepEqual(viewerTableFaults(), [], "after its pane was killed no table of the viewer's own is left");
  assert.equal(agentWindowThere(), true, "the agent keeps running");
  assert.deepEqual(panelWindows(panelSocket(dir)).length, 1, "the panel's server holds its keeper alone");
  await run.ready("after the close");

  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
});

test("what is typed reaches the agent and shows in the panel; the leader then Esc gives the focus to the list and never reaches the agent; z gives the terminal the whole screen, and the leader then Esc brings the list back with the panel", { skip: NO_TMUX }, async (t) => {
  await agentWindow();
  const term = await terminal(t);
  const run = await tui(term);
  await run.open("before typing");
  term.type("abc");
  await until(term, () => typed() === "abc", `what was typed reached the agent (it read ${JSON.stringify(typed())})`);
  await until(term, () => run.beside("abc"), "the agent's screen, with what it read, in the panel");

  await run.back();
  await until(term, () => run.sheet().startsWith(LIST_HINTS), "the list's focus after the leader then Esc");
  assert.equal(typed(), "abc", "the leader and the Esc after it were taken from the agent's input");
  // The terminal goes on being drawn while the list has the focus: a key typed from outside shows.
  tmuxOn(AGENTS, "send-keys", "-l", "-t", AGENT_TARGET, "d");
  await until(term, () => run.beside("abcd"), "the panel redrawn with the list focused");

  term.press("z");
  await until(term, () => run.zoomed("abcd") && term.screen()[0].startsWith(`${oneTab(NAME)} `) && term.screen()[0].endsWith(ZOOMED_KEYS) && run.sheet() === "", "the terminal zoomed: its tab bar on the first row, the shown tab bracketed, with the leader's keys at its right, and the viewer's scroll keys where they fit, and the agent's screen from the first column, no list and no cheat sheet");
  term.type("e");
  await until(term, () => typed() === "abcde", "typing reaches the agent while zoomed");
  await run.back();
  await until(term, () => run.beside("abcde") && RUNNING_ROW.test(run.row() ?? "") && run.sheet().startsWith(LIST_HINTS), "the list back, with the panel beside it");
  assert.equal(typed(), "abcde");

  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
});

test("an idle open terminal draws no frame for the 2 s it is watched: a frame comes when tmux says the agent's screen changed, and no timer draws one", { skip: NO_TMUX }, async (t) => {
  await agentWindow();
  const term = await terminal(t);
  const run = await tui(term);
  await run.open("before it is watched");
  // Every byte the TUI writes to its terminal, from the pane's side; a frame is one synchronized
  // update (ESC [ ? 2026 h … l), as the screen writes every frame.
  const file = join(base, `${term.id}-output`);
  writeFileSync(file, "");
  tmuxOn(TERM, "pipe-pane", "-o", "-t", term.pane, `cat >> ${shq(file)}`);
  t.after(() => { try { tmuxOn(TERM, "pipe-pane", "-t", term.pane); } catch { /* gone */ } });
  const frames = () => readFileSync(file, "latin1").split("\x1b[?2026h").length - 1;
  // The pipe sees frames: a key the agent shows is drawn.
  term.type("x");
  await until(term, () => typed() === "x" && frames() > 0, "a frame after a key the agent shows");
  // Nothing on this screen moves with a read (the time of the last read is the help's alone), and a
  // frame that changes nothing writes nothing: a read of the deployment, every five seconds, draws
  // no frame here either, so every window is watched. One window with no frame is the proof; a TUI
  // that polled would draw in each.
  const watched = [];
  for (let attempt = 0; attempt < 4 && !watched.includes(0); attempt++) {
    await pause(300);
    const before = frames();
    await pause(2000);
    watched.push(frames() - before);
  }
  t.diagnostic(`frames in each 2 s window: ${JSON.stringify(watched)}`);
  assert.equal(watched.includes(0), true, `an idle open terminal drew a frame in every window it was watched: ${JSON.stringify(watched)}`);
  assert.equal(run.beside("x"), true, "the terminal is still drawn");
  await run.back();
  await until(term, () => run.sheet().startsWith(LIST_HINTS), "the list's focus before q");
  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
});

test("a viewer that ends at once closes the terminal: the line says it could not be opened, what the viewer printed stands under it, and it is never opened again on its own", { skip: NO_TMUX }, async (t) => {
  await agentWindow();
  const term = await terminal(t);
  const run = await tui(term);
  // The window goes while the row still says running (reads are seconds apart): the viewer the
  // panel starts finds no window, says so on stderr and exits 1.
  killAgentWindow();
  term.press("Enter");
  // What tmux reports of the viewer's pane is watched from the moment the panel's server answers,
  // so a viewer that never closes says whether tmux ever had its status (CI, tmux 3.4).
  let watch = null;
  t.after(() => watch?.stop());
  await waitUntil(() => { const dir = run.dir(); if (dir && answers(panelSocket(dir))) watch = watchPanel(panelSocket(dir)); return watch !== null; }, "the panel's server", 10000);
  await until(term, () => run.outcome() === FAILED && !run.beside() && run.sheet() !== BACK, `the line ${JSON.stringify(FAILED)}, and the panel closed`, () => [`the line is ${JSON.stringify(run.outcome())}`]);
  watch.stop();
  // The kernel's viewer found no window to attach to (lib/session-viewer.mjs), said so and exited 1.
  assert.equal(run.under(), '"oats: session no longer exists"', `what the viewer printed stands under the line, in quotation marks:\n${term.shows()}`);
  const dir = run.dir();
  assert.ok(dir, "the panel was started");
  await run.twoReadsLater("the viewer ended");
  assert.deepEqual(panelWindows(panelSocket(dir)).length, 1, "the panel's server holds its keeper alone: nothing was opened again");
  assert.deepEqual(viewerSessions(), [], "no viewer session");
  assert.equal(run.beside(), false, `no terminal is shown:\n${term.shows()}`);
  assert.equal(run.status(), null, "oats tui still runs");
  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
});

test("a viewer whose terminal hangs up before its process has exited keeps its exit status: tmux reports such a pane dead before it has the status (3.4), and the panel waits for it", { skip: NO_TMUX }, async (t) => {
  const dir = mkdtempSync(join(base, "late-"));
  const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
  const closed = [];
  const panel = createPanel({ dir: () => dir, env, capture: captureRows, onClosed: (event) => closed.push(event) });
  t.after(() => { panel.end(); rmSync(dir, { recursive: true, force: true }); });
  // The process closes its terminal's files (the hang-up), ignores the SIGHUP tmux's closing of the
  // pane then sends it, and exits 3 four seconds later, past DEAD_WAIT_MS and well within
  // STATUS_WAIT_MS, the panel's waits on tmux 3.2 and on a later tmux: tmux marks
  // the pane dead at the hang-up and has its status only once it reaps the process. A viewer that
  // exits does the same in a moment.
  await panel.open({ argv: ["/bin/sh", "-c", 'trap "" HUP; exec 0<&- 1>&- 2>&-; sleep 4; exit 3'], cols: 80, rows: 20 });
  await waitUntil(() => closed.length === 1, "the viewer's end", 12000);
  assert.equal(closed[0].status, 3, `the status it exited with: ${JSON.stringify(closed[0])}`);
});

test("a viewer whose terminal hangs up and whose process lives on: where tmux reports its pane dead at the hang-up (3.4) it is over with no status once STATUS_WAIT_MS have passed, and its pane is killed, so the panel never keeps a terminal open that nothing will close (CI); where tmux keeps the pane live while its process runs (3.7c) it stays open until that process ends", { skip: NO_TMUX }, async (t) => {
  const dir = mkdtempSync(join(base, "never-"));
  const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
  const closed = [], traced = [];
  const panel = createPanel({ dir: () => dir, env, capture: captureRows, onClosed: (event) => closed.push(event), trace: (text) => traced.push(text) });
  let pid = null;
  t.after(() => { panel.end(); if (pid !== null && alive(pid)) process.kill(pid, "SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
  // The process closes its terminal's files, ignores SIGHUP and sleeps on: tmux has no status for it.
  const { id } = await panel.open({ argv: ["/bin/sh", "-c", 'trap "" HUP; exec 0<&- 1>&- 2>&- sleep 60'], cols: 80, rows: 20 });
  const socket = panelSocket(dir), from = Date.now();
  pid = Number(tmuxOn(socket, "list-panes", "-t", id, "-F", "#{pane_pid}"));
  assert.ok(Number.isInteger(pid) && pid > 1, `the pane's process (${pid})`);
  let deadAtHangUp = false;
  for (const until = Date.now() + 3000; Date.now() < until && !deadAtHangUp;) {
    try { deadAtHangUp = tmuxOn(socket, "list-panes", "-t", id, "-F", "#{pane_dead}") === "1"; } catch { break; }
    if (!deadAtHangUp) await pause(100);
  }
  if (deadAtHangUp) {
    await waitUntil(() => closed.length === 1, "the viewer's end", STATUS_WAIT_MS + 8000);
    assert.ok(Date.now() - from >= STATUS_WAIT_MS - 1000, `not before the wait: ${Date.now() - from} ms`);
    assert.deepEqual(closed[0], { id, status: null, stderr: "", asked: false });
    assert.ok(traced.includes(`${id} no status after ${STATUS_WAIT_MS} ms`), traced.join("\n"));
    await waitUntil(() => !panelWindows(socket).includes(id), "its window gone", 5000);
  } else {
    assert.deepEqual(closed, [], `${TMUX_VERSION} says the pane runs: it is open`);
    process.kill(pid, "SIGKILL");
    await waitUntil(() => closed.length === 1, "the viewer's end once its process is killed", 8000);
    assert.deepEqual(closed[0], { id, status: null, stderr: "", asked: false }, "a signal ended it");
  }
});

// When a viewer's session outlives a way out, what explains it: the viewer's two files (linked
// before the end, which removes them), its processes as ps shows them now, the agents' sessions,
// and how long the session took to go, if it went at all within 30 s.
/** The viewer's processes: its node (`session attach`) and its tmux client of the agents' server. */
const viewerProcesses = () => lines(execFileSync("ps", ["-eo", "pid,ppid,pgid,stat,args"], { encoding: "utf8", timeout: 10000 })).filter((line) => /session attach|agents\.sock/.test(line) && !/list-sessions|ps -eo| new-session -d -s team /.test(line));
/** Hard links to the run's view files, kept after the run removes its own. */
function keepViewFiles(dir, label) {
  const kept = join(base, `diag-${label}-${Date.now()}`);
  mkdirSync(kept);
  for (const name of readdirSync(dir).filter((entry) => /\.view\.(err|status)$/.test(entry))) { try { linkSync(join(dir, name), join(kept, name)); } catch { /* gone */ } }
  return kept;
}
function viewerFaults(kept, before) {
  const files = readdirSync(kept).map((name) => `${name}: ${JSON.stringify(readFileSync(join(kept, name), "utf8").slice(-2000))}`);
  const now = viewerProcesses(), sessions = sessionsOf(AGENTS);
  if (viewerSessions().length === 0) return [`view files: ${files.join("; ") || "none"}`, `viewer processes before the end: ${JSON.stringify(before)}`, `viewer processes now: ${JSON.stringify(now)}`, `agents' sessions: ${JSON.stringify(sessions)}`, "the session was gone by the time these were read"];
  const started = Date.now();
  while (viewerSessions().length > 0 && Date.now() - started < 30000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  const went = viewerSessions().length === 0 ? `the session went ${Date.now() - started} ms after the wait gave up` : "the session was still there 30 s after the wait gave up";
  return [`view files: ${files.join("; ") || "none"}`, `viewer processes before the end: ${JSON.stringify(before)}`, `viewer processes now: ${JSON.stringify(now)}`, `agents' sessions: ${JSON.stringify(sessions)}`, went];
}

for (const [how, end, expected] of [
  ["q", async (term, run) => { await run.back(); await until(term, () => run.sheet().startsWith(LIST_HINTS), "the list's focus before q"); term.press("q"); }, 0],
  ["SIGTERM", (term, run) => process.kill(run.pid, "SIGTERM"), 143],
  ["kill -9", (term, run) => process.kill(run.pid, "SIGKILL"), 137],
]) {
  test(`${how} with a terminal open: the private server is gone, its viewer's session and own key table are gone from the agents' server, and the agent is untouched${how === "kill -9" ? "; the run directory is left for the next run's sweep" : "; the run directory is removed"}`, { skip: NO_TMUX }, async (t) => {
    await agentWindow();
    const term = await terminal(t);
    const run = await tui(term);
    await run.open(`before ${how}`);
    term.type("k");
    await until(term, () => typed() === "k", "the agent read a key");
    const dir = run.dir(), socket = panelSocket(dir);
    const kept = keepViewFiles(dir, how.replace(/\W/g, "")), before = viewerProcesses();
    await end(term, run);
    assert.equal(await run.ended(`after ${how}`), expected, term.shows());
    await until(term, () => !alive(run.pid), `the process ${run.pid} to be gone after ${how}`);
    await until(term, () => !answers(socket), `the private server's socket to refuse after ${how}`);
    await until(term, () => viewerSessions().length === 0, `no viewer session on the agents' server after ${how}`, () => [`viewer sessions: ${JSON.stringify(viewerSessions())}`, ...viewerFaults(kept, before)]);
    assert.deepEqual(viewerTableFaults(), [], `no viewer's own key table on the agents' server after ${how}`);
    assert.equal(agentWindowThere(), true, `the agent keeps running after ${how}`);
    assert.equal(typed(), "k", "and nothing more reached it");
    if (how === "kill -9") {
      assert.equal(existsSync(join(dir, "owner.json")), true, "a run killed with no way to clean up leaves its directory, owner.json in it");
    } else {
      assert.equal(existsSync(socket), false, `the socket is removed after ${how}`);
      assert.equal(existsSync(dir), false, `the run directory is removed after ${how}`);
    }
  });
}

// The keeper (packages/tui/lib/panel.mjs, THE KEEPER) ends the private server when the TUI is gone,
// at any moment: a control client whose reader has gone while output is queued for it is never
// ended by tmux, so the stdin EOF alone does not do it. The program below is the panel alone, over
// the real tmux: killed with SIGKILL at a chosen moment of the start (as soon as the control client
// is spawned, at the first bytes it prints, or a few ms later), or (`hold`) left running with its
// viewer open, for the test to stop and kill.
const panelProgram = join(base, "panel-program.mjs");
const PANEL_MODULE = resolve(new URL("../packages/tui/lib/panel.mjs", import.meta.url).pathname);
function writePanelProgram() {
  writeFileSync(panelProgram, `import { spawn as nodeSpawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createPanel } from ${JSON.stringify(PANEL_MODULE)};
const [run, mark, when] = process.argv.slice(2);
const die = () => process.kill(process.pid, "SIGKILL");
const spawn = (...args) => {
  const child = nodeSpawn(...args);
  writeFileSync(mark, String(child.pid));
  if (when === "spawn") die();
  else if (when === "output") child.stdout.once("data", die);
  else if (when !== "hold") setTimeout(die, Number(when));
  return child;
};
const panel = createPanel({ dir: () => run, tmux: "tmux", spawn, env: process.env, capture: (text) => text, onScreen: () => {}, onClosed: () => {} });
panel.open({ argv: ["/bin/sh", "-c", "exec sleep 30"], cols: 40, rows: 10 }).then(() => writeFileSync(mark + ".opened", "")).catch(() => {});
setTimeout(() => {}, 20000);
`);
}
/** A run directory for the program, in a TMPDIR of the fixture's: sweepPanels and the last test see it. */
function programRun(tmp, name) {
  const run = join(tmp, `oats-tui-${name}`);
  mkdirSync(run, { mode: 0o700 });
  chmodSync(run, 0o700);
  return { run, mark: join(tmp, `${name}.pid`), socket: panelSocket(run) };
}
const budget = (ms = 10000) => Math.min(ms, Math.max(0, FILE_DEADLINE - Date.now()));
/** The pids of the processes in a private server's panes: its keeper's and its viewers'. */
const panePids = (socket) => { try { return lines(tmuxOn(socket, "list-panes", "-a", "-F", "#{pane_pid}")).map(Number); } catch { return []; } };

test("a TUI killed with SIGKILL while its private server starts leaves no server: killed at the control client's spawn, at its first bytes, or a few ms on", { skip: NO_TMUX }, async () => {
  writePanelProgram();
  const tmp = tmpFor();
  for (const when of ["spawn", "output", "0", "2", "5", "10", "20", "40"]) {
    const { run, mark, socket } = programRun(tmp, when);
    let signal = null;
    try { execFileSync(process.execPath, [panelProgram, run, mark, when], { timeout: 15000, stdio: "ignore" }); } catch (error) { signal = error.signal; }
    assert.equal(signal, "SIGKILL", `the program killed itself (${when})`);
    assert.equal(existsSync(mark), true, `the control client was spawned before the kill (${when})`);
    const client = Number(readFileSync(mark, "utf8"));
    await waitUntil(() => !alive(client), `the control client ${client} to end after the TUI was killed (${when})`, budget());
    await waitUntil(() => !answers(socket), `no private server to answer after a kill at ${when}`, budget());
    // These two fall inside the start by construction: the open never answered.
    if (when === "spawn" || when === "output") assert.equal(existsSync(`${mark}.opened`), false, `killed during the start (${when})`);
  }
});

test("a stopped TUI keeps its private server and its viewer (Ctrl+Z stops the TUI, and it holds the keeper's FIFO); killed afterwards, the server and the viewer go", { skip: NO_TMUX }, async (t) => {
  writePanelProgram();
  const { run, mark, socket } = programRun(tmpFor(), "hold");
  const program = spawn(process.execPath, [panelProgram, run, mark, "hold"], { stdio: "ignore" });
  t.after(() => { try { program.kill("SIGKILL"); } catch { /* gone */ } });
  await waitUntil(() => existsSync(`${mark}.opened`), "the program's viewer open", budget(15000));
  const panes = panePids(socket);
  assert.equal(panes.length, 2, "the keeper and the viewer");
  process.kill(program.pid, "SIGSTOP");
  await pause(1500);
  assert.equal(answers(socket), true, "a stopped TUI's server still answers");
  assert.deepEqual(panes.filter((pid) => !alive(pid)), [], "its keeper and its viewer still run");
  process.kill(program.pid, "SIGCONT");
  await pause(300);
  assert.equal(answers(socket), true, "and after it continues");
  process.kill(program.pid, "SIGKILL");
  await waitUntil(() => !answers(socket), "no private server to answer after the TUI was killed", budget());
  await waitUntil(() => panes.every((pid) => !alive(pid)), "the keeper and the viewer gone with the server", budget());
});

test("kill -9 while the agent prints without pause: the private server is gone, its viewer's session and own key table are gone from the agents' server, and the agent keeps running", { skip: NO_TMUX }, async (t) => {
  await agentWindow();
  t.after(() => { try { killAgentWindow(); } catch { /* gone */ } }); // the flood ends with its window
  const term = await terminal(t);
  const run = await tui(term);
  await run.open("before the flood");
  term.type("F");
  await until(term, () => run.panel().some((text) => text.startsWith("flood flood")), "the flood in the panel");
  await pause(300);
  const dir = run.dir(), socket = panelSocket(dir);
  process.kill(run.pid, "SIGKILL");
  assert.equal(await run.ended("after kill -9"), 137, term.shows());
  await until(term, () => !answers(socket), "the private server's socket to refuse after kill -9 with the agent printing");
  await until(term, () => viewerSessions().length === 0, "no viewer session on the agents' server after kill -9 with the agent printing", () => [`viewer sessions: ${JSON.stringify(viewerSessions())}`]);
  assert.deepEqual(viewerTableFaults(), [], "no viewer's own key table on the agents' server");
  assert.equal(agentWindowThere(), true, "the agent keeps running");
});

test("a run's sweep removes what a dead run left, its directory (its server SIGKILLed by the keeper: a socket that refuses, the FIFO, owner.json), and leaves a live run's directory and a look-alike without owner.json alone", { skip: NO_TMUX }, async (t) => {
  await agentWindow();
  const tmp = tmpFor();
  // A live run, with its terminal open.
  const liveTerm = await terminal(t);
  const live = await tui(liveTerm, { tmp });
  await live.open("in the live run");
  const liveDir = live.dir();
  assert.equal(answers(panelSocket(liveDir)), true);
  await live.back();
  await until(liveTerm, () => live.sheet().startsWith(LIST_HINTS), "the live run's list focused, its terminal open");
  // A dead run: opened, then killed with no way to clean up. Its directory is the one that is new
  // since it started: made at its first open, or before it by the add of its deployment to this
  // computer's list, and holding owner.json once the terminal is open.
  const before = new Set(runDirs(tmp));
  const deadTerm = await terminal(t);
  const dead = await tui(deadTerm, { tmp });
  deadTerm.press("Enter");
  await until(deadTerm, () => runDirs(tmp).some((dir) => !before.has(dir) && existsSync(join(dir, "owner.json"))) && dead.beside(), "the dead run's terminal open");
  const deadDir = runDirs(tmp).find((dir) => !before.has(dir));
  const deadPanes = panePids(panelSocket(deadDir));
  assert.equal(deadPanes.length, 2, "the dead run's keeper and viewer");
  process.kill(dead.pid, "SIGKILL");
  await dead.ended("after kill -9");
  await until(deadTerm, () => !answers(panelSocket(deadDir)), "the dead run's server gone");
  // Its keeper SIGKILLed the server: the socket file is left, and refuses; the keeper and the
  // viewer are gone, and so is the FIFO's writer; the FIFO and owner.json are left for the sweep.
  await until(deadTerm, () => deadPanes.every((pid) => !alive(pid)), "the dead run's keeper and viewer gone");
  assert.equal(lstatSync(panelSocket(deadDir)).isSocket(), true, "a SIGKILLed server leaves its socket file");
  assert.equal(lstatSync(join(deadDir, "alive")).isFIFO(), true, "and the keeper's FIFO");
  assert.equal(existsSync(join(deadDir, "owner.json")), true);
  // A dead run's directory made by hand: owner.json of a pid that has exited, and no socket.
  const goneDir = join(tmp, "oats-tui-gone00");
  mkdirSync(goneDir, { mode: 0o700 });
  chmodSync(goneDir, 0o700);
  const gonePid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", timeout: 10000 }));
  writeFileSync(join(goneDir, "owner.json"), `${JSON.stringify({ tool: "oats-tui", pid: gonePid, started: new Date().toISOString() })}\n`, { mode: 0o600 });
  // A look-alike: the name and the mode, and no owner.json.
  const alike = join(tmp, "oats-tui-alike0");
  mkdirSync(alike, { mode: 0o700 });
  chmodSync(alike, 0o700);
  writeFileSync(join(alike, "keep"), "not the TUI's\n");
  assert.equal(existsSync(deadDir) && existsSync(goneDir), true, "both dead runs' directories are there before the new run");

  // A new run's sweep, once, at its start.
  const nextTerm = await terminal(t);
  const next = await tui(nextTerm, { tmp });
  await until(nextTerm, () => !existsSync(deadDir) && !existsSync(goneDir), "the dead runs' directories removed by the new run's sweep", () => [`left: ${JSON.stringify(runDirs(tmp))}`]);
  assert.equal(existsSync(join(liveDir, "owner.json")), true, "the live run's directory is left");
  assert.equal(answers(panelSocket(liveDir)), true, "and its server still answers");
  assert.equal(live.beside(), true, `and its terminal is still drawn:\n${liveTerm.shows()}`);
  assert.equal(readFileSync(join(alike, "keep"), "utf8"), "not the TUI's\n", "the look-alike is left as it was");
  assert.equal(agentWindowThere(), true, "the agent keeps running");

  nextTerm.press("q");
  assert.equal(await next.ended("after q"), 0, nextTerm.shows());
  liveTerm.press("q");
  assert.equal(await live.ended("after q"), 0, liveTerm.shows());
});

// ---- the tabs (packages/tui/lib/panel.mjs, THE TABS) ---------------------------------------------
// The panel over the real tmux, in this process: up to four viewers, each a window of the private
// server, one of them shown. A tab here runs `tabProgram`, which says its name and then shows every
// byte it reads (as the agent's pane does), so what reached which tab is on that tab's own pane,
// read with plain commands on the private socket (never a control client of the test's own: see
// watchPanel). `Q` ends it with status 7.
const tabProgram = join(base, "tab-program.mjs");
function writeTabProgram() {
  writeFileSync(tabProgram, `process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  if (data.includes(81)) process.exit(7);
  process.stdout.write([...data].map((b) => (b < 32 ? "^" + String.fromCharCode(b + 64) : String.fromCharCode(b))).join(""));
});
process.stdout.write(process.argv[2] + "-ready:");
`);
}
/** A panel of this process, over a private directory of the fixture's, with what it says recorded;
 *  ended after the test. Its environment is the fixture's (fx.env: the tmux of system-bin, which
 *  admits only the fixture's sockets), as the TUI's is. */
function tabsPanel(t, label) {
  const dir = mkdtempSync(join(base, `${label}-`));
  const screens = [], closed = [], activity = [];
  const env = { ...fx.env }; delete env.TMUX; delete env.TMUX_PANE;
  const panel = createPanel({ dir: () => dir, env, capture: (text) => text, onScreen: (event) => screens.push(event), onClosed: (event) => closed.push(event), onActivity: (event) => activity.push(event) });
  t.after(() => { panel.end(); rmSync(dir, { recursive: true, force: true }); });
  const socket = panelSocket(dir);
  return {
    dir, socket, panel, screens, closed, activity,
    /** Open a tab running tabProgram as `name`; resolves with its id once its name is drawn. */
    async tab(name) {
      const { id } = await panel.open({ argv: [process.execPath, tabProgram, name], cols: 60, rows: 10 });
      await waitUntil(() => screens.some((screen) => screen.id === id && screen.screen.includes(`${name}-ready:`)), `the tab ${name} (${id}) drawn`, budget(15000));
      return id;
    },
    /** What the tab `name` in window `id` has read, from its own pane; null before it is ready. */
    read(id, name) {
      let text;
      try { text = tmuxOn(socket, "capture-pane", "-p", "-J", "-t", id).replace(/\n/g, ""); } catch { return null; }
      const at = text.indexOf(`${name}-ready:`);
      return at < 0 ? null : text.slice(at + `${name}-ready:`.length).trimEnd();
    },
    /** Each window's size, by id. */
    sizes() { return Object.fromEntries(lines(tmuxOn(socket, "list-windows", "-t", "=oats-tui", "-F", "#{window_id} #{window_width}x#{window_height}")).map((row) => row.split(" "))); },
  };
}

test(`three tabs opened and switched: each its own window, only the shown one drawn and typed to, a hidden one's output marking it, and a resize reaching every window (${TMUX_VERSION})`, { skip: NO_TMUX }, async (t) => {
  writeTabProgram();
  const p = tabsPanel(t, "tabs");
  const names = ["one", "two", "three"], ids = [];
  for (const name of names) ids.push(await p.tab(name));
  assert.deepEqual(p.panel.tabs, { ids, shown: ids[2], displayed: [ids[2]] }, "in opening order, the last opened shown");
  assert.equal(panelWindows(p.socket).length, 4, "the keeper and a window per tab");
  const read = (k) => p.read(ids[k], names[k]);
  const typedTo = () => names.map((_, k) => read(k));
  // Typing reaches the shown tab, and no other.
  p.panel.input("c");
  await waitUntil(() => read(2) === "c", "the shown tab read what was typed", budget());
  assert.deepEqual(typedTo(), ["", "", "c"]);
  // Switched: the tab shown is captured, typed to, and the only one drawn.
  let from = p.screens.length;
  p.panel.show(ids[0]);
  assert.deepEqual(p.panel.tabs, { ids, shown: ids[0], displayed: [ids[0]] });
  await waitUntil(() => p.screens.slice(from).some((screen) => screen.id === ids[0]), "a capture of the tab shown", budget());
  p.panel.input("a");
  await waitUntil(() => read(0) === "a" && p.screens.at(-1).screen.includes("one-ready:a"), "the tab shown read it, and is drawn with it", budget());
  p.panel.show(ids[1]);
  p.panel.paste("b");
  await waitUntil(() => read(1) === "^[[200~b^[[201~", `the second tab read the paste (${JSON.stringify(read(1))})`, budget());
  assert.deepEqual(typedTo(), ["a", "^[[200~b^[[201~", "c"], "each tab read only what was typed while it was shown");
  // A hidden tab's output marks it once, and is never drawn.
  from = p.screens.length;
  for (const key of ["x", "y"]) { tmuxOn(p.socket, "send-keys", "-t", ids[0], "-l", key); await pause(150); }
  // (Another tab may be marked too: the echo of what it read while shown can be heard just after
  // it was hidden, which is output while hidden.)
  const marks = () => p.activity.filter((event) => event.id === ids[0]);
  await waitUntil(() => read(0) === "axy" && marks().length > 0, "the hidden tab's output, and its mark", budget());
  await pause(300);
  assert.deepEqual(marks(), [{ id: ids[0] }], "told once in the spell");
  assert.equal(p.activity.some((event) => event.id === ids[1]), false, "the shown tab is never marked");
  assert.deepEqual([...new Set(p.screens.slice(from).map((screen) => screen.id))].filter((id) => id !== ids[1]), [], "nothing drawn of a hidden tab");
  // A resize reaches every tab's window.
  p.panel.resize(70, 12);
  await waitUntil(() => ids.every((id) => p.sizes()[id] === "70x12"), `every tab's window at 70x12 (${JSON.stringify(p.sizes())})`, budget());
  await waitUntil(() => p.screens.at(-1).id === ids[1], "a capture of the shown tab after the resize", budget());
});

test("a tab closed: its window goes, nothing is shown until show(), and showing its neighbour draws it and types to it", { skip: NO_TMUX }, async (t) => {
  writeTabProgram();
  const p = tabsPanel(t, "close");
  const names = ["left", "middle", "right"], ids = [];
  for (const name of names) ids.push(await p.tab(name));
  p.panel.show(ids[1]);
  p.panel.close(ids[1]);
  assert.deepEqual(p.panel.tabs, { ids: [ids[0], ids[2]], shown: null, displayed: [] }, "the panel picks no neighbour");
  await waitUntil(() => p.closed.length === 1, "the closed tab's end", budget());
  assert.deepEqual(p.closed[0], { id: ids[1], status: null, stderr: "", asked: true });
  await waitUntil(() => !panelWindows(p.socket).includes(ids[1]), "its window gone", budget());
  assert.equal(panelWindows(p.socket).length, 3, "the keeper and the two tabs left");
  p.panel.input("lost");
  await pause(300);
  assert.deepEqual([p.read(ids[0], "left"), p.read(ids[2], "right")], ["", ""], "with none shown, nothing is typed");
  const from = p.screens.length;
  p.panel.show(ids[2]);
  await waitUntil(() => p.screens.slice(from).some((screen) => screen.id === ids[2] && screen.screen.includes("right-ready:")), "the neighbour drawn", budget());
  p.panel.input("n");
  await waitUntil(() => p.read(ids[2], "right") === "n", "the neighbour typed to", budget());
  assert.equal(p.read(ids[0], "left"), "");
  assert.deepEqual(p.panel.tabs, { ids: [ids[0], ids[2]], shown: ids[2], displayed: [ids[2]] });
});

test("a hidden tab's viewer that ends on its own is reported and its window goes, and the shown tab stays shown: a kernel viewer whose agent's window ended, and a program that exits 7", { skip: NO_TMUX }, async (t) => {
  writeTabProgram();
  await agentWindow();
  const p = tabsPanel(t, "hidden");
  // The kernel's viewer of the agent, then a program tab beside it, then another, shown.
  const { id: viewer } = await p.panel.open({ argv: [process.execPath, CLI, "session", "attach", "--home", world.home], cols: 60, rows: 10 });
  await waitUntil(() => viewerSessions().length === 1 && attached().includes(viewerSessions()[0]), "the viewer attached to the agents' server", budget(20000));
  const quits = await p.tab("quits");
  const shown = await p.tab("shown");
  assert.deepEqual(p.panel.tabs, { ids: [viewer, quits, shown], shown, displayed: [shown] });
  // The agent's window ends: the viewer's client leaves, and the viewer exits, hidden.
  killAgentWindow();
  await waitUntil(() => p.closed.some((event) => event.id === viewer), "the hidden viewer's end", budget(20000));
  assert.equal(p.closed.find((event) => event.id === viewer).asked, false, JSON.stringify(p.closed));
  await waitUntil(() => viewerSessions().length === 0, "no viewer session on the agents' server", budget());
  // A hidden program tab ends with its status.
  tmuxOn(p.socket, "send-keys", "-t", quits, "-l", "Q");
  await waitUntil(() => p.closed.some((event) => event.id === quits), "the hidden program's end", budget(15000));
  assert.deepEqual(p.closed.find((event) => event.id === quits), { id: quits, status: 7, stderr: "", asked: false });
  await waitUntil(() => panelWindows(p.socket).length === 2, `the keeper and the shown tab alone (${JSON.stringify(panelWindows(p.socket))})`, budget());
  assert.deepEqual(p.panel.tabs, { ids: [shown], shown, displayed: [shown] }, "the shown tab still shown");
  p.panel.input("s");
  await waitUntil(() => p.read(shown, "shown") === "s", "and typed to", budget());
});

// Two displayed at once (THE TABS): one tab per group of a split, each its own window at its own
// size, both captured, the keys to the shown one.
/** The screens of tab `id` handed back since `from`. */
const screensOf = (p, id, from = 0) => p.screens.slice(from).filter((screen) => screen.id === id);

test(`two groups, each displaying a tab, at two sizes: both are captured when their panes change, and typing reaches only the shown one; focus() moves the keys (${TMUX_VERSION})`, { skip: NO_TMUX }, async (t) => {
  writeTabProgram();
  const p = tabsPanel(t, "split");
  const left = await p.tab("left");
  const { id: right } = await p.panel.open({ argv: [process.execPath, tabProgram, "right"], cols: 40, rows: 8, instead: null });
  await waitUntil(() => screensOf(p, right).some((screen) => screen.screen.includes("right-ready:")), "the right tab drawn", budget(15000));
  assert.deepEqual(p.panel.tabs, { ids: [left, right], shown: right, displayed: [left, right] });
  assert.deepEqual([p.sizes()[left], p.sizes()[right]], ["60x10", "40x8"], "each window at its own size");
  // Typing reaches the shown one only, and it is drawn with it.
  p.panel.input("r");
  await waitUntil(() => p.read(right, "right") === "r" && screensOf(p, right).at(-1)?.screen.includes("right-ready:r"), "the shown tab read it and is drawn with it", budget());
  assert.equal(p.read(left, "left"), "", "the other displayed tab read nothing");
  // The other displayed tab's pane changes (a key from outside the panel): it is captured too.
  const from = p.screens.length;
  tmuxOn(p.socket, "send-keys", "-t", left, "-l", "o");
  await waitUntil(() => screensOf(p, left, from).some((screen) => screen.screen.includes("left-ready:o")), "the other displayed tab captured with its change", budget());
  assert.deepEqual(p.activity, [], "a displayed tab's output is no activity");
  // The keys follow focus().
  p.panel.focus(left);
  p.panel.input("l");
  await waitUntil(() => p.read(left, "left") === "ol", "the focused tab read it", budget());
  await pause(300);
  assert.equal(p.read(right, "right"), "r", "the one no longer shown read nothing more");
  // Each screen is at its own window's size: a capture holds as many lines as its pane has rows.
  assert.equal(screensOf(p, left).at(-1).screen.split("\n").length, 10);
  assert.equal(screensOf(p, right).at(-1).screen.split("\n").length, 8);
});

test("a move: a tab not displayed in one group is displayed in place of the other group's tab, resized to that group's size, captured at it and typed to", { skip: NO_TMUX }, async (t) => {
  writeTabProgram();
  const p = tabsPanel(t, "move");
  // The left group: `first`, then `second` in its place (first no longer displayed). The right group: `other`.
  const first = await p.tab("first");
  const { id: second } = await p.panel.open({ argv: [process.execPath, tabProgram, "second"], cols: 60, rows: 10, instead: first });
  const { id: other } = await p.panel.open({ argv: [process.execPath, tabProgram, "other"], cols: 40, rows: 8, instead: null });
  await waitUntil(() => [second, other].every((id) => p.screens.some((screen) => screen.id === id)), "both displayed tabs drawn", budget(15000));
  assert.deepEqual(p.panel.tabs, { ids: [first, second, other], shown: other, displayed: [second, other] });
  // The move: `first` to the right group, in place of `other`, at the right group's size.
  const from = p.screens.length;
  p.panel.resize(40, 8, [first]);
  p.panel.show(first, { instead: other });
  assert.deepEqual(p.panel.tabs, { ids: [first, second, other], shown: first, displayed: [first, second] });
  await waitUntil(() => p.sizes()[first] === "40x8", `the moved tab's window at the group's size (${JSON.stringify(p.sizes())})`, budget());
  assert.deepEqual([p.sizes()[second], p.sizes()[other]], ["60x10", "40x8"], "no other window resized");
  await waitUntil(() => screensOf(p, first, from).some((screen) => screen.screen.includes("first-ready:") && screen.screen.split("\n").length === 8), "the moved tab captured at its new size", budget());
  p.panel.input("m");
  await waitUntil(() => p.read(first, "first") === "m", "the moved tab typed to", budget());
  assert.deepEqual([p.read(second, "second"), p.read(other, "other")], ["", ""], "and no other");
  // The tab it replaced is no longer displayed: its output marks it, once.
  const marked = p.screens.length;
  tmuxOn(p.socket, "send-keys", "-t", other, "-l", "x");
  await waitUntil(() => p.activity.some((event) => event.id === other), "the replaced tab marked", budget());
  await pause(300);
  assert.equal(p.read(other, "other"), "x", "its pane read it");
  assert.deepEqual(screensOf(p, other, marked), [], "nothing drawn of a tab not displayed");
  assert.deepEqual(p.activity.filter((event) => event.id === other), [{ id: other }], "marked once");
});

/** A tab program that counts: `F` starts printing `count <n>` lines without pause, `S` stops. */
const countProgram = join(base, "count-program.mjs");
function writeCountProgram() {
  writeFileSync(countProgram, `process.stdin.setRawMode(true);
let n = 0, timer = null;
process.stdin.on("data", (data) => {
  if (data.includes(70) && timer === null) timer = setInterval(() => { for (let i = 0; i < 20; i++) process.stdout.write("count " + ++n + "\\n"); }, 1);
  if (data.includes(83) && timer !== null) { clearInterval(timer); timer = null; process.stdout.write("stopped " + n + "\\n"); }
});
process.stdout.write(process.argv[2] + "-ready:\\n");
`);
}
/** The last count a capture of the pane in window `id` shows, or null. */
const lastCount = (text) => { const all = [...String(text).matchAll(/count (\d+)/g)]; return all.length ? Number(all.at(-1)[1]) : null; };

test(`a hidden tab that floods is marked once and paused: its pane is still read, nothing of it is drawn, and shown again its first screen is the pane's current one, and it is drawn as it goes on (${TMUX_VERSION})`, { skip: NO_TMUX }, async (t) => {
  writeCountProgram();
  writeTabProgram();
  const p = tabsPanel(t, "flood");
  const { id: flood } = await p.panel.open({ argv: [process.execPath, countProgram, "flood"], cols: 60, rows: 10 });
  await waitUntil(() => p.screens.some((screen) => screen.id === flood && screen.screen.includes("flood-ready:")), "the flooding tab drawn", budget(15000));
  const { id: quiet } = await p.panel.open({ argv: [process.execPath, tabProgram, "quiet"], cols: 60, rows: 10, instead: flood });
  await waitUntil(() => p.screens.some((screen) => screen.id === quiet && screen.screen.includes("quiet-ready:")), "the quiet tab drawn", budget(15000));
  const pane = () => tmuxOn(p.socket, "capture-pane", "-p", "-t", flood);
  const from = p.screens.length;
  // Hidden, it floods: marked once, and its pane goes on (tmux still reads a paused pane).
  tmuxOn(p.socket, "send-keys", "-t", flood, "-l", "F");
  await waitUntil(() => p.activity.some((event) => event.id === flood), "the hidden tab marked", budget());
  const early = lastCount(pane());
  await waitUntil(() => (lastCount(pane()) ?? 0) > (early ?? 0) + 500, "its pane still read while paused", budget());
  assert.deepEqual(p.activity, [{ id: flood }], "marked once, whatever it printed");
  assert.deepEqual(screensOf(p, flood, from), [], "nothing drawn of it");
  // Shown: its first screen is the pane's current one (no older count than the pane had just
  // before), and it goes on being drawn.
  const before = lastCount(pane()), shownFrom = p.screens.length;
  p.panel.show(flood);
  await waitUntil(() => screensOf(p, flood, shownFrom).length > 0, "a capture of the tab shown", budget());
  const first = lastCount(screensOf(p, flood, shownFrom)[0].screen);
  assert.ok(first !== null && first >= before, `the first screen is current: ${first} after ${before}`);
  await waitUntil(() => (lastCount(screensOf(p, flood, shownFrom).at(-1).screen) ?? 0) > first + 500, "drawn as it goes on", budget());
  tmuxOn(p.socket, "send-keys", "-t", flood, "-l", "S");
});

test("removing a group: one of the two displayed closed, its window goes, nothing is shown, the other still displayed and captured, and typed to after focus()", { skip: NO_TMUX }, async (t) => {
  writeTabProgram();
  const p = tabsPanel(t, "ungroup");
  const stays = await p.tab("stays");
  const { id: goes } = await p.panel.open({ argv: [process.execPath, tabProgram, "goes"], cols: 40, rows: 8, instead: null });
  await waitUntil(() => screensOf(p, goes).some((screen) => screen.screen.includes("goes-ready:")), "the second group's tab drawn", budget(15000));
  p.panel.close(goes);
  assert.deepEqual(p.panel.tabs, { ids: [stays], shown: null, displayed: [stays] }, "the shown one closed: nothing shown, the panel picks no neighbour");
  await waitUntil(() => p.closed.length === 1, "the closed tab's end", budget());
  assert.deepEqual(p.closed[0], { id: goes, status: null, stderr: "", asked: true });
  await waitUntil(() => !panelWindows(p.socket).includes(goes), "its window gone", budget());
  p.panel.input("lost");
  await pause(300);
  assert.equal(p.read(stays, "stays"), "", "with none shown, nothing is typed");
  // Still displayed: its pane's change is captured.
  const from = p.screens.length;
  tmuxOn(p.socket, "send-keys", "-t", stays, "-l", "o");
  await waitUntil(() => screensOf(p, stays, from).some((screen) => screen.screen.includes("stays-ready:o")), "the remaining tab still captured", budget());
  p.panel.focus(stays);
  assert.deepEqual(p.panel.tabs, { ids: [stays], shown: stays, displayed: [stays] });
  p.panel.input("s");
  await waitUntil(() => p.read(stays, "stays") === "os", "typed to after focus()", budget());
  // A resize of the panel's one group now: its window, captured at the size.
  p.panel.resize(70, 12, [stays]);
  await waitUntil(() => p.sizes()[stays] === "70x12" && screensOf(p, stays).at(-1).screen.split("\n").length === 12, "the remaining group at the whole panel's size", budget());
});

// Every way out with FOUR tabs open, each a kernel viewer of the agent (four viewer sessions on the
// agents' server), TWO of them displayed (one per group of a split, at two sizes: the first two
// opened side by side, then the third in the first's place and the fourth in the second's). The
// program is the panel under the TUI's own guard (packages/tui/lib/term/tty.mjs, createGuard: the
// signals, an uncaught error, `onEnd`), in a terminal: `q` ends it as the TUI's q does, `!` throws
// from a timer as a crash would. It writes the tabs' ids to its mark once all four are open.
const tabsProgram = join(base, "tabs-program.mjs");
const TTY_MODULE = resolve(new URL("../packages/tui/lib/term/tty.mjs", import.meta.url).pathname);
function writeTabsProgram() {
  writeFileSync(tabsProgram, `import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanel } from ${JSON.stringify(PANEL_MODULE)};
import { createGuard } from ${JSON.stringify(TTY_MODULE)};
const [mark, cli, home] = process.argv.slice(2);
const run = mkdtempSync(join(tmpdir(), "oats-tui-"));
const panel = createPanel({ dir: () => run, env: process.env, capture: (text) => text });
const guard = createGuard({ stdin: process.stdin, stdout: process.stdout, proc: process, frame: () => "",
  onInput: (bytes) => { if (bytes.includes(113)) guard.finish(0); else if (bytes.includes(33)) setTimeout(() => { throw new Error("a crash"); }); },
  onResize: () => {}, onRedraw: () => {}, onEnd: () => panel.end() });
guard.start();
const ids = [];
const viewer = [process.execPath, cli, "session", "attach", "--home", home];
ids.push((await panel.open({ argv: viewer, cols: 60, rows: 10 })).id);
ids.push((await panel.open({ argv: viewer, cols: 40, rows: 8, instead: null })).id);
ids.push((await panel.open({ argv: viewer, cols: 60, rows: 10, instead: ids[0] })).id);
ids.push((await panel.open({ argv: viewer, cols: 40, rows: 8, instead: ids[1] })).id);
writeFileSync(mark, JSON.stringify({ ids, run, tabs: panel.tabs }));
const { status } = await guard.done;
process.exit(status);
`);
}

for (const [how, end, expected] of [
  ["q", (term) => term.type("q"), 0],
  ["SIGTERM", (term, pid) => process.kill(pid, "SIGTERM"), 143],
  ["SIGHUP", (term, pid) => process.kill(pid, "SIGHUP"), 129],
  ["kill -9", (term, pid) => process.kill(pid, "SIGKILL"), 137],
  ["a crash", (term) => term.type("!"), 1],
]) {
  test(`${how} with four tabs open, two displayed: no viewer session of any tab is left on the agents' server, no private server answers, and the agent is untouched`, { skip: NO_TMUX }, async (t) => {
    writeTabsProgram();
    await agentWindow();
    const term = await terminal(t);
    const n = ++started, tmp = tmpFor();
    const pidFile = join(base, `tabs-${n}.pid`), statusFile = join(base, `tabs-${n}.status`), mark = join(base, `tabs-${n}.json`);
    await term.command(`sh -c ${shq(`echo $$ > ${shq(pidFile)}; TMPDIR=${shq(tmp)} exec ${shq(process.execPath)} ${shq(tabsProgram)} ${shq(mark)} ${shq(CLI)} ${shq(world.home)}`)}; echo $? > ${shq(statusFile)}`, "the tabs program");
    const status = () => { const text = existsSync(statusFile) ? readFileSync(statusFile, "utf8") : ""; return /^\d+\n$/.test(text) ? Number(text) : null; };
    await until(term, () => existsSync(mark) || status() !== null, "the four tabs open", () => [`status ${status()}`], 60000);
    assert.equal(status(), null, `the program still runs:\n${term.shows()}`);
    const { ids, run, tabs } = readJson(mark), socket = panelSocket(run), pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.equal(ids.length, 4);
    assert.deepEqual(tabs, { ids, shown: ids[3], displayed: [ids[2], ids[3]] }, "four tabs, two of them displayed");
    await until(term, () => viewerSessions().length === 4 && viewerSessions().every((session) => attached().includes(session)), "four viewer sessions, each attached", () => [`viewer sessions: ${JSON.stringify(viewerSessions())}, attached: ${JSON.stringify(attached())}`], 30000);
    assert.equal(panelWindows(socket).length, 5, "the keeper and the four tabs");
    const sizes = Object.fromEntries(lines(tmuxOn(socket, "list-windows", "-t", "=oats-tui", "-F", "#{window_id} #{window_width}x#{window_height}")).map((row) => row.split(" ")));
    assert.deepEqual(ids.map((id) => sizes[id]), ["60x10", "40x8", "60x10", "40x8"], "each window at its group's size");
    const kept = keepViewFiles(run, `tabs${how.replace(/\W/g, "")}`), before = viewerProcesses();
    await end(term, pid);
    await until(term, () => status() !== null, `the program to end after ${how}`);
    assert.equal(status(), expected, term.shows());
    await until(term, () => !alive(pid), `the process ${pid} to be gone after ${how}`);
    await until(term, () => !answers(socket), `the private server's socket to refuse after ${how}`);
    await until(term, () => viewerSessions().length === 0, `no viewer session on the agents' server after ${how}`, () => [`viewer sessions: ${JSON.stringify(viewerSessions())}`, ...viewerFaults(kept, before)], 30000);
    assert.deepEqual(viewerTableFaults(), [], `no viewer's own key table on the agents' server after ${how}`);
    assert.equal(agentWindowThere(), true, `the agent keeps running after ${how}`);
    assert.equal(existsSync(socket), how === "kill -9", how === "kill -9" ? "a run killed with no way to clean up leaves its socket for the sweep" : `the socket is removed after ${how}`);
  });
}

// ---- four agents, four tabs ---------------------------------------------------------------------
// q and kill -9 as with one terminal open (the tests after "on a terminal"), with the real `oats tui`
// and four agents' terminals open, each a tab, opened as a person opens them: Enter on the first
// agent, then Alt+Shift+Down from each shown terminal, which opens the next agent of the list
// (on macOS, where that is no chord, the list's j then Enter: openTab) (docs/tui.md, "Tabs" and
// "Chords"). The three agents beside alpha are these tests' own: homes recorded as launched in
// windows of AGENTS as alpha's is (launchedAgent), spawned at the first of them, each window made
// new by each test and killed after it, so nothing after them lists those
// agents running.
const OTHERS = ["bravo", "charlie", "delta"];
/** The four agents, in the order the list draws them (newest first: alpha was spawned before the
 *  others, delta last) and so the tabs are opened. */
const FOUR = [...OTHERS].reverse().concat(NAME);
let othersSpawned = null;
/** The four agents' windows, new; the three others' homes spawned at the first call, and their
 *  windows killed after the test. */
async function fourAgents(t) {
  othersSpawned ??= (async () => { for (const name of OTHERS) await launchedAgent(name); })();
  await othersSpawned;
  t.after(() => { for (const name of OTHERS) { try { killAgentWindow(name); } catch { /* gone */ } } });
  for (const name of FOUR) await agentWindow(name);
}
/** The names in the tab bar, the panel's top row (the screen's first), in its order: the tabs
 *  between its dividers (`│`), the shown tab's brackets, its number and a hidden tab's mark (`•`)
 *  dropped. The numbers are checked by stripNumbers. */
const stripNames = (run) => (run.panel()[0] ?? "").split("│").map((tab) => tab.trim().replace(/^\[(.*)\]$/, "$1").replace(/ \d$/, "").replace(/•$/, "")).filter(Boolean);
/** The tabs' numbers in the tab bar, in its order, or null for a tab with none. */
const stripNumbers = (run) => (run.panel()[0] ?? "").split("│").map((tab) => tab.trim().replace(/^\[(.*)\]$/, "$1")).filter(Boolean).map((tab) => / (\d)$/.exec(tab)?.[1] ?? null);
/** The row of agent `name` is selected and running, read from the list's columns. */
const selectedRunning = (term, name) => term.screen().some((text) => new RegExp(`^> +● ${instanceDisplayName(name)}$`).test([...text].slice(0, LIST_BESIDE).join("").trimEnd()));
/** The tab of FOUR[k]: Enter on the selected agent for the first, then for each next one
 *  Alt+Shift+Down (`next`, the instance move: the leader's Down moves between workspaces) from the
 *  terminal shown. It is one key, so no read can split it from a leader; it does not repeat safely
 *  (a second one opens the agent after), so it is pressed once. On macOS, where that is no chord
 *  (docs/tui.md, "Chords on macOS"), the list's way: the leader then Esc, then `j` once its sheet is
 *  drawn and past the key parser's wait after an ESC (a retried pair's Esc and `j` together would
 *  read as Alt+J), then Enter once the next agent's row is selected. `j`, not Down: one byte, never
 *  a sequence of its own after an ESC.
 *  Resolves once its viewer's session is attached, its screen is in the panel with the focus in it,
 *  its row is selected, and the strip names every agent opened so far, in the order opened. */
async function openTab(term, run, k) {
  const name = FOUR[k], before = new Set(viewerSessions());
  if (k > 0 && process.platform === "darwin") {
    await run.back();
    await pause(ESC_WAIT_MS);
    term.press("j");
    await until(term, () => selectedRunning(term, name), `${name}'s row selected, before its Enter`);
    term.press("Enter");
  } else term.press(k === 0 ? "Enter" : "M-S-Down");
  const opened = FOUR.slice(0, k + 1);
  await until(term, () => {
    assert.equal(run.status(), null, `oats tui ended opening ${name}`);
    const session = viewerSessions().find((s) => !before.has(s));
    return session !== undefined && attached().includes(session) && run.beside() && run.sheet() === backWith(k + 1) && selectedRunning(term, name) && JSON.stringify(stripNames(run)) === JSON.stringify(opened)
      && JSON.stringify(stripNumbers(run)) === JSON.stringify(opened.map((_, i) => (NUMBERED ? String(i + 1) : null)));
  }, `the tab of ${name}: its viewer attached, its screen in the panel with the focus in it, its row selected, and the tab bar naming ${JSON.stringify(opened)}, numbered from 1 (at ${COLS} columns all four fit with their numbers)`,
  () => [`the tab bar names ${JSON.stringify(stripNames(run))}, numbered ${JSON.stringify(stripNumbers(run))}`, `viewer sessions: ${JSON.stringify(viewerSessions())}, attached: ${JSON.stringify(attached())}`], 30000);
}

for (const [how, end, expected] of [
  ["q", async (term, run) => { await run.back(); await until(term, () => run.sheet().startsWith(LIST_HINTS), "the list's focus before q"); term.press("q"); }, 0],
  ["kill -9", (term, run) => process.kill(run.pid, "SIGKILL"), 137],
]) {
  test(`${how} with four agents' terminals open as tabs of the real oats tui: the private server is gone, no viewer session of any tab and no viewer's own key table is left on the agents' server, and every agent keeps running${how === "kill -9" ? "; the run directory is left for the next run's sweep" : "; the run directory is removed"}`, { skip: NO_TMUX }, async (t) => {
    await fourAgents(t);
    const term = await terminal(t);
    const run = await tui(term, { first: FOUR[0] });
    for (let k = 0; k < FOUR.length; k++) await openTab(term, run, k);
    const dir = run.dir(), socket = panelSocket(dir);
    await until(term, () => viewerSessions().length === 4 && viewerSessions().every((session) => attached().includes(session)), "four viewer sessions, each attached", () => [`viewer sessions: ${JSON.stringify(viewerSessions())}, attached: ${JSON.stringify(attached())}`], 30000);
    assert.equal(panelWindows(socket).length, 5, "the keeper and the four tabs");
    assert.deepEqual(FOUR.map((name) => typed(name)), ["", "", "", ""], "no key of the leader's, nor Enter, reached an agent");
    const kept = keepViewFiles(dir, `four${how.replace(/\W/g, "")}`), before = viewerProcesses();
    await end(term, run);
    assert.equal(await run.ended(`after ${how}`), expected, term.shows());
    await until(term, () => !alive(run.pid), `the process ${run.pid} to be gone after ${how}`);
    await until(term, () => !answers(socket), `the private server's socket to refuse after ${how}`);
    await until(term, () => viewerSessions().length === 0, `no viewer session on the agents' server after ${how}`, () => [`viewer sessions: ${JSON.stringify(viewerSessions())}`, ...viewerFaults(kept, before)], 30000);
    assert.deepEqual(viewerTableFaults(), [], `no viewer's own key table on the agents' server after ${how}`);
    assert.deepEqual(FOUR.filter((name) => !agentWindowThere(name)), [], `every agent keeps running after ${how}`);
    assert.deepEqual(FOUR.map((name) => typed(name)), ["", "", "", ""], "and nothing reached any of them");
    if (how === "kill -9") {
      assert.equal(existsSync(join(dir, "owner.json")), true, "a run killed with no way to clean up leaves its directory, owner.json in it");
    } else {
      assert.equal(existsSync(socket), false, `the socket is removed after ${how}`);
      assert.equal(existsSync(dir), false, `the run directory is removed after ${how}`);
    }
  });
}

test("afterwards no viewer session and no viewer's own key table is on the agents' server, no private server answers, and the terminals' server has the sessions, windows, key bindings and options it had before the first test", { skip: NO_TMUX }, () => {
  assert.deepEqual(viewerSessions(), [], "no oatsview-* session on AGENTS");
  assert.deepEqual(viewerTableFaults(), [], "no viewer's key table on AGENTS");
  assert.deepEqual(sessionsOf(AGENTS), [SESSION], "the agents' server holds its own session only");
  for (const tmp of tmps) for (const dir of runDirs(tmp)) assert.equal(answers(panelSocket(dir)), false, `no private server answers in ${dir}`);
  const after = termServer();
  assert.deepEqual(after.windows, TERM_BEFORE.windows, "TERM's sessions and windows");
  assert.equal(after.keys, TERM_BEFORE.keys, "TERM's key bindings (list-keys)");
  assert.deepEqual(after, TERM_BEFORE, "TERM's options: show-options -g, -s, -gw and -w");
});
