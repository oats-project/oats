// `oats tui` (preview) end to end: the real CLI on a real terminal, reading a fixture deployment
// with the checkout's own kernel.
//
// Real tmux, never the operator's (docs/implementation.md; the conventions of
// test/session-attach-detach-key.test.mjs): the fixture owns a private TMUX_TMPDIR, and the one
// server here is a socket inside the fixture. A terminal is a session of that server whose pane
// runs an interactive shell; the command is typed at it, keys are sent as a terminal sends them,
// the screen is what `capture-pane` prints, and the shell records the exit status. A signal goes
// only to a pid the command's own wrapper wrote down. Every wait is on what a pane shows, on a
// file or on the process table, and the file has a budget: once it is spent every further wait
// fails at once, so a program that hangs cannot hold a shard.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertNoFixtureProcesses, fixtureBase, fixtureEnv, isolateSessionEnvironment, systemExecutable, waitUntil } from "./helpers/host-fixture.mjs";
import { leaderPairs } from "./helpers/leader-pairs.mjs";
import { comparableStty } from "./helpers/stty-line.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { backKeyLabel } from "../packages/tui/lib/actions.mjs";
import { defaultDetachKey } from "../packages/tui/lib/config.mjs";
import { instanceDisplayName } from "../packages/client/instance-display-name.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const hostTool = (name) => { try { return systemExecutable(name); } catch { return null; } };

// The host's own tools, found before the environment is isolated (PATH is then the fixture's).
const REAL_TMUX = hostTool("tmux");
/** Outside CI a host without tmux skips the terminal tests; in CI test/tmux-in-ci.test.mjs fails. */
const NO_TMUX = REAL_TMUX ? false : "tmux is not on PATH: these tests drive `oats tui` in a real tmux (test/tmux-in-ci.test.mjs fails for this in CI)";
const STTY = REAL_TMUX ? systemExecutable("stty") : null; // not one of the fixture's tools: called by its path
const PS = REAL_TMUX ? systemExecutable("ps") : null; // the same: front/tmux asks it who started it, addingToList what a TUI's children run
const base = fixtureBase("oats-tui-"); // short: a socket path lives in it
const restoreEnvironment = REAL_TMUX ? isolateSessionEnvironment(base) : () => {};
const TERM = join(base, "term.sock");

/** Every test starts the real CLI, which reads the fixture with the real kernel before it draws:
 *  on a host twice oversubscribed (a load of 30 on 16 cores) the file took a minute and a half.
 *  A program that never draws would cost a ten-second wait in every test. */
const BUDGET_MS = 180000;
const FILE_DEADLINE = Date.now() + BUDGET_MS;

const tmuxRaw = (...args) => execFileSync("tmux", ["-u", "-S", TERM, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
const tmuxOn = (...args) => tmuxRaw(...args).trim();
const lines = (text) => text.split("\n").filter(Boolean);
/** Everything on the private server: its sessions, windows and panes. The TUI makes none. */
const everything = () => lines(tmuxOn("list-panes", "-a", "-F", "#{session_name} #{window_id} #{pane_id}")).sort();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

if (REAL_TMUX) {
  // One session that only keeps the server: every test makes, and removes, its own.
  tmuxOn("new-session", "-d", "-s", "hold", "-n", "hold", "-x", "80", "-y", "24", "-c", base, "cat");
  tmuxOn("set-option", "-g", "default-terminal", "screen");
}

// ---- a deployment to look at ---------------------------------------------------------------------
/** The variables an OATS instance session carries (packages/client/kernel-environment.mjs): the
 *  TUI removes them from its own environment before it starts a child (docs/tui.md). */
const INSTANCE_VARIABLES = ["PI_AGENTS_ROOT", "PI_AGENT_HOME", "PI_AGENT_INSTANCE", "OATS_HOME", "OATS_INSTANCE_HOME", "OATS_INSTANCE", "OATS_DEPLOYMENT", "OATS_RESOLUTION"];
const withPath = async (path, fn) => { const saved = process.env.PATH; process.env.PATH = path; try { return await fn(); } finally { process.env.PATH = saved; } };

/** A fixture deployment (test/helpers/v2-deployment.mjs) with three instances that never ran:
 *  `alpha` and its child `beta` of the soul `dev`, and `gamma` of the soul `reviewer`, alone.
 *  `gamma` is spawned first: the list is newest first (docs/tui.md), so alpha's cluster is on top.
 *  `souls` and `capabilities` are the fixture's (v2Deployment's options): a test that needs a
 *  capability makes a world of its own with one.
 *  `enter` is a script that sets the fixture's environment and then becomes its arguments: a
 *  terminal's shell is started through it, so the TUI typed there reads this deployment with the
 *  fixture's home, cache and tools, as `fx.cli` does.
 *
 *  A home that never ran has no recorded tmux socket, and for such a home the shared liveness
 *  collector asks the default tmux server, which no test may reach. So the first `tmux` on that
 *  PATH is `front/tmux`: it asks the fixture's own `oats` server instead, which nothing started,
 *  and real tmux answers that no server runs: every row is `stopped`. It writes down the
 *  environment it was started with. While the file `hold` exists it does not answer the collector
 *  (the process that started it runs liveness-main.mjs) or the kernel's own `oats status` read (a
 *  kernel with feature status-liveness reads the liveness itself, and its TUI runs no collector;
 *  every kernel's status asks tmux, `tmux -V` at least): it starts a `sleep` of half a minute,
 *  writes that pid to `held` and waits for it: a read that stays in flight. The sleep is in the
 *  process group of that collector or kernel and outlives its own time limit for tmux, so when it
 *  is gone long before its time, the TUI ended the group. Every other caller is answered as ever:
 *  the kernel's machine sweep, which the TUI runs when it opens (`oats session resume`), reads the
 *  deployment's status and with it tmux, and is a change the TUI never ends, not a read; and the
 *  warm reader (`oats reader --stdio`) answers only background reads, never the refresh key's. */
async function deployment(t, { souls = { dev: {}, reviewer: {} }, capabilities = {} } = {}) {
  const fx = v2Deployment({ souls, capabilities, t });
  const world = { fx, dep: fx.dep, enter: join(fx.base, "enter.sh"), holdFile: join(fx.base, "hold"), heldFile: join(fx.base, "held"), seenFile: join(fx.base, "collector-tmux.env") };
  world.spawn = (soul, options) => withPath(fx.env.PATH, () => fx.spawn(soul, { harness: "claude", ...options }));
  await world.spawn("reviewer", { name: "gamma" });
  world.home = (await world.spawn("dev", { name: "alpha" })).home;
  await world.spawn("dev", { name: "beta", relativeTo: "alpha", relation: "child" });
  const front = world.front = join(fx.base, "front");
  mkdirSync(front);
  writeFileSync(join(front, "tmux"), `#!/bin/sh
env > ${shq(world.seenFile)}
if [ -e ${shq(world.holdFile)} ]; then case "$(${shq(PS)} -o args= -p $PPID 2>/dev/null)" in *liveness-main*|*/bin/oats.mjs\\ status\\ *) sleep 30 < /dev/null > /dev/null 2>&1 & echo $! >> ${shq(world.heldFile)}; wait; exit 1;; esac; fi
exec ${shq(join(base, "system-bin", "tmux"))} -L oats "$@"
`, { mode: 0o755 });
  const env = world.env = { ...fx.env, PATH: `${front}:${fx.env.PATH}` };
  writeFileSync(world.enter, `#!/bin/sh\n${Object.entries(env).map(([name, value]) => `export ${name}=${shq(value)}`).join("\n")}\nexec "$@"\n`);
  /** The pids of the sleeps that held a read, in the order they started. */
  world.held = () => (existsSync(world.heldFile) ? lines(readFileSync(world.heldFile, "utf8")).map(Number) : []);
  world.release = () => rmSync(world.holdFile, { force: true });
  return world;
}
/** The deployment most tests look at; a test that changes one makes its own. */
const WORLD = REAL_TMUX ? await deployment() : null;

/** A world of its own with one machine registered, `garnet`, which is never reached: the other
 *  worlds keep a registry with no machine, so no TUI of theirs reads another machine.
 *  The kernel keeps registered machines in `$OATS_HOME_DIR/servers.json` and reaches one by
 *  running `ssh` as found on PATH (lib/servers.mjs). So the registry is the fixture's own, and
 *  the first `ssh` on the fixture's PATH is `front/ssh`, which connects nowhere: it writes its pid
 *  to `sshCallsFile` each time it is started, prints one line on stderr and exits 255, which the
 *  kernel's roster answers as a machine that was not reached. While the file `sshHoldFile` exists
 *  it does not exit: it starts a `sleep` of half a minute, writes that pid to `sshHeldFile` and
 *  waits for it, as `front/tmux` does: a roster read that stays in flight. The sleep is in the
 *  process group of the kernel that reads the roster and outlives the twenty seconds that kernel
 *  gives a machine, so when it is gone long before its time, the TUI ended that group.
 *  The machine is registered with the real kernel, `oats server add`, which writes the
 *  registration and then asks the host once through `ssh` for its workspace key: it is run only
 *  after the two checks below, so it can neither write under the user's `~/.oats` nor start the
 *  real `ssh`. */
async function machineWorld(t) {
  const world = await deployment(t);
  const { fx } = world;
  Object.assign(world, { sshHoldFile: join(fx.base, "ssh-hold"), sshHeldFile: join(fx.base, "ssh-held"), sshCallsFile: join(fx.base, "ssh-calls") });
  const ssh = join(world.front, "ssh");
  writeFileSync(ssh, `#!/bin/sh
echo $$ >> ${shq(world.sshCallsFile)}
if [ -e ${shq(world.sshHoldFile)} ]; then sleep 30 < /dev/null > /dev/null 2>&1 & echo $! >> ${shq(world.sshHeldFile)}; wait; exit 255; fi
echo 'ssh: the fake ssh of a test connects nowhere' >&2
exit 255
`, { mode: 0o755 });
  const numbers = (file) => (existsSync(file) ? lines(readFileSync(file, "utf8")).map(Number) : []);
  /** The pids of the sleeps that held a roster read, in the order they started. */
  world.sshHeld = () => numbers(world.sshHeldFile);
  /** How often the fake `ssh` was started. */
  world.sshCalls = () => numbers(world.sshCallsFile).length;
  world.holdSsh = () => writeFileSync(world.sshHoldFile, "");
  // The list of workspaces under the fixture's row: the machine, which matched no workspace, a row
  // of the same flat list, its name alone (whatever the roster read said of it).
  world.listed = [/^ {2}garnet$/];
  const releaseTmux = world.release;
  world.release = () => { releaseTmux(); rmSync(world.sshHoldFile, { force: true }); };

  try {
    const registry = join(fx.base, "oats-home");
    assert.equal(world.env.OATS_HOME_DIR, registry, "the registry `oats server add` writes is the fixture's own");
    const found = spawnSync(join(base, "system-bin", "sh"), ["-c", "command -v ssh"], { env: world.env, encoding: "utf8", timeout: 10000 });
    assert.equal(found.stdout, `${ssh}\n`, `the first ssh on the fixture's PATH is the fake (${world.env.PATH})`);
    const added = fx.cli(["server", "add", "garnet", "--ssh", "garnet-host", "--workspace", "/srv/acme-platform"], { env: world.env });
    assert.equal(added.status, 0, `oats server add in the fixture: ${added.stderr}`);
    assert.ok(existsSync(join(registry, "servers.json")), "the registration is in the fixture's registry");
    assert.equal(world.sshCalls(), 1, "oats server add asked the host once, through the fake ssh");
  } catch (error) {
    if (!t) fx.cleanup(); // with a test, the fixture's own clean-up is registered
    throw error;
  }
  return world;
}
/** The world with the machine, for the tests that read a roster and change nothing. */
const MACHINES = REAL_TMUX ? await machineWorld() : null;

/** The process group a process is in: /proc's field where there is a /proc, else what `ps` says
 *  (macOS has no /proc). Null unless that is a number. As `groupOf` in
 *  packages/tui/test/read.test.mjs, which reads the same field with a helper of its own. */
function groupOf(pid) {
  try {
    const stat = existsSync("/proc/self/stat") ? readFileSync(`/proc/${pid}/stat`, "utf8") : null;
    const text = stat !== null ? stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2] : execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 10000 }).trim();
    return /^[0-9]+$/.test(text ?? "") ? Number(text) : null;
  } catch { return null; }
}

/** What keeps the process `pid` from having heard the end of the add of its deployment to this
 *  computer's list, as rows of `ps`, none once it has: a child runs `oats deployments add`, or a
 *  child is on its way out and not yet reaped. The TUI takes a change off its list where it reaps
 *  the child, and a child stops showing what it ran before that: first its arguments go, and `ps`
 *  prints its name in brackets (in parentheses on macOS) with the process still running, and then
 *  it is a zombie. One `-o` a column, since BSD's `ps` reads a comma after `=` as more of the
 *  heading; `-ww`, since its width is not lifted for a pipe. */
function addingToList(pid) {
  const rows = lines(execFileSync(PS, ["-ww", "-A", "-o", "ppid=", "-o", "stat=", "-o", "args="], { encoding: "utf8", timeout: 10000 }));
  return rows.filter((row) => {
    const [, parent, state, args] = row.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/) ?? [];
    return Number(parent) === pid && (state.startsWith("Z") || /^[[(]/.test(args) || args.includes("/bin/oats.mjs deployments add "));
  });
}

test.after(() => {
  if (REAL_TMUX) { try { execFileSync(REAL_TMUX, ["-S", TERM, "kill-server"], { stdio: "ignore", timeout: 10000 }); } catch { /* not running */ } }
  const errors = [];
  // Every TUI of this file ran in `base`, and so did its children: none is left (the SIGKILL case
  // leaves a collector that ends by itself, within the check's own wait).
  if (REAL_TMUX) { try { assertNoFixtureProcesses(base, { settleMs: 6000 }); } catch (error) { errors.push(error); } }
  try { WORLD?.fx.cleanup(); } catch (error) { errors.push(error); }
  try { MACHINES?.fx.cleanup(); } catch (error) { errors.push(error); }
  restoreEnvironment();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (errors.length) throw errors[0];
});

// ---- what the program says, as the spec gives it ------------------------------------------------
const TUI = `${shq(process.execPath)} ${shq(CLI)} tui`;
const PROMPT = "tui-test$";
const USAGE = "oats tui [--dir <path>] [--ascii]";
/** The leader: the default (C-x, Ctrl+X, on every platform), as tmux's
 *  send-keys names it too, and as the cheat sheet and the help spell it. */
const LEADER_KEY = defaultDetachKey(), LEADER = backKeyLabel(LEADER_KEY);
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The first row of the cheat sheet in every focus (docs/tui.md, "The cheat sheet"), as the screen
 *  shows it: only the TUI draws it, so a screen without it is not the TUI's. */
const LEAD_ROW = new RegExp(`^ ${literal(LEADER)} +commands(?: |│|\\||$)`);
/** The rows of the cheat sheet, each a key and what it does (docs/tui.md, "The cheat sheet"): the
 *  leader first in every focus, then the palette. */
const LEAD_HINT = [LEADER, "commands"], PALETTE_HINT = ["Ctrl+K", "palette"], LAST_HINTS = [["?", "help"], ["q", "quit"]];
/** The Instances view's sheet, the list focused: small, the same whatever row is selected (or
 *  none). Every instance here is stopped (it never ran), so Enter opens nothing and is not named;
 *  `w workspaces` follows `n spawn`; the acts, the filter, the detail and refresh are the leader's
 *  hint's, the palette's and the help's, never the sheet's. */
const LIST_SHEET = [LEAD_HINT, PALETTE_HINT, ["n", "spawn"], ["w", "workspaces"], ...LAST_HINTS];
/** With a filter kept: the list's sheet; Esc still clears the filter, unnamed there. */
const KEPT_SHEET = LIST_SHEET;
/** While the filter's text is typed: its own keys. */
const FIELD_SHEET = [LEAD_HINT, ["Enter", "keep"], ["Esc", "clear"]];
/** With the detail focused: Tab goes back to the list, then the list's. */
const DETAIL_SHEET = [LEAD_HINT, PALETTE_HINT, ["Tab", "back"], ["n", "spawn"], ["w", "workspaces"], ...LAST_HINTS];
const HELP_SHEET = [LEAD_HINT, PALETTE_HINT, ["Esc", "close"], ...LAST_HINTS];
/** The switcher's, with a workspace open (Esc closes it onto that workspace's view). */
const SWITCHER_SHEET = [LEAD_HINT, PALETTE_HINT, ["Enter", "open"], ["/", "filter"], ["r", "refresh"], ["Esc", "close"], ...LAST_HINTS];
/** The rows the sheet draws for `hints`: the key at the margin, what it does in a column of its
 *  own three cells after the widest key. */
const sheetRows = (hints) => {
  const widest = Math.max(...hints.map(([key]) => key.length));
  return hints.map(([key, word]) => ` ${key.padEnd(widest)}   ${word}`);
};
/** The switcher's two headings (the first is the shared home's, the second the TUI's own), and the
 *  TUI's row for a roster read that failed before any answer. */
const UNMATCHED = "  Not matched to a workspace";
const OFFERED = "  On this machine, not opened";
const ROSTER_FAILED = "Other machines were not read.";
/** The help's first rows on Linux and Windows, where the Alt family's chords lead it (every one is
 *  read in any terminal): the family's line, then a row per chord with the leader's key under it. */
const HELP_CHORDS = [
  /^ *Alt\+K {2,}palette, or$/, /^ {2,}Ctrl\+X then k$/, /^ *Alt\+P {2,}spawn, or$/, /^ {2,}Ctrl\+X then n$/,
  /^ *Alt\+O {2,}workspaces, or$/, /^ {2,}Ctrl\+X then o$/, /^ *Alt\+Shift\+Up\/Down {2,}previous and$/, /^ {2,}next instance$/,
];
/** The help's first rows on macOS, where the chords are the Alt (Option) arrows alone (docs/tui.md,
 *  "Chords on macOS"): a row per pair with the leader's keys under it. */
const HELP_MAC_CHORDS = [
  /^ *Alt\+Up\/Down {2,}previous and$/, /^ {2,}next$/, /^ {2,}workspace, or$/, /^ {2,}Ctrl\+X then Up$/, /^ {2,}and Down$/,
  /^ *Alt\+Left\/Right {2,}previous and$/, /^ {2,}next tab, or$/, /^ {2,}Ctrl\+X then$/, /^ {2,}Left and Right$/,
];
/** The help's first section and its rows: the chords lead it everywhere (every one is read in any
 *  terminal), the Alt family's on Linux and Windows, the Alt arrows on macOS (docs/tui.md, "Chords"). */
const HELP_FIRST = process.platform === "darwin"
  ? { title: "Chords", rows: HELP_MAC_CHORDS, first: "`Alt+Up/Down  previous and`", lead: /^ {2}Shortcuts on macOS: / }
  : { title: "Chords", rows: HELP_CHORDS, first: "`Alt+K  palette, or`", lead: /^ {2}Shortcuts: Alt\. / };
const NO_TERMINAL = "oats: `oats tui` needs a terminal on stdin and stdout (E_NO_TERMINAL); `oats status` prints the instances once";
const noDeployment = (dir) => `oats: no OATS deployment at or above ${dir} (E_NO_DEPLOYMENT); name one with \`oats tui --dir <path>\``;
/** The same start with no `--dir`, when this computer's list of deployments holds none (awebai/oats#1390). */
const noDeploymentListed = (dir) => `oats: no deployment at or above ${dir}, and this computer's list of deployments holds none (E_NO_DEPLOYMENT): \`oats tui --dir <path>\` opens one (and lists it), \`oats onboard <dir> --workspace <ref>\` creates one`;
/** Whether the kernel of this checkout lists this computer's deployments (`oats deployments`,
 *  feature deployments-list): a start outside every deployment with no `--dir` reads that list. */
const LISTS = /"deployments-list"/.test(spawnSync(process.execPath, [CLI, "version", "--json"], { encoding: "utf8", timeout: 20000 }).stdout ?? "");
const NO_LIST = LISTS ? false : "this kernel has no `oats deployments` (feature deployments-list, awebai/oats#1390)";
/** This computer's list of deployments as the kernel keeps it (`$OATS_HOME_DIR/config/deployments.json`,
 *  schema 1), written for a test of its own: `paths` canonical, and the one-time import of `~/Agents`
 *  marked done, so the kernel lists these and no other. Its OATS_HOME_DIR. */
function listedHome(dir, paths) {
  mkdirSync(join(dir, "config"), { recursive: true, mode: 0o700 });
  const at = "2026-10-19T10:00:00.000Z";
  writeFileSync(join(dir, "config", "deployments.json"), JSON.stringify({ schemaVersion: 1, deployments: paths.map((path) => ({ path, addedAt: at, via: "cli" })), imports: { "agents-dir": at } }), { mode: 0o600 });
  return dir;
}
const tooSmallLine = (cols, rows) => `Terminal too small: ${cols}x${rows}, oats tui needs 60x15.`;
const UTF8 = { locale: "C.UTF-8", rule: "─", bar: "│", stopped: "○" };
const ASCII = { locale: "C", rule: "-", bar: "|", stopped: "-" };
/** The columns of the sidebar where the terminal is wide enough for the main area beside it
 *  (docs/tui.md); under 80 columns the sidebar has the whole width. */
const listCols = (cols) => (cols >= 80 ? Math.min(60, Math.max(36, Math.floor(cols * 0.48))) : cols);
/** The sidebar's part of each row (trailing blanks cut), and the main area's: from two cells after
 *  the rule between them, where the detail and every overlay stand. */
const sidebarOf = (screen, cols = 80) => screen.map((text) => [...text].slice(0, listCols(cols)).join("").trimEnd());
const mainOf = (screen, cols = 80) => screen.map((text) => [...text].slice(listCols(cols) + 2).join(""));
/** A view's row of the sidebar's accordion, `width` cells wide: its name, and its key at the
 *  right, a cell from the edge. Given `name` with no key, the row as it stands (a heading that
 *  names a filter). */
const viewRow = (name, key, width = listCols(80)) => `${` ${name}`.padEnd(width - 2)}${key}`;
/** The cheat sheet on a screen as words: each row its key and what it does with the run of blanks
 *  between them made one space, from the leader's row (`commands`) to the first empty row; []
 *  when the screen draws no sheet. */
function sheetOf(screen, cols = 80) {
  const side = sidebarOf(screen, cols).map((text) => text.trim().replace(/ {2,}/g, " "));
  const first = side.findIndex((text) => text === `${LEADER} commands`);
  if (first < 0) return [];
  const end = side.indexOf("", first);
  return side.slice(first, end < 0 ? undefined : end);
}

/** Hints as sheetOf reads them: `key word`. */
const words = (hints) => hints.map(([key, word]) => `${key} ${word}`);
/** Whether the cheat sheet on a screen begins with `hints`. */
const sheetStarts = (screen, hints) => JSON.stringify(sheetOf(screen).slice(0, hints.length)) === JSON.stringify(words(hints));
/** The leader, then a key in a later read, pressed until what the key does is seen (helpers/leader-pairs.mjs). */
const pairs = leaderPairs({ leaderKey: LEADER_KEY, pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), waitUntil, deadline: FILE_DEADLINE, until });
/** Whether `name`'s view is the open one: its heading under a rule, the view before it just above
 *  the rule (the accordion: an open view's list stands under its heading, so the next heading has a
 *  rule above it, and the one before the open view has none between them). Opening a view that is
 *  open changes nothing, so its pair repeats safely. */
function viewOpen(screen, name, key, before) {
  const side = sidebarOf(screen), at = side.indexOf(viewRow(name, key));
  return at >= 2 && side[at - 1] === UTF8.rule.repeat(listCols(80)) && side[at - 2] === before;
}
/** The open view's list on a screen: the sidebar's rows under its heading (`heading`, that row as
 *  it stands), down to the rule under them. */
function listUnder(screen, heading, cols = 80) {
  const side = sidebarOf(screen, cols), at = side.indexOf(heading), end = at < 0 ? -1 : side.indexOf(UTF8.rule.repeat(listCols(cols)), at + 1);
  return at < 0 ? [] : side.slice(at + 1, end < 0 ? undefined : end);
}

/** The sidebar, the same in every view: what is wrong with it (docs/tui.md, "What it shows").
 *  From the top: the list of workspaces, whose first row is the open one's (`title`: the
 *  fixture's name alone, no count) and its other rows `listed` (each a string, or what it
 *  matches), or the title alone where no workspace is listed (the switcher's), the rows `above` (each a
 *  string, or what it matches: a deployment's state and reason), an empty row, then the views
 *  Instances, Souls and Capabilities, each with its key, the `open` one's heading (`heading`, its
 *  row unless given) with its list under it and a rule between it and each view beside it; a
 *  rule, then the cheat sheet `sheet` (its first rows, as many as the rows left hold, the leader's
 *  at least), and nothing under it. From 80 columns the rule between the sidebar and the main
 *  area (`look.bar`) stands on every row. Answers the faults and the rows of the open view's list. */
function sidebarFaults(screen, { cols = 80, rows = 24, look = UTF8, title = "  fixture", listed = [], above = [], open = "instances", heading, sheet }) {
  const faults = [], width = listCols(cols), side = sidebarOf(screen, cols), rule = look.rule.repeat(width);
  const expect = (row, want, what) => {
    const got = side[row] ?? "";
    if (want instanceof RegExp ? !want.test(got) : got !== want) faults.push(`${what} (row ${row + 1}) is ${JSON.stringify(side[row])}, not ${want instanceof RegExp ? want : JSON.stringify(want)}`);
  };
  if (screen.length !== rows) faults.push(`the screen has ${screen.length} rows, not ${rows}`);
  if (screen.some((row) => [...row].length > cols)) faults.push(`a row is longer than ${cols} cells`);
  if (cols >= 80) screen.forEach((text, i) => { if ([...text][width] !== look.bar) faults.push(`row ${i + 1} has no ${look.bar} in column ${width + 1}, between the sidebar and the main area: ${JSON.stringify(text)}`); });
  let r = 0, list = [];
  expect(r++, title, "the title");
  for (const want of listed) expect(r++, want, "a row of the list of workspaces");
  for (const want of above) expect(r++, want, "a row under the title");
  expect(r++, "", "the empty row over the views");
  const views = [["Instances", "1", "instances"], ["Souls", "2", "souls"], ["Capabilities", "3", "capabilities"]];
  const at = views.findIndex(([, , id]) => id === open);
  views.forEach(([name, key], i) => {
    if (i === at && i > 0) expect(r++, rule, `the rule over ${name}, the open view`);
    expect(r++, i === at && heading !== undefined ? heading : viewRow(name, key, width), i === at ? `the heading of ${name}, the open view` : `the row of ${name}`);
    if (i !== at) return;
    const end = side.indexOf(rule, r);
    list = side.slice(r, end < 0 ? r : end);
    if (end >= 0) r = end;
    if (i < views.length - 1) expect(r++, rule, `the rule under the list of ${name}`);
  });
  expect(r++, rule, "the rule over the cheat sheet");
  const kept = sheet.slice(0, Math.max(1, Math.min(sheet.length, rows - r)));
  for (const want of sheetRows(kept)) expect(r++, want, "a row of the cheat sheet");
  for (; r < rows; r++) expect(r, "", "a row under the cheat sheet");
  return { faults, list };
}
/** What keeps a screen from being the Instances view of the fixture at that size: nothing, when
 *  it is that view. `selected` is the instance the selection is on; `folded`: `alpha` is
 *  collapsed; `gone`: names no row shows (folded away, or hidden by the filter); `extra`: names of
 *  instances a test added; `detail`: the detail holds the focus; `heading`: the open view's
 *  heading, when a filter is typed or kept; `sheet`: the cheat sheet. With every row hidden the
 *  list says that nothing matches the filter, and the detail is empty.
 *  With nothing hidden the list is the Desktop's order, row for row: the cluster, an empty row,
 *  the single instance. With something hidden only what the shared grouping promises whatever it
 *  hides is asserted: which rows are drawn, each once, and which is selected; not where a row
 *  stands among the groups (awebai/oats#971). */
function viewFaults(screen, { cols = 80, rows = 24, look = UTF8, listed = [], selected = "alpha", folded = false, gone = [], extra = [], detail = false, heading, sheet = LIST_SHEET } = {}) {
  const { faults, list } = sidebarFaults(screen, { cols, rows, look, listed, heading, sheet });
  const hidden = new Set([...gone, ...(folded ? ["beta"] : [])]);
  // A row is its mark and its name, indented by its level: no disclosure mark and no word (every
  // row here is stopped, which the mark says). A folded row says how many it folds away.
  const row = (name, depth, fold = "") => new RegExp(`^${name === selected ? ">" : " "} ${"  ".repeat(depth)}${literal(look.stopped)} ${instanceDisplayName(name)}${fold ? literal(` ${fold}`) : ""}$`);
  const wanted = [["alpha", 0, folded ? "+1" : ""], ["beta", 1], ["gamma", 0], ...extra.map((name) => [name, 0])].filter(([name]) => !hidden.has(name));
  const NO_MATCH = "   No instance matches the filter.";
  const drawn = list.filter((text) => text !== "" && text !== NO_MATCH);
  if (wanted.length === 0 && JSON.stringify(list) !== JSON.stringify([NO_MATCH])) faults.push(`the list is ${JSON.stringify(list)}, not the one row ${JSON.stringify(NO_MATCH)}`);
  if (wanted.length > 0 && list.includes(NO_MATCH)) faults.push("the list says nothing matches");
  if (hidden.size === 0 && extra.length === 0) {
    const order = [wanted[0], wanted[1], null, wanted[2]];
    order.forEach((want, i) => { if (want ? !row(...want).test(list[i] ?? "") : list[i] !== "") faults.push(`row ${i + 1} of the list is ${JSON.stringify(list[i])}, not ${want ? row(...want) : "empty"}`); });
    if (list.length !== order.length) faults.push(`the list has ${list.length} rows, not ${order.length}: ${JSON.stringify(list)}`);
  } else {
    for (const want of wanted) { const n = drawn.filter((text) => row(...want).test(text)).length; if (n !== 1) faults.push(`${n} rows of the list are ${row(...want)}: ${JSON.stringify(drawn)}`); }
    if (drawn.length !== wanted.length) faults.push(`the list draws ${drawn.length} rows, not ${wanted.length}: ${JSON.stringify(drawn)}`);
    for (const name of hidden) if (drawn.some((text) => new RegExp(`\\b${instanceDisplayName(name)}\\b`).test(text))) faults.push(`a row still shows ${name}`);
  }
  // From 80 columns the detail stands beside the sidebar, from the first row.
  if (cols >= 80) {
    const pane = mainOf(screen, cols);
    const title = wanted.length ? `${detail ? ">" : " "} ${selected}` : "";
    if (pane[0] !== title) faults.push(`the detail's first row is ${JSON.stringify(pane[0])}, not ${JSON.stringify(title)}`);
    if (wanted.length && !pane.some((text) => /^ {2}soul {5}(dev|reviewer)$/.test(text))) faults.push("the detail names no soul");
    if (!wanted.length && pane.some((text) => text !== "")) faults.push(`the detail is not empty: ${JSON.stringify(pane)}`);
  }
  return faults;
}
/** The same for the help: the sidebar beside it as the Instances view draws it, with the help's
 *  own cheat sheet; in the main area the time of the last read on the help's top row (it is on no
 *  other screen: docs/tui.md, "The help"), then its first section (HELP_FIRST): the title
 *  `Chords`, the line of the family (on macOS, of its Alt arrows) and a row per chord; as many rows
 *  as the area holds over its last row, and no detail. */
function helpFaults(screen, { cols = 80, rows = 24, look = UTF8, listed = [] } = {}) {
  const { faults } = sidebarFaults(screen, { cols, rows, look, listed, sheet: HELP_SHEET });
  const pane = mainOf(screen, cols);
  if (!/^ {2}read \d\d:\d\d:\d\d$/.test(pane[0] ?? "")) faults.push(`the help's top row is ${JSON.stringify(pane[0])}, not the time of the last read`);
  const area = pane.slice(1);
  const { title, rows: wanted, first, lead } = HELP_FIRST;
  if (area[0]?.trim() !== title) faults.push(`the help's second row is ${JSON.stringify(area[0])}, not the title \`${title}\``);
  if (lead && !area.some((text) => lead.test(text))) faults.push(`no row under the title says the family in force (${lead})`);
  const start = area.findIndex((text) => wanted[0].test(text));
  if (start < 0) faults.push(`no row under the title is ${first}`);
  else wanted.slice(0, area.length - 1 - start).forEach((pattern, i) => { if (!pattern.test(area[start + i] ?? "")) faults.push(`row ${start + i + 2} is ${JSON.stringify(area[start + i])}, which is not ${pattern}`); });
  if (pane.some((text) => /^ {2}soul {5}/.test(text))) faults.push("the detail is still drawn beside the help");
  return faults;
}

/** What keeps a screen from being the Instances view of a deployment that was not read. What a
 *  failed read becomes is the shared rule's answer, and so are its words: here only that it is
 *  said in the sidebar, under the title: the state on the row after the title (its time at the
 *  right, when it has one), then the reason on rows of its own, each started at the margin; that
 *  no instance is drawn and no detail; and that the cheat sheet is the list's with no instance
 *  selected. `title` is what the title row matches; `reason`: the most rows the reason takes (it
 *  is wrapped to the sidebar's width, and the frame gives a long one up to four at 24 rows). */
function notReadFaults(screen, { cols = 80, rows = 24, title = /^ {2}\S+$/, reason = 4 } = {}) {
  const side = sidebarOf(screen, cols), said = side.indexOf("", 1) - 1;
  const { faults, list } = sidebarFaults(screen, { cols, rows, title, above: Array(Math.max(0, said)).fill(/^ \S/), sheet: LIST_SHEET });
  if (said < 2 || said > 1 + reason) faults.push(`the rows under the title do not say what state the deployment is in and why, on at most ${reason} rows: ${JSON.stringify(side.slice(1, Math.max(3, said + 1)))}`);
  if (list.length) faults.push(`the list draws rows: ${JSON.stringify(list)}`);
  if (mainOf(screen, cols).some((text) => text !== "")) faults.push("something is drawn beside the sidebar");
  return faults;
}

/** The same for the switcher, in the main area: the title says `workspaces` where a workspace's
 *  name stands, no view of the accordion is open, and the main area is `body`, row for row from
 *  the first (each a string, or what the row matches), and nothing under it. `open`: a workspace
 *  is open, so Esc has a view to close the switcher onto and the cheat sheet offers it. `removable`:
 *  a row of this computer's list of deployments is selected, and the sheet offers its Remove. */
function switcherFaults(screen, { cols = 80, rows = 24, look = UTF8, body, open = true, removable = false }) {
  const sheet = [...SWITCHER_SHEET.slice(0, -LAST_HINTS.length).filter(([key]) => open || key !== "Esc"), ...(removable ? [["Delete", "remove"]] : []), ...LAST_HINTS];
  const { faults } = sidebarFaults(screen, { cols, rows, look, title: " workspaces", open: null, sheet });
  const area = mainOf(screen, cols);
  body.forEach((want, i) => { if (want instanceof RegExp ? !want.test(area[i] ?? "") : area[i] !== want) faults.push(`row ${i + 1} of the switcher is ${JSON.stringify(area[i])}, not ${want instanceof RegExp ? want : JSON.stringify(want)}`); });
  if (!area.slice(body.length).every((text) => text === "")) faults.push(`something is drawn under the ${body.length} rows of the switcher`);
  return faults;
}

// ---- a terminal ---------------------------------------------------------------------------------

/** The pane's modes, as tmux tracks them. `bracket_paste_flag` is empty on a tmux that has no such
 *  format (it prints nothing for a name it does not know). */
const FLAGS = ["alternate_on", "cursor_flag", "wrap_flag", "mouse_any_flag", "keypad_flag", "keypad_cursor_flag", "insert_flag", "origin_flag", "bracket_paste_flag"];
let opened = 0, started = 0;

/** Wait for what a terminal shows (or for a file), within the file's budget. A timeout says what
 *  was waited for, what is missing (`faults()`, read when the wait gives up) and what the pane
 *  shows instead. */
async function until(term, predicate, what, faults = () => []) {
  const left = Math.max(0, FILE_DEADLINE - Date.now());
  try { await waitUntil(predicate, what, Math.min(10000, left)); } catch (error) {
    if (!/^timed out waiting for /.test(error?.message ?? "")) throw error;
    const missing = faults();
    assert.fail(`${error.message}${left === 0 ? ` (this file's budget of ${BUDGET_MS / 1000}s was spent before the wait began)` : ""}${missing.length ? `: ${missing.join("; ")}` : ""}; ${term.id} (${term.flagsLine()}) shows:\n${term.shows()}`);
  }
}
/** Wait for a whole screen: `faults(screen)` answers what keeps it from being the one waited for. */
const untilScreen = (term, faults, what) => until(term, () => faults(term.screen()).length === 0, what, () => faults(term.screen()));

/** A terminal of `cols`x`rows`: a new session of the private server, removed after the test. Its
 *  pane runs `command`, or an interactive bash with job control, a known prompt and the locale
 *  named (the TUI reads LC_ALL to choose its rules), started in `cwd` with the environment of
 *  `world`'s deployment and `env` over it; then it resolves at the first prompt. */
async function terminal(t, { cols = 80, rows = 24, locale = UTF8.locale, command, world = WORLD, cwd = base, env = {} } = {}) {
  const id = `t${++opened}`;
  const extra = Object.entries(env).map(([name, value]) => `${name}=${shq(value)} `).join("");
  const shell = command ?? `sh ${shq(world.enter)} env ${extra}LC_ALL=${locale} LANG=${locale} HISTFILE=/dev/null PS1=${shq(`${PROMPT} `)} bash --norc --noprofile -i`;
  const [pane, session] = tmuxOn("new-session", "-d", "-P", "-F", "#{pane_id} #{session_id}", "-s", id, "-x", String(cols), "-y", String(rows), "-c", cwd, shell).split(" ");
  let files = 0, typed = null;
  const term = {
    id, pane, session,
    /** The screen: one string per row, as `capture-pane` prints them (no trailing spaces). */
    screen() { return tmuxRaw("capture-pane", "-p", "-t", pane).split("\n").slice(0, -1); },
    /** The screen with wrapped rows joined: a line longer than the terminal is one line. */
    joined() { return tmuxRaw("capture-pane", "-p", "-J", "-t", pane).split("\n").map((row) => row.trimEnd()).filter(Boolean); },
    /** Whether the pane shows `line`, printed by the command typed last (or by the pane's own
     *  command), as a whole line: a joined row of its own, or the rest of the row that holds the
     *  prompt and what was typed. A typed line that fills its last row exactly leaves that row
     *  marked as wrapped, and the joined capture then has what was printed next on the same row. */
    showsLine(line) { const rows = term.joined(); return rows.includes(line) || (typed !== null && rows.includes(`${PROMPT} ${typed}${line}`)); },
    /** Whether the prompt is on the row after what was typed last, with nothing printed between
     *  them: the last two joined rows are the typed line and the prompt, or, where the typed line
     *  fills its row (see `showsLine`), the last joined row is the typed line with the prompt on
     *  its end. */
    promptFollowsTyped() { const rows = term.joined(), line = `${PROMPT} ${typed}`; return typed !== null && ((rows.at(-2) === line && rows.at(-1) === PROMPT) || rows.at(-1) === `${line}${PROMPT}`); },
    shows() { try { return term.screen().map((row) => `  |${row}`).join("\n"); } catch (error) { return `  (no pane: ${error.message})`; } },
    flags() { const values = tmuxOn("display-message", "-p", "-t", pane, FLAGS.map((flag) => `#{${flag}}`).join(",")).split(","); return Object.fromEntries(FLAGS.map((flag, i) => [flag, values[i] ?? ""])); },
    flagsLine() { try { return Object.entries(term.flags()).map(([flag, value]) => `${flag}=${value}`).join(" "); } catch { return "no flags"; } },
    size() { return tmuxOn("display-message", "-p", "-t", pane, "#{pane_width}x#{pane_height}"); },
    /** The row the cursor is on, counted from 0 as the rows of `screen()` are. */
    cursorRow() { return Number(tmuxOn("display-message", "-p", "-t", pane, "#{cursor_y}")); },
    /** Keys, as tmux names them, typed at the terminal. */
    press(...keys) { tmuxOn("send-keys", "-t", pane, ...keys); },
    atPrompt() { return term.screen().filter(Boolean).at(-1) === PROMPT; },
    async prompt(why) { await until(term, () => term.atPrompt(), `the shell's prompt in ${id}, ${why}`); },
    /** A command line typed at the shell's prompt, and Enter. */
    async command(text, why) {
      await term.prompt(`before typing ${why}`);
      tmuxOn("send-keys", "-l", "-t", pane, text);
      tmuxOn("send-keys", "-t", pane, "Enter");
      typed = text;
    },
    /** The terminal's line settings, as `stty -g` prints them in the pane's own shell. */
    async stty(when) {
      const file = join(base, `${id}-stty-${++files}`);
      await term.command(`${shq(STTY)} -g > ${shq(file)}`, `stty -g ${when}`);
      await until(term, () => existsSync(file) && /\n$/.test(readFileSync(file, "utf8")), `the output of stty -g ${when} in ${id}`);
      await term.prompt(`after stty -g ${when}`);
      return comparableStty(readFileSync(file, "utf8").trim());
    },
    /** Everything a program can leave changed: the line settings, the pane's modes and title, and
     *  every option of the server, the session, the window and the pane. Taken at the prompt. */
    async state(when) {
      const stty = await term.stty(when);
      return {
        stty, flags: term.flags(), title: tmuxOn("display-message", "-p", "-t", pane, "#{pane_title}"),
        options: {
          global: tmuxOn("show-options", "-g"), server: tmuxOn("show-options", "-s"), windowGlobal: tmuxOn("show-window-options", "-g"),
          session: tmuxOn("show-options", "-t", session), window: tmuxOn("show-window-options", "-t", pane), pane: tmuxOn("show-options", "-p", "-t", pane),
        },
      };
    },
    kill() { try { tmuxOn("kill-session", "-t", session); } catch { /* gone */ } },
    /** Something to do when the test that opened this terminal is over. */
    after(fn) { t.after(fn); },
  };
  t.after(term.kill); // a failed test leaves nothing for the next one
  if (!command) await term.prompt("when its shell has started");
  return term;
}

/** `oats tui`, the real CLI, typed at a terminal's prompt through a wrapper that writes its own pid
 *  and then becomes the CLI (so the pid is the TUI's, and the shell's job is the TUI). `args` are
 *  the word's arguments: the deployment by `--dir`, unless a test says otherwise. The shell
 *  records the exit status unless `record` is false. Resolves once the Instances view of that
 *  deployment is on the screen, read (or once `first(run, term)` has seen the first screen of a
 *  run that starts on another): `given` is what `viewFaults` is told about every screen of this run
 *  (its size, its look), with the rows the world lists under the open workspace (`world.listed`) unless it says. */
async function tui(term, given = {}, { record = true, world = WORLD, args = `--dir ${shq(world.dep)}`, first = (run) => run.view("after the start") } = {}) {
  const at = { listed: world.listed ?? [], ...given };
  const n = ++started;
  const pidFile = join(base, `tui-${n}.pid`), statusFile = join(base, `tui-${n}.status`);
  await term.command(`sh -c ${shq(`echo $$ > ${shq(pidFile)}; exec ${TUI} ${args}`)}${record ? `; echo $? > ${shq(statusFile)}` : ""}`, "the oats tui command");
  const run = {
    statusFile, world,
    /** The exit status the pane's shell recorded; null while the command runs. */
    status() { const text = existsSync(statusFile) ? readFileSync(statusFile, "utf8") : ""; return /^\d+\n$/.test(text) ? Number(text) : null; },
    async ended(why) { await until(term, () => run.status() !== null, `oats tui in ${term.id} to end ${why}`); return run.status(); },
    /** The Instances view is on the screen, as `want` says, and the program still runs. */
    async view(why, want = {}) {
      await untilScreen(term, (screen) => viewFaults(screen, { ...at, ...want }), `the Instances view ${why}`);
      assert.equal(run.status(), null, `oats tui still runs ${why}`);
    },
    async help(why, want = {}) {
      await untilScreen(term, (screen) => helpFaults(screen, { ...at, ...want }), `the help ${why}`);
      assert.equal(run.status(), null, `oats tui still runs ${why}`);
    },
    /** The switcher is on the screen, with `want.body` as its rows, and the program still runs. */
    async switcher(why, want) {
      await untilScreen(term, (screen) => switcherFaults(screen, { ...at, ...want }), `the switcher ${why}`);
      assert.equal(run.status(), null, `oats tui still runs ${why}`);
    },
    /** A read in flight: the next answer of the collector's or the kernel status read's tmux is held (see `deployment`), the
     *  refresh key starts a read now, and this resolves once a held tmux wrote down the pid of its
     *  sleep: the pids that hold reads, of processes that run. `release()` lets the next read
     *  answer again. */
    async reading(why) {
      const before = world.held().length;
      writeFileSync(world.holdFile, "");
      term.press("r");
      await until(term, () => world.held().length > before, `a read in flight ${why}: its tmux, held`);
      const pids = world.held().slice(before);
      assert.ok(pids.every((pid) => Number.isInteger(pid) && pid > 1 && alive(pid)), `what holds the read runs ${why} (${pids})`);
      return pids;
    },
    /** A roster read in flight, in a world with a machine (see `machineWorld`): the next `ssh` of
     *  the kernel that reads the roster is held, and this resolves once a held `ssh` wrote down
     *  the pid of its sleep: the pids that hold the read, of processes that run. One roster read
     *  runs at a time, and the refresh key starts one only while none is in flight: so `r` is
     *  pressed again, once a second, until a read it started is held (the read of the start may
     *  have been past its `ssh` when the hold was set). With `press` false no key is pressed: the
     *  hold was set earlier, when `before` sleeps had held a read, and the read waited for is one
     *  the TUI starts unasked (the first of a run, the one of a return from a suspend).
     *  That kernel leads a process group of its own (lib/read.mjs), which is what the TUI ends on
     *  every way out: what holds the read is in a group, and not in the TUI's. */
    async rosterReading(why, { press = true, before = world.sshHeld().length } = {}) {
      world.holdSsh();
      let pressed = 0;
      await until(term, () => {
        if (world.sshHeld().length > before) return true;
        if (press && Date.now() - pressed >= 1000) { term.press("r"); pressed = Date.now(); }
        return false;
      }, `a roster read in flight ${why}: the kernel's ssh, held`);
      const pids = world.sshHeld().slice(before);
      assert.ok(pids.every((pid) => Number.isInteger(pid) && pid > 1 && alive(pid)), `what holds the roster read runs ${why} (${pids})`);
      const own = groupOf(run.pid);
      if (own !== null) for (const pid of pids) { const group = groupOf(pid); assert.ok(group !== null && group !== own, `what holds the roster read (${pid}, in the process group ${group}) is in a group, and not in the TUI's (${own}), ${why}`); }
      return pids;
    },
    /** The add of the deployment this run started in is over, and the TUI knows: a run in a
     *  deployment starts it before it can take the answer of a read, so it has begun once a read's
     *  rows are on the screen, and a run that started in the switcher has none. Nothing on the screen
     *  says so (docs/tui.md, "Opening a deployment lists it"). */
    async added(why) {
      await until(term, () => addingToList(run.pid).length === 0, `the add to this computer's list to be over ${why}`, () => addingToList(run.pid));
    },
    /** The children of a read that was in flight are gone. Left alone, what held the read would
     *  run for half a minute, far longer than any wait of this file: the TUI ended its group. */
    async childrenGone(pids, why) {
      await until(term, () => pids.every((pid) => !alive(pid)), `the children of the read in flight (${pids}) to be gone ${why}`);
    },
  };
  term.after(world.release); // a held read of a failed test holds no later one
  await first(run, term);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 1, `the wrapper wrote the pid (${pid})`);
  run.pid = pid;
  return run;
}
/** A shell's terminal: its own screen, with a cursor and autowrap. */
function assertShellModes(flags, why) {
  assert.deepEqual({ alternate_on: flags.alternate_on, cursor_flag: flags.cursor_flag, wrap_flag: flags.wrap_flag }, { alternate_on: "0", cursor_flag: "1", wrap_flag: "1" }, `${why}: the shell's own screen, with a cursor and autowrap`);
}
/** The modes the TUI switches on, and the ones it never touches (docs/tui.md). */
function assertRunningModes(term, why) {
  const { bracket_paste_flag: paste, insert_flag: _insert, origin_flag: _origin, ...flags } = term.flags();
  assert.deepEqual(flags, { alternate_on: "1", cursor_flag: "0", wrap_flag: "0", mouse_any_flag: "0", keypad_flag: "0", keypad_cursor_flag: "0" }, `${why}: the alternate screen, no cursor, no autowrap; no mouse, no keypad modes`);
  // The shell's readline switches bracketed paste off before it runs a command: on here, it is the TUI's.
  if (paste !== "") assert.equal(paste, "1", `${why}: bracketed paste is on`);
}

// ---- the reading of `stty -g` itself: no terminal needed ----------------------------------------
test("a stty -g line is compared without macOS's PENDIN bit and with everything else: that bit of lflag is cleared in a macOS line and nothing else is; a Linux line is untouched", () => {
  // Two real lines of one pane on macOS, from the control's output: PENDIN set, and clear.
  const mac = (lflag, iflag = "6b02") => `gfmt1:cflag=4b00:iflag=${iflag}:lflag=${lflag}:oflag=3:discard=f:dsusp=19:eof=4:eol=ff:eol2=ff:erase=7f:intr=3:kill=15:lnext=16:min=1:quit=1c:reprint=12:start=11:status=14:stop=13:susp=1a:time=0:werase=17:ispeed=9600:ospeed=9600`;
  assert.equal(comparableStty(mac("200005cb")), mac("5cb"), "that bit is cleared, and no other character of the line changes");
  assert.equal(comparableStty(mac("5cb")), mac("5cb"), "a line without the bit is returned as it is");
  assert.equal(comparableStty(mac("200005cb")), comparableStty(mac("5cb")), "two lines that differ only in PENDIN compare equal");
  assert.equal(comparableStty(mac("a00005cb")), mac("800005cb"), "the bits above it stay (NOFLSH, 0x80000000)");
  assert.equal(comparableStty(mac("20000000")), mac("0"), "PENDIN alone leaves no bit");

  // Every other difference is still a difference.
  assert.notEqual(comparableStty(mac("200005c3")), comparableStty(mac("5cb")), "ECHO (0x8) off on one side");
  assert.notEqual(comparableStty(mac("220005cb")), comparableStty(mac("200005cb")), "NOKERNINFO (0x02000000), the bit next to it in the name");
  assert.notEqual(comparableStty(mac("200004cb")), comparableStty(mac("200005cb")), "ICANON (0x100) off: raw mode left on");
  assert.notEqual(comparableStty(mac("200005cb", "6b00")), comparableStty(mac("5cb")), "a bit of iflag");
  assert.notEqual(comparableStty(mac("5cb").replace("oflag=3", "oflag=20000003")), comparableStty(mac("5cb")), "the same bit in another field is that field's");
  assert.notEqual(comparableStty(mac("5cb").replace("min=1", "min=0")), comparableStty(mac("5cb")), "a control character");

  // A macOS line it cannot read is returned as it is, and so fails its comparison as it stands.
  for (const odd of [
    mac("200005cb").replace("lflag=200005cb:", ""), // no lflag
    mac("200005cb").replace("lflag=200005cb", "lflag="), // empty
    mac("200005cb").replace("lflag=200005cb", "lflag=0x200005cb"), // not plain hex
    mac("200005cb").replace("oflag=3", "lflag=20000003"), // written twice
    mac("200005cb").replace("lflag=", "xlflag="), // another name that ends the same
  ]) assert.equal(comparableStty(odd), odd, odd);

  // Linux prints hex fields with no names; the fourth is lflag. Nothing of it is touched, whatever it holds.
  const linux = "4500:5:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0";
  assert.equal(comparableStty(linux), linux);
  const linuxWithThatBit = linux.replace(":8a3b:", ":20008a3b:");
  assert.equal(comparableStty(linuxWithThatBit), linuxWithThatBit);
  assert.notEqual(comparableStty(linuxWithThatBit), comparableStty(linux), "on Linux that bit is compared like any other");
  assert.equal(comparableStty(""), "");
});

// ---- no terminal at all: plain children ---------------------------------------------------------
test("without a terminal on stdout `oats tui` prints the E_NO_TERMINAL line on stderr and exits 1 with no escape byte, with or without --dir; --json is refused as one JSON envelope, --help prints the usage, and --server and a --dir without a path are refused", () => {
  // The worktree may live inside an agent's instance home: the children run in the fixture, with
  // its environment, and with no name that makes them an OATS instance.
  const env = REAL_TMUX ? { ...process.env } : fixtureEnv(base, { extra: { OATS_HOME_DIR: join(base, "oats-home") } });
  for (const key of Object.keys(env)) if (key !== "OATS_HOME_DIR" && /^(OATS_|PI_AGENT|TMUX)/.test(key)) delete env[key];
  const cli = (...args) => spawnSync(process.execPath, [CLI, "tui", ...args], { cwd: base, env: { ...env, TERM: "xterm-256color" }, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });

  // The terminal is asked for before the deployment is looked for: no directory changes the answer.
  const none = cli(), named = cli("--dir", base);
  for (const r of [none, named]) assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 1, stdout: "", stderr: `${NO_TERMINAL}\n` });

  const json = cli("--json");
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stdout), { schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS", message: "oats tui is interactive and has no --json form; `oats status --json` is the machine view" } });
  assert.equal(json.stdout.trim().split("\n").length, 1, "one envelope, on one line");

  const help = cli("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage:\n/);
  assert.ok(help.stdout.includes(USAGE), help.stdout);
  assert.equal(help.stderr, "");

  const server = cli("--server", "x");
  assert.deepEqual({ status: server.status, stdout: server.stdout }, { status: 1, stdout: "" });
  assert.match(server.stderr, /\(E_BAD_ARGS\)/);
  assert.ok(server.stderr.includes("--server") && server.stderr.includes(USAGE), `--server is named, with the usage: ${server.stderr}`);
  const bare = cli("--dir");
  assert.deepEqual({ status: bare.status, stdout: bare.stdout, stderr: bare.stderr }, { status: 1, stdout: "", stderr: `oats: \`oats tui --dir\` takes a path (E_BAD_ARGS); usage: ${USAGE}\n` });
  for (const r of [none, named, json, help, server, bare]) assert.equal(/\x1b/.test(r.stdout + r.stderr), false, "no escape byte without a terminal");
});

// ---- on a terminal ------------------------------------------------------------------------------
const TMUX_VERSION = REAL_TMUX ? execFileSync(REAL_TMUX, ["-V"], { encoding: "utf8", timeout: 10000 }).trim() : "none";
test(`the tmux these tests run against: ${TMUX_VERSION}`, { skip: NO_TMUX }, async (t) => {
  const term = await terminal(t);
  t.diagnostic(`tmux -V: ${TMUX_VERSION}; pane modes it reports at a shell prompt: ${term.flagsLine()}`);
  assert.match(TMUX_VERSION, /^tmux /);
  assert.equal(term.size(), "80x24", "a detached session made with -x and -y has that size");
});

test("on a terminal of 80x24 `oats tui --dir` shows the fixture's instances, grouped as the shared home groups them, with the detail of the selected one; j, h, l, /, text, Enter, Esc, r, Tab and ? each do what the help says, waited for on what the pane shows; q exits with status 0 and the shell's screen is back", { skip: NO_TMUX }, async (t) => {
  const world = await deployment(t); // its own: this test adds an instance
  const term = await terminal(t, { world });
  const run = await tui(term, {}, { world });
  const two = (left, right) => `${left.padEnd(38)}│${right}`.trimEnd();
  // The sidebar: the title (the name alone: no count, and no time of a read), an empty row, the
  // views with the open one's list, and the cheat sheet; the detail beside it from the first row.
  const rule = "─".repeat(38);
  const side = ["  fixture", "", viewRow("Instances", "1"), "> ○ Alpha", "    ○ Beta", "", "  ○ Gamma", rule, viewRow("Souls", "2"), viewRow("Capabilities", "3"), rule, ...sheetRows(LIST_SHEET)];
  const detail = ["   alpha", "   soul     dev", "   state    stopped", "   harness  claude", "   work     directory", "   home     …/agents/dev/instances/alpha"];
  assert.deepEqual(term.screen(), Array.from({ length: 24 }, (_, i) => two(side[i] ?? "", detail[i] ?? "")), "the Instances view, row for row");

  term.press("j");
  await run.view("after j: the next row, the child", { selected: "beta" });
  term.press("h");
  await run.view("after h on a row with nothing below it: its parent", { selected: "alpha" });
  term.press("h");
  await run.view("after h on an open row: collapsed", { selected: "alpha", folded: true });
  term.press("l");
  await run.view("after l on a collapsed row: open again", { selected: "alpha" });
  term.press("l");
  await run.view("after l on an open row: its first child", { selected: "beta" });

  term.press("/");
  await run.view("after /: the filter field is the heading of the view, and the cheat sheet its keys", { selected: "beta", heading: viewRow("/", "1"), sheet: FIELD_SHEET });
  tmuxOn("send-keys", "-l", "-t", term.pane, "gamq");
  await run.view("after text: q is text in the field, and nothing matches", { gone: ["alpha", "beta", "gamma"], heading: viewRow("/gamq", "1"), sheet: FIELD_SHEET });
  term.press("BSpace");
  await run.view("after Backspace: the one match, selected", { selected: "gamma", gone: ["alpha", "beta"], heading: viewRow("/gam", "1"), sheet: FIELD_SHEET });
  term.press("Enter");
  await run.view("after Enter: the filter is kept, named on the heading, and the keys are keys again", { selected: "gamma", gone: ["alpha", "beta"], heading: viewRow("Instances  /gam", "1"), sheet: KEPT_SHEET });
  term.press("Escape");
  await run.view("after Esc: the filter is cleared, the selection stays on its instance", { selected: "gamma" });

  // The view follows the deployment: an instance spawned meanwhile is there after a read. (That
  // the key asks for one is packages/tui/test/main.test.mjs's; a read comes every five seconds too.)
  await world.spawn("reviewer", { name: "delta" });
  term.press("r");
  const more = { selected: "gamma", extra: ["delta"] };
  await run.view("after r: the new instance", more);

  term.press("Tab");
  await run.view("after Tab: the detail holds the focus", { ...more, detail: true, sheet: DETAIL_SHEET });
  term.press("Escape");
  await run.view("after Esc: the list has it again", more);
  term.press("?");
  await run.help("after ?");
  term.press("Escape");
  await run.view("after Esc closed the help", more);
  term.press("?");
  await run.help("after ? again");
  term.press("?");
  await run.view("after ? closed the help", more);

  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
  await term.prompt("after q");
  assert.equal(term.screen().some((row) => LEAD_ROW.test(row)), false, `the view is gone from the shell's screen:\n${term.shows()}`);
  assert.equal(alive(run.pid), false, "the process is gone");
});

/** A terminal is intact after a TUI that left it by `leave`: status `status`, what held a read
 *  in flight is gone, and `stty -g`, the pane's modes and every tmux option are what they were
 *  before the start; while it ran, only the alternate screen, the cursor, autowrap and bracketed
 *  paste were changed. `arrive(term, run)` brings the TUI to where it is left, and answers the
 *  pids of what holds its read then. `env` is set in the terminal's shell over the world's,
 *  `start` is what `tui` is told of the start (its arguments, its first screen), and `size` the
 *  terminal's (`{ cols, rows }`, 80x24 when not given), which every screen of the run is read at. */
async function leavesTheTerminalIntact(t, { how, status, world = WORLD, env = {}, start = {}, size = {}, arrive, leave }) {
  const term = await terminal(t, { world, env, ...size });
  const before = await term.state("before the start");
  assertShellModes(before.flags, "before the start");
  const mine = everything();
  const run = await tui(term, size, { world, ...start });
  assertRunningModes(term, `while it runs, before ${how}`);
  assert.deepEqual(everything(), mine, "the TUI made no session, window or pane");

  // The TUI names a change to the list still running in one line above the prompt as it leaves, on
  // every way out (docs/tui.md), and the add it starts with is one. What is read below is a leave
  // with no such line, so that row is the command line; packages/tui/test/main.test.mjs reads the
  // line itself.
  // Waited for first: the reads `arrive` holds are held for as long as a row needs them, no longer.
  await run.added(`before ${how}`);
  const reading = await arrive(term, run);
  await leave(term, run);
  await run.childrenGone(reading, `after ${how}`);
  assert.equal(await run.ended(`after ${how}`), status, term.shows());
  await until(term, () => !alive(run.pid), `the process ${run.pid} to be gone after ${how}`);
  // The cursor the alternate screen saved is the one that came back: the prompt is on the row
  // after the command line, with the cursor on it, and nothing of the view above it.
  await term.prompt(`after ${how}`);
  const screen = term.screen(), promptRow = screen.findLastIndex((row) => row === PROMPT);
  assert.equal(term.cursorRow(), promptRow, `the cursor is on the prompt's row after ${how}:\n${term.shows()}`);
  assert.equal(screen.slice(promptRow + 1).every((row) => row === ""), true, `nothing below the prompt after ${how}:\n${term.shows()}`);
  assert.notEqual(screen[promptRow - 1], "", `no empty row between the command and the prompt after ${how}:\n${term.shows()}`);
  assert.ok(term.promptFollowsTyped(), `the row above the prompt is the command line after ${how}:\n${term.shows()}`);
  const after = await term.state(`after ${how}`);
  assert.equal(after.stty, before.stty, `stty -g after ${how}`);
  assert.deepEqual(after.flags, before.flags, `the pane's modes after ${how}`);
  assertShellModes(after.flags, `after ${how}`);
  assert.deepEqual(after, before, `the terminal and the server after ${how}`);
  assert.equal(term.screen().some((row) => LEAD_ROW.test(row)), false, `the shell's screen is back, with no cheat sheet on it:\n${term.shows()}`);
}

for (const [how, status, leave, first = async () => {}] of [
  ["q", 0, (term) => term.press("q")],
  ["Ctrl+C, the byte 0x03 on a raw terminal", 0, (term) => term.press("C-c")],
  ["SIGINT", 130, (term, run) => process.kill(run.pid, "SIGINT")],
  ["SIGTERM", 143, (term, run) => process.kill(run.pid, "SIGTERM")],
  ["SIGQUIT", 131, (term, run) => process.kill(run.pid, "SIGQUIT")],
  // Ctrl+L leaves and enters the alternate screen again. However often it did, the end is one
  // leave, and the shell's cursor is where the first entry found it. Keys are read in order, so the
  // help that answers the `?` typed after a Ctrl+L shows that the Ctrl+L was acted on before it.
  ...[1, 3].map((times) => [`${times} Ctrl+L and then q`, 0, (term) => term.press("q"), async (term, run) => {
    for (let i = 1; i <= times; i++) {
      term.press("C-l");
      term.press("?");
      await run.help(`after Ctrl+L number ${i}, then ?`);
      assertRunningModes(term, `after Ctrl+L number ${i}`);
      term.press("Escape");
      await run.view(`after Ctrl+L number ${i}, then ? and Esc`);
    }
  }]),
]) {
  test(`the terminal is intact after ${how}, with the view drawn and a read in flight: status ${status}, the read's children are gone, and stty -g, the pane's modes and every tmux option are what they were before the start; while it ran, only the alternate screen, the cursor, autowrap and bracketed paste were changed`, { skip: NO_TMUX }, async (t) => {
    await leavesTheTerminalIntact(t, { how, status, leave, arrive: async (term, run) => { await first(term, run); return run.reading(`before ${how}`); } });
  });
}

/** The switcher's area at `cols` columns: the main area beside the sidebar. Its names stand in a
 *  column a third of its width, of twenty cells at least (views/switcher.mjs). */
const switcherCols = (cols) => cols - listCols(cols) - 3;
const labelCols = (cols) => Math.min(Math.max(Math.floor(switcherCols(cols) / 3), 20), 40);
/** A choice of the switcher at `cols` columns: the selection's mark, the mark of the workspace
 *  that is open, the name in its column, and two cells on what stands beside it, which is cut with
 *  `…` where it would reach the area's last cell. */
const choice = (label, place, { selected = false, open = false } = {}, cols = 80) => {
  const room = switcherCols(cols) - 1 - (4 + labelCols(cols) + 2);
  const beside = place.length > room ? `${place.slice(0, room - 1)}…` : place;
  return `${selected ? ">" : " "} ${open ? "*" : " "} ${label.padEnd(labelCols(cols))}  ${beside}`.trimEnd();
};
/** The same where what stands beside the name is the shared home's to word: `beside` is the
 *  source of what it matches. */
const choiceLike = (label, beside, marks, cols = 80) => new RegExp(`^${literal(choice(label, "", marks, cols).padEnd(4 + labelCols(cols) + 2))}${beside}$`);
/** A workspace's indicator line in the switcher: under its row, dim, what it says of one deployment. */
const indicator = (said) => `      ${said}`;
/** The switcher in the world with the machine: the fixture's workspace, open and selected, its
 *  deployment of this machine on the line under it, and under the shared heading the machine that
 *  did not answer, by its own name with the short reason the shared home gives it. */
const MACHINES_SWITCHER = [choice("fixture", "", { selected: true, open: true }), indicator("This machine"), UNMATCHED, choiceLike("garnet", "\\S.*")];

test("the terminal is intact after q with the switcher open and a roster read in flight: status 0, the held ssh of the read is gone, and stty -g, the pane's modes and every tmux option are what they were before the start, with the prompt on the row after the command", { skip: NO_TMUX }, async (t) => {
  await leavesTheTerminalIntact(t, {
    how: "q in the switcher", status: 0, world: MACHINES, leave: (term) => term.press("q"),
    arrive: async (term, run) => {
      const reading = await run.rosterReading("before the switcher is opened");
      // The first w gives the list of workspaces the focus, the second opens the switcher.
      term.press("w", "w");
      await run.switcher("after w twice, with a roster read in flight", { body: MACHINES_SWITCHER });
      assertRunningModes(term, "with the switcher open");
      assert.ok(reading.every(alive), `the roster read is still in flight with the switcher open (${reading})`);
      return reading;
    },
  });
});

/** What the fixture's tmux says for the one socket it does not read: an invented sentence. The
 *  kernel's reason for an instance whose terminal server it could not read is that tmux's own
 *  words (lib/core.mjs `recordedTmuxWindows`). */
const NOT_READ = "tmux: the socket of acme-platform could not be read";

/** Make the kernel answer that it does not know whether the instance in `home` runs, with `said`
 *  as its reason. The TUI runs no kernel but its install's own, so the answer is the real
 *  kernel's: it reads a launched home's windows from the tmux socket the home recorded, and where
 *  that tmux fails with anything but "no server" it answers `running: null`, the state
 *  `unreachable` and what tmux wrote on stderr. So the home is recorded as launched on a socket in
 *  the fixture, receipt included (as `recordedHome` of test/status-recorded-socket.test.mjs
 *  records one), and for that socket `front/tmux` writes `said` on stderr and exits 1. Nothing is
 *  started and no socket file is made: the path only names the server that is asked for. The
 *  shared collector leaves a row the kernel answered so as it is (packages/client/liveness.mjs):
 *  the reason that reaches the screen is the kernel's. */
function serverNotRead(world, home, said) {
  const socket = join(world.fx.base, "not-read.sock");
  const record = join(home, "instance.json"), meta = JSON.parse(readFileSync(record, "utf8"));
  const runtime = { launched: true, tmux: { session: "oats-agents", window: meta.instance, socket } };
  writeFileSync(record, `${JSON.stringify({ ...meta, ...runtime }, null, 2)}\n`);
  const receipt = join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
  writeFileSync(receipt, `${JSON.stringify({ ...JSON.parse(readFileSync(receipt, "utf8")), runtime }, null, 2)}\n`);
  // After the script's first line: for this socket nothing else of it runs, and no tmux is asked.
  const front = join(world.front, "tmux");
  writeFileSync(front, readFileSync(front, "utf8").replace("\n", `\ncase " $* " in *" -S "${shq(socket)}" "*) echo ${shq(said)} >&2; exit 1 ;; esac\n`));
}

test("the reason the kernel gives for an instance it could not observe stands in the detail under the state, after `OATS says:` and with no quotation mark: with a tmux that fails for the socket one instance is recorded on, that instance reads the shared `state unknown` in the list, `unreachable` on its detail's state line, and no row counts it (the title is the workspace's name alone), its detail has the kernel's text wrapped under `state`, and the others are stopped as before; after q the terminal is intact", { skip: NO_TMUX }, async (t) => {
  const world = await deployment(t); // its own: this test changes a home's record and the fixture's tmux
  serverNotRead(world, join(world.fx.root, "reviewer", "instances", "gamma"), NOT_READ);

  const two = (left, right) => `${left.padEnd(38)}│${right}`.trimEnd();
  // Only the row whose state is not known has a word, the shared label `state unknown`: the word
  // column is as wide as it, and starts at cell 20.
  const listed = (row, word) => `${row.padEnd(20)}${word}`;
  /** The whole screen with `selected` selected and `detail` as the rows of its detail beside the
   *  sidebar: the title, the views with the list, and the cheat sheet, the list's whatever the
   *  row: it names no act, the instance whose state is not known or another. */
  const screenOf = (selected, detail) => {
    const at = (name) => (name === selected ? ">" : " "), rule = "─".repeat(38);
    const list = [`${at("alpha")} ○ Alpha`, `${at("beta")}   ○ Beta`, "", listed(`${at("gamma")} ? Gamma`, "state unknown")];
    const side = ["  fixture", "", viewRow("Instances", "1"), ...list, rule, viewRow("Souls", "2"), viewRow("Capabilities", "3"), rule, ...sheetRows(LIST_SHEET)];
    return Array.from({ length: 24 }, (_, i) => two(side[i] ?? "", detail[i] ?? ""));
  };
  /** What keeps a screen from being `want`, row for row, but for its clock time: when the
   *  instance was started (the detail of a launched home). */
  const faults = (want) => (screen) => {
    const got = screen.map((row) => row.replace(/(│ {3}started {2})\S.*$/, "$1HH:MM"));
    return [...(got.length === want.length ? [] : [`the screen has ${got.length} rows, not ${want.length}`]), ...want.flatMap((row, i) => (got[i] === row ? [] : [`row ${i + 1} is ${JSON.stringify(got[i])}, not ${JSON.stringify(row)}`]))];
  };
  const ALPHA = ["   alpha", "   soul     dev", "   state    stopped", "   harness  claude", "   work     directory", "   home     …/agents/dev/instances/alpha"];
  // The reason is one fact with no label: it continues the state above it, on as many rows as it
  // needs in the 28 cells a value has here.
  const GAMMA = [
    "   gamma", "   soul     reviewer", "   state    unreachable",
    "            OATS says: tmux: the socket", "            of acme-platform could not", "            be read",
    "   harness  claude", "   work     directory", "   started  HH:MM", "   home     …ts/reviewer/instances/gamma",
  ];

  await leavesTheTerminalIntact(t, {
    how: "q with the detail of an instance the kernel could not observe", status: 0, world, leave: (term) => term.press("q"),
    start: { first: (run, term) => untilScreen(term, faults(screenOf("alpha", ALPHA)), "the Instances view with one instance the kernel could not observe") },
    arrive: async (term, run) => {
      term.press("j", "j");
      await untilScreen(term, faults(screenOf("gamma", GAMMA)), "the detail of the instance the kernel could not observe, after j and j");
      assert.equal(run.status(), null, "oats tui still runs with that detail drawn");
      // However the reason wraps, the rows under the state are the speaker's words and the
      // kernel's text, and nothing around them.
      const pane = term.screen().map((row) => [...row].slice(listCols(80) + 1).join(""));
      const state = pane.indexOf("   state    unreachable"), under = [];
      for (let i = state + 1; /^ {12}\S/.test(pane[i] ?? ""); i++) under.push(pane[i].trim());
      assert.equal(under.join(" "), `OATS says: ${NOT_READ}`, `the rows under the state:\n${term.shows()}`);
      assert.equal(term.screen().some((row) => row.includes('"')), false, `no quotation mark is on the screen:\n${term.shows()}`);
      return []; // no read is held
    },
  });
});

test("SIGHUP ends it with status 129, and the children of a read in flight with it; SIGKILL ends it at once: either way the process is gone and the private server holds exactly the sessions, windows and panes the tests made", { skip: NO_TMUX }, async (t) => {
  for (const [signal, status] of [["SIGHUP", 129], ["SIGKILL", 137]]) {
    // A temporary directory of the test's own for this run, empty: what the run leaves in it is all
    // it made. A run SIGKILLed can remove nothing: the directory it made for the add of its
    // deployment to this computer's list (a change, whose output goes there) is left, with no
    // owner.json, since no terminal was opened, so no later run's sweep takes it (docs/tui.md, "What
    // it reads, and what it runs"). The test removes its own directory, whatever happens.
    const tmp = join(base, `tmp-${signal}`);
    mkdirSync(tmp, { mode: 0o700 });
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const made = () => readdirSync(tmp).map((name) => join(tmp, name));
    const term = await terminal(t, { env: { TMPDIR: tmp } });
    const mine = everything();
    const run = await tui(term);
    // After SIGKILL nothing ran that could end a child either: a read then ends by itself.
    const reading = signal === "SIGHUP" ? await run.reading("before SIGHUP") : [];
    process.kill(run.pid, signal);
    await run.childrenGone(reading, `after ${signal}`);
    assert.equal(await run.ended(`after ${signal}`), status, term.shows());
    await until(term, () => !alive(run.pid), `the process ${run.pid} to be gone after ${signal}`);
    assert.deepEqual(everything(), mine, `${signal}: nothing was added to the server, and nothing of the test's was taken`);
    if (signal === "SIGHUP") assert.deepEqual(made(), [], "SIGHUP: the run removed its directory on the way out");
    else assert.equal(made().every((dir) => /[/]oats-tui-[^/]+$/.test(dir) && !existsSync(join(dir, "owner.json"))), true, `SIGKILL: what is left is a run directory with no panel: ${made()}`);
    // After SIGKILL nothing ran that could put the terminal back: it is left in the alternate
    // screen, which is expected and documented, and not asserted. The terminal goes with its session.
    t.diagnostic(`after ${signal} the pane reports ${term.flagsLine()}`);
    run.world.release();
    term.kill();
    assert.deepEqual(everything(), mine.filter((row) => !row.startsWith(`${term.id} `)), `${signal}: the test's terminal is removed`);
  }
});

test("with a roster read in flight SIGTERM ends it with status 143 and SIGHUP with status 129, and the held ssh of the read with it: either way the process is gone and the private server holds exactly the sessions, windows and panes the tests made", { skip: NO_TMUX }, async (t) => {
  for (const [signal, status] of [["SIGTERM", 143], ["SIGHUP", 129]]) {
    const term = await terminal(t, { world: MACHINES });
    const mine = everything();
    const run = await tui(term, {}, { world: MACHINES });
    const reading = await run.rosterReading(`before ${signal}`);
    process.kill(run.pid, signal);
    await run.childrenGone(reading, `after ${signal}`);
    assert.equal(await run.ended(`after ${signal}`), status, term.shows());
    await until(term, () => !alive(run.pid), `the process ${run.pid} to be gone after ${signal}`);
    assert.deepEqual(everything(), mine, `${signal}: nothing was added to the server, and nothing of the test's was taken`);
    run.world.release();
    term.kill();
    assert.deepEqual(everything(), mine.filter((row) => !row.startsWith(`${term.id} `)), `${signal}: the test's terminal is removed`);
  }
});

test("Ctrl+Z with the first roster read of the run in flight: the read is given up and its held ssh is gone, and the shell's prompt returns; fg draws the view again and a new roster read runs, and the row of a roster read that failed is not on the screen, since a read given up is no failed answer; q then exits 0 and the held ssh of the new read is gone too", { skip: NO_TMUX }, async (t) => {
  const world = MACHINES;
  const term = await terminal(t, { world });
  // Held before the start: no roster answered in this run, so a read taken as failed would be
  // said on a row of its own after the list (after an answer, a machine's heading says it).
  const before = world.sshHeld().length;
  world.holdSsh();
  term.after(world.release);
  // No roster answers in this test, so the machine is no workspace yet: the list of workspaces
  // holds the fixture's row alone on every screen (the switcher has no row of it either).
  const run = await tui(term, { listed: [] }, { world, record: false });
  const reading = await run.rosterReading("before Ctrl+Z", { press: false, before });

  term.press("C-z");
  await run.childrenGone(reading, "after Ctrl+Z");
  await until(term, () => term.flags().alternate_on === "0" && term.atPrompt(), "the shell's prompt on its own screen after Ctrl+Z");
  assert.equal(world.sshHeld().length, before + reading.length, "no roster read was started while it was stopped");

  // The hold stays: the read the return starts is held too, and so is seen to run.
  await term.command("fg", "fg");
  await run.view("after fg");
  const again = await run.rosterReading("after fg", { press: false, before: before + reading.length });
  assert.equal(term.screen().some((row) => row.includes(ROSTER_FAILED)), false, `no row says that a roster read failed:\n${term.shows()}`);
  await run.view("with the new roster read in flight");

  term.press("q");
  await run.childrenGone(again, "after q");
  await term.command(`echo $? > ${shq(run.statusFile)}`, "the status of fg");
  assert.equal(await run.ended("after fg and q"), 0, term.shows());
});

test("Ctrl+Z during a read suspends with the terminal handed back: the read is given up and its children are gone, the shell's prompt returns, the alternate screen is off, autowrap and the cursor are on and stty -g is what it was; fg draws the view again from a new read; q then exits 0", { skip: NO_TMUX }, async (t) => {
  const term = await terminal(t);
  const before = await term.state("before the start");
  const run = await tui(term, {}, { record: false });
  assertRunningModes(term, "while it runs");

  const reading = await run.reading("before Ctrl+Z");
  term.press("C-z");
  await run.childrenGone(reading, "after Ctrl+Z");
  run.world.release();
  await until(term, () => term.flags().alternate_on === "0" && term.atPrompt(), "the shell's prompt on its own screen after Ctrl+Z");
  await until(term, () => /^T/.test(execFileSync("ps", ["-o", "stat=", "-p", String(run.pid)], { encoding: "utf8", timeout: 10000 }).trim()), `the process ${run.pid} to be stopped`);
  assert.ok(term.joined().some((row) => /Stopped/.test(row)), `the shell reports a stopped job:\n${term.shows()}`);
  const stopped = await term.state("while it is stopped");
  assert.equal(stopped.stty, before.stty, "stty -g while stopped");
  assertShellModes(stopped.flags, "while stopped");
  assert.deepEqual(stopped.flags, before.flags, "the pane's modes while stopped");
  assert.deepEqual(stopped, before, "the terminal and the server while stopped");

  await term.command("fg", "fg");
  await run.view("after fg");
  assertRunningModes(term, "after fg");
  term.press("?");
  await run.help("after fg: it reads keys again");
  term.press("Escape");
  await run.view("after the help was closed");

  term.press("q");
  await term.command(`echo $? > ${shq(run.statusFile)}`, "the status of fg");
  assert.equal(await run.ended("after fg and q"), 0, term.shows());
  const after = await term.state("after q");
  assert.deepEqual(after, before, "the terminal and the server after a suspend, a return and q");
});

test("Ctrl+Z through a wrapper that does not exec: the wrapper stops with the TUI, the interactive shell's prompt returns with the alternate screen off, fg draws the view again, and after q the wrapper goes on", { skip: NO_TMUX }, async (t) => {
  const term = await terminal(t);
  const before = await term.state("before the start");
  const statusFile = join(base, `${term.id}-wrapped.status`);
  await term.command(`sh -c ${shq(`${TUI} --dir ${shq(WORLD.dep)}; echo after-the-tui`)}`, "oats tui under sh -c");
  await untilScreen(term, (screen) => viewFaults(screen), "the view under a wrapper");
  assertRunningModes(term, "while it runs under a wrapper");

  term.press("C-z");
  await until(term, () => term.flags().alternate_on === "0" && term.atPrompt(), "the interactive shell's prompt on its own screen after Ctrl+Z under a wrapper");
  assert.ok(term.joined().some((row) => /Stopped/.test(row)), `the shell reports a stopped job:\n${term.shows()}`);
  assert.equal(term.screen().includes("after-the-tui"), false, "the wrapper stopped too: it has not gone on to its next command");
  const stopped = await term.state("while the wrapper is stopped");
  assertShellModes(stopped.flags, "while the wrapper is stopped");
  assert.deepEqual(stopped, before, "the terminal and the server while stopped");

  await term.command("fg", "fg");
  await untilScreen(term, (screen) => viewFaults(screen), "the view after fg under a wrapper");
  assertRunningModes(term, "after fg under a wrapper");

  term.press("q");
  await until(term, () => term.screen().includes("after-the-tui") && term.atPrompt(), "the wrapper's next command to print after q");
  await term.command(`echo $? > ${shq(statusFile)}`, "the status of fg");
  await until(term, () => existsSync(statusFile) && /\n$/.test(readFileSync(statusFile, "utf8")), "the status of the wrapper");
  assert.equal(readFileSync(statusFile, "utf8"), "0\n");
  assert.deepEqual(await term.state("after q under a wrapper"), before, "the terminal and the server afterwards");
});

test("Ctrl+Z, the deployment removed, fg: the view returns and says, in the shared home's words, that the deployment is not observed and why, with no instance drawn; it still reads keys, and q exits 0", { skip: NO_TMUX }, async (t) => {
  const world = await deployment(t); // its own: this test removes it
  const term = await terminal(t, { world });
  const run = await tui(term, {}, { world, record: false });
  // An add that came to the folder after it was gone would fail, and the TUI would say so under the title.
  await run.added("before the deployment is removed");
  term.press("C-z");
  await until(term, () => term.flags().alternate_on === "0" && term.atPrompt(), "the shell's prompt on its own screen after Ctrl+Z");
  renameSync(world.dep, `${world.dep}-gone`);

  await term.command("fg", "fg");
  await untilScreen(term, notReadFaults, "the view after fg, saying the deployment could not be read");
  assertRunningModes(term, "after fg");
  t.diagnostic(`after fg with the deployment gone the pane shows:\n${term.shows()}`);
  term.press("?");
  await until(term, () => mainOf(term.screen()).some((row) => row.trim() === HELP_FIRST.title) && JSON.stringify(sheetOf(term.screen())) === JSON.stringify(words(HELP_SHEET)), "the help, with its cheat sheet, after fg with the deployment gone");
  assert.equal(run.status(), null, "it still runs");
  term.press("Escape");
  await untilScreen(term, notReadFaults, "the view again after the help was closed");

  term.press("q");
  await term.command(`echo $? > ${shq(run.statusFile)}`, "the status of fg");
  assert.equal(await run.ended("after fg and q"), 0, term.shows());
});

test("it follows the terminal's size: at 60x15 the view still draws, the sidebar alone; below it, in either direction, one line gives the size found and the size needed; back at 80x24 the detail returns beside the sidebar with the selection where it was; under 80 columns the detail is a page of its own", { skip: NO_TMUX }, async (t) => {
  const term = await terminal(t);
  const run = await tui(term);
  // A detached session keeps the size it was made with, and resize-window sets window-size to
  // manual for that window itself: no server option is needed. tmux passes a pane's new size on
  // at most a few times a second, so every step here is a wait on the screen.
  const resize = (cols, rows) => { tmuxOn("resize-window", "-t", term.pane, "-x", String(cols), "-y", String(rows)); assert.equal(term.size(), `${cols}x${rows}`, "tmux resized the pane"); };
  const tooSmall = async (cols, rows) => {
    resize(cols, rows);
    const want = [tooSmallLine(cols, rows), ...Array(rows - 1).fill("")];
    await untilScreen(term, (screen) => (JSON.stringify(screen) === JSON.stringify(want) ? [] : [`the screen is not that one line and ${rows - 1} empty rows`]), `the one line of a terminal too small at ${cols}x${rows}, ${JSON.stringify(want[0])}`);
    assert.equal(run.status(), null, `oats tui still runs at ${cols}x${rows}`);
  };

  term.press("j");
  await run.view("after j", { selected: "beta" });
  resize(60, 15);
  await run.view("at 60x15, the smallest size it draws at", { cols: 60, rows: 15, selected: "beta" });
  await tooSmall(59, 15); // one column short
  await tooSmall(60, 14); // one row short
  await tooSmall(59, 14);
  resize(80, 24);
  await run.view("back at 80x24: the state was kept", { selected: "beta" });
  assertRunningModes(term, "after the resizes");

  // With the focus on the detail, a terminal under 80 columns shows the detail alone.
  term.press("Tab");
  await run.view("after Tab", { selected: "beta", detail: true, sheet: DETAIL_SHEET });
  resize(79, 24);
  // The page is the whole screen from its first row: no title, no list and no cheat sheet; its
  // first row carries its keys at the right instead, dim, ending a cell from the edge: the
  // cheat sheet's but for the leader, the palette, help and quit.
  const pageKeys = "Tab back   n spawn   w workspaces";
  const pageFaults = (screen) => [
    ...(screen.length === 24 ? [] : [`the screen has ${screen.length} rows, not 24`]),
    ...(screen.some((row) => [...row].length > 79) ? ["a row is longer than 79 cells"] : []),
    ...(screen[0] === `${" > beta".padEnd(78 - pageKeys.length)}${pageKeys}` ? [] : [`row 1 is ${JSON.stringify(screen[0])}, not the detail's title with its keys`]),
    ...(screen.includes("   parent   alpha") ? [] : ["no row names the parent"]),
    ...(screen.some((row) => row === "  fixture" || /^[> ] +○ \w/.test(row) || LEAD_ROW.test(row)) ? ["a row of the sidebar is still shown"] : []),
  ];
  await untilScreen(term, pageFaults, "the detail as a page at 79x24");
  term.press("Escape");
  await run.view("after Esc at 79x24: the list, the sidebar alone", { cols: 79, rows: 24, selected: "beta" });

  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
});

let refusals = 0;
/** A pane nothing but the program writes to: no shell prompt, no readline. It waits for a line, so
 *  that the recording of what it receives starts before the program does, and for another at its
 *  end: a dead pane kept by remain-on-exit reports its cursor as off. Resolves with every byte the
 *  pane received, the status, and the terminal. */
async function bare(t, command, what) {
  const n = ++refusals;
  const statusFile = join(base, `refusal-${n}.status`), record = join(base, `refusal-${n}.bytes`);
  const term = await terminal(t, { command: `read go; ${command}; echo $? > ${shq(statusFile)}; echo tui-ended; read stay` });
  tmuxOn("pipe-pane", "-o", "-t", term.pane, `cat > ${shq(record)}`);
  const before = term.flags();
  term.press("Enter");
  await until(term, () => existsSync(record) && readFileSync(record, "utf8").includes("tui-ended"), `everything the pane received ${what}, to its end`);
  const received = readFileSync(record);
  assert.equal(received.includes(0x1b), false, `no escape byte reached the terminal ${what}: ${JSON.stringify(received.toString("latin1"))}`);
  assert.deepEqual(term.flags(), before, `no mode of the terminal changed ${what}`);
  // The terminal's echo of the Enter, the program's lines, the pane's own last word.
  return { term, status: readFileSync(statusFile, "utf8"), text: received.toString("utf8").replace(/\r/g, "") };
}

for (const [what, set] of [["TERM=dumb", "env TERM=dumb"], ["an empty TERM", "env TERM="], ["no TERM", "env -u TERM"]]) {
  test(`with ${what} on a real terminal it refuses with the E_NO_TERMINAL line and status 1, and the terminal received no escape byte and changed no mode`, { skip: NO_TMUX }, async (t) => {
    const { term, status, text } = await bare(t, `${set} ${TUI}`, `with ${what}`);
    assert.equal(status, "1\n", term.shows());
    assert.equal(text, `\n${NO_TERMINAL}\ntui-ended\n`);
    assert.ok(term.showsLine(NO_TERMINAL), `the pane shows the line:\n${term.shows()}`);
  });
}

test("outside a deployment with a --dir it prints one line with E_NO_DEPLOYMENT that names the directory and --dir, with status 1, and the terminal received no escape byte and changed no mode: for a --dir that is a file, and for one that is not there", { skip: NO_TMUX }, async (t) => {
  // What was asked for is not there: answered before the kernel is asked, whatever this computer lists.
  const file = join(base, "a-file"), missing = join(base, "not", "there");
  writeFileSync(file, "");
  for (const [what, args, dir] of [["for a --dir that is a file", `--dir ${shq(file)}`, file], ["for a --dir that is not there", `--dir ${shq(missing)}`, missing]]) {
    const { term, status, text } = await bare(t, `${TUI} ${args}`, what);
    assert.equal(status, "1\n", term.shows());
    assert.equal(text, `\n${noDeployment(dir)}\ntui-ended\n`, what);
  }
});

test("outside every deployment with no --dir and nothing on this computer's list of deployments it prints the E_NO_DEPLOYMENT line that says how to open one and how to create one, with status 1, and the terminal received no escape byte and changed no mode; at a shell's prompt the terminal and the server are what they were", { skip: NO_TMUX || NO_LIST }, async (t) => {
  // A list of the test's own that holds no row, its import of ~/Agents done: what the kernel answers is an empty list.
  const empty = `env OATS_HOME_DIR=${shq(listedHome(join(base, "oats-home-empty"), []))}`;
  const { term: bareTerm, status, text } = await bare(t, `${empty} ${TUI}`, "where it was started");
  assert.equal(status, "1\n", bareTerm.shows());
  assert.equal(text, `\n${noDeploymentListed(realpathSync(base))}\ntui-ended\n`);
  const term = await terminal(t);
  const before = await term.state("before the start");
  const statusFile = join(base, `${term.id}-outside.status`);
  await term.command(`${empty} ${TUI}; echo $? > ${shq(statusFile)}`, "oats tui outside a deployment");
  await until(term, () => existsSync(statusFile) && /\n$/.test(readFileSync(statusFile, "utf8")), "the status of oats tui outside a deployment");
  await term.prompt("after the refusal");
  assert.equal(readFileSync(statusFile, "utf8"), "1\n");
  assert.ok(term.showsLine(noDeploymentListed(realpathSync(base))), `the pane shows the line:\n${term.shows()}`);
  assert.deepEqual(await term.state("after the refusal"), before, "the terminal and the server after the refusal");
});

test("started outside a deployment and with no --dir, it opens on the switcher when this computer's list of deployments holds one: it is listed by its name and its path under the heading for what is not opened; Enter opens it and the Instances view of that deployment is drawn, which says that it is not observed and why; w twice (the list of workspaces, then the switcher) returns to the switcher, where it is now the open one; q exits 0 and the terminal is what it was. With a --dir that is in no deployment, it prints the E_NO_DEPLOYMENT line as before", { skip: NO_TMUX || NO_LIST }, async (t) => {
  // A home and a list of the test's own, for its terminals only. test/helpers/v2-deployment.mjs
  // makes a deployment in a base of its own and nowhere else, so the folder holds only a regular
  // `oats-local.yaml` (the fixture deployment's own): a deployment for the list's existence check
  // and the switcher, which read nothing of a folder but that file's existence, and one the kernel
  // cannot read once it is opened.
  const home = join(base, "home-listed"), folder = join(home, "acme-ledger"), here = realpathSync(base);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "oats-local.yaml"), readFileSync(join(WORLD.dep, "oats-local.yaml")));
  const listed = listedHome(join(base, "oats-home-listed"), [realpathSync(folder)]);
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(listed, { recursive: true, force: true }); });
  // What was asked for is not there: a --dir is never answered with the switcher.
  const { term: refusedTerm, status, text } = await bare(t, `env HOME=${shq(home)} OATS_HOME_DIR=${shq(listed)} ${TUI} --dir ${shq(here)}`, "for a --dir in no deployment, with a deployment listed");
  assert.equal(status, "1\n", refusedTerm.shows());
  assert.equal(text, `\n${noDeployment(here)}\ntui-ended\n`);

  // 120 columns: at 80 the switcher beside the sidebar has twelve cells for what stands beside a
  // name, which would cut the folder's path and the workspace's place.
  const cols = 120;
  await leavesTheTerminalIntact(t, {
    how: "q in the switcher of a run started outside a deployment", status: 0, env: { HOME: home, OATS_HOME_DIR: listed }, size: { cols }, leave: (term) => term.press("q"),
    // Nothing is open yet: Esc has no view to close the switcher onto, and the cheat sheet does not offer it.
    start: { args: "", first: (run) => run.switcher("at the start", { open: false, removable: true, body: [OFFERED, choiceLike("acme-ledger", "(?:\\S.* · )?~/acme-ledger", { selected: true }, cols)] }) },
    arrive: async (term, run) => {
      term.press("Enter");
      // The view of that deployment: its folder's name in the title, and the state and the
      // reason of a deployment that was not read, which are the shared home's words.
      await untilScreen(term, (screen) => notReadFaults(screen, { cols, title: /^ {2}acme-ledger$/, reason: 4 }), "the Instances view of the folder's deployment after Enter");
      assert.equal(run.status(), null, "oats tui still runs after Enter");
      term.press("w", "w");
      // It is served now, so it is no folder to open: it is this run's one workspace, which the
      // shared home lists by its machine and a short reason, under its heading for what it
      // matched to no workspace.
      await run.switcher("after w twice", { body: [UNMATCHED, choiceLike("acme-ledger", "This machine \\S+ \\S.*", { selected: true, open: true }, cols)] });
      return []; // no read is held
    },
  });
});

test("what follows a typed command is found on the pane whether the typed line ends one cell short of its row, fills it exactly or runs one cell over: a line the command prints, and the prompt after a command that prints nothing. Where the typed line fills its row, the joined capture has what follows on the command's own row, and no row equal to it", { skip: NO_TMUX }, async (t) => {
  const cols = 80;
  // What prints a line, and the line: it is put together by printf, so it is nowhere in what is
  // typed. The second is longer than the pane and wraps by itself. The third prints nothing.
  const short = ["printf '%s%s\\n' shown -by-the-command", "shown-by-the-command"], long = [`printf '%0${cols + 20}d\\n' 7`, `${"0".repeat(cols + 19)}7`], silent = [":", null];
  // The length of the typed line, prompt included, and what it prints.
  const cases = [[cols - 1, short], [cols, short], [cols + 1, short], [2 * cols, short], [cols - 1, long], [cols, long], [cols - 1, silent], [cols, silent], [cols + 1, silent], [2 * cols, silent]];
  for (const [n, [length, [print, line]]] of cases.entries()) {
    const what = `a typed line of ${length} cells in ${cols} columns that prints ${line === null ? "nothing" : `${line.length} cells`}`;
    const done = join(base, `typed-${n}.done`);
    const term = await terminal(t, { cols, env: { DONE: done } });
    // The rest of the typed line is a comment: the command prints that line and nothing else.
    const text = `${print}; : > "$DONE"; #`.padEnd(length - PROMPT.length - 1, "x");
    assert.equal(`${PROMPT} ${text}`.length, length, `${what}: the command fits the length asked for`);
    await term.command(text, what);
    await until(term, () => existsSync(done), `the command to end, ${what}`);
    await term.prompt(`after ${what}`);
    const rows = term.joined(), fills = length % cols === 0, next = line ?? PROMPT;
    const pane = `\n${rows.join("\n")}`;
    if (fills) {
      // What the second way of both helpers is for. A tmux or a shell that does not do this
      // fails here: on such a host this case would test nothing of it.
      assert.equal(rows.includes(`${PROMPT} ${text}`), false, `${what}: the typed line fills its row, and the joined capture was expected to have what follows on that row, not on one of its own. This tmux or this shell does not join them, so this case cannot test what it is for:${pane}`);
      assert.equal(rows.includes(`${PROMPT} ${text}${next}`), true, `${what}: the joined row is the prompt, what was typed and what follows:${pane}`);
      if (line !== null) assert.equal(rows.includes(line), false, `${what}: the printed line is no row of its own:${pane}`);
    } else {
      assert.equal(rows.includes(`${PROMPT} ${text}`), true, `${what}: the typed line is a joined row of its own:${pane}`);
      if (line !== null) assert.equal(rows.includes(line), true, `${what}: the printed line is a joined row of its own:${pane}`);
    }
    assert.equal(term.promptFollowsTyped(), line === null, `${what}: the prompt follows what was typed, with nothing between, only where nothing was printed:\n${term.shows()}`);
    assert.equal(term.showsLine(text), false, `${what}: what was typed is not a line the command printed`);
    if (line !== null) {
      assert.equal(text.includes(line), false);
      assert.equal(term.showsLine(line), true, `${what}: the pane shows the line:\n${term.shows()}`);
      // Only a whole line: not a part of one.
      assert.equal(term.showsLine(line.slice(1)), false, `${what}: a part of the line is not the line`);
      assert.equal(term.showsLine(line.slice(0, -1)), false, `${what}: a part of the line is not the line`);
    }
    term.kill();
  }
});

test("started in an agent's pane, in the instance's home and with the variables of an instance session set, it shows the deployment that home is in, and no child of a read sees one of them; with one of the two that name a captured context the kernel refuses the word as it refuses every command, before anything is drawn", { skip: NO_TMUX }, async (t) => {
  // Each names another place: a kernel that ran with them would answer for that place, or refuse.
  // Two of the eight name a captured context, which bin/oats.mjs refuses for every command but
  // `version` before the command runs: the TUI never starts with those, and they are the last part
  // of this test. (That it removes all eight is packages/tui/test/read.test.mjs's.)
  const CAPTURED = ["OATS_RESOLUTION", "OATS_DEPLOYMENT"];
  const stray = Object.fromEntries(INSTANCE_VARIABLES.filter((name) => !CAPTURED.includes(name)).map((name) => [name, join(base, "elsewhere", name.toLowerCase())]));
  const term = await terminal(t, { cwd: WORLD.home, env: stray });
  const shellEnv = join(base, `${term.id}-shell.env`);
  await term.command(`env > ${shq(shellEnv)}; echo written`, "env in the pane's shell");
  await until(term, () => term.screen().includes("written") && term.atPrompt(), "the shell's environment, written down");
  for (const name of Object.keys(stray)) assert.ok(lines(readFileSync(shellEnv, "utf8")).includes(`${name}=${stray[name]}`), `the pane's shell has ${name}`);

  rmSync(WORLD.seenFile, { force: true });
  const run = await tui(term, {}, { args: "" }); // no --dir: the deployment is found from the home
  // The view is drawn from a read whose kernel (and, without status-liveness, collector) ran tmux, which wrote its environment down.
  await until(term, () => existsSync(WORLD.seenFile) && /(^|\n)PATH=/.test(readFileSync(WORLD.seenFile, "utf8")), "the environment a read's tmux was started with");
  const seen = lines(readFileSync(WORLD.seenFile, "utf8")).map((line) => line.split("=")[0]);
  assert.deepEqual(INSTANCE_VARIABLES.filter((name) => seen.includes(name)), [], "no instance variable reached a child's child");
  assert.ok(seen.includes("HOME") && seen.includes("OATS_HOME_DIR"), "the rest of the environment did");
  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());

  for (const name of CAPTURED) {
    const refused = await bare(t, `env ${name}=${shq(join(base, "elsewhere"))} ${TUI} --dir ${shq(WORLD.dep)}`, `with ${name} set`);
    assert.equal(refused.status, "1\n", refused.term.shows());
    assert.match(refused.text, new RegExp(`^\\noats: this environment carries a captured context \\(${name}\\): [^\\n]+\\ntui-ended\\n$`), `the kernel's own refusal, on one line, with ${name} set`);
  }
});

test("tui.json is honoured: the key it gives an action is that action's key in the cheat sheet, in the help and at the keyboard, and the default it replaced is no key; a file the TUI cannot use is named on stderr with E_TUI_CONFIG, status 1, and nothing is drawn", { skip: NO_TMUX }, async (t) => {
  // tui.json is $OATS_HOME_DIR/config/tui.json: each run here has an OATS_HOME_DIR of its own, so
  // the file's own (which the other tests share) never holds one.
  const good = join(base, "config-good"), bad = join(base, "config-bad");
  for (const [dir, value] of [[good, { keys: { quit: ["x"] } }], [bad, { keys: { fly: ["x"] } }]]) {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "tui.json"), JSON.stringify(value));
  }
  const term = await terminal(t, { env: { OATS_HOME_DIR: good } });
  const withX = (hints) => hints.map(([key, word]) => (word === "quit" ? ["x", word] : [key, word]));
  const run = await tui(term, { sheet: withX(LIST_SHEET) });
  term.press("q"); // no key now: read, and nothing happens
  term.press("?");
  // At 80x24 the help has the 39 cells of the main area beside the sidebar, and its line of `quit`
  // is its 168th row or so on macOS, its 208th on Linux and Windows, under the chords that lead
  // the help (HELP_FIRST), the views, `workspaces` and the palette, `open` four times with
  // the agent's terminal and the leader's keys under it (whose rows depend on how the leader's label
  // wraps: one more with `Ctrl+X`, the default, than with `Alt+O`), the switcher's `remove`, `soul-instances`, the open terminal's keys, the
  // split's, the four acts with the rules of a confirmation under them, and the spawn's, each
  // sentence wrapped to that width. How many rows that is changes with any sentence of the help, so
  // the help is scrolled a row at a time until the line of `quit` is on the screen: each `j` waited
  // on until the help has moved, at most 300 (a help that stops moving first fails here, by name).
  const quitShown = () => mainOf(term.screen()).some((row) => /^ *x {2,}quit$/.test(row));
  for (let i = 0; i < 300 && !quitShown(); i++) {
    const before = JSON.stringify(mainOf(term.screen()));
    term.press("j");
    await until(term, () => quitShown() || JSON.stringify(mainOf(term.screen())) !== before, `the help moved a row down at the ${i + 1}th j, towards its line of quit`);
  }
  await until(term, () => quitShown() && JSON.stringify(sheetOf(term.screen())) === JSON.stringify(words(withX(HELP_SHEET))), "the help with x as the quit key, in it and in its cheat sheet, after a q that did not quit");
  assert.equal(mainOf(term.screen()).some((row) => /^ *q\b.* quit$/.test(row)), false, `q is no key of quit:\n${term.shows()}`);
  term.press("Escape");
  await run.view("after the help was closed");
  term.press("x");
  assert.equal(await run.ended("after x"), 0, term.shows());

  const refused = await bare(t, `env OATS_HOME_DIR=${shq(bad)} ${TUI} --dir ${shq(WORLD.dep)}`, "with a tui.json that names an action there is none of");
  assert.equal(refused.status, "1\n", refused.term.shows());
  const said = refused.text.split("\n").filter(Boolean);
  assert.equal(said.length, 2, refused.text);
  assert.ok(said[0].startsWith(`oats: \`oats tui\` cannot use ${join(bad, "config", "tui.json")}: `) && said[0].endsWith(" (E_TUI_CONFIG)") && said[0].includes("fly"), said[0]);
  assert.equal(said[1], "tui-ended");
});

test("a bracketed paste outside the filter field is dropped whole: a pasted q does not quit, nor does a longer paste with q and a newline in it; into the open field its first line is the filter's text, a line the display filter would change adds nothing, and nothing of a paste is a key; a typed q then quits with status 0", { skip: NO_TMUX }, async (t) => {
  const term = await terminal(t);
  const run = await tui(term);
  // -p pastes between the bracket codes only when the pane's program asked for them: it did.
  const paste = (text) => { tmuxOn("set-buffer", "-b", `${term.id}-paste`, text); tmuxOn("paste-buffer", "-d", "-p", "-b", `${term.id}-paste`, "-t", term.pane); };

  paste("q");
  term.press("?"); // input is read in order: once the help is open, the paste before it was read
  await run.help("after a pasted q, then ?");
  term.press("?");
  await run.view("after the help was closed");

  paste("quit q\n?q\x03");
  term.press("?");
  await run.help("after a longer paste, then ?");
  term.press("Escape");
  await run.view("after the pastes");
  assertRunningModes(term, "after the pastes");

  term.press("/");
  await run.view("after /", { heading: viewRow("/", "1"), sheet: FIELD_SHEET });
  paste("gam\nq\n");
  await run.view("after a paste into the field: its first line", { selected: "gamma", gone: ["alpha", "beta"], heading: viewRow("/gam", "1"), sheet: FIELD_SHEET });
  paste("\u202Ema"); // a bidi override: the display filter replaces it
  term.press("Enter"); // read after the paste: the heading names what the field held then
  await run.view("after a paste the display filter would change, then Enter: nothing was added", { selected: "gamma", gone: ["alpha", "beta"], heading: viewRow("Instances  /gam", "1"), sheet: KEPT_SHEET });
  term.press("Escape");
  await run.view("after Esc cleared the filter", { selected: "gamma" });

  term.press("q");
  assert.equal(await run.ended("after a typed q"), 0, term.shows());
});

test("Ctrl+L takes the terminal again: after the screen and the modes were reset from outside the program, the view is complete, the modes are the TUI's again and a paste is still not keys", { skip: NO_TMUX }, async (t) => {
  const term = await terminal(t);
  const run = await tui(term);
  // `send-keys -R` resets the pane's terminal state inside tmux: the screen is cleared without the
  // program writing or knowing, so a program that only writes what changed would leave it empty.
  tmuxOn("send-keys", "-R", "-t", term.pane);
  assert.deepEqual(term.screen().filter(Boolean), [], `${TMUX_VERSION} wiped the pane's screen`);
  term.press("C-l");
  await run.view("after Ctrl+L on a wiped screen");
  // tmux's reset also put the pane's modes back to a terminal's defaults (cursor shown, autowrap
  // on, bracketed paste off): Ctrl+L sets the TUI's own again, so a paste cannot act as keys.
  assertRunningModes(term, `after ${TMUX_VERSION}'s reset and Ctrl+L`);
  tmuxOn("set-buffer", "-b", `${term.id}-paste`, "q");
  tmuxOn("paste-buffer", "-d", "-p", "-b", `${term.id}-paste`, "-t", term.pane);
  term.press("C-l");
  term.press("?");
  await run.help("after another Ctrl+L, then ?");
  term.press("C-l");
  term.press("Escape");
  await run.view("after Ctrl+L with the help open, then Esc");

  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
});

test("in a locale that is not UTF-8 the view's rules and marks are ASCII, and the keys, the help and q work the same", { skip: NO_TMUX }, async (t) => {
  const term = await terminal(t, { locale: ASCII.locale });
  const run = await tui(term, { look: ASCII });
  const screen = term.screen();
  assert.equal(sidebarOf(screen)[7], "-".repeat(38), "the rule under the list");
  assert.equal(screen[23], `${"".padEnd(38)}|`, "the line between the sidebar and the main area reaches the last row");
  assert.equal(screen[3].slice(0, 38).trimEnd(), "> - Alpha");
  assert.equal(screen.some((row) => /[^\x20-\x7e]/.test(row)), false, `every character on the screen is printable ASCII:\n${term.shows()}`);
  term.press("h");
  await run.view("after h in an ASCII locale: collapsed", { folded: true });
  assert.equal(term.screen().some((row) => /[^\x20-\x7e]/.test(row)), false, `every character on the screen is printable ASCII:\n${term.shows()}`);
  term.press("?");
  await run.help("in an ASCII locale");
  term.press("Escape");
  await run.view("after the help was closed", { folded: true });
  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
});

test("the Souls view, with the real `oats souls`: the leader then 2 shows the workspace's souls, each with its instances here counted; Enter shows the selected soul's detail; i shows its instances in the Instances view, filtered by that soul and said so on its heading; Esc clears the filter; q exits 0", { skip: NO_TMUX }, async (t) => {
  const term = await terminal(t);
  const run = await tui(term);
  const row = (name) => term.screen().find((line) => new RegExp(`^[> ] ■ ${name}\\b`).test(line)) ?? null;
  await pairs.repeatable(term, "2", () => viewOpen(term.screen(), "Souls", "2", viewRow("Instances", "1")), "the Souls view open");
  await until(term, () => row("dev") !== null && row("reviewer") !== null, "the souls, read with `oats souls`");
  assert.match(row("dev"), /^[> ] ■ dev ·2(?: |│|$)/, "dev has alpha and beta here");
  assert.match(row("reviewer"), /^[> ] ■ reviewer ·1(?: |│|$)/, "reviewer has gamma");
  assert.deepEqual(sidebarOf(term.screen()).slice(2, 5), [viewRow("Instances", "1"), UTF8.rule.repeat(38), viewRow("Souls", "2")], `the Souls view is the open one, its heading under a rule:\n${term.shows()}`);
  // Move to dev, wherever soulRows sorts it.
  if (!row("dev").startsWith(">")) { term.press("k"); await until(term, () => row("dev")?.startsWith(">"), "dev selected"); }
  term.press("Enter");
  await until(term, () => sheetStarts(term.screen(), [LEAD_HINT, PALETTE_HINT, ["Tab", "back"], ["Enter", "instances"]]), "the detail holds the focus: Tab goes back to the list, Enter shows the soul's instances");
  const detail = () => term.screen().map((line) => line.split("│")[1] ?? "");
  assert.equal(detail()[0].trimEnd(), " > dev", `the detail is dev's, with the focus:\n${term.shows()}`);
  assert.equal(detail().some((line) => line.trim() === "○ alpha  ○ beta"), true, `its instances here, with their marks:\n${term.shows()}`);
  term.press("i");
  const filtered = viewRow("Instances  soul dev", "1");
  await until(term, () => sidebarOf(term.screen())[2] === filtered, "the Instances view, filtered by dev, which its heading says");
  const shown = () => listUnder(term.screen(), sidebarOf(term.screen())[2]).join("\n");
  assert.match(shown(), /Alpha/);
  assert.match(shown(), /Beta/);
  assert.doesNotMatch(shown(), /Gamma/, "the reviewer's instance is not dev's");
  term.press("Escape");
  await until(term, () => /Gamma/.test(shown()) && sidebarOf(term.screen())[2] === viewRow("Instances", "1"), "Esc clears the soul filter, and the heading says no more of it");
  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
});

test("the Capabilities view, with the real `oats capabilities` and `oats souls`: the leader then 3 shows the workspace's capabilities under their section; Enter shows the selected capability's detail, the soul that uses it marked under Used by with its instances here counted; Enter on that soul shows it selected in the Souls view; q exits 0", { skip: NO_TMUX }, async (t) => {
  // A world of its own: the soul dev composes the member capability acme.notes, so its instances
  // alpha and beta carry it; reviewer composes none.
  const world = await deployment(t, {
    souls: { dev: { soul: { capabilities: { "acme.notes": { from: "here" } } } }, reviewer: {} },
    capabilities: { "acme.notes": { manifest: { description: "Notes the fixture keeps." } } },
  });
  const term = await terminal(t, { world });
  const run = await tui(term, {}, { world });
  const list = () => listUnder(term.screen(), viewRow("Capabilities", "3"));
  const detail = () => term.screen().map((line) => (line.split("│")[1] ?? "").trimEnd());
  await pairs.repeatable(term, "3", () => viewOpen(term.screen(), "Capabilities", "3", viewRow("Souls", "2")), "the Capabilities view open");
  await until(term, () => list().some((line) => /^> +acme\.notes$/.test(line)), "the capabilities, read with `oats capabilities`, the first selected");
  assert.equal(list()[0], " Workspace owned", `the section of the member's capabilities heads the list:\n${term.shows()}`);
  assert.match(list()[1], /^ {2}\S.* · member repo · host$/, "then the group of its repository, the host's");
  assert.equal(detail()[0], "   acme.notes", `the detail is the selected capability's:\n${term.shows()}`);
  assert.equal(detail()[1], "   Notes the fixture keeps.", "its description");
  term.press("Enter");
  await until(term, () => JSON.stringify(sheetOf(term.screen())) === JSON.stringify(words([LEAD_HINT, PALETTE_HINT, ["Tab", "back"], ["Enter", "soul"], ...LAST_HINTS])), "the detail holds the focus, a soul of Used by marked: Tab goes back to the list, Enter shows it");
  assert.equal(detail()[0], " > acme.notes", `the detail has the focus:\n${term.shows()}`);
  const used = detail().findIndex((line) => /^ {3}Used by\b/.test(line));
  assert.ok(used > 0, `the detail says which souls use it:\n${term.shows()}`);
  assert.deepEqual(detail().slice(used + 1).filter(Boolean), ["   > ■ dev ·2"], `dev uses it, marked, with alpha and beta carrying it; reviewer does not:\n${term.shows()}`);
  term.press("Enter");
  const soul = (name) => listUnder(term.screen(), viewRow("Souls", "2")).find((line) => new RegExp(`^[> ] ■ ${name}\\b`).test(line)) ?? null;
  await until(term, () => JSON.stringify(sheetOf(term.screen())) === JSON.stringify(words([LEAD_HINT, PALETTE_HINT, ["Enter", "detail"], ["n", "spawn"], ...LAST_HINTS])) && soul("dev") !== null, "the Souls view, its list focused: Enter shows the detail, n spawns");
  assert.match(soul("dev"), /^> ■ dev ·2(?: |$)/, `dev is selected in the Souls view:\n${term.shows()}`);
  assert.equal(soul("reviewer")?.startsWith(" "), true, "and reviewer is not");
  term.press("q");
  assert.equal(await run.ended("after q"), 0, term.shows());
});
