process.env.TZ = "UTC";
import test from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, bindings, keyLabel } from "../lib/actions.mjs";
import { DETACH_KEY_FEATURE, DETAIL_WITHHELD, INSTANCE_VARIABLES, TERMS, startInstance, chordFamilyFrom, createResumeTrigger, cliReadsRemotes, createCapabilityCatalog, createSoulCatalog, sessionAttachArgv, cliRecord, deploymentState, heldHome, identityMemory, observeIdentities, observedEntry, panelData, panelInstances, primaryDeployment, remoteRosterState, rosterRows } from "../lib/client.mjs";
import { effectiveConfig } from "../lib/config.mjs";
import { KEYBOARD_WAIT_MS, NO_TERMINAL, USAGE, main, noDeployment, noDeploymentListed, noKernel, noList, parseArgs } from "../lib/main.mjs";
import { LIST_WORDS } from "../lib/model.mjs";
import { shown, textOf as textShown } from "../lib/term/text.mjs";
import { ENTER, LEAVE, POP, PUSH, QUERY } from "../lib/term/tty.mjs";
import { CLI, DEPLOYMENT, TEST_PLATFORM, lifecycleSession, lifecycleWork, failed, fakeProcess, fakeStdin, fakeStdout, fakeTimers, instanceRow, modesOf, observed, readTerminalOutput, rosterOf } from "./helpers.mjs";

/** One outcome of the roster read as an event for the store, made as lib/read.mjs `takeRoster`
 *  makes it: the shared rule over the roster held, then what it reported into the memory of
 *  identities, with the time of the cycle that began the read. */
function rosterEvent(held, outcome, at) {
  const state = remoteRosterState(held.remote, outcome, at);
  const identities = state.reported === null ? { memory: held.memory, notes: held.notes } : observeIdentities({ memory: held.memory, notes: held.notes }, state.reported, at);
  return { roster: { remote: { remoteGroups: state.remoteGroups, rosterAnswered: state.rosterAnswered, rosterFailure: state.rosterFailure }, memory: identities.memory, notes: identities.notes, at } };
}
/** The reader of a run, faked: what the loop asked of it, in order, and a way to answer. */
function fakeReader(log, options) {
  let number = 0;
  const did = (what, ...more) => { log.push(["reader", what, ...more]); };
  return {
    options, calls: [],
    start() { did("start"); return Promise.resolve(); },
    request(how) { did("request", how); return Promise.resolve(); },
    touch() { did("touch"); },
    voidInFlight() { did("void"); },
    /** The exec the loop hands the shared preflight: the test's fake prepareRemoteTerm only checks it is this one. */
    exec() { throw new Error("the fake reader starts nothing"); },
    /** A change (an apply, a start): recorded with its label, answered by the test through `changed`. */
    changeExec(bin, argv, options, callback) { did("change", [...argv], options.label); this.changed.push({ argv, options, callback }); return { pid: 4000 + this.changed.length }; },
    changed: [],
    /** The changes still running when the run ends, as lib/read.mjs answers after its stop. */
    running: [],
    changes() { return this.running; },
    stop() { did("stop"); },
    children: () => [],
    /** A served deployment's answer of a cycle, as lib/read.mjs gives it: every answer under a
     *  number of its own, as every cycle has. */
    answer(entry, id = DEPLOYMENT) { options.onEntry({ id, entry, number: ++number }); },
    /** The number of the last cycle begun, as lib/read.mjs `begun` answers: each answer and each
     *  `cycle()` begins one. */
    begun() { return number; },
    /** A cycle begun now, answered later (`read`): its number. */
    cycle() { return ++number; },
    /** An answer made from the kernel's (`read: true`), of a cycle begun earlier or now. */
    read(entry, at = ++number, id = DEPLOYMENT) { options.onEntry({ id, entry, number: at, read: true }); },
    /** A roster read begun, as lib/read.mjs says it. */
    collecting() { options.onRoster({ collecting: true }); },
    /** One outcome of the roster read, over what the loop holds of the other machines now. */
    roster(outcome) { options.onRoster(rosterEvent(options.getRoster(), outcome, options.clock())); },
  };
}
/** The run's panel (lib/panel.mjs), faked: what the loop asked of it, in order, under "panel" in
 *  the log; `opens`, every open with a way to answer it as the panel does (`made(id)`, `refuse(error)`);
 *  `screen` and `closed`, the panel's two callbacks, as it calls them. */
function fakePanel(log, options) {
  const did = (what, ...more) => { log.push(["panel", what, ...more]); };
  const p = {
    options, opens: [],
    screen: (id, text, cursor = { x: 0, y: 0, visible: true }, size = { cols: 40, rows: 10 }) => options.onScreen({ id, screen: options.capture(text, size), cursor }),
    closed: (id, status, stderr = "", asked = false) => options.onClosed({ id, status, stderr, asked }),
    activity: (id) => options.onActivity({ id }),
  };
  p.api = {
    open({ argv, cols, rows }) {
      did("open", [...argv], cols, rows);
      return new Promise((resolve, reject) => { p.opens.push({ argv, cols, rows, made: (id) => resolve({ id }), refuse: reject }); });
    },
    close(id) { did("close", ...(id === undefined ? [] : [id])); }, show(id) { did("show", id); }, resize(cols, rows, ids) { did("resize", cols, rows, ...(ids === undefined ? [] : [ids])); },
    // T3: what the loop displays and gives the keys to (lib/main.mjs fitPanel).
    hide(id) { did("hide", id); }, focus(id) { did("focus", id); },
    input(bytes) { did("input", Buffer.from(bytes).toString("latin1")); }, paste(text) { did("paste", text); },
    setVisible(on) { did("visible", on); }, refresh() { did("refresh"); }, pause() { did("pause"); }, resume() { did("resume"); }, end() { did("end"); },
    get current() { return null; },
  };
  return p;
}
/** The help is on the screen: its first heading, the chords' on Linux and Windows, the keys' on macOS. */
const HELP_HEADING = /\b(Chords|Keys)\b/;
/** `oats tui` on a fake terminal: the run, its streams and what it wrote. Everything outside the
 *  terminal (the user's file, the deployment, the kernel, the reader) is the test's own, and so is
 *  its platform: Linux (helpers.mjs TEST_PLATFORM), whatever platform runs the tests, so that the
 *  chords the tests type are the ones the run binds (#1608: on macOS Alt+Shift+Down is no chord).
 *  macOS's are pinned with `platform: "darwin"`. */
function run({ argv = [], env = { TERM: "xterm-256color", LANG: "en_US.UTF-8" }, columns = 80, rows = 24, stdinTTY = true, stdoutTTY = true, config = { ok: true, actions: ACTIONS, ascii: false, detachKey: "C-\\" }, deployment = { ok: true, deployment: DEPLOYMENT }, kernel = { ok: true, cli: CLI }, cwd = "/work/here", listed = [], listAnswer = null, admit = (path) => ({ ok: true, deployment: path }), prepare = null, confirm = null, start = null, tellable = () => false, keyboard = false, platform = TEST_PLATFORM, keys = chordFamilyFrom(null) } = {}) {
  const log = [];
  const stdin = fakeStdin({ log, isTTY: stdinTTY }), stdout = fakeStdout({ log, columns, rows, isTTY: stdoutTTY }), proc = fakeProcess(), timers = fakeTimers();
  proc.platform = platform;
  const kill = proc.kill;
  proc.kill = (pid, signal) => { log.push(["kill", pid, signal]); return kill(pid, signal); };
  const errors = [];
  const stderr = { write(text) { errors.push(text); log.push(["stderr", text]); return true; } };
  let clock = Date.parse("2026-10-11T10:00:30.000Z");
  // `listed`: the rows this computer's deployments list answers a read with; `listAnswer(asked, call)`:
  // the answer of any call to that list (a read, an add, a remove), by default `listed` for a read and
  // done for a change, each the test's to replace; an answer of undefined holds the call open, for
  // the test to answer through its `answer`. `lists`: every call, in order.
  // `panel`: the run's panel, faked (what the loop asked of it, and a way to answer as the panel
  // does); `preflights`: every preflight it began, each with what it was handed and a way to answer it.
  // `soulReads`: every `oats souls` the run's catalog asked for, with a way to answer it; `soulExec`
  // the exec the loop made the catalog with. `capabilityReads` and `capabilityExec`: the same of
  // the run's capabilities table (`oats capabilities`).
  // `spawn`: what the run made of the three shared spawn factories, faked: the preview's reads and
  // the transaction's submits and checks, each with a way to answer; what the boundary was made with.
  // `identities`: what the run asked of its identity reads (lib/read.mjs createIdentityReads, faked): each
  // start's paths in order, how many times they were stopped, and what the run made them with.
  const r = { stdin, stdout, proc, timers, errors, log, listed, keysAsked: [], observed: [], lists: [], identities: { starts: [], stops: 0, options: null }, reader: null, panel: null, preflights: [], confirmations: [], starts: [], soulReads: [], soulExec: null, capabilityReads: [], capabilityExec: null, tick(ms) { clock += ms; },
    spawn: { preview: null, previewExec: null, reads: [], applyRead: null, applyExec: null, applyCalls: [], request: null, submits: [], checks: [] } };
  r.listAnswer = listAnswer ?? ((asked) => (asked.action === "list" ? { ok: true, value: { ok: true, rows: r.listed } } : { ok: true, value: asked.action === "add" ? { path: asked.path, added: true } : { path: asked.path, removed: true } }));
  let up;
  r.up = new Promise((resolve) => { up = resolve; });
  const effects = {
    loadConfig(asked) { log.push(["effect", "config", { ...asked.env }]); return config; },
    // keys.json (lib/config.mjs loadKeys), the test's own: no test reads a user's file. `keys` is
    // its answer (no file by default); what it was asked with is kept, not logged.
    loadKeys(asked) { r.keysAsked.push({ env: { ...asked.env }, home: asked.home }); return keys; },
    findDeployment(start) { log.push(["effect", "deployment", start]); return deployment; },
    async probeKernel(asked) { log.push(["effect", "kernel", { ...asked.env }]); return kernel; },
    createReader(options) { r.reader = fakeReader(log, options); const start = r.reader.start; r.reader.start = () => { const answer = start(); queueMicrotask(up); return answer; }; return r.reader; },
    // The identity reads, faked: nothing is read; the test answers through `r.identities.options.onRead`.
    createIdentityReads(options) { r.identities.options = options; return { start(paths) { r.identities.starts.push([...paths]); }, stop() { r.identities.stops += 1; } }; },
    // This computer's deployments list (the shared cliDeploymentList), faked: each call is logged
    // with what it asked and the exec it was handed: `start` (the effect below, the exec of the one
    // read before the terminal is taken), `read` (the reader's own exec) or `change` (any other: the
    // loop's changeExec, for an add or a remove).
    deploymentList(cli, asked, io) {
      const via = io.exec === effects.startExec ? "start" : io.exec === r.reader?.exec ? "read" : "change";
      log.push(["effect", "list", { ...asked }, via]);
      return new Promise((resolve) => {
        const call = { cli, asked, io, answer: resolve };
        r.lists.push(call);
        const given = r.listAnswer(asked, call);
        if (given !== undefined) resolve(given);
      });
    },
    startExec() { throw new Error("the fake start exec starts nothing"); },
    admitDeployment(path) { log.push(["effect", "admit", path]); return admit(path); },
    createPanel(options) { r.panel = fakePanel(log, options); return r.panel.api; },
    // The shared resume trigger itself; what each read gave its `observed` is kept (`r.observed`).
    createResumeTrigger(options) {
      const made = createResumeTrigger(options);
      return { ...made, observed(rows, given) { r.observed.push({ rows, options: given }); return made.observed(rows, given); } };
    },
    sweep(options) { log.push(["panel", "sweep", options.env === env]); return { removed: [] }; },
    runDir() { log.push(["panel", "dir"]); return "/tmp/oats-tui-fixture"; },
    removeDir(dir) { log.push(["panel", "remove", dir]); },
    prepareRemoteTerm(cli, target, options) {
      log.push(["preflight", target]);
      if (prepare) return prepare(cli, target, options);
      return new Promise((resolve, reject) => { r.preflights.push({ cli, target, options, resolve, reject }); });
    },
    // The acts: the shared confirmation is the real one unless the test gives its own (`confirm`);
    // a start is the test's (`start`), and so is whether stderr is a terminal or a file.
    ...(confirm ? { createLifecycleConfirmation(options) { const made = confirm(options); r.confirmations.push(made); return made; } } : {}),
    ...(start ? { startInstance(...args) { r.starts.push(args); return start(...args); } } : {}),
    tellable,
    // The souls: the shared catalog itself, over a kernel read the test answers.
    createSoulCatalog(options) {
      r.soulExec = options.exec;
      return createSoulCatalog({ ...options, invoke: (cli, asked) => new Promise((resolve) => { log.push(["souls", asked.action]); r.soulReads.push({ asked, answer: resolve }); }) });
    },
    // The capabilities: the shared table itself, over a kernel read the test answers.
    createCapabilityCatalog(options) {
      r.capabilityExec = options.exec;
      return createCapabilityCatalog({ ...options, invoke: (cli, asked) => new Promise((resolve) => { log.push(["capabilities", asked.action]); r.capabilityReads.push({ asked, answer: resolve }); }) });
    },
    // The spawn: the shared preview, apply boundary and transaction, faked.
    createSpawnPreview(options) {
      r.spawn.previewExec = options.exec;
      r.spawn.preview = {
        read: (request, getContext) => new Promise((resolve) => { log.push(["spawn", "preview"]); r.spawn.reads.push({ request, context: getContext(), answer: resolve }); }),
        prepareRead() { throw new Error("the fake preview prepares nothing"); },
        cache: { invalidate(id) { log.push(["spawn", "invalidate", id]); }, size: () => 0 },
      };
      return r.spawn.preview;
    },
    createSpawnApplyBoundary(options) {
      r.spawn.applyRead = options.read; r.spawn.applyExec = options.exec; r.spawn.applyTimer = options.applyTimer; r.spawn.answerTimer = options.timer;
      return (body, getContext, extra) => { r.spawn.applyCalls.push({ body, context: getContext(), settled: extra?.settled }); return Promise.resolve(null); };
    },
    createSpawnTransaction(options) {
      r.spawn.request = options.request; r.spawn.sleep = options.sleep;
      return {
        submit: (intent, call) => new Promise((resolve) => { log.push(["spawn", "submit"]); r.spawn.submits.push({ intent, call, answer: resolve }); }),
        check: (job, call) => new Promise((resolve) => { log.push(["spawn", "check"]); r.spawn.checks.push({ job, call, answer: resolve }); }),
        recover() { throw new Error("the TUI recovers nothing"); },
      };
    },
  };
  // `keyboard`: a run asks for the kitty keyboard protocol (docs/tui.md, "Chords"); the tests of a
  // terminal that is never asked, every one but the chords', pass false, the default here.
  r.status = main({ argv, stdin, stdout, stderr, env, proc, now: () => clock, setTimer: timers.setTimer, clearTimer: timers.clearTimer, cwd: () => cwd, home: "/home/u", keyboard, effects });
  r.status.then(up);
  return r;
}
/** A run that has taken its terminal and drawn its first frame. */
async function started(options) { const r = run(options); await r.up; return r; }
/** The text a run has on screen after its writes, read naively: enough to find a word. */
const textOf = (output) => readTerminalOutput(output).text;
const readerDid = (r) => r.log.filter(([what]) => what === "reader").map(([, ...rest]) => rest);
const ENTRY = observed([instanceRow("acme-expert", "acme-expert-tui"), instanceRow("acme-maintainer", "acme-maintainer-ops", { running: false, runtimeState: "stopped" })]);

// ── Other machines and the switcher: fixtures in the kernel's own forms. A workspace is the
// identity a kernel reports; a roster group's id is `<server>:<targetKey>` with a lower-case server
// name and no path in it; a remote row says whether it is addressable. A group in another form is
// never remembered, and a deployment that reports no identity is matched to no workspace.
const reportedWorkspace = (key = "git.example.com/acme-platform/agents", team = "aweb:acme-platform") => ({ reachable: true, key, ref: `git:${key}`, keyFrom: "workspace", standalone: false, defaultTeam: { label: "default", team }, teams: { default: team }, teamsFrom: "observed" });
/** An observed entry of the deployment at `root`, through the real `rosterRows`, `panelInstances`
 *  and `observedEntry`, as helpers.mjs `observed` makes one, with the workspace it reports. */
function observedAt(root, rows, { workspace = reportedWorkspace(), name = "acme-platform" } = {}) {
  const local = rows.map((row) => ({ ...row, home: `${root}/agents/${row.agent}/instances/${row.instance}`, repo: `${root}/oats` }));
  const base = rosterOf(local);
  const document = { ...base, root: `${root}/agents`, agents: base.agents.map((soul) => ({ ...soul, dir: `${root}/agents/${soul.name}` })), workspace };
  const listed = rosterRows(document, CLI);
  return observedEntry({ roster: document, workspaceStatus: { workspace: { name } }, observedAt: "2026-10-11T09:59:00.000Z" }, panelInstances(listed, listed.map((row) => ({ running: row.running, runtimeState: row.runtimeState, tmux: row.tmux }))), "2026-10-11T10:00:00.000Z");
}
/** The fixture's deployment, reporting the workspace `garnet` reports too. */
const HOME_ENTRY = observedAt(DEPLOYMENT, [instanceRow("acme-expert", "acme-expert-tui"), instanceRow("acme-maintainer", "acme-maintainer-ops", { running: false, runtimeState: "stopped" })]);
const remoteRow = (name, root, more = {}) => ({ instance: name, agent: "dev", agentsRoot: `${root}/agents`, home: `${root}/agents/dev/instances/${name}`, running: true, savedRoute: false, addressable: true, missingRemotely: false, createdAt: null, identity: { alias: name, team: "aweb:acme-platform" }, ...more });
function group(id, root, rows, workspace = reportedWorkspace()) {
  const server = id.slice(0, id.indexOf(":"));
  return { id, server, label: server, registrationPresent: true, target: { sshHost: `${server}.example`, workspace: root }, probe: { ok: true }, agentsRoot: `${root}/agents`, workspace, souls: [], instances: rows, retireFailures: [] };
}
/** A machine in the fixture's workspace, and one that reports a workspace of its own. */
const garnet = () => group("garnet:t1", "/srv/acme-platform", [remoteRow("dev-far", "/srv/acme-platform"), remoteRow("dev-held", "/srv/acme-platform", { running: false, addressable: false })]);
const onyx = () => group("onyx:t2", "/home/builder/acme-atlas", [remoteRow("dev-east", "/home/builder/acme-atlas", { identity: { alias: "dev-east", team: "aweb:acme-atlas" } })], reportedWorkspace("git.example.com/acme-atlas/charts", "aweb:acme-atlas"));
/** What `oats server roster --json` prints for these groups. */
const rosterAnswer = (groups) => ({ schemaVersion: 1, ok: true, result: { groups } });
/** A kernel record that reads other machines, made by the shared `cliRecord` as the probe makes it. */
const REMOTE_CLI = cliRecord({ version: CLI.version, workspaceApi: CLI.workspaceApi, features: [...CLI.features], remote: ["roster"] }, { bin: CLI.bin, source: "tui" });
/** A row of this computer's deployments list that this run does not serve, as the shared reader gives it. */
const LEDGER = "/home/u/acme-ledger";
const LISTED = Object.freeze([Object.freeze({ path: LEDGER, name: "acme-ledger", state: "ok" })]);
/** What the kernel refuses a call to the list with when another holds its lock. */
const BUSY = Object.freeze({ code: "E_DEPLOYMENTS_BUSY", message: "This computer's list of deployments is busy; try again." });
/** The delete key, as a terminal sends it: the switcher's Remove. */
const DELETE = "\x1b[3~";
/** Every microtask and the callbacks of the I/O already due run: an answer given is taken. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** What a run asked of the file system and the kernel, in order: the effects with their arguments
 *  (the user's file and the kernel are asked with the environment, which is not repeated here). */
const effectsOf = (r) => r.log.filter(([what]) => what === "effect").map(([, which, ...rest]) => (which === "config" || which === "kernel" ? [which] : [which, ...rest]));
/** The whole screen as the run draws it now. Ctrl+L redraws in full, so the text read does not
 *  depend on which cells the last frame left as they were. */
function screenOf(r) {
  r.stdout.take();
  r.stdin.type("\x0c");
  return textOf(r.stdout.take());
}
/** The reason the shared home gives for the fixture's deployment holding `entry`, asked directly. */
function sharedReason(entry) {
  const held = { ctxs: [DEPLOYMENT], snapshot: { byWs: new Map([[DEPLOYMENT, entry]]) }, remoteGroups: [], remembered: identityMemory({ memory: new Map(), notes: new Map() }), rosterAnswered: false, rosterFailure: null, cli: CLI, observing: new Set(), remoteCollecting: false, home: "/home/u", at: "2026-10-11T10:00:30.000Z" };
  return deploymentState(primaryDeployment(panelData(held, DEPLOYMENT, TERMS).deployments)).detail;
}
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
/** Every byte a run wrote to its terminal, from its first. */
const written = (r) => r.log.filter(([what]) => what === "write").map(([, bytes]) => bytes).join("");
/** A screen's text with every run of blanks as one: two screens that differ in a sentence's length compare by their words. */
const words = (text) => text.replace(/ +/g, " ");
/** The rows a terminal shows after `output`, `cols` by `rows`, each with its trailing blanks cut:
 *  the text placed where each position sequence puts it, an erase to the end of a row and a clear
 *  of the screen done (the only sequences that move or clear anything, helpers.mjs). One character
 *  is one cell: enough for the fixtures' words. */
function screenRows(output, cols, rows) {
  const screen = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let row = 0, col = 0;
  for (let i = 0; i < output.length; i++) {
    const csi = output[i] === "\x1b" ? /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(output.slice(i, i + 32)) : null;
    if (csi) {
      if (csi[2] === "H") [row, col] = csi[1].split(";").map((n) => Number(n) - 1);
      else if (csi[2] === "J") screen.forEach((line) => line.fill(" "));
      else if (csi[2] === "K" && row < rows) screen[row].fill(" ", col);
      i += csi[0].length - 1;
    } else if (output[i] !== "\x1b") {
      if (row < rows && col < cols) screen[row][col] = output[i];
      col += 1;
    }
  }
  return screen.map((line) => line.join("").trimEnd());
}
/** The sidebar's text as the run draws it now (docs/tui.md, "What it shows"), by a redraw that is no
 *  key (a resize to the same size: a key bound to an action would put the line after an open
 *  away): each row up to the rule beside it, the rows joined, every run of blanks as one. A
 *  sentence the sidebar wraps reads whole, and nothing of the main area comes between its rows. */
function sidebarOf(r) {
  r.stdout.take();
  r.stdout.resize(r.stdout.columns, r.stdout.rows);
  return words(screenRows(r.stdout.take(), r.stdout.columns, r.stdout.rows).map((line) => line.split("\u2502")[0].trim()).filter(Boolean).join(" "));
}
/** The main area's text the same way: each row after the rule beside the sidebar. A sentence the
 *  switcher wraps reads whole, and nothing of the sidebar comes between its rows. */
function mainAreaOf(r) {
  r.stdout.take();
  r.stdout.resize(r.stdout.columns, r.stdout.rows);
  return words(screenRows(r.stdout.take(), r.stdout.columns, r.stdout.rows).map((line) => line.split("\u2502").slice(1).join("\u2502").trim()).filter(Boolean).join(" "));
}

test("the action table binds each key to one action, and a key bound twice is refused when the table is read", () => {
  assert.deepEqual(Object.fromEntries(bindings(ACTIONS)), {
    up: "up", k: "up", down: "down", j: "down", g: "top", home: "top", G: "bottom", end: "bottom", pageup: "page-up", pagedown: "page-down",
    left: "collapse", h: "collapse", right: "expand", l: "expand", tab: "detail", "/": "filter", r: "refresh", 1: "instances", 2: "souls", 3: "capabilities",
    w: "workspaces", enter: "open", delete: "remove", i: "soul-instances", z: "zoom", c: "close-terminal", "[": "tab-previous", "]": "tab-next", "|": "split-right", "-": "split-down", X: "stop", D: "retire", S: "start", R: "restart", n: "spawn", N: "spawn-another", C: "spawn-check",
    "?": "help", escape: "close", q: "quit", "ctrl+c": "quit", "ctrl+z": "suspend", "ctrl+l": "redraw", "ctrl+k": "palette",
  });
  assert.throws(() => bindings([{ id: "a", keys: ["x"], label: "a" }, { id: "b", keys: ["x"], label: "b" }]), /key x is bound to a and to b/);
  assert.equal(Object.isFrozen(ACTIONS) && ACTIONS.every((a) => Object.isFrozen(a) && Object.isFrozen(a.keys)), true);
  assert.deepEqual(["?", "q", "escape", "ctrl+c", "shift+tab", "f5", "ctrl+alt+up", "space", "alt+x"].map(keyLabel), ["?", "q", "Esc", "Ctrl+C", "Shift+Tab", "F5", "Ctrl+Alt+Up", "Space", "Alt+X"]);
  // Enter opens the selected agent's terminal in the list and the selected workspace in the
  // switcher: one action. The capitals are the acts on an instance, G, another of the selected
  // instance's soul (N) and the check of a spawn's result (C): no act is a lower-case key (Enter is
  // cheap, a capital takes Shift). A spawn's own key is n: it opens a prompt, and spawns nothing.
  assert.equal(bindings(ACTIONS).get("enter"), "open");
  assert.deepEqual([...bindings(ACTIONS).keys()].filter((key) => /^[A-Z]$/.test(key)), ["G", "X", "D", "S", "R", "N", "C"]);
  for (const id of ["stop", "retire", "start", "restart"]) assert.equal(ACTIONS.find((action) => action.id === id).keys.every((key) => /^[A-Z]$/.test(key)), true, id);
});

test("the arguments are --ascii, --help and --dir with a path, in both spellings; anything else is refused with E_BAD_ARGS and the usage, --server and --no-resume included", () => {
  assert.deepEqual(parseArgs([]), { options: { ascii: false, help: false, dir: null } });
  assert.deepEqual(parseArgs(["--ascii"]).options, { ascii: true, help: false, dir: null });
  assert.equal(parseArgs(["-h"]).options.help, true);
  assert.deepEqual(parseArgs(["--ascii", "--help"]).options, { ascii: true, help: true, dir: null });
  assert.equal(parseArgs(["--dir", "/srv/deploy"]).options.dir, "/srv/deploy");
  assert.equal(parseArgs(["--dir=/srv/deploy", "--ascii"]).options.dir, "/srv/deploy");
  assert.equal(parseArgs(["--dir", "--ascii"]).options.dir, "--ascii", "what follows --dir is its path, whatever it looks like");
  assert.equal(parseArgs(["--dir=a=b"]).options.dir, "a=b");
  for (const argv of [["--dir"], ["--dir="], ["--ascii", "--dir"], ["--dir", ""]]) assert.equal(parseArgs(argv).error, `oats: \`oats tui --dir\` takes a path (E_BAD_ARGS); usage: ${USAGE}`, argv.join(" "));
  for (const argv of [["--server", "build"], ["--json"], ["instances"], ["--ascii", "--no"], ["--ascii=1"], ["--directory", "/x"], ["--no-resume"], ["--resume"]]) {
    const { error, options } = parseArgs(argv);
    assert.equal(options, undefined);
    assert.equal(error, `oats: \`oats tui\` takes no argument ${argv.find((a) => a !== "--ascii")} (E_BAD_ARGS); usage: ${USAGE}`);
  }
  const hostile = parseArgs(["\x1b[2J\x1b]0;owned\x07"]).error;
  assert.doesNotMatch(hostile, /[\x00-\x1f\x7f]/, "an argument is never echoed raw: this line goes to a terminal");
  assert.match(hostile, /E_BAD_ARGS/);
  assert.equal(USAGE, "oats tui [--dir <path>] [--ascii]");
});

test("without a terminal on stdin and stdout, or with TERM unset, empty or dumb, it exits 1 with one line on stderr, draws nothing and reads nothing", async () => {
  const cases = [
    { stdinTTY: false }, { stdoutTTY: false }, { stdinTTY: false, stdoutTTY: false },
    { env: { LANG: "en_US.UTF-8" } }, { env: { TERM: "" } }, { env: { TERM: "dumb" } },
  ];
  for (const options of cases) {
    const r = run(options);
    assert.equal(await r.status, 1, JSON.stringify(options));
    assert.deepEqual(r.errors, [`${NO_TERMINAL}\n`]);
    assert.deepEqual(r.stdout.written, [], "no byte, so no escape byte, on a stream that is not a terminal");
    assert.equal(r.stdin.raw, false);
    assert.deepEqual(r.proc.eventNames(), [], "and it listens for nothing");
    assert.deepEqual(r.log.filter(([what]) => what === "effect"), [], "the user's file, the deployment and the kernel are not looked at");
  }
  assert.equal(NO_TERMINAL, "oats: `oats tui` needs a terminal on stdin and stdout (E_NO_TERMINAL); `oats status` prints the instances once");
});

test("--help prints the usage and exits 0 with no terminal; a bad argument exits 1 before the terminal is looked at", async () => {
  const help = run({ argv: ["--help"], stdinTTY: false, stdoutTTY: false });
  assert.equal(await help.status, 0);
  assert.equal(help.stdout.written.join("").startsWith(`Usage:\n  ${USAGE}\n`), true);
  assert.match(help.stdout.written.join(""), /--dir <path>.*--ascii/s);
  assert.deepEqual(help.errors, []);
  const bad = run({ argv: ["--server", "build"] });
  assert.equal(await bad.status, 1);
  assert.deepEqual(bad.errors, [`oats: \`oats tui\` takes no argument --server (E_BAD_ARGS); usage: ${USAGE}\n`]);
  assert.deepEqual(bad.stdout.written, []);
});

test("the eight instance variables are removed from the process environment itself before anything is read or started, so the user's file, the kernel and every child see none", async () => {
  const env = { TERM: "xterm-256color", LANG: "en_US.UTF-8", KEEP: "this", ...Object.fromEntries(INSTANCE_VARIABLES.map((name) => [name, `/an/agent/${name}`])) };
  assert.equal(INSTANCE_VARIABLES.length, 8);
  const r = await started({ env });
  for (const name of INSTANCE_VARIABLES) assert.equal(name in env, false, name);
  assert.equal(env.KEEP, "this");
  for (const [, , seen] of r.log.filter(([what, which]) => what === "effect" && which !== "deployment")) assert.deepEqual(Object.keys(seen).filter((name) => INSTANCE_VARIABLES.includes(name)), []);
  assert.equal(r.reader.options.env, env, "the reader is given that same environment, the one its children inherit");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  // Also when the run then stops for want of a terminal: the removal comes before that check.
  const none = { ...Object.fromEntries(INSTANCE_VARIABLES.map((name) => [name, "x"])) };
  await run({ env: none }).status;
  assert.deepEqual(Object.keys(none), []);
});

test("before the alternate screen, in this order and each a line on stderr with status 1: the user's file, the deployment, the kernel, and outside every deployment this computer's list of deployments", async () => {
  const lines = ["oats: `oats tui` cannot use /home/u/.oats/config/tui.json: quit has no key; give it one (E_TUI_CONFIG)", "oats: `oats tui` cannot use /home/u/.oats/config/tui.json: unknown action reload; the actions are up (E_TUI_CONFIG)"];
  const cases = [
    [{ config: { ok: false, lines } }, lines.map((line) => `${line}\n`).join(""), ["config"]],
    [{ kernel: { ok: false, reason: "version 0.24.0 outside >=0.25.8 <0.53.0" } }, `${noKernel("version 0.24.0 outside >=0.25.8 <0.53.0")}\n`, ["config", "deployment", "kernel"]],
    // No deployment where the user is, and none named: the list is read through the kernel, so a
    // kernel the TUI cannot use reads no list; a list that holds no row, and one that could not be read.
    [{ deployment: { ok: false, dir: "/work/here" }, kernel: { ok: false, reason: "version 0.24.0 outside >=0.25.8 <0.53.0" } }, `${noKernel("version 0.24.0 outside >=0.25.8 <0.53.0")}\n`, ["config", "deployment", "kernel"]],
    [{ deployment: { ok: false, dir: "/work/here" } }, `${noDeploymentListed("/work/here")}\n`, ["config", "deployment", "kernel", "list"]],
    [{ deployment: { ok: false, dir: "/work/here" }, listAnswer: () => ({ ok: false, reason: BUSY }) }, `${noList(BUSY)}\n`, ["config", "deployment", "kernel", "list"]],
  ];
  for (const [options, said, asked] of cases) {
    const r = run(options);
    assert.equal(await r.status, 1);
    assert.equal(r.errors.join(""), said);
    assert.deepEqual(r.log.filter(([what]) => what === "effect").map(([, which]) => which), asked);
    assert.equal(r.lists.length, asked.includes("list") ? 1 : 0, "the list is read at most once");
    assert.deepEqual(r.stdout.written, [], "nothing is drawn");
    assert.equal(r.stdin.raw, false);
    assert.equal(r.reader, null, "and nothing is read");
    assert.deepEqual(r.proc.eventNames(), []);
  }
  assert.equal(noDeployment("/work/here"), "oats: no OATS deployment at or above /work/here (E_NO_DEPLOYMENT); name one with `oats tui --dir <path>`");
  assert.equal(noKernel("version 0.24.0 outside >=0.25.8 <0.53.0"), "oats: `oats tui` could not use its own kernel (E_TUI_KERNEL): version 0.24.0 outside >=0.25.8 <0.53.0");
  assert.equal(noDeploymentListed("/work/here"), "oats: no deployment at or above /work/here, and this computer's list of deployments holds none (E_NO_DEPLOYMENT): `oats tui --dir <path>` opens one (and lists it), `oats onboard <dir> --workspace <ref>` creates one");
  assert.equal(noList(BUSY), "oats: `oats tui` could not read this computer's list of deployments (E_DEPLOYMENTS_BUSY): This computer's list of deployments is busy; try again.", "the kernel's code, and its message as it came: it says what to do");
});

test("a path or a reason in those lines is never written raw: a path that is not plain reads `that directory`, and a reason goes through the display filter", () => {
  for (const dir of ["/tmp/\x1b[2J", "/tmp/café", `/${"d".repeat(200)}`, "", null]) {
    assert.equal(noDeployment(dir), "oats: no OATS deployment at or above that directory (E_NO_DEPLOYMENT); name one with `oats tui --dir <path>`", JSON.stringify(dir));
  }
  assert.equal(noDeployment("/srv/my deployments/one").includes("/srv/my deployments/one"), true, "a space is plain");
  for (const dir of ["/tmp/\x1b[2J", "/tmp/café", `/${"d".repeat(200)}`, "", null]) {
    assert.equal(noDeploymentListed(dir), "oats: no deployment at or above that directory, and this computer's list of deployments holds none (E_NO_DEPLOYMENT): `oats tui --dir <path>` opens one (and lists it), `oats onboard <dir> --workspace <ref>` creates one", JSON.stringify(dir));
  }
  // The list's refusal: a code not in the kernel's form is not echoed (E_CLI_FAILED stands for it), and the message goes through the display filter.
  assert.doesNotMatch(noList({ code: "E_DEPLOYMENTS_BUSY", message: "busy (\x1b]0;owned\x07)" }), /[\x00-\x1f\x7f-\x9f]/);
  assert.match(noList({ code: "E_DEPLOYMENTS_BUSY", message: "busy (\x1b]0;owned\x07)" }), /\(E_DEPLOYMENTS_BUSY\): \[withheld\]$/);
  assert.match(noList({ code: "E_DEPLOYMENTS_BUSY", message: "two\nlines" }), /: two lines$/);
  for (const reason of [{ code: "\x1b[2J", message: "m" }, { code: "busy", message: "m" }, { message: "m" }]) assert.match(noList(reason), /deployments \(E_CLI_FAILED\): m$/, JSON.stringify(reason));
  for (const reason of [{ code: "E_DEPLOYMENTS_BUSY", message: "" }, { code: "E_DEPLOYMENTS_BUSY" }]) assert.match(noList(reason), /\(E_DEPLOYMENTS_BUSY\): it gave no reason$/);
  assert.equal(noList(null), "oats: `oats tui` could not read this computer's list of deployments (E_CLI_FAILED): it gave no reason");
  assert.doesNotMatch(noKernel("not the oats CLI (name: \x1b]0;owned\x07)"), /[\x00-\x1f\x7f-\x9f]/);
  assert.match(noKernel("not the oats CLI (name: \x1b]0;owned\x07)"), /\(E_TUI_KERNEL\): \[withheld\]$/);
  assert.match(noKernel("two\nlines"), /: two lines$/);
  assert.match(noKernel(""), /: it gave no reason$/);
});

test("the deployment is looked for from --dir, a relative one from where the user is, else from where the user is", async () => {
  for (const [argv, from] of [[[], "/work/here"], [["--dir", "/srv/deploy/agents"], "/srv/deploy/agents"], [["--dir=../there"], "/work/there"], [["--dir", "."], "/work/here"]]) {
    const r = run({ argv, deployment: { ok: false, dir: from } });
    await r.status;
    assert.deepEqual(r.log.find(([what, which]) => what === "effect" && which === "deployment"), ["effect", "deployment", from], argv.join(" "));
  }
});

test("a run says it is reading, draws the instances when the reader answers (the sidebar names the workspace and counts nothing), opens and closes the help, and q quits with status 0, the terminal restored and the reader stopped before the run is over", async () => {
  const r = await started();
  assert.deepEqual([r.reader.options.getServed(), r.reader.options.cli], [[DEPLOYMENT], CLI], "the reader reads the deployment that was found, with the kernel that was accepted");
  assert.equal(r.reader.options.getEntry(DEPLOYMENT).deployment.status, "pending", "and is told the entry the store holds");
  assert.match(textOf(r.stdout.take()), /^ {2}deploy +│.*Instances +1 │ +Reading the deployment\..*Souls +2 │ Capabilities +3 │.*Ctrl\+\\ +commands.*\? +help.*q +quit/s);
  r.reader.answer(ENTRY);
  const answered = textOf(r.stdout.take());
  assert.match(answered, /^ {2}acme-platform +│.*● Acme expert tui.*○ Acme maintainer ops/s);
  assert.doesNotMatch(answered, /\d+ (running|stopped)/, "no counts: the header that held them is gone");
  assert.equal(r.reader.options.getEntry(DEPLOYMENT), ENTRY);
  r.stdin.type("?");
  // Beside the sidebar, its top row the time of the read the screen shows. The chords lead (every
  // one is read in any terminal), each with its leader key: the Alt family's, on Linux (macOS's in
  // the next test). At 24 rows its first page ends before Esc.
  assert.match(textOf(r.stdout.take()), /│ {3}read 10:00:00 .*Chords.*Shortcuts: Alt\..*Alt\+K +palette, or.*Ctrl\+\\ then k.*more below/s);
  r.stdin.type("G");
  // Its last page: the last section's commands, `oats server connect`'s on two rows, and the close.
  assert.match(textOf(r.stdout.take()), /oats session attach --home <home>.*oats server connect <id> --ssh <alias>.*--dir <path on that machine>.*closes this help.*more above/s, "the movement keys scroll the help to its end");
  r.stdin.type("?");
  assert.match(textOf(r.stdout.take()), /acme-expert-tui/);
  r.log.length = 0;
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  assert.equal(r.stdout.take(), LEAVE);
  assert.equal(r.stdin.raw, false);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.log.filter(([what, which]) => (what === "write" || which === "stop")).map(([what, which]) => (what === "write" ? "leave" : which)), ["leave", "stop"], "the terminal first, then the reads");
  r.reader.answer(ENTRY);
  assert.equal(r.stdout.take(), "", "an answer that arrives after the end draws nothing");
});

test("on macOS the help's chords are the Alt (Option) arrows alone, and at 24 rows its first page ends before Esc", async () => {
  const r = await started({ platform: "darwin" });
  r.reader.answer(ENTRY);
  r.stdout.take();
  r.stdin.type("?");
  assert.match(textOf(r.stdout.take()), /│ {3}read 10:00:00 .*Chords.*Shortcuts on macOS: Alt \(Option\).*Alt\+Up\/Down +previous and.*Alt\+Left\/Right +previous and.*more below/s);
  r.stdin.type("?");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("every key press tells the reader the user is there; r asks for a live read, at once", async () => {
  const r = await started();
  r.log.length = 0;
  r.stdin.type("j");
  r.stdin.type("r");
  assert.deepEqual(readerDid(r), [["touch"], ["touch"], ["request", { live: true }]]);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the modes a whole run switches are exactly the list: four on at the start, the same four off and on again at Ctrl+L, the four back at the end, and nothing else, with the view drawn, filtered and scrolled", async () => {
  const r = await started({ listed: LISTED });
  r.reader.answer(ENTRY);
  r.stdin.type("?");
  r.stdout.resize(100, 30);
  r.stdout.resize(40, 10);
  r.stdin.type("\x0c"); // Ctrl+L
  r.stdin.type("?");
  r.stdin.type("j\t/");
  r.stdin.type("\x1b[200~pasted q\nand a second line\x1b[201~");
  r.stdin.type("\r");
  r.reader.answer(failed(ENTRY, { code: "E_NEW_CODE", message: "a refusal with \x1b[2J in it" }));
  // The same refusal as the kernel's own (the reader marks it): the shared sentence names the speaker.
  r.reader.answer(failed(ENTRY, { code: "E_NEW_CODE", message: "a refusal with \x1b[2J in it", origin: "kernel" }));
  // And with the switcher drawn, over a machine's roster and a row of this computer's list.
  r.reader.collecting();
  r.reader.roster({ envelope: rosterAnswer([garnet(), onyx()]) });
  r.stdin.type("w"); r.stdin.type("w");
  await settle();
  r.stdin.type("j/");
  r.stdin.type("\x1b[200~onyx\x1b]0;owned\x07\x1b[201~");
  r.stdin.type("\r");
  r.stdin.type("\x03"); // Ctrl+C
  assert.equal(await r.status, 0);
  const output = r.stdout.written.join("");
  const on = ["?1049h", "?25l", "?7l", "?2004h"], off = ["?2004l", "?7h", "?25h", "?1049l"];
  assert.deepEqual(modesOf(output), [...on, ...off, ...on, ...off]);
  assert.deepEqual([...new Set(modesOf(output))].sort(), [...on, ...off].sort(), "the set of mode sequences is the list, and only it");
  const { sequences, foreign, text } = readTerminalOutput(output);
  assert.deepEqual(foreign, [], "no mouse or focus reporting, no keyboard protocol, no keypad mode, no title, no clipboard, no query");
  assert.deepEqual([...new Set(sequences.map((s) => s.kind))].sort(), ["erase", "mode", "position", "sgr", "sync"]);
  const sync = sequences.filter((s) => s.kind === "sync").map((s) => s.body);
  assert.equal(sync.length > 0 && sync.every((body, i) => body === (i % 2 === 0 ? "?2026h" : "?2026l")), true, "every frame is begun and ended within itself: no synchronized update is left open");
  assert.doesNotMatch(text, /[\x00-\x1f\x7f-\x9f]/, "no bell, no other control byte");
  assert.equal(output.startsWith(ENTER) && output.endsWith(LEAVE), true);
});

test("Esc alone closes the help once nothing has followed it for 50 ms, and not before", async () => {
  const r = await started();
  r.stdin.type("?");
  r.stdout.take();
  r.stdin.type("\x1b");
  assert.equal(r.stdout.take(), "", "a lone ESC may be the start of a key");
  assert.deepEqual(r.timers.delays(), [50]);
  r.tick(50);
  r.timers.fire();
  assert.match(textOf(r.stdout.take()), /Reading the deployment\./);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  assert.equal(r.timers.count, 0, "no timer outlives the run");
});

test("a paste into the list is dropped whole: a pasted q, a pasted Ctrl+C and a pasted ? do nothing; into the filter field its first line is text", async () => {
  const r = await started();
  r.reader.answer(ENTRY);
  r.stdout.take();
  r.stdin.type("\x1b[200~q\x03?\x1a\x1b[201~");
  assert.equal(r.stdout.take(), "", "nothing changed, so nothing was written");
  assert.equal(r.log.some(([what]) => what === "kill"), false, "it was not suspended");
  r.stdin.type("/");
  r.stdout.take();
  r.stdin.type("\x1b[200~maintainer\nq\x1b[201~");
  const filtered = textOf(r.stdout.take());
  assert.match(filtered, /maintainer/);
  assert.doesNotMatch(filtered, /acme-expert-tui/, "the row that does not match is gone");
  r.stdin.type("q");
  assert.match(textOf(r.stdout.take()), /No instance matches the filter\./, "q is text in the field");
  r.stdin.type("\x03");
  assert.equal(await r.status, 0, "Ctrl+C still quits from the field");
});

test("a resize redraws in full; below 60x15 the screen is the too-small line, and back above it the view returns as it was", async () => {
  const r = await started();
  r.reader.answer(ENTRY);
  r.stdin.type("j");
  r.stdout.take();
  r.stdout.resize(60, 15);
  let out = r.stdout.take();
  assert.equal(out.startsWith("\x1b[?2026h\x1b[0m\x1b[2J"), true, "a resize clears first, inside the frame's synchronized update");
  assert.match(textOf(out), /^ {2}acme-platform.*Acme maintainer ops.*Ctrl\+\\ +commands +Ctrl\+K +palette +n +spawn +w +workspaces +\? +help +q +quit$/s, "at 15 rows the small cheat sheet gives up nothing");
  r.stdout.resize(59, 14);
  out = r.stdout.take();
  assert.equal(textOf(out), "Terminal too small: 59x14, oats tui needs 60x15.");
  r.stdout.resize(80, 24);
  assert.match(textOf(r.stdout.take()), /acme-maintainer-ops +│ +soul +acme-maintainer\b.*> ○ Acme maintainer ops/s, "the selection is where it was, its detail beside the list");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("a resize while a frame is being written makes no second write until the first has drained, then one frame at the newest size", async () => {
  const r = await started();
  r.stdout.take();
  r.stdout.accepts = false;
  r.stdin.type("?");
  assert.equal(r.stdout.written.length, 1, "the help frame is being written");
  r.stdout.resize(100, 30);
  r.stdout.resize(59, 14);
  r.reader.answer(ENTRY);
  r.stdout.resize(120, 40);
  assert.equal(r.stdout.written.length, 1, "nothing is queued behind it, an answer of the reader included");
  r.stdout.take();
  r.stdout.accepts = true;
  r.stdout.emit("drain");
  assert.equal(r.stdout.written.length, 1, "one frame for three resizes and an answer");
  const out = r.stdout.take();
  assert.equal(out.startsWith("\x1b[?2026h\x1b[0m\x1b[2J"), true);
  assert.match(out, /\x1b\[40;1H/, "drawn for the 40 rows the terminal has now");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("Ctrl+L sets the terminal's modes again and redraws in full; Ctrl+\\ in the list is the leader, which writes nothing while it waits, and a second Ctrl+\\ cancels it and writes nothing either", async () => {
  const r = await started();
  const first = r.stdout.take();
  assert.equal(first.startsWith(ENTER), true);
  r.log.length = 0;
  r.stdin.type("\x1c");
  assert.equal(r.stdout.take(), "", "while the leader waits the screen is as it was: nothing is written");
  r.stdin.type("\x1c");
  assert.equal(r.stdout.take(), "", "the leader again cancels it, and nothing is written");
  assert.deepEqual(readerDid(r), [["touch"], ["touch"]], "the leader reads nothing");
  r.log.length = 0;
  r.stdin.type("\x0c");
  assert.equal(r.stdout.take(), LEAVE + first, "the terminal left, then the same bytes as the start: the modes, then the frame cleared and drawn whole");
  assert.deepEqual(r.log.filter(([what]) => what === "raw"), [["raw", false], ["raw", true]], "raw mode is set again too");
  assert.deepEqual(readerDid(r), [["touch"]], "a redraw reads nothing and drops nothing");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the bytes Ctrl+L writes, in order: raw mode off and on, then the leave and the enter sequence in ONE write, then the frame; three in a row write that three times, and q then leaves once", async () => {
  const r = await started();
  const frame = r.stdout.take().replace(ENTER, "");
  assert.equal(frame.startsWith("\x1b[?2026h") && frame.endsWith("\x1b[?2026l"), true, "the frame is one synchronized update");
  assert.equal(frame.replace(/\x1b\[\?2026[hl]/g, "").includes("\x1b[?"), false, "the frame itself switches no mode, but the update it begins and ends");
  r.log.length = 0;
  r.stdin.type("\x0c");
  // One write for the pair: a terminal never shows the shell's screen between the two halves, and
  // no other write of the program can land between them.
  const acts = r.log.filter(([what]) => what !== "reader");
  assert.deepEqual(acts.slice(0, 3), [["raw", false], ["raw", true], ["write", LEAVE + ENTER]]);
  assert.equal(acts.slice(3).every(([what]) => what === "write"), true);
  assert.equal(acts.slice(3).map(([, bytes]) => bytes).join(""), frame, "then the frame, cleared and drawn whole");
  assert.equal(r.stdout.take(), LEAVE + ENTER + frame);

  r.stdin.type("\x0c");
  r.stdin.type("\x0c");
  assert.equal(r.stdout.take(), (LEAVE + ENTER + frame).repeat(2));
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  assert.equal(r.stdout.take(), LEAVE, "after any number of Ctrl+L the end is one leave: every entry was matched by a leave before it");
  assert.equal(r.stdin.raw, false);
});

test("Ctrl+Z hands the terminal back, drops the reads in flight and only then stops the process group; SIGCONT brings the frame back in full and reads at once", async () => {
  const r = await started();
  const first = r.stdout.take().replace(ENTER, "");
  r.log.length = 0;
  r.stdin.type("\x1a");
  assert.equal(r.stdout.take(), LEAVE);
  // A cycle in flight when the process stops is no evidence about the deployment: it is dropped
  // BEFORE the signal, while the process can still do it.
  assert.deepEqual(r.log.filter(([what]) => what !== "raw"), [["reader", "touch"], ["write", LEAVE], ["reader", "void"], ["kill", 0, "SIGTSTP"]]);
  assert.equal(r.stdin.raw, false);
  r.log.length = 0;
  r.proc.emit("SIGCONT", "SIGCONT");
  assert.equal(r.stdout.take(), ENTER + first);
  assert.equal(r.stdin.raw, true);
  assert.deepEqual(readerDid(r), [["request", { live: true }]], "the return reads at once, and has nothing more to drop");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("stopped and continued from outside, which it could not prepare for: the reads in flight are dropped on the return, the modes are set again and it reads at once", async () => {
  const r = await started();
  const first = r.stdout.take().replace(ENTER, "");
  r.log.length = 0;
  r.proc.emit("SIGCONT", "SIGCONT");
  assert.deepEqual(readerDid(r), [["void"], ["request", { live: true }]]);
  assert.equal(r.stdout.take(), LEAVE + ENTER + first);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("with --ascii, the user's file saying ascii, or a locale that is not UTF-8, the rules are hyphens and no byte outside ASCII is written", async () => {
  for (const options of [{ argv: ["--ascii"] }, { config: { ok: true, actions: ACTIONS, ascii: true, detachKey: "C-\\" } }, { env: { TERM: "xterm", LANG: "C" } }, { env: { TERM: "xterm", LC_ALL: "POSIX", LANG: "en_US.UTF-8" } }]) {
    const r = await started(options);
    r.reader.answer(ENTRY);
    r.stdin.type("?");
    r.stdin.type("q");
    assert.equal(await r.status, 0);
    const output = r.stdout.written.join("");
    assert.doesNotMatch(output, /[^\x00-\x7f]/, JSON.stringify(options.argv ?? options.env ?? "tui.json"));
    assert.match(textOf(output), /-{38}\|/, "the sidebar's rule is hyphens across its 38 columns, and the rule beside it a bar");
  }
  const utf8 = await started();
  utf8.stdin.type("q");
  await utf8.status;
  assert.match(textOf(utf8.stdout.written.join("")), /─{38}│/);
});

test("the keys are the effective table's: with the user's file giving quit to x, x quits and q does nothing, and the cheat sheet says so", async () => {
  const config = effectiveConfig({ keys: { quit: ["x"] } });
  const r = await started({ config: { ...config, path: "/home/u/.oats/config/tui.json" } });
  assert.match(textOf(r.stdout.take()), / x +quit +│/);
  r.stdin.type("q");
  assert.equal(r.stdout.take(), "");
  r.stdin.type("x");
  assert.equal(await r.status, 0);
});

test("each signal ends the run with its status, the terminal restored and the reader stopped; the message of an uncaught error is printed after the alternate screen is left", async () => {
  for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["SIGQUIT", 131]]) {
    const r = await started();
    r.stdout.take();
    r.log.length = 0;
    r.proc.emit(signal, signal);
    assert.equal(await r.status, status, signal);
    assert.equal(r.stdout.take(), LEAVE);
    assert.deepEqual(readerDid(r), [["stop"]], signal);
    assert.deepEqual(r.errors, []);
  }
  const r = await started();
  r.proc.emit("uncaughtException", new Error("the view broke"));
  assert.equal(await r.status, 1);
  const order = r.log.map(([what, bytes]) => (what === "write" && bytes === LEAVE ? "leave" : what === "reader" ? bytes : what)).filter((what) => ["leave", "stop", "stderr"].includes(what));
  assert.deepEqual(order, ["leave", "stop", "stderr"]);
  assert.match(r.errors.join(""), /^oats: `oats tui` stopped on an internal error; the terminal was restored\n {2}Error: the view broke\n/);
});

test("an error's text is never written raw: a control sequence in its message is withheld from the terminal", async () => {
  const r = await started();
  r.proc.emit("uncaughtException", new Error("name \x1b]0;owned\x07\x1b[2J"));
  assert.equal(await r.status, 1);
  assert.doesNotMatch(r.errors.join(""), /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  const thrown = await started();
  thrown.proc.emit("unhandledRejection", "a string, not an error");
  assert.equal(await thrown.status, 1);
  assert.match(thrown.errors.join(""), /\n {2}a string, not an error\n$/);
});

test("a reader that throws when asked ends the run as an internal error, with the terminal restored", async () => {
  const r = await started();
  r.reader.request = () => { throw new Error("the reader broke"); };
  r.stdin.type("r");
  assert.equal(await r.status, 1);
  assert.match(r.errors.join(""), /stopped on an internal error.*the reader broke/s);
  assert.equal(r.stdin.raw, false);
});

// ── Other machines and the workspace switcher ────────────────────────────────

test("started outside every deployment with no --dir, it reads this computer's list of deployments through its kernel before the terminal is taken, and with a row there it opens on the switcher: the row is listed, nothing is served, and the reader is started, which reads the roster of other machines", async () => {
  // 120 columns: the switcher beside the sidebar is wide enough for a row's whole path.
  const r = await started({ deployment: { ok: false, dir: "/work/here" }, listed: LISTED, kernel: { ok: true, cli: REMOTE_CLI }, columns: 120, rows: 40 });
  assert.deepEqual(r.errors, [], "there is something to list, so no line that there is no deployment");
  assert.deepEqual(effectsOf(r), [["config"], ["deployment", "/work/here"], ["kernel"], ["list", { action: "list" }, "start"]], "the list is read through the kernel just asked, with the exec made for the start: the reader's does not exist yet");
  const [read] = r.lists;
  assert.deepEqual([read.cli, read.io.env], [REMOTE_CLI, r.reader.options.env], "with the run's own kernel and environment");
  const at = (what, which) => r.log.findIndex(([w, x]) => w === what && (which === undefined || x === which));
  assert.equal(at("effect", "list") < at("write"), true, "before the terminal is taken");
  assert.deepEqual(r.reader.options.getServed(), [], "nothing is served");
  assert.deepEqual(r.reader.options.getRoster(), { remote: { remoteGroups: [], rosterAnswered: false, rosterFailure: null }, memory: new Map(), notes: new Map() });
  assert.deepEqual(readerDid(r), [["start"]], "the reader is started all the same: its cycles read the other machines");
  const first = textOf(r.stdout.take());
  assert.match(first, /^ workspaces.*On this machine, not opened.*acme-ledger\s+~\/acme-ledger.*Enter +open.*\/ +filter.*r +refresh.*Delete +remove.*\? +help.*q +quit/s);
  assert.doesNotMatch(first, /Reading the deployment|Esc close/, "no deployment is being read, and there is no view to close the switcher onto");
  // What the reader's first cycle found of the other machines is listed too.
  r.reader.collecting();
  r.reader.roster({ envelope: rosterAnswer([garnet()]) });
  assert.match(screenOf(r), /^ workspaces.*garnet.*On this machine, not opened.*acme-ledger/s);
  assert.deepEqual(r.reader.options.getServed(), []);
  await settle();
  assert.equal(r.lists.length, 1, "a run started in no deployment adds none to the list");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("started outside every deployment with no row on this computer's list, it exits 1 with the E_NO_DEPLOYMENT line that says so and no byte on stdout, and so does a list that could not be read, with the kernel's code and message; a --dir that is in no deployment exits with its own line before the kernel is asked or the list read", async () => {
  const none = run({ deployment: { ok: false, dir: "/work/here" } });
  assert.equal(await none.status, 1);
  assert.deepEqual(effectsOf(none), [["config"], ["deployment", "/work/here"], ["kernel"], ["list", { action: "list" }, "start"]]);
  assert.deepEqual(none.errors, [`${noDeploymentListed("/work/here")}\n`]);
  assert.deepEqual(none.stdout.written, [], "no byte, so no escape byte");
  assert.deepEqual([none.reader, none.stdin.raw, none.proc.eventNames()], [null, false, []]);

  // A list that could not be read is no empty list: what the kernel said, as it said it.
  const unread = run({ deployment: { ok: false, dir: "/work/here" }, listAnswer: () => ({ ok: false, reason: BUSY }) });
  assert.equal(await unread.status, 1);
  assert.deepEqual(unread.errors, [`${noList(BUSY)}\n`]);
  assert.equal(unread.errors[0].includes(`(${BUSY.code}): ${BUSY.message}\n`), true, "the kernel's code and message, unchanged");
  assert.deepEqual([unread.stdout.written, unread.reader, unread.stdin.raw, unread.proc.eventNames()], [[], null, false, []]);

  // What was asked for is not there: a row of the list is no answer to a path that was named.
  for (const argv of [["--dir", "/srv/nowhere"], ["--dir=/srv/nowhere"], ["--ascii", "--dir", "/srv/nowhere"]]) {
    const named = run({ argv, deployment: { ok: false, dir: "/srv/nowhere" }, listed: LISTED });
    // A run that took the terminal instead would wait for a key and never end, and this file with
    // it: such a run is seen as soon as it has started, and is ended here before it is judged.
    const how = await Promise.race([named.status, named.up.then(() => "it took the terminal")]);
    if (how !== 1) { named.stdin.type("q"); await named.status; }
    assert.equal(how, 1, argv.join(" "));
    assert.deepEqual(effectsOf(named), [["config"], ["deployment", "/srv/nowhere"]], `${argv.join(" ")}: the kernel is not asked, and the list is not read`);
    assert.deepEqual(named.lists, []);
    assert.deepEqual(named.errors, [`${noDeployment("/srv/nowhere")}\n`]);
    assert.deepEqual(named.stdout.written, []);
    assert.deepEqual([named.reader, named.stdin.raw, named.proc.eventNames()], [null, false, []]);
  }
});

test("a run started in a deployment, from where it was started or by --dir, adds it to this computer's list once, as the TUI's, after the reader starts and as a change of the run, then reads the list once for the identity reads; never adds again in that run: not on w, not on r, not when a row is opened", async () => {
  for (const [argv, from] of [[[], "/work/here"], [["--dir", DEPLOYMENT], DEPLOYMENT]]) {
    const r = await started({ argv, listed: LISTED });
    await settle();
    assert.deepEqual(effectsOf(r), [["config"], ["deployment", from], ["kernel"], ["list", { action: "add", path: DEPLOYMENT, via: "tui" }, "change"], ["list", { action: "list" }, "read"]], `${argv.join(" ")}: the add, through no exec of the start's and no read's; then the list, through the reader's exec`);
    const at = (what, which) => r.log.findIndex(([w, x]) => w === what && x === which);
    assert.equal(at("reader", "start") < at("effect", "list"), true, "after the reader starts");
    const [add] = r.lists;
    assert.deepEqual([add.cli, add.io.env], [CLI, r.reader.options.env], "with the run's own kernel and environment");
    r.stdin.type("q");
    assert.equal(await r.status, 0);
  }
  const r = await started({ listed: LISTED });
  r.reader.answer(HOME_ENTRY);
  r.stdin.type("w"); r.stdin.type("w"); await settle();
  r.stdin.type("r"); await settle();
  r.stdin.type("j");
  r.stdin.type("\r"); await settle();
  assert.deepEqual(r.reader.options.getServed(), [DEPLOYMENT, LEDGER], "the row was opened");
  r.stdin.type("w"); r.stdin.type("w"); await settle();
  r.stdin.type("r"); await settle();
  assert.deepEqual(r.lists.map(({ asked }) => asked.action), ["add", "list", "list", "list", "list", "list"], "one add, a read at the start, and a read for each w and each r");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("an add the kernel refuses is said once, under the sidebar's list of workspaces, with the kernel's message as it came, and blocks nothing; an add that is done says nothing", async () => {
  const r = await started({ columns: 120, listAnswer: (asked) => (asked.action === "add" ? { ok: false, reason: BUSY } : { ok: true, value: { ok: true, rows: LISTED } }) });
  await settle();
  r.reader.answer(ENTRY);
  // A redraw that types nothing: screenOf's Ctrl+L is a key bound to an action, which puts the line away.
  const said = sidebarOf(r);
  // Under the list of workspaces, the open one's row (this computer's listed deployments are the switcher's).
  assert.match(said, /^acme-platform This deployment was not added to this computer's list: This computer's list of deployments is busy; try again\. /, said);
  assert.match(said, /Acme expert tui.*Acme maintainer ops/s, "the deployment is read and drawn all the same");
  r.stdin.type("j");
  const after = screenOf(r);
  assert.doesNotMatch(after, /not added/, "said once: the next key puts it away");
  assert.match(after, /Acme expert tui.*Acme maintainer ops/s);
  r.reader.answer(ENTRY);
  r.stdin.type("w"); r.stdin.type("w"); await settle();
  assert.match(screenOf(r), /On this machine, not opened.*acme-ledger/s, "the list is read as ever");
  assert.doesNotMatch(screenOf(r), /not added/, "and nothing brings the line back");
  assert.deepEqual(r.lists.map(({ asked }) => asked.action), ["add", "list", "list"], "the add is not tried again: the start's read and the w's");
  r.stdin.type("q");
  assert.equal(await r.status, 0);

  const done = await started({ columns: 120 });
  await settle();
  done.reader.answer(ENTRY);
  assert.doesNotMatch(textOf(written(done)), /not added|this computer's list/);
  done.stdin.type("q");
  assert.equal(await done.status, 0);
});

test("a change to this computer's list still running when the run ends is named after the screen is left, in the list's own line, only to a terminal or a file", async () => {
  for (const [tell, lines] of [[true, [`${LIST_WORDS.leaving}\n`]], [false, []]]) {
    const r = await started({ tellable: () => tell });
    await settle();
    const [add] = r.lists;
    // The exec the add was handed is the reader's changeExec, labelled as a change to the list; what
    // the shared call asks of it goes on as it was.
    add.io.exec(CLI.bin, ["deployments", "add", DEPLOYMENT, "--via", "tui", "--json"], { cwd: DEPLOYMENT }, () => {});
    const [change] = r.reader.changed;
    assert.deepEqual([change.argv, change.options.cwd], [["deployments", "add", DEPLOYMENT, "--via", "tui", "--json"], DEPLOYMENT]);
    r.reader.running = [{ pid: 4001, label: change.options.label }];
    r.stdin.type("q");
    assert.equal(await r.status, 0, String(tell));
    assert.deepEqual(r.errors, lines, String(tell));
  }
  assert.equal(LIST_WORDS.leaving, "oats: a change to this computer's list of deployments is still running; `oats deployments` shows the list.");
});

// ── Lost sessions resumed (#1559; docs/tui.md, "Resuming lost sessions"): the kernel's machine sweep,
// through the shared trigger, the shared runner and the shared reader, over the fake reader's changeExec.

/** The run's kernel with the machine sweep (`oats version --json` features). */
const RESUME_CLI = Object.freeze({ ...CLI, features: Object.freeze([...CLI.features, "session-resume"]) });
/** The sweeps the run started: its changes that are `oats session resume --json`. */
const sweepsOf = (r) => r.reader.changed.filter(({ argv }) => argv[0] === "session");
/** The kernel's answer to a sweep that resumed `instance` of the fixture's deployment, as its stdout. */
const resumedAnswer = (instance) => JSON.stringify({ schemaVersion: 1, ok: true, result: { schemaVersion: 1, plan: false,
  deployments: [{ deployment: DEPLOYMENT, state: "ok", swept: true }], rows: [{ deployment: DEPLOYMENT, instance, outcome: "resumed" }] } });
/** An observed entry of the fixture's deployment whose `instance` has lost its session. */
const lostEntry = (instance) => {
  const entry = observedAt(DEPLOYMENT, [instanceRow("acme-expert", instance, { running: false, runtimeState: "stopped" })]);
  return { ...entry, instances: entry.instances.map((row) => ({ ...row, sessionEnd: "lost" })) };
};

test("with a kernel that has the sweep, a run started in a deployment resumes lost sessions once the add of that deployment has settled: after the first frame and the reader's start, as a change of the run labelled as the sweep, from /, with the run's environment", async () => {
  let add = null;
  const env = { TERM: "xterm-256color", LANG: "en_US.UTF-8", OATS_HOME_DIR: "/scratch/oats-home" };
  const r = await started({ env, kernel: { ok: true, cli: RESUME_CLI }, listAnswer: (asked, call) => {
    if (asked.action === "add") { add = call; return undefined; }
    return { ok: true, value: { ok: true, rows: [] } };
  } });
  await settle();
  assert.notEqual(add, null, "the add is on its way");
  assert.deepEqual(sweepsOf(r), [], "no sweep while the add is on its way");
  add.answer({ ok: true, value: { path: DEPLOYMENT, added: true } });
  await settle();
  const [sweep, ...more] = sweepsOf(r);
  assert.deepEqual(more, [], "one sweep");
  assert.deepEqual(sweep.argv, ["session", "resume", "--json"]);
  assert.deepEqual(sweep.options.label, { verb: "resume" }, "the sweep's label: a change, let go in silence on the way out");
  assert.equal(sweep.options.cwd, "/");
  assert.equal(sweep.options.env.OATS_HOME_DIR, "/scratch/oats-home", "the run's environment, as the other kernel calls have it");
  const at = (what, which) => r.log.findIndex(([w, x]) => w === what && (which === undefined || x === which));
  const swept = r.log.findIndex(([w, x, argv]) => w === "reader" && x === "change" && argv?.[0] === "session");
  assert.equal(at("write") < swept && at("reader", "start") < swept, true, "after the first frame and the reader's start");
  r.stdin.type("q");
  assert.equal(await r.status, 0);

  // A refused add holds the sweep up no more than a done one.
  const refused = await started({ kernel: { ok: true, cli: RESUME_CLI }, listAnswer: (asked) => (asked.action === "add" ? { ok: false, reason: BUSY } : { ok: true, value: { ok: true, rows: [] } }) });
  await settle();
  assert.equal(sweepsOf(refused).length, 1);
  refused.stdin.type("q");
  assert.equal(await refused.status, 0);
});

test("a run started in the switcher, outside every deployment, resumes lost sessions too: the sweep is the machine's, with no add to wait for", async () => {
  const r = await started({ deployment: { ok: false, dir: "/work/here" }, listed: LISTED, kernel: { ok: true, cli: RESUME_CLI } });
  await settle();
  assert.deepEqual(r.lists.map(({ asked }) => asked.action), ["list"], "no add");
  assert.deepEqual(sweepsOf(r).map(({ argv }) => argv), [["session", "resume", "--json"]]);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("with a kernel without the sweep nothing is run: not at the start, not when a read shows a lost session", async () => {
  const r = await started({});
  await settle();
  r.reader.read(lostEntry("acme-expert-tui"));
  r.tick(60_000);
  r.reader.read(lostEntry("acme-expert-ops"));
  await settle();
  assert.deepEqual(sweepsOf(r), []);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("what the sweep did is not said, and the rows are read live; a read showing a lost session sweeps again, never while one is in flight nor within the floor", async () => {
  const r = await started({ columns: 120, kernel: { ok: true, cli: RESUME_CLI } });
  await settle();
  r.reader.answer(ENTRY);
  assert.equal(sweepsOf(r).length, 1, "the sweep at the start");
  // A lost session read while the first sweep is in flight starts no second.
  r.reader.read(lostEntry("acme-expert-tui"));
  await settle();
  assert.equal(sweepsOf(r).length, 1, "one in flight at a time");
  r.log.length = 0;
  sweepsOf(r)[0].callback(null, resumedAnswer("acme-expert-tui"), "");
  await settle();
  assert.deepEqual(readerDid(r).filter(([what]) => what === "request"), [["request", { live: true }]], "a live read, so the resumed row reads running");
  assert.doesNotMatch(sidebarOf(r), /resum|lost/i, "nothing said of the sweep");
  // Within the floor a lost session read starts none; once it has passed, the next does.
  r.reader.read(lostEntry("acme-expert-ops"));
  r.tick(29_000);
  r.reader.read(lostEntry("acme-expert-ops"));
  await settle();
  assert.equal(sweepsOf(r).length, 1, "not within 30 s of the last");
  r.tick(1_000);
  r.reader.read(lostEntry("acme-expert-ops"));
  await settle();
  assert.equal(sweepsOf(r).length, 2, "again once 30 s have passed");
  // A read with no lost session starts none.
  r.tick(60_000);
  sweepsOf(r)[1].callback(null, resumedAnswer("acme-expert-ops"), "");
  await settle();
  r.reader.read(ENTRY);
  await settle();
  assert.equal(sweepsOf(r).length, 2, "nothing lost, nothing swept");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

/** The kernel's answer to a sweep that found nothing to do. */
const QUIET_ANSWER = JSON.stringify({ schemaVersion: 1, ok: true, result: { schemaVersion: 1, plan: false, deployments: [], rows: [] } });

test("a sweep that failed, or found the machine's sweep busy, says nothing and asks for no read", async () => {
  const refusals = [
    ["failed", JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_RESUME_STATE", message: "the resume state could not be read" } })],
    ["unreadable", "not json"],
    ["busy", JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_RESUME_BUSY", message: "another sweep holds this computer" } })],
  ];
  for (const [what, stdout] of refusals) {
    const r = await started({ columns: 120, kernel: { ok: true, cli: RESUME_CLI } });
    await settle();
    r.reader.answer(ENTRY);
    r.log.length = 0;
    sweepsOf(r)[0].callback(Object.assign(new Error("exit 1"), { code: 1 }), stdout, "");
    await settle();
    assert.deepEqual(readerDid(r).filter(([did]) => did === "request"), [], `${what}: no read`);
    assert.doesNotMatch(sidebarOf(r), /resum|lost|E_RESUME|E_CLI/i, `${what}: nothing said`);
    r.stdin.type("q");
    assert.equal(await r.status, 0);
    assert.deepEqual(r.errors, [], what);
  }
});

test("a lost row of another machine's deployment in the open view sweeps nothing: the trigger is given the view's rows with only this machine's deployments as local", async () => {
  const r = await started({ columns: 120, kernel: { ok: true, cli: { ...REMOTE_CLI, features: [...REMOTE_CLI.features, "session-resume"] } } });
  await settle();
  assert.equal(sweepsOf(r).length, 1, "the sweep at the start");
  sweepsOf(r)[0].callback(null, QUIET_ANSWER, "");
  await settle();
  // garnet reports the fixture's workspace: its rows are in the open view, beside this machine's.
  r.reader.roster({ envelope: rosterAnswer([group("garnet:t1", "/srv/acme-platform", [remoteRow("dev-far", "/srv/acme-platform", { running: false, sessionEnd: "lost" })])]) });
  r.tick(60_000);
  r.reader.read(HOME_ENTRY);
  await settle();
  const { rows, options } = r.observed.at(-1);
  assert.deepEqual(options, { localDeploymentIds: [DEPLOYMENT] }, "this machine's deployment alone is local");
  const far = rows.find((row) => row.instance === "dev-far");
  assert.deepEqual([far?.sessionEnd, far?.running, far?.deployment?.id === DEPLOYMENT], ["lost", false, false], "another machine's lost row, as the view serves it");
  assert.deepEqual(rows.filter((row) => row.deployment?.id === DEPLOYMENT).map((row) => row.instance).sort(), ["acme-expert-tui", "acme-maintainer-ops"]);
  assert.equal(sweepsOf(r).length, 1, "no sweep for another machine's loss");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("a lost row of this machine sweeps once; once that sweep has completed the row waits, and the same read later sweeps nothing", async () => {
  const r = await started({ kernel: { ok: true, cli: RESUME_CLI } });
  await settle();
  sweepsOf(r)[0].callback(null, QUIET_ANSWER, "");
  await settle();
  r.tick(30_000);
  r.reader.read(lostEntry("acme-expert-tui"));
  await settle();
  assert.equal(sweepsOf(r).length, 2, "a sweep for the lost row");
  assert.deepEqual(r.observed.at(-1).options, { localDeploymentIds: [DEPLOYMENT] });
  sweepsOf(r)[1].callback(null, QUIET_ANSWER, "");
  await settle();
  r.tick(30_000);
  r.reader.read(lostEntry("acme-expert-tui"));
  await settle();
  assert.equal(sweepsOf(r).length, 2, "settled: the same lost row sets off no other sweep");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the sweep is a change the run never signals, and none is named after the screen is left: not the launch sweep, not one a lost row started; quitting before its answer lets it go and its late answer is not shown", async () => {
  for (const tell of [true, false]) {
    // The launch sweep in flight.
    const r = await started({ kernel: { ok: true, cli: RESUME_CLI }, tellable: () => tell });
    await settle();
    const [launch] = sweepsOf(r);
    r.reader.running = [{ pid: 4001, label: launch.options.label }];
    r.stdin.type("q");
    assert.equal(await r.status, 0, String(tell));
    assert.deepEqual(r.log.filter(([what]) => what === "kill"), [], "nothing is signalled");
    assert.deepEqual(r.errors, [], `the launch sweep is not named (${tell})`);
    r.stdout.take();
    launch.callback(null, resumedAnswer("acme-expert-tui"), "");
    await settle();
    assert.equal(r.stdout.take(), "", "the late answer draws nothing");

    // A sweep a lost row started in flight, with the launch sweep, beside an act of the person's.
    const o = await started({ kernel: { ok: true, cli: RESUME_CLI }, tellable: () => tell });
    await settle();
    sweepsOf(o)[0].callback(null, QUIET_ANSWER, "");
    await settle();
    o.tick(30_000);
    o.reader.read(lostEntry("acme-expert-tui"));
    await settle();
    const [first, observed] = sweepsOf(o);
    assert.deepEqual([first.options.label, observed.options.label], [{ verb: "resume" }, { verb: "resume" }], "every sweep has the sweep's one label");
    const act = { verb: "stop", name: "acme-expert-ops" };
    o.reader.running = [{ pid: 4001, label: first.options.label }, { pid: 4002, label: observed.options.label }, { pid: 4003, label: act }];
    o.stdin.type("q");
    assert.equal(await o.status, 0, String(tell));
    assert.deepEqual(o.log.filter(([what]) => what === "kill"), [], "nothing is signalled");
    assert.deepEqual(o.errors, tell ? ["oats: the stop of acme-expert-ops is still running; `oats status` shows its result.\n"] : [], `no sweep is named, and the act still is (${tell})`);
  }
});

test("w opens the switcher: this computer's list of deployments is read through the reader's exec, and its rows this run does not serve are listed under the workspaces; r there reads it again and asks for a live read; one read runs at a time, and a read asked for while one is on its way is one more after it, whose answer is the one taken", async () => {
  // The list holds the deployment the run serves too: it is not offered.
  // 120 columns: the switcher beside the sidebar is wide enough for a row's whole path.
  const r = await started({ listed: [Object.freeze({ path: DEPLOYMENT, name: "deploy", state: "ok" }), ...LISTED], columns: 120 });
  r.reader.answer(HOME_ENTRY);
  await settle();
  assert.deepEqual(r.lists.filter(({ asked }) => asked.action === "list").length, 1, "a run started in a deployment reads the list once at the start, for the identity reads, and then until it is asked to");
  r.stdout.take();
  r.log.length = 0;
  // In the list of instances Enter opens the selected agent in the panel, here with a kernel record
  // that has no detach key (the viewer is given none); the leader then Esc gives the list back, and c
  // closes it. None of it is an effect on the file system or a read.
  r.stdin.type("\r");
  await settle();
  assert.deepEqual([effectsOf(r), readerDid(r)], [[], [["touch"]]]);
  assert.equal(r.panel.opens.length, 1);
  leaderEscape(r);
  r.stdin.type("c");
  r.log.length = 0;
  r.stdin.type("w"); r.stdin.type("w");
  await settle();
  assert.deepEqual(effectsOf(r), [["list", { action: "list" }, "read"]], "a read, through the reader's own exec");
  assert.deepEqual(readerDid(r), [["touch"], ["touch"]], "opening the switcher reads no deployment: each key only touches the reader");
  assert.notEqual(r.stdout.take(), "");
  const listed = screenOf(r);
  assert.match(mainAreaOf(r), /^> \* acme-platform This machine.*On this machine, not opened acme-ledger ~\/acme-ledger$/);
  assert.match(sidebarOf(r), /^workspaces .*Enter open \/ filter r refresh Esc close \? help q quit$/, "on a workspace no Remove is offered");
  assert.doesNotMatch(listed, /acme-expert-tui|\/srv\/deploy/, "the deployment the run serves is on the list, and not offered");

  // Another row joined the list.
  r.listed = [...r.listed, Object.freeze({ path: "/home/u/acme-ledger-archive", name: "acme-ledger-archive", state: "ok" })];
  r.log.length = 0;
  r.stdin.type("r");
  await settle();
  assert.deepEqual(effectsOf(r), [["list", { action: "list" }, "read"]]);
  assert.deepEqual(readerDid(r), [["touch"], ["request", { live: true }]]);
  assert.notEqual(r.stdout.take(), "");
  assert.match(screenOf(r), /acme-ledger\s+~\/acme-ledger.*acme-ledger-archive\s+~\/acme-ledger-archive/s);

  // One read at a time: three asked while one is on its way start nothing more; once it answers,
  // its answer is not taken (the list may have changed since it began) and one more read begins,
  // whose answer is.
  r.listAnswer = () => undefined;
  const before = r.lists.length;
  for (let i = 0; i < 4; i++) r.stdin.type("r");
  await settle();
  assert.equal(r.lists.length, before + 1, "one read on its way, however many times r was pressed");
  const first = r.lists.at(-1);
  first.answer({ ok: true, value: { ok: true, rows: [...LISTED, Object.freeze({ path: "/home/u/acme-older", name: "acme-older", state: "ok" })] } });
  await settle();
  assert.equal(r.lists.length, before + 2, "one more after it, for the r pressed meanwhile");
  assert.doesNotMatch(screenOf(r), /acme-older/, "the answer of a read asked again while it was on its way is not taken");
  r.lists.at(-1).answer({ ok: true, value: { ok: true, rows: LISTED } });
  await settle();
  const kept = screenOf(r);
  assert.match(kept, /acme-ledger\s+~\/acme-ledger/);
  assert.doesNotMatch(kept, /acme-ledger-archive|acme-older/, "the last read's rows");
  assert.equal(r.lists.length, before + 2, "and nothing after it");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("a kernel that does not list this computer's deployments is asked nothing of it in a run: no add of the deployment the run started in, no read when the switcher opens or on r, and no line about it", async () => {
  const OLD = Object.freeze({ ...CLI, features: Object.freeze(CLI.features.filter((feature) => feature !== "deployments-list")) });
  const r = await started({ kernel: { ok: true, cli: OLD }, listed: LISTED });
  r.reader.answer(HOME_ENTRY);
  await settle();
  r.stdin.type("w"); r.stdin.type("w");
  await settle();
  r.stdin.type("r");
  await settle();
  assert.deepEqual(r.lists, [], "nothing asked");
  assert.doesNotMatch(screenOf(r), /acme-ledger|Update oats|could not be read/, "no row, and nothing said of the list");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("Enter on a row of this computer's list asks whether it is a deployment now; admitted, it is served from then on under the path it was admitted as, its Instances view is shown and a live read is asked for", async () => {
  // The row is a link: what is admitted is where it leads.
  // 120 columns: the switcher beside the sidebar is wide enough for a row's whole path.
  const r = await started({ listed: LISTED, admit: () => ({ ok: true, deployment: "/srv/acme-ledger" }), columns: 120, rows: 40 });
  r.reader.answer(HOME_ENTRY);
  r.stdin.type("w"); r.stdin.type("w");
  await settle();
  r.stdin.type("j"); // from the workspace that is open to the row under it
  assert.match(screenOf(r), /\* acme-platform.*>\s+acme-ledger\s+~\/acme-ledger/s);
  r.stdout.take();
  r.log.length = 0;
  r.stdin.type("\r");
  assert.deepEqual(effectsOf(r), [["admit", LEDGER]]);
  assert.deepEqual(r.reader.options.getServed(), [DEPLOYMENT, "/srv/acme-ledger"], "served after the one the run started in");
  assert.equal(r.reader.options.getEntry("/srv/acme-ledger").deployment.status, "pending", "not read yet");
  assert.equal(r.reader.options.getEntry(DEPLOYMENT), HOME_ENTRY, "and the first deployment is held as it was");
  assert.deepEqual(readerDid(r), [["touch"], ["request", { live: true }]], "it is read at once");
  assert.notEqual(r.stdout.take(), "");
  const opened = screenOf(r);
  // The list of workspaces has it as a row of its own, the open one.
  assert.match(opened, /^ {2}acme-platform .* {2}acme-ledger .*Instances +1 │ +Reading the deployment\..*Souls +2 │ Capabilities +3 │.*Ctrl\+\\ +commands +│ Ctrl\+K +palette +│ n +spawn +│ w +workspaces +│ \? +help +│ q +quit +│/s);
  assert.doesNotMatch(opened, /acme-expert-tui|~\/acme-ledger/, "the switcher is closed (no row of it names the folder), and the view is the new deployment's");
  // From then on: the reader's answer for it is taken and drawn.
  r.reader.answer(observedAt("/srv/acme-ledger", [instanceRow("acme-clerk", "acme-clerk-books")], { workspace: reportedWorkspace("git.example.com/acme-ledger/books", "aweb:acme-ledger"), name: "acme-ledger" }), "/srv/acme-ledger");
  assert.match(textOf(r.stdout.take()), /acme-clerk-books/);
  const read = screenOf(r);
  assert.match(read, /^ {2}acme-platform .* {2}acme-ledger .*acme-clerk-books/s);
  assert.doesNotMatch(read, /1 running/, "no counts on the screen");
  // And the switcher no longer offers it: the list holds canonical paths, as the served ids are,
  // and a row that is a deployment this run serves is left out.
  r.listed = [Object.freeze({ path: "/srv/acme-ledger", name: "acme-ledger", state: "ok" })];
  r.log.length = 0;
  r.stdin.type("w"); r.stdin.type("w");
  await settle();
  assert.deepEqual(effectsOf(r), [["list", { action: "list" }, "read"]], "read again, and nothing added: a row opened is on the list already");
  assert.doesNotMatch(screenOf(r), /On this machine, not opened/);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("Enter on a row of this computer's list that is no deployment any more: its row says so, and nothing else changed", async () => {
  // 120 columns: the switcher beside the sidebar is wide enough for a row's whole path.
  const r = await started({ listed: LISTED, admit: () => ({ ok: false }), columns: 120, rows: 40 });
  r.reader.answer(HOME_ENTRY);
  r.stdin.type("w"); r.stdin.type("w");
  await settle();
  r.stdin.type("j");
  const before = screenOf(r);
  r.stdout.take();
  r.log.length = 0;
  r.stdin.type("\r");
  assert.deepEqual(effectsOf(r), [["admit", LEDGER]]);
  assert.deepEqual(readerDid(r), [["touch"]], "nothing is read for it");
  assert.deepEqual(r.reader.options.getServed(), [DEPLOYMENT]);
  assert.equal(r.reader.options.getEntry(LEDGER), null);
  assert.notEqual(r.stdout.take(), "");
  const after = screenOf(r);
  assert.match(after, /^ workspaces.*\* acme-platform.*This machine.*On this machine, not opened.*>\s+acme-ledger\s+Not an OATS deployment any more\..*Enter +open.*Esc +close/s);
  assert.equal(words(after), words(before).replace("~/acme-ledger", "Not an OATS deployment any more."), "the switcher as it was, but for what that row says");
  // The view the switcher was opened over is still there to go back to.
  r.stdin.type("\x1b");
  r.tick(50);
  r.timers.fire();
  assert.match(screenOf(r), /^ {2}acme-platform.*Acme expert tui.*Acme maintainer ops/s);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("a stale row of this computer's list says its state where its path stood, and Enter on it asks nothing: no admit, no read, the switcher as it was", async () => {
  const stale = [["acme-gone", "missing", "Not found."], ["acme-moved", "not-a-deployment", "Not an OATS deployment any more."], ["acme-locked", "unreadable", "Can't be read."]];
  // 120 columns: the switcher beside the sidebar is wide enough for what a stale row says.
  const r = await started({ listed: stale.map(([name, state]) => Object.freeze({ path: `/home/u/${name}`, name, state })), columns: 120 });
  r.reader.answer(HOME_ENTRY);
  r.stdin.type("w"); r.stdin.type("w");
  await settle();
  const listed = screenOf(r);
  assert.match(mainAreaOf(r), /On this machine, not opened acme-gone Not found\. acme-moved Not an OATS deployment any more\. acme-locked Can't be read\.$/);
  assert.doesNotMatch(listed, /~\/acme-/, "a stale row's path is not shown");
  for (const [name] of stale) {
    r.stdin.type("j");
    const before = screenOf(r);
    assert.match(before, new RegExp(`>\\s+${name}`), name);
    r.log.length = 0;
    r.stdin.type("\r");
    await settle();
    assert.deepEqual([effectsOf(r), readerDid(r)], [[], [["touch"]]], name);
    assert.equal(words(screenOf(r)), words(before), name);
  }
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("Delete on a row of this computer's list asks first, over the rows; Enter in a later read removes it as a change of the run, the switcher says so and the list is read again; Enter in the read that asked, Esc and another key keep it, and Delete on a workspace asks nothing; a refused remove says the kernel's message", async () => {
  // 120 columns: the switcher beside the sidebar is wide enough for a row's whole path.
  const r = await started({ listed: LISTED, columns: 120 });
  r.reader.answer(HOME_ENTRY);
  r.stdin.type("w"); r.stdin.type("w");
  await settle();
  r.stdin.type("j");
  const removes = () => r.lists.filter(({ asked }) => asked.action === "remove");
  const ASKED = /^Remove the selected row from this computer's list\? Enter removes it; other keys keep it\. Its folder stays\. .*On this machine, not opened > acme-ledger ~\/acme-ledger$/;
  // Delete and Enter in one read: a paste cannot both ask and press. The question stands.
  r.stdin.type(`${DELETE}\r`);
  await settle();
  assert.deepEqual(removes(), []);
  // A redraw that types nothing: Ctrl+L is a key, which keeps the row.
  assert.match(mainAreaOf(r), ASKED);
  r.listed = [];
  r.log.length = 0;
  r.stdin.type("\r");
  await settle();
  assert.deepEqual(effectsOf(r), [["list", { action: "remove", path: LEDGER }, "change"], ["list", { action: "list" }, "read"]], "the remove, as a change of the run, then the list read again; nothing is admitted");
  let shown = screenOf(r);
  assert.match(mainAreaOf(r), /^acme-ledger was removed from this computer's list\. > \* acme-platform/);
  assert.doesNotMatch(shown, /On this machine, not opened|Remove the selected row/, "the list read again holds it no more");

  // Back on the list; Esc keeps it, and so does another key, which does what it does.
  r.listed = LISTED;
  r.stdin.type("r");
  await settle();
  r.stdin.type("G");
  r.stdin.type(DELETE);
  assert.match(mainAreaOf(r), ASKED);
  r.stdin.type("\x1b");
  r.tick(50);
  r.timers.fire();
  shown = wholeScreen(r);
  assert.doesNotMatch(shown, /Remove the selected row/);
  assert.match(mainAreaOf(r), /> acme-ledger/, "the switcher stays");
  r.stdin.type(DELETE);
  r.stdin.type("k");
  shown = wholeScreen(r);
  assert.doesNotMatch(shown, /Remove the selected row/);
  assert.match(shown, /> \* acme-platform/, "k moved the selection");
  r.stdin.type(DELETE);
  assert.doesNotMatch(wholeScreen(r), /Remove the selected row/, "a workspace is no row of the list");
  r.stdin.type("\r");
  await settle();
  assert.equal(removes().length, 1);

  // The kernel refuses one: its message, as it came, and the list is read again.
  r.stdin.type("w"); r.stdin.type("w");
  await settle();
  const done = r.listAnswer;
  r.listAnswer = (asked, call) => (asked.action === "remove" ? { ok: false, reason: { code: "E_DEPLOYMENTS_BUSY", message: "The list is busy." } } : done(asked, call));
  r.stdin.type("G");
  r.stdin.type(DELETE);
  r.log.length = 0;
  r.stdin.type("\r");
  await settle();
  assert.deepEqual(effectsOf(r), [["list", { action: "remove", path: LEDGER }, "change"], ["list", { action: "list" }, "read"]]);
  assert.match(mainAreaOf(r), /^acme-ledger was not removed from this computer's list: The list is busy\. .*On this machine, not opened > acme-ledger ~\/acme-ledger$/);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("a read of this computer's list that fails keeps the rows of the last one that answered and says why over them, with the kernel's message as it came, or the TUI's when the kernel could not be asked; the next read that answers puts the line away", async () => {
  const r = await started({ columns: 120, listed: LISTED });
  r.reader.answer(HOME_ENTRY);
  r.stdin.type("w"); r.stdin.type("w");
  await settle();
  const done = r.listAnswer;
  r.listAnswer = () => ({ ok: false, reason: BUSY });
  r.stdin.type("r");
  await settle();
  assert.match(mainAreaOf(r), /^This computer's list of deployments could not be read: This computer's list of deployments is busy; try again\. .*On this machine, not opened acme-ledger ~\/acme-ledger$/);
  r.listAnswer = () => { throw new Error("spawn EAGAIN"); };
  r.stdin.type("r");
  await settle();
  const unasked = mainAreaOf(r);
  assert.match(unasked, /^This computer's list of deployments could not be read: the kernel could not be asked .*acme-ledger ~\/acme-ledger$/);
  assert.doesNotMatch(unasked, /EAGAIN/);
  r.listAnswer = done;
  r.stdin.type("r");
  await settle();
  const read = screenOf(r);
  assert.doesNotMatch(read, /could not be read/);
  assert.match(read, /acme-ledger\s+~\/acme-ledger/);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the identity reads (#482): once at the start, over the rows of this computer's list that the run does not serve and the kernel says are deployments, through the reader's exec; again when the switcher is opened and on r there; never on a timer; an answer merges the row into its workspace, whose Enter opens it; a suspend gives them up", async () => {
  const GONE = Object.freeze({ path: "/home/u/gone", name: "gone", state: "missing" });
  const r = await started({ listed: [Object.freeze({ path: DEPLOYMENT, name: "deploy", state: "ok" }), ...LISTED, GONE], columns: 120 });
  r.reader.answer(HOME_ENTRY);
  await settle();
  assert.deepEqual(r.identities.starts, [[LEDGER]], "the served deployment and a stale row are not read");
  assert.deepEqual([r.identities.options.exec, r.identities.options.cli, r.identities.options.env], [r.reader.exec, CLI, r.reader.options.env], "through the reader's own exec, kernel and environment");
  // However long the run waits and whatever its timers do, nothing reads them again on its own.
  for (let i = 0; i < 5; i++) { r.tick(60_000); r.timers.fire(); await settle(); }
  assert.deepEqual(r.identities.starts, [[LEDGER]], "no timer reads a deployment the run does not serve");
  r.stdin.type("w"); r.stdin.type("w"); await settle();
  assert.deepEqual(r.identities.starts, [[LEDGER], [LEDGER]], "the switcher opened: read again, after the list");
  assert.match(screenOf(r), /On this machine, not opened.*acme-ledger/s, "drawn before any answer");
  r.stdin.type("r"); await settle();
  assert.equal(r.identities.starts.length, 3, "r in the switcher reads them again");
  // An answer comes in: the row is in its workspace's, with its line, and nothing is left under the heading.
  r.identities.options.onRead({ path: LEDGER, read: { ok: true, workspace: reportedWorkspace() } });
  await settle();
  const merged = screenOf(r);
  assert.match(merged, /\* acme-platform.*This machine · deploy.*This machine · acme-ledger · not opened/s);
  assert.match(merged, /On this machine, not opened.*gone/s, "only the stale row is left there");
  assert.doesNotMatch(merged, /On this machine, not opened[^│]*│[^│]*acme-ledger/);
  r.log.length = 0;
  r.stdin.type("\r"); await settle();
  assert.deepEqual(effectsOf(r), [["admit", LEDGER]], "Enter on the workspace asks whether the listed deployment is one now");
  assert.deepEqual(r.reader.options.getServed(), [DEPLOYMENT, LEDGER], "and serves it from then on");
  assert.deepEqual(readerDid(r).filter(([what]) => what === "request"), [["request", { live: true }]]);
  const stops = r.identities.stops;
  r.stdin.type("\x1a");
  assert.equal(r.identities.stops, stops + 1, "a suspend gives the reads in flight up");
  r.proc.emit("SIGCONT");
  await settle();
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("started outside every deployment, the identity reads begin at once over the rows the list answered before the terminal was taken: no second read of the list", async () => {
  const r = await started({ deployment: { ok: false, dir: "/work/here" }, listed: LISTED });
  await settle();
  assert.deepEqual(r.identities.starts, [[LEDGER]]);
  assert.equal(r.lists.length, 1);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("Enter on a workspace opens its view and asks for a live read", async () => {
  const r = await started({ kernel: { ok: true, cli: REMOTE_CLI } });
  r.reader.answer(HOME_ENTRY);
  r.reader.collecting();
  r.reader.roster({ envelope: rosterAnswer([onyx()]) }); // a machine that reports a workspace of its own
  r.stdin.type("w"); r.stdin.type("w");
  await settle(); // the list read it asked for has answered: what follows asks nothing more
  const two = screenOf(r);
  assert.match(two, /\* acme-platform.*This machine/s, "the open workspace is marked, its deployment on a line under it");
  assert.match(two, / {2}charts.*onyx/s, "and the machine's own workspace is listed beside it, unmarked");
  // Whatever order the shared home lists them in, the filter leaves the one that is wanted.
  r.stdin.type("/");
  r.stdin.type("onyx");
  r.stdin.type("\r"); // keeps the filter
  assert.deepEqual(readerDid(r).filter(([what]) => what !== "touch" && what !== "start"), [], "Enter in the open field opens nothing");
  r.stdout.take();
  r.log.length = 0;
  r.stdin.type("\r");
  assert.deepEqual(readerDid(r), [["touch"], ["request", { live: true }]]);
  assert.deepEqual(effectsOf(r), [], "a workspace is not a folder: nothing is asked of the file system");
  assert.notEqual(r.stdout.take(), "");
  const opened = screenOf(r);
  assert.match(opened, /^ {2}acme-platform .* {2}charts .*Instances +1 │.*dev-east.*Enter +open +│ n +spawn +│ w +workspaces +│ \? +help +│ q +quit +│/s, "the machine's view, the open one of the list's two rows");
  assert.doesNotMatch(opened, /acme-expert-tui/);
  // The time of the roster read it is drawn from: the help's top row, beside the sidebar (this
  // machine's own was read at 10:00:00).
  r.stdin.type("?");
  assert.match(screenOf(r), /│ {3}read 10:00:30 /);
  r.stdin.type("?");
  assert.deepEqual(r.reader.options.getServed(), [DEPLOYMENT], "a machine's workspace is no deployment this run serves");
  r.stdin.type("w"); r.stdin.type("w");
  const back = screenOf(r);
  assert.match(back, /\* charts.*onyx/s, "and it is the open one now");
  assert.match(back, / {2}acme-platform.*This machine/s);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the roster of other machines: a read that began changes nothing on the screen, and its answer lists the machine's instances under a heading that names the machine and the time of that read", async () => {
  const r = await started({ kernel: { ok: true, cli: REMOTE_CLI } });
  assert.equal(cliReadsRemotes(REMOTE_CLI), true);
  r.reader.answer(HOME_ENTRY);
  assert.doesNotMatch(screenOf(r), /machine|garnet/, "one deployment: no heading");
  r.reader.collecting();
  assert.equal(r.stdout.take(), "");
  r.tick(15_000);
  const held = r.reader.options.getRoster();
  r.reader.roster({ envelope: rosterAnswer([garnet()]) });
  assert.notEqual(r.stdout.take(), "", "the answer is drawn when it arrives");
  const two = screenOf(r);
  assert.match(two, /^ {2}acme-platform\s+│.*This machine.*Acme expert tui.*Acme maintainer ops.*garnet\s+read 10:00:45.*● Dev far.*○ Dev held  not reachable on g…/s, "the name before its word: the word is cut to what the name leaves");
  assert.doesNotMatch(two, /\d+ (running|stopped)/, "no counts on the screen");
  // What the loop holds is what the shared rule made of the answer, and the reader is told it.
  const now = r.reader.options.getRoster(), made = rosterEvent(held, { envelope: rosterAnswer([garnet()]) }, "2026-10-11T10:00:45.000Z").roster;
  assert.deepEqual(now, { remote: made.remote, memory: made.memory, notes: made.notes });
  assert.deepEqual([now.remote.rosterAnswered, now.remote.remoteGroups.map((g) => g.id), [...now.memory.keys()]], [true, ["garnet:t1"], ["garnet:t1"]], "the fixture has the kernel's forms: the machine is remembered");

  // The next read throws: the machine keeps its heading, says it was not reached, and nothing of it
  // reads as stopped: each of its rows has the unknown mark and the shared label of its reason.
  r.reader.collecting();
  r.reader.roster({ thrown: "spawn EMFILE" });
  const lost = screenOf(r);
  assert.match(lost, /This machine.*garnet\s+remembered\s+Not reached.*\? Dev far\s+garnet not reached.*\? Dev held\s+garnet not reached/s);
  assert.doesNotMatch(lost, /\d+ (running|stopped|unknown)/, "no counts on the screen");
  assert.doesNotMatch(lost, /garnet\s+read /, "a heading that is not live carries no time");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("Ctrl+Z with a roster read in flight: every read is made void before the process group is stopped, the return asks for a live read, and the answer of the read it begins is taken", async () => {
  const r = await started({ kernel: { ok: true, cli: REMOTE_CLI } });
  r.reader.answer(HOME_ENTRY);
  r.reader.collecting();
  r.stdout.take();
  r.log.length = 0;
  r.stdin.type("\x1a");
  assert.deepEqual(r.log.filter(([what]) => what !== "raw"), [["reader", "touch"], ["write", LEAVE], ["reader", "void"], ["kill", 0, "SIGTSTP"]]);
  r.log.length = 0;
  r.proc.emit("SIGCONT", "SIGCONT");
  assert.deepEqual(readerDid(r), [["request", { live: true }]], "the return reads at once, and has nothing more to drop");
  // The read that was in flight answers nothing (lib/read.mjs); the one the return began does.
  r.stdout.take();
  r.reader.collecting();
  r.reader.roster({ envelope: rosterAnswer([garnet()]) });
  assert.match(screenOf(r), /garnet\s+read 10:00:30.*Dev far/s);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("what the reader gives after the run ended is dropped: an entry, the start of a roster read and its answer change nothing the loop holds, and nothing is written", async () => {
  const r = await started({ kernel: { ok: true, cli: REMOTE_CLI } });
  r.reader.answer(HOME_ENTRY);
  const held = r.reader.options.getRoster();
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  r.stdout.take();
  r.reader.answer(observedAt(DEPLOYMENT, [instanceRow("acme-expert", "acme-expert-late")]));
  r.reader.collecting();
  r.reader.roster({ envelope: rosterAnswer([garnet()]) });
  r.reader.roster({ thrown: "spawn EMFILE" });
  assert.equal(r.reader.options.getEntry(DEPLOYMENT), HOME_ENTRY);
  const now = r.reader.options.getRoster();
  for (const part of ["remote", "memory", "notes"]) assert.equal(now[part], held[part], part);
  assert.deepEqual([now.remote.rosterAnswered, now.remote.remoteGroups, now.memory.size], [false, [], 0]);
  assert.equal(r.stdout.take(), "");
  assert.deepEqual(r.errors, []);
});

test("a deployment that could not be observed says why in the shared sentence: the kernel's refusal in each of its three forms (with its message, with a message withheld, with none), and the reader's own failure as it is", async () => {
  const hostile = "a refusal with \x1b[2J in it";
  const cases = [
    [{ code: "E_NEW_CODE", message: "the workspace is locked", origin: "kernel" }, "OATS answered with an error (E_NEW_CODE). It says: the workspace is locked"],
    [{ code: "E_NEW_CODE", message: hostile, origin: "kernel" }, `OATS answered with an error (E_NEW_CODE). ${DETAIL_WITHHELD}`],
    [{ code: "E_NEW_CODE", message: "", origin: "kernel" }, "OATS answered with an error (E_NEW_CODE)."],
    // Without the reader's mark the reason is one the reader made itself: no speaker is named.
    [{ code: "E_NEW_CODE", message: "the workspace is locked" }, "E_NEW_CODE: the workspace is locked"],
  ];
  for (const [reason, sentence] of cases) {
    const entry = failed(null, reason), label = JSON.stringify(reason);
    assert.equal(sharedReason(entry), sentence, `the shared home's sentence for ${label}`);
    const r = await started();
    r.stdout.take();
    r.reader.answer(entry);
    assert.notEqual(r.stdout.take(), "", label);
    const text = screenOf(r);
    assert.equal(sidebarOf(r).split(sentence).length, 2, `drawn once, whole (wrapped to the sidebar's width): ${label}`);
    assert.match(text, /not observed/, label);
    assert.equal(/It says:/.test(text), sentence.includes("It says:"), `a message that is withheld or absent is not introduced: ${label}`);
    assert.equal(text.includes(DETAIL_WITHHELD), sentence.includes(DETAIL_WITHHELD), label);
    assert.doesNotMatch(text, /Reading the deployment/, label);
    r.stdin.type("q");
    assert.equal(await r.status, 0);
    const all = readTerminalOutput(written(r));
    assert.deepEqual(all.foreign, [], label);
    assert.doesNotMatch(all.text, CONTROL, label);
  }
  // The hand-made reason of this file, unmarked and with the kernel's message withheld by the TUI's own filter.
  const unmarked = failed(null, { code: "E_NEW_CODE", message: hostile });
  assert.doesNotMatch(textShown(shown(hostile)), CONTROL, "the TUI's own filter leaves no control character of the message as it came");
  const r = await started();
  r.reader.answer(unmarked);
  const text = screenOf(r);
  assert.match(text, /not observed/);
  assert.doesNotMatch(text, /2J in it|OATS answered/);
  assert.doesNotMatch(text, CONTROL);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  assert.deepEqual(readTerminalOutput(written(r)).foreign, []);
});

// ── Opening an agent's terminal: the panel (T1) ───────────────────────────────────────────────────

/** A kernel record that opens agents here and on other machines. It lists no detach key: the
 *  viewer is given none. */
const KEYED = cliRecord({ version: CLI.version, workspaceApi: CLI.workspaceApi, features: [...CLI.features], remote: ["roster", "session"] }, { bin: CLI.bin, source: "tui" });
/** The agents' socket the kernel records for this machine's rows: the TUI names it nowhere. */
const AGENTS_SOCKET = "/tmp/oats-tmux-1000/agents";
const OPEN_ENTRY = observedAt(DEPLOYMENT, [instanceRow("acme-expert", "acme-expert-tui", { tmux: { session: "oats-agents", window: "acme-expert-tui", socket: AGENTS_SOCKET } })]);
const KEY_CONFIG = { ok: true, actions: ACTIONS, ascii: false, detachKey: "C-\\" };
/** A run on a deployment whose one agent runs. */
async function opening(options = {}) {
  const r = await started({ kernel: { ok: true, cli: KEYED }, config: KEY_CONFIG, ...options });
  r.reader.answer(OPEN_ENTRY);
  r.stdout.take();
  r.log.length = 0;
  return r;
}
const HOME = `${DEPLOYMENT}/agents/acme-expert/instances/acme-expert-tui`;
/** What the loop asked of the panel since the log was last emptied. */
const panelDid = (r) => r.log.filter(([what]) => what === "panel").map(([, ...rest]) => rest);
/** The whole screen as the run draws it now, by a way that types nothing into a terminal that has
 *  the focus: a resize to the same size redraws in full. */
function wholeScreen(r) {
  r.stdout.take();
  r.stdout.resize(r.stdout.columns, r.stdout.rows);
  return textOf(r.stdout.take());
}
/** The leader, then Esc, each in a read of its own, as a person types them: from the terminal's
 *  focus the leader is the back key the scanner finds in the bytes, and Esc the TUI reads as its
 *  own key; the focus goes to the list (docs/tui.md, "The leader"). Esc is typed as ESC and then a
 *  focus report (ESC [ I), which the key parser reads at once as the Esc key and a report it drops,
 *  so no timer has to fire. */
function leaderEscape(r) {
  r.stdin.type("\x1c");
  r.stdin.type("\x1b\x1b[I");
}
/** The cheat sheet while the terminal has the focus, as the screen's text has it: the leader, the
 *  leader then Esc, and the leader twice, which types it into the terminal. */
const TYPING_SHEET = /Ctrl\+\\ +commands +│ Ctrl\+\\ Esc +the list +│ Ctrl\+\\ Ctrl\+\\ +types Ctrl\+\\ │/;
/** A run with the agent's terminal open in the panel (window `@1`), the focus in it. */
async function viewing(options) {
  const r = await opening(options);
  r.stdin.type("\r");
  await settle();
  r.panel.opens[0].made("@1");
  await settle();
  r.log.length = 0;
  return r;
}

test("Enter on a running agent of this machine: the kernel's viewer starts in the panel beside the list, at the panel's size, with the shared home's arguments and no key; the TUI keeps its terminal and its reads, and the cheat sheet names the leader's keys", async () => {
  const r = await opening();
  r.stdin.type("\r");
  await settle();
  const [asked] = r.panel.opens;
  assert.deepEqual(asked.argv, [process.execPath, KEYED.bin, ...sessionAttachArgv(KEYED, { home: HOME })], "node, the kernel's own binary, the shared home's arguments");
  assert.equal(asked.argv.includes("--detach-key"), false);
  assert.deepEqual([asked.cols, asked.rows], [49, 23], "80 columns: the 30 columns the sidebar keeps beside a terminal, its bar, and 49 to the right edge; every row but the title's");
  assert.deepEqual(r.log.filter(([what, which]) => (what === "write" && (which === LEAVE || which === ENTER)) || what === "raw" || (what === "reader" && ["void", "hold"].includes(which))), [], "nothing is lent: no leave, no cooked mode, no read made void");
  assert.equal(r.stdin.paused, false);
  asked.made("@1");
  await settle();
  r.panel.screen("@1", "$ marker-of-the-agent", { x: 2, y: 0, visible: true }, { cols: 49, rows: 23 });
  const screen = wholeScreen(r);
  assert.match(screen, /acme-expert-tui[\s\S]*marker-of-the-agent/, "the list and the agent's screen");
  assert.match(screen, TYPING_SHEET);
  // A capture of a window that is not the open one is not drawn.
  r.stdout.take();
  r.panel.screen("@9", "$ not-this-one");
  assert.doesNotMatch(r.stdout.take(), /not-this-one/);
  leaderEscape(r);
  assert.match(wholeScreen(r), /Ctrl\+\\ +commands +│ Ctrl\+K +palette +│ Enter +focus terminal +│ n +spawn +│ w +workspaces +│ \? +help +│ q +quit +│/);
  r.log.length = 0;
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  const order = r.log.filter(([what, which]) => (what === "panel" && which === "end") || (what === "reader" && which === "stop")).map(([what]) => what);
  assert.deepEqual(order, ["panel", "reader"], "the private server is ended on the way out, before the reads");
});

test("No other workspace to show. goes at the next key, one typed to the agent included, and at a resize: the loop tells the store what it does not see", async () => {
  const r = await viewing();
  // The screen as the bytes written so far leave it: no redraw of the test's own, which would be a resize.
  const now = () => screenRows(written(r), r.stdout.columns, r.stdout.rows).join("\n");
  r.stdin.type("\x1c");
  r.stdin.type("\x1b[A");
  await settle();
  assert.match(now(), /No other workspace to show\./);
  r.stdin.type("a");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input"), [["input", "a"]], "the key is the agent's");
  assert.doesNotMatch(now(), /No other workspace/, "and the line went with it");
  r.stdin.type("\x1c");
  r.stdin.type("\x1b[A");
  await settle();
  assert.match(now(), /No other workspace to show\./);
  r.stdout.resize(r.stdout.columns + 10, r.stdout.rows);
  assert.doesNotMatch(now(), /No other workspace/, "a resize: the line goes");
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("while the terminal has the focus every byte but the leader goes to the agent as typed, q, Ctrl+C, Ctrl+Z, Ctrl+L, Esc and ? among them, and a bracketed paste goes as a paste; what comes in the leader's own read is nobody's and cancels it, and the leader then a key in a later read is the TUI's", async () => {
  const r = await viewing();
  r.stdin.type("q\x03\x1a\x0c\x1b?");
  r.stdin.type("\x1b[200~one\x1ctwo\x1b[201~");
  assert.deepEqual(panelDid(r), [["input", "q\x03\x1a\x0c\x1b?"], ["paste", "one\x1ctwo"]]);
  r.log.length = 0;
  let over = false;
  r.status.then(() => { over = true; });
  // The leader with keys after it in one read (a paste, with bracketed paste off): the bytes before
  // it are the agent's, the ones after it are dropped, and the leader waits for nothing.
  r.stdin.type("ab\x1c?");
  r.stdin.type("x");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input"), [["input", "ab"], ["input", "x"]], "the ? was dropped, and the next key is the agent's again");
  assert.doesNotMatch(wholeScreen(r), HELP_HEADING, "nothing opened the help");
  r.log.length = 0;
  r.stdin.type("\x1c");
  r.stdin.type("?");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input"), [], "the leader and its key are not the agent's");
  assert.equal(over, false, "a view that draws no terminal (the help) leaves the panel hidden, and the run goes on");
  assert.match(wholeScreen(r), HELP_HEADING, "the leader then ? opened the help");
  r.stdin.type("\x1b");
  r.tick(50);
  r.timers.fire();
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the leader twice from the terminal's focus types the leader's own bytes into the agent and the terminal keeps the focus, so what is typed next is the agent's too; Esc then the leader's key typed as two keys are the agent's as typed (one keypress)", async () => {
  const r = await viewing();
  r.stdin.type("\x1c");
  r.stdin.type("\x1c");
  await settle();
  r.stdin.type("q");
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input"), [["input", "\x1c"], ["input", "q"]], "C-\\ twice: one 0x1c to the agent, then q");
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  // M-o, the default on Linux and Windows before C-x, as a tui.json names it: ESC o is the leader only as one keypress.
  const m = await viewing({ config: { ...KEY_CONFIG, detachKey: "M-o" } });
  m.stdin.type("\x1bo");
  m.stdin.type("\x1bo");
  await settle();
  m.stdin.type("x");
  assert.deepEqual(panelDid(m).filter(([what]) => what === "input"), [["input", "\x1bo"], ["input", "x"]], "M-o twice: ESC o to the agent, then x");
  m.log.length = 0;
  m.stdin.type("\x1b");
  m.tick(30);
  m.stdin.type("o");
  assert.deepEqual(panelDid(m).filter(([what]) => what === "input"), [["input", "\x1b"], ["input", "o"]], "Esc, then o 30 ms later: the agent's");
  m.stdin.type("\x1bo");
  m.stdin.type("\x1b\x1b[I");
  m.stdin.type("q");
  assert.equal(await m.status, 0, "the leader then Esc, then q in the list");
});

test("the default leader, Ctrl+X on every platform: 0x18 in the list is the leader (k after it opens the palette), and from the terminal's focus 0x18 twice types one 0x18 into the agent; Ctrl+Alt+X (ESC 0x18) and an Alt key no chord takes are the agent's as typed (Alt+B, ESC b; on macOS Alt+O, ESC o, the leader of before #1433 there too), and in the list neither is the leader (#1433)", async () => {
  const DEFAULT = { ...KEY_CONFIG, detachKey: "C-x" };
  for (const platform of ["linux", "darwin"]) {
    // On Linux and Windows Alt+O is the workspaces chord of the Alt family (packages/client/keymap.mjs).
    const alt = platform === "darwin" ? "\x1bo" : "\x1bb", altName = platform === "darwin" ? "Alt+O" : "Alt+B";
    const l = await opening({ config: DEFAULT, platform });
    // Nothing on the screen says the leader waits: k in a later read says it, by the palette it opens.
    for (const typed of [alt, "\x1b\x18"]) {
      l.stdin.type(typed);
      l.stdin.type("k");
      assert.doesNotMatch(wholeScreen(l), /acme-expert-tui +instance/, `${platform}: ${JSON.stringify(typed)} in the list is not the leader`);
    }
    assert.match(wholeScreen(l), /Ctrl\+X +commands +│/, `${platform}: the cheat sheet names Ctrl+X`);
    l.stdin.type("\x18");
    l.stdin.type("\x18");
    l.stdin.type("k");
    assert.doesNotMatch(wholeScreen(l), /acme-expert-tui +instance/, `${platform}: the leader again cancels it`);
    l.stdin.type("\x18");
    assert.match(wholeScreen(l), /Ctrl\+X +commands +│/, `${platform}: the cheat sheet as it was while the leader waits`);
    l.stdin.type("k");
    assert.match(wholeScreen(l), /acme-expert-tui +instance/, `${platform}: 0x18 is the leader`);
    l.stdin.type("\x1b\x1b[I");
    l.stdin.type("q");
    assert.equal(await l.status, 0);
    const r = await viewing({ config: DEFAULT, platform });
    assert.match(wholeScreen(r), /Ctrl\+X +commands +│ Ctrl\+X Esc +the list +│ Ctrl\+X Ctrl\+X +types Ctrl\+X │/, `${platform}: the terminal's cheat sheet`);
    r.log.length = 0;
    r.stdin.type("\x18");
    r.stdin.type("\x18");
    await settle();
    r.stdin.type("q");
    r.stdin.type("\x1b\x18");
    r.stdin.type(alt);
    assert.deepEqual(panelDid(r).filter(([what]) => what === "input"), [["input", "\x18"], ["input", "q"], ["input", "\x1b\x18"], ["input", alt]], `${platform}: C-x twice is one 0x18, then q, Ctrl+Alt+X and ${altName} as typed`);
    r.stdin.type("\x18");
    r.stdin.type("\x1b\x1b[I");
    r.stdin.type("q");
    assert.equal(await r.status, 0, `${platform}: the leader then Esc, then q in the list`);
  }
});

test("under the confirmed protocol the default leader Ctrl+X is CSI 120;5u in the list and from the terminal's focus, and twice types 0x18 into the agent; Ctrl+Shift+X and Ctrl+Alt+X are never the leader, and reach the agent as 0x18 and ESC 0x18, an Alt key no chord takes (Alt+B) as ESC b (#1433)", async () => {
  const l = await opening({ keyboard: true, platform: "linux", config: { ...KEY_CONFIG, detachKey: "C-x" } });
  l.stdin.type("\x1b[?5u");
  // Nothing on the screen says the leader waits: k in a later read says it, by the palette it opens.
  for (const typed of ["\x1b[120;6u", "\x1b[120:88;6u", "\x1b[120;7u", "\x1b[98;3u"]) {
    l.stdin.type(typed);
    l.stdin.type("k");
    assert.doesNotMatch(wholeScreen(l), /acme-expert-tui +instance/, `${JSON.stringify(typed)} in the list is not the leader`);
  }
  l.stdin.type("\x1b[120;5u");
  l.stdin.type("k");
  assert.match(wholeScreen(l), /acme-expert-tui +instance/, "CSI 120;5u is the leader");
  l.stdin.type("\x1b[27u");
  l.stdin.type("q");
  assert.equal(await l.status, 0);
  const r = await opening({ keyboard: true, platform: "linux", config: { ...KEY_CONFIG, detachKey: "C-x" } });
  r.stdin.type("\x1b[?5u");
  r.stdin.type("\r");
  await settle();
  r.panel.opens[0].made("@1");
  await settle();
  r.log.length = 0;
  r.stdin.type("\x1b[120;5u");
  r.stdin.type("\x1b[120;5u");
  await settle();
  r.stdin.type("q");
  for (const typed of ["\x1b[120;6u", "\x1b[120:88;6u", "\x1b[120;7u", "\x1b[98;3u"]) r.stdin.type(typed);
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input"), [["input", "\x18"], ["input", "q"], ["input", "\x18"], ["input", "\x18"], ["input", "\x1b\x18"], ["input", "\x1bb"]],
    "the leader twice: one 0x18; then q, Ctrl+Shift+X (with and without its shifted key), Ctrl+Alt+X and Alt+B as their legacy bytes");
  r.stdin.type("\x1b[120;5u");
  r.stdin.type("\x1b[27u");
  r.stdin.type("q");
  assert.equal(await r.status, 0, "the leader then Esc, then q in the list");
});

// ── The chords (docs/tui.md, "Chords"): the kitty keyboard protocol asked for at the start, and read
// only once the terminal answers with flag 1. packages/tui/test/chords.test.mjs has the modules'.
const writes = (r) => r.log.filter(([what]) => what === "write").map(([, bytes]) => bytes);

test("a run asks for the kitty keyboard protocol in the write that sets its modes; with no answer in its wait it pops it, and reads keys as without it for the rest of the run, a late answer and CSI u keys dropped", async () => {
  const r = await started({ keyboard: true, platform: "linux", kernel: { ok: true, cli: KEYED }, config: KEY_CONFIG });
  r.reader.answer(OPEN_ENTRY);
  assert.equal(writes(r)[0], ENTER + PUSH + QUERY, "pushed and asked after the modes, in one write");
  assert.equal(PUSH, "\x1b[>5u", "flags 1 and 4");
  assert.deepEqual(r.timers.delays(), [KEYBOARD_WAIT_MS], "the wait is the one timer");
  r.stdin.type("\x1b[107;7u");
  assert.doesNotMatch(wholeScreen(r), /acme-expert-tui +instance/, "Ctrl+Alt+K before an answer is no key");
  // A lone Esc while the answer is awaited may begin it: kept until the wait's end, then the Esc key.
  r.stdin.type("?");
  r.stdin.type("\x1b");
  r.tick(50);
  assert.match(wholeScreen(r), HELP_HEADING, "the help, its Esc kept");
  r.log.length = 0;
  r.timers.fire();
  assert.deepEqual(writes(r).filter((bytes) => bytes.includes("\x1b[<")), [POP], "popped at the wait's end");
  assert.doesNotMatch(wholeScreen(r), HELP_HEADING, "the kept Esc closed the help at the wait's end");
  r.stdin.type("\x1b[?5u");
  r.stdin.type("\x1b[107;7u");
  assert.doesNotMatch(wholeScreen(r), /acme-expert-tui +instance/, "an answer after the wait is not taken");
  r.stdin.type("\x0b");
  assert.match(wholeScreen(r), /acme-expert-tui +instance/, "Ctrl+K opens the palette, as without the protocol");
  r.stdin.type("\x1b\x1b[I");
  r.log.length = 0;
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  assert.deepEqual(writes(r), [LEAVE], "nothing pushed is left to pop");
});

test("with the Ctrl+Alt family chosen in keys.json, once the terminal answers with flags 1 and 4, Ctrl+Alt+K opens the palette from the list and from a terminal's focus, where no byte of it reaches the agent; every other key reaches the agent as its legacy bytes; the help lists the chords; quit pops the protocol before the modes", async () => {
  const r = await opening({ keyboard: true, platform: "linux", keys: chordFamilyFrom('{ "chords": "ctrl+alt" }') });
  r.stdin.type("\x1b[?5u");
  assert.deepEqual(r.timers.delays(), [], "the answer ends the wait");
  assert.doesNotMatch(wholeScreen(r), /acme-expert-tui +instance/);
  r.stdin.type("\x1b[107;7u");
  assert.match(wholeScreen(r), /acme-expert-tui +instance/, "Ctrl+Alt+K: the palette");
  r.stdin.type("\x1b[27u");
  assert.doesNotMatch(wholeScreen(r), /acme-expert-tui +instance/, "Esc under the protocol: exact, no timer");
  r.stdin.type("?");
  let help = wholeScreen(r);
  for (let page = 0; page < 40 && /more below/.test(help.slice(-40)); page++) { r.stdin.type("\x1b[6~"); help += wholeScreen(r); }
  assert.match(help, /Chords/);
  assert.match(help, /Ctrl\+Alt\+K +palette,/);
  // The rules under the table (what a terminal may take first) wrap with the width: chords.test.mjs reads them.
  r.stdin.type("?");
  r.stdin.type("\r");
  await settle();
  r.panel.opens[0].made("@1");
  await settle();
  r.log.length = 0;
  // Ctrl+C, Esc and then o, Shift+Alt+2 with the shifted key reported: the agent's, as without the protocol.
  r.stdin.type("a\x1b[99;5u\x1b[27uo\x1b[50:64;4u");
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input").map(([, bytes]) => bytes).join(""), "a\x03\x1bo\x1b@");
  r.log.length = 0;
  r.stdin.type("\x1b[107;7uzz");
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input" || what === "paste"), [], "the chord and the rest of its read reach nobody");
  assert.match(wholeScreen(r), /acme-expert-tui +instance/, "the palette, from the terminal's focus");
  r.stdin.type("\x1b[27u");
  r.log.length = 0;
  r.stdin.type("x");
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input"), [["input", "x"]], "closed, the palette gives the terminal its focus back");
  r.log.length = 0;
  // The leader (C-\ here) under the protocol is one sequence: no timing; then Esc, the list.
  r.stdin.type("\x1b[92;5u");
  r.stdin.type("\x1b[27u");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input"), [], "the leader, Esc and q were the TUI's");
  assert.equal(writes(r).at(-1), POP + LEAVE, "the protocol popped before the modes, in the one write that leaves");
});

test("keys.json is read once, at the start, with the run's environment and home, after tui.json; one tui.json refuses is never read, and a keys.json that cannot be read starts the run as Ctrl+Alt", async () => {
  const r = await started({ platform: "linux", env: { TERM: "xterm-256color", OATS_HOME_DIR: "/o" } });
  assert.deepEqual(r.keysAsked, [{ env: { TERM: "xterm-256color", OATS_HOME_DIR: "/o" }, home: "/home/u" }]);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  const refused = run({ config: { ok: false, lines: ["oats: `oats tui` cannot use /x: it is not valid JSON (E_TUI_CONFIG)"] } });
  assert.equal(await refused.status, 1);
  assert.deepEqual(refused.keysAsked, [], "tui.json refused: the run ends before keys.json");
  const unreadable = await started({ platform: "linux", keys: chordFamilyFrom(null, { code: "EACCES" }) });
  assert.deepEqual(unreadable.errors, [], "nothing is said on stderr");
  unreadable.stdin.type("q");
  assert.equal(await unreadable.status, 0);
});

test("under keys.json's Ctrl+Shift and the confirmed protocol, Ctrl+Shift+K opens the palette from the list and from a terminal's focus, where no byte of it reaches the agent; Ctrl+Alt+K is then no chord; under the default family Ctrl+Shift+D is the agent's Ctrl+D", async () => {
  const r = await opening({ keyboard: true, platform: "linux", keys: chordFamilyFrom('{ "chords": "ctrl+shift" }') });
  r.stdin.type("\x1b[?5u");
  r.stdin.type("\x1b[107;7u");
  assert.doesNotMatch(wholeScreen(r), /acme-expert-tui +instance/, "Ctrl+Alt+K: no chord in the Ctrl+Shift family");
  r.stdin.type("\x1b[107;6u");
  assert.match(wholeScreen(r), /acme-expert-tui +instance/, "Ctrl+Shift+K: the palette");
  r.stdin.type("\x1b[27u");
  r.stdin.type("\r");
  await settle();
  r.panel.opens[0].made("@1");
  await settle();
  r.log.length = 0;
  r.stdin.type("\x04\r\x1b[107;6uzz");
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input" || what === "paste"), [["input", "\x04\r"]], "the legacy 0x04 and 0x0d are the agent's; the chord and the rest of its read reach nobody");
  assert.match(wholeScreen(r), /acme-expert-tui +instance/, "the palette, from the terminal's focus");
  r.stdin.type("\x1b[27u");
  r.stdin.type("\x1b[92;5u");
  r.stdin.type("\x1b[27u");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  // The default family: the same event is Ctrl and the letter, typed into the agent as before.
  const d = await opening({ keyboard: true, platform: "linux" });
  d.stdin.type("\x1b[?5u");
  d.stdin.type("\r");
  await settle();
  d.panel.opens[0].made("@1");
  await settle();
  d.log.length = 0;
  d.stdin.type("\x1b[100;6u\x1b[109;6u");
  assert.deepEqual(panelDid(d).filter(([what]) => what === "input").map(([, bytes]) => bytes).join(""), "\x04\r", "CSI 100;6u and 109;6u: the agent's Ctrl+D and Enter");
  d.stdin.type("\x1b[92;5u");
  d.stdin.type("\x1b[27u");
  d.stdin.type("q");
  assert.equal(await d.status, 0);
});

test("with the protocol confirmed, a split chord typed in a terminal is the leader then its key: the panel splits as after the leader then |, and no byte reaches the agent: Ctrl+Alt+E with the Ctrl+Alt family chosen, Alt+E with the default Alt family (as CSI u: under the protocol ESC e is Esc then e, chords.test.mjs reads it without)", async () => {
  const CTRL_ALT = chordFamilyFrom('{ "chords": "ctrl+alt" }');
  const split = async (keys, family = chordFamilyFrom(null)) => {
    const r = await opening({ keyboard: true, platform: "linux", columns: 120, rows: 40, keys: family });
    r.stdin.type("\x1b[?5u");
    r.stdin.type("\r");
    await settle();
    r.panel.opens[0].made("@1");
    await settle();
    r.log.length = 0;
    for (const key of keys) { r.stdin.type(key); await settle(); }
    const did = panelDid(r).filter(([what]) => what !== "refresh");
    r.stdin.type("\x1b[92;5u");
    r.stdin.type("\x1b[27u");
    r.stdin.type("q");
    assert.equal(await r.status, 0);
    return did;
  };
  const led = await split(["\x1b[92;5u", "|"]);
  assert.equal(led.some(([what]) => what === "resize"), true, "the leader then | split the panel");
  for (const [keys, family, name] of [[["\x1b[101;7u"], CTRL_ALT, "Ctrl+Alt+E"], [["\x1b[101;3u"], undefined, "Alt+E as CSI u"]]) {
    const chorded = await split(keys, family);
    assert.deepEqual(chorded, led, `${name} is the leader then |`);
    assert.equal(chorded.some(([what]) => what === "input" || what === "paste"), false, `${name}: nothing reached the agent`);
  }
});

test("with the protocol confirmed, Ctrl+Z (a CSI u key) suspends: the protocol is popped with the modes before the stop, and pushed again with them on the return", async () => {
  const r = await started({ keyboard: true, platform: "linux" });
  r.stdin.type("\x1b[?5u");
  r.stdout.take();
  r.log.length = 0;
  r.stdin.type("\x1b[122;5u");
  assert.equal(r.stdout.take(), POP + LEAVE);
  assert.deepEqual(r.log.filter(([what]) => what === "kill"), [["kill", 0, "SIGTSTP"]]);
  r.proc.emit("SIGCONT", "SIGCONT");
  assert.equal(r.stdout.take().startsWith(ENTER + PUSH), true, "pushed again, not asked again");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

// ── The leader and the palette from a terminal's focus (Spec T1b): the leader is the one key the
// TUI takes from the agent, and what follows it in a later read is the TUI's.
const LEDGER_HOME = `${DEPLOYMENT}/agents/acme-ledger/instances/acme-ledger-dev`;
const TWO_ENTRY = observedAt(DEPLOYMENT, [
  instanceRow("acme-expert", "acme-expert-tui", { tmux: { session: "oats-agents", window: "acme-expert-tui", socket: AGENTS_SOCKET } }),
  instanceRow("acme-ledger", "acme-ledger-dev", { tmux: { session: "oats-agents", window: "acme-ledger-dev", socket: AGENTS_SOCKET } }),
]);
test("a tab's viewer is asked for no status line (--no-status-line) where the kernel advertises session-attach-no-status-line: the TUI's cheat sheet names the scroll keys itself (#1502 part E)", async () => {
  const QUIET = cliRecord({ version: CLI.version, workspaceApi: CLI.workspaceApi, features: [...CLI.features, "session-attach-no-status-line"], remote: ["roster", "session"] }, { bin: CLI.bin, source: "tui" });
  const r = await started({ kernel: { ok: true, cli: QUIET }, config: KEY_CONFIG });
  r.reader.answer(TWO_ENTRY);
  r.stdin.type("\r");
  await settle();
  assert.deepEqual(r.panel.opens[0].argv, [process.execPath, QUIET.bin, "session", "attach", "--home", HOME, "--no-status-line"]);
  r.panel.opens[0].made("@1");
  await settle();
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the cheat sheet of a focused terminal of this machine names the scroll keys its kernel's version --json says the viewer takes: Ctrl+B [ where sessionViewer.prefixScroll is true, Shift+PageUp alone where it is false, and none where the kernel does not list session-attach-prefix-scroll (#1502 part E)", async () => {
  const payload = { version: CLI.version, workspaceApi: CLI.workspaceApi, remote: ["roster", "session"] };
  const withFeature = CLI.features, withoutFeature = CLI.features.filter((name) => name !== "session-attach-prefix-scroll");
  for (const [why, record, hint] of [
    ["prefixScroll true", { ...payload, features: withFeature, sessionViewer: { prefixScroll: true } }, "Ctrl+B [ scroll back"],
    ["prefixScroll false", { ...payload, features: withFeature, sessionViewer: { prefixScroll: false } }, "Shift+PageUp scroll back"],
    ["a kernel before the feature", { ...payload, features: withoutFeature, sessionViewer: { prefixScroll: true } }, null],
  ]) {
    const cli = cliRecord(record, { bin: CLI.bin, source: "tui" });
    const r = await started({ kernel: { ok: true, cli }, config: KEY_CONFIG, columns: 120, rows: 40 });
    r.reader.answer(TWO_ENTRY);
    r.stdin.type("\r");
    await settle();
    r.panel.opens[0].made("@1");
    await settle();
    const drawn = sidebarOf(r);
    assert.equal(drawn.includes(hint ?? "scroll back"), hint !== null, `${why}: ${drawn}`);
    if (hint !== "Ctrl+B [ scroll back") assert.equal(drawn.includes("Ctrl+B [ scroll back"), false, `${why}: ${drawn}`);
    leaderEscape(r);
    r.stdin.type("q");
    assert.equal(await r.status, 0);
  }
});

/** A run with two running agents of this machine, the first one's terminal open with the focus in it. */
async function viewingFirstOfTwo() {
  const r = await started({ kernel: { ok: true, cli: KEYED }, config: KEY_CONFIG });
  r.reader.answer(TWO_ENTRY);
  r.stdout.take();
  r.stdin.type("\r");
  await settle();
  assert.deepEqual(r.panel.opens[0].argv, [process.execPath, KEYED.bin, ...sessionAttachArgv(KEYED, { home: HOME })], "the first agent's terminal");
  r.panel.opens[0].made("@1");
  await settle();
  r.log.length = 0;
  return r;
}

test("with a terminal focused, the leader, k, a few letters and Enter, each in a read of its own, open the palette, find the other agent and open it as a tab of its own, the focus in the new terminal: no byte of it reaches the agent (Spec T1b; T2)", async () => {
  const r = await viewingFirstOfTwo();
  r.stdin.type("\x1c");
  r.stdin.type("k");
  assert.match(wholeScreen(r), /acme-expert-tui +instance[\s\S]*acme-ledger-dev +instance/, "the palette, the agents first");
  r.stdin.type("ledg");
  const found = wholeScreen(r);
  assert.match(found, /> ledg/);
  assert.match(found, /acme-ledger-dev +instance/);
  assert.doesNotMatch(found, /acme-expert-tui +instance/, "the query keeps the one it matches");
  r.stdin.type("\r");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input" || what === "paste"), [], "nothing typed reached the agent");
  assert.deepEqual(panelDid(r).filter(([what]) => what === "close" || what === "open").map(([what]) => what), ["open"], "a tab of its own: the open one stays (T2)");
  assert.deepEqual(r.panel.opens[1].argv, [process.execPath, KEYED.bin, ...sessionAttachArgv(KEYED, { home: LEDGER_HOME })], "the chosen agent's terminal");
  r.panel.opens[1].made("@2");
  await settle();
  r.log.length = 0;
  r.stdin.type("typed");
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input"), [["input", "typed"]], "the focus is in the new terminal");
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

/** The first of two agents viewed, then the second opened beside it with Alt+Shift+Down:
 *  `@1` is hidden and `@2` shown, the focus in it. */
async function viewingTwoTabs(options = {}) {
  const r = await started({ kernel: { ok: true, cli: KEYED }, config: KEY_CONFIG, ...options });
  r.reader.answer(TWO_ENTRY);
  r.stdin.type("\r");
  await settle();
  r.panel.opens[0].made("@1");
  await settle();
  r.stdin.type("\x1b[1;4B");
  await settle();
  r.panel.opens[1].made("@2");
  await settle();
  r.log.length = 0;
  return r;
}

test("a hidden tab's output marks it on the strip and draws nothing of its screen; the shown tab's screen is drawn (T2)", async () => {
  const r = await viewingTwoTabs();
  assert.match(wholeScreen(r), /│ acme-expert-tui 1 │\[acme-ledger-dev 2\]/, "the tab bar: both tabs, each with its number, the shown one in brackets, no mark");
  r.panel.activity("@1");
  r.panel.screen("@1", "hidden words");
  await settle();
  const marked = wholeScreen(r);
  assert.match(marked, /│ acme-expert-tui\u2022 1 │\[acme-ledger-dev 2\]/, "the hidden tab is marked");
  assert.doesNotMatch(marked, /hidden words/, "a hidden tab's screen is not drawn");
  r.panel.activity("@2");
  r.panel.screen("@2", "shown words");
  await settle();
  const shown = wholeScreen(r);
  assert.match(shown, /shown words/);
  assert.match(shown, /│ acme-expert-tui\u2022 1 │\[acme-ledger-dev 2\]/, "the shown tab is never marked");
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("on the last tab the leader then Right does nothing: the terminal keeps the focus, and q then reaches the agent (T2, round 1 of the review)", async () => {
  const r = await viewingTwoTabs();
  r.stdin.type("\x1c");
  r.stdin.type("\x1b[C");
  await settle();
  r.stdin.type("q");
  assert.deepEqual(panelDid(r).filter(([what]) => what !== "refresh" && what !== "visible" && what !== "resize"), [["input", "q"]]);
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("two groups: a split resizes the first group's windows to its region; a tab moved shows both, each at its group's size, the keys to the focused one; the group's last closed gives the other the whole panel (T3)", async () => {
  const r = await viewingTwoTabs({ columns: 120, rows: 40 });
  const did = () => { const d = panelDid(r).filter(([what]) => what !== "refresh"); r.log.length = 0; return d; };
  r.stdin.type("\x1c");
  r.stdin.type("|");
  await settle();
  assert.deepEqual(did(), [["resize", 44, 39, ["@1", "@2"]]], "the second group is empty: nothing else is shown");
  r.stdin.type("\x1c");
  r.stdin.type("\t");
  await settle();
  assert.deepEqual(did(), [], "from the list to the first group's terminal: its window has the keys already");
  r.stdin.type("\x1c");
  r.stdin.type("m");
  await settle();
  assert.deepEqual(did(), [["show", "@1"], ["focus", "@2"]], "both displayed; the keys to the moved one");
  r.stdin.type("typed");
  assert.deepEqual(did(), [["input", "typed"]]);
  r.stdin.type("\x1c");
  r.stdin.type("w");
  await settle();
  assert.deepEqual(did(), [["close", "@2"], ["resize", 89, 39, ["@1"]], ["focus", "@1"]]);
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("keys typed after a switch of group or tab reach the agent switched to, also while the output is blocked and no frame is written: the panel is fitted first (T3, round 1 of the review)", async () => {
  const r = await viewingTwoTabs({ columns: 120, rows: 40 });
  for (const k of ["|", "\t", "m"]) { r.stdin.type("\x1c"); r.stdin.type(k); await settle(); } // @1 in the first group, @2 in the second, focused
  // A redraw in full (a resize to the same size) is the frame that blocks; the leader draws
  // nothing, and Tab, in a later read, is drawn by no frame.
  r.stdout.accepts = false;
  r.stdout.resize(r.stdout.columns, r.stdout.rows);
  r.stdout.accepts = true;
  r.stdout.take();
  r.log.length = 0;
  const did = () => { const d = panelDid(r).filter(([what]) => what !== "refresh"); r.log.length = 0; return d; };
  r.stdin.type("\x1c");
  r.stdin.type("\t");
  await settle();
  assert.equal(r.stdout.take(), "", "no frame is written while the output is blocked");
  r.stdin.type("for-first-agent");
  assert.deepEqual(did(), [["focus", "@1"], ["input", "for-first-agent"]], "the keys go to @1, never to @2");
  r.stdout.emit("drain"); await settle();
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  // A tab hidden by a resize is no destination: the empty group focused and drawn alone at 80
  // columns hides @2; the leader then Tab back to it, blocked, shows it before the keys go.
  const h = await viewingTwoTabs({ columns: 120, rows: 40 });
  h.stdin.type("\x1c"); h.stdin.type("|"); await settle();
  h.stdout.resize(80, 24); await settle();
  assert.deepEqual(panelDid(h).filter(([what]) => what === "hide"), [["hide", "@2"]], "the focused empty group alone");
  h.stdout.accepts = false;
  h.stdout.resize(h.stdout.columns, h.stdout.rows);
  h.stdout.accepts = true;
  h.log.length = 0;
  h.stdin.type("\x1c");
  h.stdin.type("\t");
  await settle();
  h.stdin.type("keep-these-bytes");
  assert.deepEqual(panelDid(h).filter(([what]) => what !== "refresh"), [["resize", 49, 23, ["@1", "@2"]], ["show", "@2"], ["input", "keep-these-bytes"]], "its group drawn alone, at its size, and shown before the keys");
  h.stdout.emit("drain"); await settle();
  leaderEscape(h);
  h.stdin.type("q");
  assert.equal(await h.status, 0);
  // A tab switched within one group, blocked the same way: the tab before shown first, then the keys.
  const t = await viewingTwoTabs();
  t.stdout.accepts = false;
  t.stdout.resize(t.stdout.columns, t.stdout.rows);
  t.stdout.accepts = true;
  t.stdin.type("\x1c");
  t.stdin.type("\x1b[D");
  await settle();
  t.log.length = 0;
  t.stdin.type("for-first");
  assert.deepEqual(panelDid(t).filter(([what]) => what !== "refresh"), [["hide", "@2"], ["show", "@1"], ["input", "for-first"]]);
  t.stdout.emit("drain"); await settle();
  leaderEscape(t);
  t.stdin.type("q");
  assert.equal(await t.status, 0);
});

test("the palette's Split right at 80 columns is refused with the line, measured on the panel the Instances view gives, and its Split down splits (T3, round 1 of the review)", async () => {
  const r = await viewingTwoTabs();
  const choose = async (text) => { r.stdin.type("\x1c"); r.stdin.type("k"); await settle(); r.stdin.type(text); await settle(); r.stdin.type("\r"); await settle(); };
  await choose("splitr");
  assert.match(sidebarOf(r), /No room to split side by side: each group needs 40 columns\./);
  // The line stands in the sidebar, so the panel keeps its size: at its whole width still.
  assert.deepEqual(panelDid(r).filter(([what, cols]) => what === "hide" || (what === "resize" && cols !== 49)), [], "no split: nothing hidden, no window narrower");
  r.log.length = 0;
  await choose("splitd");
  assert.deepEqual(panelDid(r).filter(([what]) => what === "resize"), [["resize", 49, 11, ["@1", "@2"]]], "the first group above, 11 rows of the 23");
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("with two tabs open, another workspace opened closes each tab's viewer by its window id, and no terminal is left (T2)", async () => {
  const r = await viewingTwoTabs({ listed: LISTED, admit: () => ({ ok: true, deployment: "/srv/acme-ledger" }) });
  leaderEscape(r);
  r.stdin.type("w"); r.stdin.type("w");
  await settle();
  r.stdin.type("j");
  r.log.length = 0;
  r.stdin.type("\r");
  await settle();
  assert.deepEqual(effectsOf(r), [["admit", LEDGER]]);
  assert.deepEqual(panelDid(r).filter(([what]) => what === "close"), [["close", "@1"], ["close", "@2"]]);
  r.log.length = 0;
  r.stdin.type("typed");
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input"), [], "no terminal has the focus");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("back in the workspace left with two tabs, the loop opens their viewers again one at a time, in their order, the second once the first's window is made; the shown one is the one left shown (docs/tui.md, Tabs)", async () => {
  const r = await viewingTwoTabs({ listed: LISTED, admit: () => ({ ok: true, deployment: "/srv/acme-ledger" }) });
  const [first, second] = r.panel.opens.map((each) => each.argv);
  leaderEscape(r);
  for (const k of ["w", "w", "j", "\r"]) { r.stdin.type(k); await settle(); }
  assert.deepEqual(panelDid(r).filter(([what]) => what === "close"), [["close", "@1"], ["close", "@2"]]);
  assert.equal(r.panel.opens.length, 2, "nothing opens in the other workspace");
  r.log.length = 0;
  for (const k of ["w", "w", "g", "\r"]) { r.stdin.type(k); await settle(); }
  assert.deepEqual([r.panel.opens.length, r.panel.opens[2].argv], [3, first], "the first tab's viewer, alone");
  r.panel.opens[2].made("@3");
  await settle();
  assert.deepEqual([r.panel.opens.length, r.panel.opens[3].argv], [4, second], "then the second's");
  r.panel.opens[3].made("@4");
  await settle();
  assert.match(wholeScreen(r), /│ acme-expert-tui 1 │\[acme-ledger-dev 2\]/, "both tabs, each with its number, the one left shown in brackets");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("a workspace left again before a restore's viewer is made: in the same read of input, its window is never asked for, and nothing else in the panel is closed; while it is being made, its window is closed once made; the way back opens it again (docs/tui.md, Tabs)", async () => {
  const r = await viewingTwoTabs({ listed: LISTED, admit: () => ({ ok: true, deployment: "/srv/acme-ledger" }) });
  const [first] = r.panel.opens.map((each) => each.argv);
  leaderEscape(r);
  for (const k of ["w", "w", "j", "\r"]) { r.stdin.type(k); await settle(); }
  for (const k of ["w", "w", "g"]) { r.stdin.type(k); await settle(); }
  r.log.length = 0;
  // Back and away in one read: the restore's first viewer is started, then closed, before the loop
  // asks the panel for its window.
  r.stdin.type("\rwj\r");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "open" || what === "close"), [], "no window asked for, and no other closed in its place");
  assert.equal(r.panel.opens.length, 2);
  // Back, and away while its window is being made: closed once it is made.
  for (const k of ["w", "w", "g", "\r"]) { r.stdin.type(k); await settle(); }
  assert.deepEqual([r.panel.opens.length, r.panel.opens[2].argv], [3, first], "the way back opens it again");
  r.log.length = 0;
  for (const k of ["w", "w", "j", "\r"]) { r.stdin.type(k); await settle(); }
  assert.deepEqual(panelDid(r).filter(([what]) => what === "close"), [["close"]], "the open under way given up");
  r.panel.opens[2].made("@3");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "close"), [["close"], ["close", "@3"]], "the window made late is closed");
  assert.equal(r.panel.opens.length, 3, "and nothing opens in the other workspace");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("with a terminal focused, Alt+Shift+Down opens the next agent's terminal as a tab with the focus in it, and then Alt+Shift+Up shows the one before, a tab already; nothing reaches the agent (Spec T1b; T2)", async () => {
  const r = await viewingFirstOfTwo();
  r.stdin.type("\x1b[1;4B");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "input" || what === "paste"), []);
  assert.deepEqual(r.panel.opens[1].argv, [process.execPath, KEYED.bin, ...sessionAttachArgv(KEYED, { home: LEDGER_HOME })], "the next agent");
  r.panel.opens[1].made("@2");
  await settle();
  r.log.length = 0;
  r.stdin.type("\x1b[1;4A");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "open" || what === "show"), [["show", "@1"]], "the agent before is a tab: shown, not opened again");
  // At the first agent, Up again goes nowhere: no wrap.
  r.log.length = 0;
  r.stdin.type("\x1b[1;4A");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "open" || what === "close" || what === "input"), [], "no wrap, and nothing typed");
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("a paste that holds the leader's byte and a command key runs nothing: with bracketed paste off, the bytes before the leader are the agent's and the rest of that read is dropped; inside a bracketed paste the byte is pasted text; in the list, the leader and a key in one read open nothing (Spec T1b)", async () => {
  const r = await viewingFirstOfTwo();
  for (const pasted of ["x\x1cX", "x\x1ck", "x\x1c\x1c", "x\x1cw"]) {
    r.log.length = 0;
    r.stdin.type(pasted);
    await settle();
    assert.deepEqual(panelDid(r).filter(([what]) => what !== "visible" && what !== "refresh"), [["input", "x"]], `${JSON.stringify(pasted)}: the x alone, nothing closed or opened`);
    r.log.length = 0;
    r.stdin.type("y");
    assert.deepEqual(panelDid(r), [["input", "y"]], `${JSON.stringify(pasted)}: the leader was cancelled, and the terminal keeps the focus`);
  }
  r.log.length = 0;
  r.stdin.type("\x1b[200~\x1cX\x1b[201~");
  assert.deepEqual(panelDid(r), [["paste", "\x1cX"]], "a bracketed paste goes to the agent as a paste, its leader byte with it");
  assert.doesNotMatch(wholeScreen(r), /Cancel| instance\b/, "no confirmation and no palette");
  leaderEscape(r);
  // In the list's focus: the leader with k, or X, in the same read opens nothing.
  for (const pasted of ["\x1ck", "\x1cX", "\x1c?"]) {
    r.stdin.type(pasted);
    assert.doesNotMatch(wholeScreen(r), /Cancel|Keys| instance\b/, JSON.stringify(pasted));
  }
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("keys that came in one chunk with the Enter that opened the terminal are dropped: neither the list nor the agent has them (round 1 of PR 4's review, kept)", async () => {
  for (const behind of ["q", "\x03", "?", "w", "\x1b"]) {
    const r = await opening();
    let over = false;
    r.status.then(() => { over = true; });
    r.stdin.type(`\r${behind}`);
    r.tick(50);
    r.timers.fire();
    await settle();
    assert.equal(r.panel.opens.length, 1, JSON.stringify(behind));
    assert.equal(over, false, `${JSON.stringify(behind)}: the run goes on`);
    assert.deepEqual(panelDid(r).filter(([what]) => what === "input" || what === "close"), [], `${JSON.stringify(behind)}: nothing typed, nothing closed`);
    const screen = wholeScreen(r);
    assert.doesNotMatch(screen, /^ workspaces|Keys/, `${JSON.stringify(behind)}: no other view was opened`);
    assert.match(screen, TYPING_SHEET, JSON.stringify(behind));
    leaderEscape(r);
    r.stdin.type("q");
    assert.equal(await r.status, 0, JSON.stringify(behind));
  }
});

test("a viewer that ends on its own closes the terminal: the line says what it printed, a live read is asked, and it is never opened again on its own; one the person closed says nothing", async () => {
  const r = await viewing();
  r.panel.closed("@1", 1, "can't find session: acme-expert-tui\n");
  await settle();
  assert.match(sidebarOf(r), /acme-expert-tui could not be opened\. "can't find session: acme-expert-tui"/);
  assert.doesNotMatch(wholeScreen(r), /Esc +the list/, "the list has the focus");
  assert.deepEqual(readerDid(r).filter(([what]) => what === "request"), [["request", { live: true }]]);
  r.tick(60_000);
  r.timers.fire();
  await settle();
  assert.equal(r.panel.opens.length, 1, "not reopened");
  // Enter opens it again; c closes it, and its end, reported later, says nothing.
  r.stdin.type("\r");
  await settle();
  r.panel.opens[1].made("@2");
  await settle();
  leaderEscape(r);
  r.log.length = 0;
  r.stdin.type("c");
  assert.deepEqual(panelDid(r).filter(([what]) => what === "close"), [["close", "@2"]], "the shown tab, by its window");
  r.panel.closed("@2", null, "", true);
  await settle();
  assert.doesNotMatch(wholeScreen(r), /could not|ended|Esc +the list|focus terminal/);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("no argument the TUI hands the panel is tmux or the agents' socket: the panel runs the kernel's viewer, and the viewer reaches the agent", async () => {
  const r = await opening();
  r.stdin.type("\r");
  await settle();
  for (const arg of r.panel.opens[0].argv) {
    assert.equal(/(^|\/)tmux$/.test(arg), false, arg);
    assert.equal(arg.includes(AGENTS_SOCKET), false, arg);
  }
  leaderEscape(r);
  r.stdin.type("q");
  await r.status;
});

// T3: each resize names the windows it is for (lib/main.mjs fitPanel: a group's tabs).
test("the panel is told what the frame gives the terminal: zoom and back resize its window, Tab hides it and shows it again, a resize of the terminal resizes it, and under 80 columns the list's focus hides it", async () => {
  const r = await viewing();
  leaderEscape(r);
  r.log.length = 0;
  r.stdin.type("z");
  assert.deepEqual(panelDid(r), [["resize", 80, 23, ["@1"]]], "zoomed: the whole screen, but its title row");
  r.log.length = 0;
  leaderEscape(r);
  assert.deepEqual(panelDid(r), [["resize", 49, 23, ["@1"]]]);
  r.log.length = 0;
  r.stdin.type("\t");
  assert.deepEqual(panelDid(r), [["visible", false]], "the detail in the terminal's place: no capture runs");
  r.log.length = 0;
  r.stdin.type("\t");
  assert.deepEqual(panelDid(r), [["visible", true]], "shown again: one fresh capture (the panel's)");
  r.log.length = 0;
  r.stdout.resize(120, 40);
  assert.deepEqual(panelDid(r), [["resize", 89, 39, ["@1"]]], "120 columns: the sidebar keeps 30 beside the terminal");
  r.log.length = 0;
  r.stdout.resize(70, 30);
  assert.deepEqual(panelDid(r), [["visible", false]], "under 80 columns, the list alone");
  r.log.length = 0;
  r.stdin.type("\r");
  assert.deepEqual(panelDid(r), [["visible", true], ["resize", 70, 29, ["@1"]]], "Enter: the terminal, over the whole screen");
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the panel is told the size and the sight its new window needs: a resize while the window was being made reaches it once the window exists, and a terminal closed hidden leaves the next one shown", async () => {
  const r = await opening();
  r.stdin.type("\r");
  await settle();
  r.stdout.resize(120, 40);
  r.log.length = 0;
  r.panel.opens[0].made("@1");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "resize"), [["resize", 89, 39, ["@1"]]], "the size the frame gives now, once the window exists");
  // Closed behind the detail: the next open shows its window again.
  leaderEscape(r);
  r.stdin.type("\t");
  r.stdin.type("c");
  assert.deepEqual(panelDid(r).filter(([what]) => what === "visible" || what === "close"), [["visible", false], ["close", "@1"]]);
  r.stdin.type("\t");
  r.log.length = 0;
  r.stdin.type("\r");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "visible" || what === "open").map(([what, more]) => (what === "open" ? what : [what, more])), [["visible", true], "open"]);
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("SIGTERM with a terminal open ends the run at once with 143, the private server ended on the way out; a stop from the list pauses the panel and the return resumes it", async () => {
  const r = await viewing();
  leaderEscape(r);
  r.log.length = 0;
  r.stdin.type("\x1a");
  assert.deepEqual(panelDid(r), [["pause"]]);
  r.log.length = 0;
  r.proc.emit("SIGCONT", "SIGCONT");
  assert.deepEqual(panelDid(r).slice(0, 1), [["resume"]]);
  r.stdin.type("\r");
  r.log.length = 0;
  r.proc.emit("SIGTERM", "SIGTERM");
  assert.equal(await r.status, 143);
  assert.deepEqual(panelDid(r), [["end"]]);
  assert.equal(r.timers.delays().length === 0 || !r.timers.delays().some((ms) => ms > 1000), true, "no grace: nothing is waited for");
});

test("the sweep runs once a run, after the first frame, with the run's environment; the run directory is made only when something needs it, and removed on the way out after the panel and the reader", async () => {
  const r = run({ kernel: { ok: true, cli: KEYED }, config: KEY_CONFIG });
  await r.up;
  assert.deepEqual(r.log.filter(([what]) => what === "panel").map(([, ...rest]) => rest), [["sweep", true]]);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  assert.equal(r.log.some(([what, which]) => what === "panel" && (which === "dir" || which === "remove")), false, "never made: nothing to remove");
  // A run whose panel asked for the directory removes it last.
  const s = await viewing();
  r.log.length = 0;
  s.panel.options.dir();
  s.log.length = 0;
  leaderEscape(s);
  s.stdin.type("q");
  assert.equal(await s.status, 0);
  assert.deepEqual(s.log.filter(([what, which]) => (what === "panel" && (which === "end" || which === "remove")) || (what === "reader" && which === "stop")).map(([what, which, more]) => [what, which, ...(more ? [more] : [])]), [["panel", "end"], ["reader", "stop"], ["panel", "remove", "/tmp/oats-tui-fixture"]]);
});

test("a panel that cannot start a viewer says so in the TUI's words: no tmux, or one too old, is named; another refusal is a failed open with tmux's words under it", async () => {
  const r = await opening();
  r.stdin.type("\r");
  await settle();
  r.panel.opens[0].refuse(Object.assign(new Error("tmux is not installed"), { code: "E_PANEL_TMUX" }));
  await settle();
  assert.match(sidebarOf(r), /acme-expert-tui could not be opened: the terminal panel needs tmux 3\.2 or later on this machine\./);
  r.stdin.type("\r");
  await settle();
  r.panel.opens[1].refuse(Object.assign(new Error("the panel's tmux server did not start"), { code: "E_PANEL_START", detail: "error connecting to /tmp/x/tmux (File name too long)" }));
  await settle();
  assert.match(sidebarOf(r), /acme-expert-tui could not be opened\. "error connecting to \/tmp\/x\/tmux \(File name too long\)"/);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

/** The fixture's deployment and garnet, with garnet's row selected. */
async function elsewhere(options = {}) {
  const r = await started({ kernel: { ok: true, cli: KEYED }, config: KEY_CONFIG, ...options });
  r.reader.answer(HOME_ENTRY);
  r.reader.roster({ envelope: rosterAnswer([garnet()]) });
  for (let i = 0; i < 6 && !/> +\S+ Dev far/.test(screenOf(r)); i++) r.stdin.type("j");
  assert.match(screenOf(r), /> +\S+ Dev far/, "garnet's running row is selected");
  r.stdout.take();
  r.log.length = 0;
  return r;
}

test("Enter on a running agent of another machine: the shared preflight over the reader's exec, with a signal and no key; what it prepared starts in the panel; a link that ends is said; a failure is said and nothing starts", async () => {
  const r = await elsewhere();
  r.stdin.type("\r");
  await settle();
  const [asked] = r.preflights;
  assert.deepEqual([asked.cli, asked.target, asked.options.exec, "detachKey" in asked.options, asked.options.signal.aborted], [KEYED, { serverId: "garnet", instance: "dev-far", home: "/srv/acme-platform/agents/dev/instances/dev-far" }, r.reader.exec, false, false]);
  assert.match(screenOf(r), /Esc +stop opening/);
  r.stdin.type("\r");
  await settle();
  assert.equal(r.preflights.length, 1, "a second Enter does nothing");
  asked.resolve({ binary: KEYED.bin, args: ["session", "attach", "--server", "garnet", "--home", asked.target.home] });
  await settle();
  assert.deepEqual(r.panel.opens.map((o) => o.argv.slice(0, 6)), [[process.execPath, KEYED.bin, "session", "attach", "--server", "garnet"]]);
  r.panel.opens[0].made("@1");
  await settle();
  r.panel.closed("@1", 255, "Connection to garnet.example closed by remote host.\n");
  await settle();
  assert.match(sidebarOf(r), /The connection to garnet ended\. "Connection to garnet\.example closed by remote host\."/);

  r.stdin.type("\r");
  await settle();
  r.preflights[1].reject(Object.assign(new Error("remote session inspection timed out"), { code: "E_TERM_PREPARE_TIMEOUT" }));
  await settle();
  assert.equal(r.panel.opens.length, 1, "nothing starts");
  assert.match(textOf(r.stdout.take()), /Terminal preparation timed out\./);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("a preflight that answers behind the help opens the viewer at the size the Instances view gives it, and the run goes on: the help is no frame of the panel's (T3, round 1 of the review)", async () => {
  const r = await elsewhere();
  r.stdin.type("\r");
  await settle();
  r.stdin.type("?");
  await settle();
  const [asked] = r.preflights;
  asked.resolve({ binary: KEYED.bin, args: ["session", "attach", "--server", "garnet", "--home", asked.target.home] });
  await settle();
  assert.deepEqual(r.panel.opens.map((o) => [o.cols, o.rows]), [[49, 23]]);
  r.panel.opens[0].made("@1");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "visible").at(-1), ["visible", false], "hidden behind the help");
  r.log.length = 0;
  r.stdin.type("?");
  await settle();
  assert.deepEqual(panelDid(r).filter(([what]) => what === "visible"), [["visible", true]], "shown once the help closes");
  leaderEscape(r);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("Esc during a preflight gives it up through its signal, and what it answers afterwards is dropped; a suspend gives it up first, with nothing said", async () => {
  const r = await elsewhere();
  r.stdin.type("\r");
  await settle();
  r.stdin.type("\x1b");
  r.tick(50); // the parser's wait for what may follow ESC
  r.timers.fire();
  await settle();
  assert.equal(r.preflights[0].options.signal.aborted, true);
  r.preflights[0].resolve({ binary: KEYED.bin, args: [] });
  await settle();
  assert.deepEqual(r.panel.opens, [], "given up: nothing starts");
  assert.doesNotMatch(screenOf(r), /Esc +stop opening/);

  r.stdin.type("\r");
  await settle();
  r.log.length = 0;
  r.stdin.type("\x1a"); // Ctrl+Z
  assert.equal(r.preflights[1].options.signal.aborted, true, "aborted before the reads are dropped and the process stops");
  assert.deepEqual(r.log.filter(([what, which]) => what === "reader" && which === "void" || what === "kill").map(([what]) => what), ["reader", "kill"]);
  r.proc.emit("SIGCONT", "SIGCONT");
  const failure = Object.assign(new Error("Terminal context changed"), { code: "E_TERM_CONTEXT_CHANGED" });
  r.preflights[1].reject(failure);
  await settle();
  const screen = screenOf(r);
  assert.doesNotMatch(screen, /Esc +stop opening|could not|timed out/, "nothing is said");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

// ── The acts (awebai/oats#855, PR 5): what the loop does with the store's effects ─────────────────

/** A kernel record that plans stops and retires and starts sessions. */
const ACTS_CLI = Object.freeze({ ...CLI, lifecycleApi: 1, features: Object.freeze([...CLI.features, "lifecycle-plans", "retire-retention", "retire-home", "session-start", "session-restart"]) });
/** A confirmation of the shared home's shape, already in review with `offers`: what it was asked, in order. */
function reviewing(offers = ["apply", "refresh", "close"]) {
  return (options) => {
    const made = {
      options, calls: [], closed: 0,
      state: () => ({ phase: "review", outcome: null, notice: null, offers, running: null }),
      view: () => ({ question: `Stop ${options.target.instance}?`, happening: [], state: { rows: [], notes: [] }, warning: null, choices: [], notice: null }),
      apply() { made.calls.push("apply"); }, refresh() { made.calls.push("refresh"); }, checkAgain() { made.calls.push("check-again"); },
      setChoice(...args) { made.calls.push(["setChoice", ...args]); }, close() { made.closed++; },
    };
    options.onChange(); // told inside the constructor, as the shared one tells it
    return made;
  };
}
/** A run of the fixture's deployment with its first agent (running) selected and the acts readable. */
async function acting(options = {}) {
  const r = await started({ kernel: { ok: true, cli: ACTS_CLI }, confirm: reviewing(), ...options });
  r.reader.answer(ENTRY);
  await settle();
  return r;
}

test("p pins the selected agent through the kernel's verb, as a change of this run labelled pin, and its answer reads the rows again (feature instance-pin)", async () => {
  const PIN_CLI = Object.freeze({ ...CLI, features: Object.freeze([...CLI.features, "instance-pin"]) });
  const r = await started({ kernel: { ok: true, cli: PIN_CLI } });
  r.reader.answer(ENTRY);
  await settle();
  const home = `${DEPLOYMENT}/agents/acme-expert/instances/acme-expert-tui`;
  // The line under the sidebar's title goes with the next key (Ctrl+L too): read what the run painted.
  r.stdout.take();
  r.stdin.type("p");
  await settle(); await settle();
  assert.match(textOf(r.stdout.take()), /Pinning acme-expert-tui…/);
  assert.equal(r.reader.changed.length, 1, "one change");
  const [change] = r.reader.changed;
  assert.deepEqual(change.argv, ["instance", "pin", "acme-expert-tui", "on", "--home", home, "--dir", DEPLOYMENT, "--json"]);
  assert.deepEqual(change.options.label, { verb: "pin", name: "acme-expert-tui" });
  const before = readerDid(r).filter(([what]) => what === "request").length;
  change.callback(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { instancePinApi: 1, instance: "acme-expert-tui", home, pinned: true, changed: true } }), "");
  await settle(); await settle();
  assert.match(textOf(r.stdout.take()), /acme-expert-tui is pinned to the top/, "the line, wrapped at the sidebar's width");
  assert.deepEqual(readerDid(r).filter(([what]) => what === "request").slice(before), [["request", { live: true }]]);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("p on a kernel without instance-pin runs nothing and says why", async () => {
  const r = await started();
  r.reader.answer(ENTRY);
  await settle();
  r.stdout.take();
  r.stdin.type("p");
  await settle();
  assert.equal(r.reader.changed.length, 0);
  assert.match(textOf(r.stdout.take()), /This OATS can't pin instances/);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("keys that came in one read with the key that opened a confirmation never press its act: X⏎ and Xl⏎ and Dl⏎ cancel, X⇥⏎ and D⇥⏎ review again, X⇥⇥⏎ is ignored; Enter in a read of its own presses it (Done 2)", async () => {
  for (const [typed, calls, closed, verb] of [["X\r", [], 1, "stop"], ["Xl\r", [], 1, "stop"], ["Dl\r", [], 1, "retire"], ["X\t\r", ["refresh"], 0, "stop"], ["D\t\r", ["refresh"], 0, "retire"], ["X\t\t\r", [], 0, "stop"]]) {
    const r = await acting();
    r.stdin.type(typed);
    await settle();
    const [made] = r.confirmations;
    assert.equal(r.confirmations.length, 1, JSON.stringify(typed));
    assert.deepEqual([made.options.operation, made.options.target.instance, made.calls, made.closed], [verb, "acme-expert-tui", calls, closed], JSON.stringify(typed));
    if (typed === "X\t\t\r") {
      r.stdin.type("\r");
      assert.deepEqual(made.calls, ["apply"], "Enter in a read of its own presses the act");
    }
    r.stdin.type("q");
    assert.equal(await r.status, 0, JSON.stringify(typed));
    assert.equal(made.closed, 1, "closed once: by Cancel, or on the way out");
  }
});

test("Esc closes the open confirmation, and what it tells afterwards changes nothing on the screen; a settled answer asks for one live read", async () => {
  const r = await acting();
  r.stdin.type("X");
  const [made] = r.confirmations;
  assert.match(screenOf(r), /Stop acme-expert-tui\?/);
  r.stdin.type("\x1b");
  r.tick(50);
  r.timers.fire();
  await settle();
  assert.equal(made.closed, 1);
  const after = screenOf(r);
  assert.doesNotMatch(after, /Stop acme-expert-tui\?/);
  r.stdout.take();
  made.options.onChange();
  assert.equal(r.stdout.take(), "", "told after close: nothing drawn");
  const before = readerDid(r).filter(([what]) => what === "request").length;
  made.options.onSettled();
  assert.deepEqual(readerDid(r).filter(([what]) => what === "request").slice(before), [["request", { live: true }]]);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the shared boundary runs a plan read through the reader's exec as a read, and the apply through its changeExec as a change of this run labelled with the act and the agent", async () => {
  const r = await started({ kernel: { ok: true, cli: ACTS_CLI } });
  r.reader.answer(ENTRY);
  await settle();
  const home = `${DEPLOYMENT}/agents/acme-expert/instances/acme-expert-tui`, plan = { lifecycleApi: 1, action: "stop", instance: "acme-expert-tui", home, recursive: true, at: "2026-10-11T10:00:00Z", planRevision: "a".repeat(24), notes: [], skipped: [], ambiguous: [],
    targets: [{ instance: "acme-expert-tui", agent: "acme-expert", agentsRoot: `${DEPLOYMENT}/agents`, home, depth: 0, session: lifecycleSession(), work: lifecycleWork(), workMode: "worktree", launched: true, retiring: false, stopPending: false, midTask: false }] };
  const reads = [];
  r.reader.exec = (bin, argv, options, callback) => { reads.push({ argv: [...argv], options }); setImmediate(() => callback(null, JSON.stringify({ schemaVersion: 1, ok: true, result: plan }), "")); return { pid: 3000 }; };
  r.stdin.type("X");
  await settle(); await settle();
  assert.equal(reads.length, 1, "the plan read");
  assert.deepEqual(reads[0].argv.slice(0, 4), ["instance", "stop", "acme-expert-tui", "--plan"]);
  assert.equal(reads[0].options.detached, undefined, "a read: no session of its own");
  assert.match(screenOf(r), /Stop acme-expert-tui\?/);
  r.stdin.type("\t");
  r.stdin.type("\t");
  r.stdin.type("\r");
  await settle();
  const [change] = r.reader.changed;
  assert.ok(change, "the apply ran as a change");
  assert.deepEqual([change.argv.slice(0, 4), change.options.label], [["instance", "stop", "acme-expert-tui", "--apply"], { verb: "stop", name: "acme-expert-tui" }]);
  assert.equal(change.options.detached, undefined, "changeExec is always a session of its own: the mark is not passed on");
  const at = (flag) => change.argv[change.argv.indexOf(flag) + 1];
  const receipt = { lifecycleApi: 1, action: "stop", instance: "acme-expert-tui", home, planRevision: at("--plan-revision"), idempotencyKey: at("--idempotency-key"), at: "2026-10-11T10:01:00Z", replayed: false, ok: true,
    retained: ["home", "work", "transcript", "launch"], results: [{ instance: "acme-expert-tui", home, ok: true, stopped: true, alreadyIdle: false, state: "stopped" }] };
  const before = readerDid(r).filter(([what]) => what === "request").length;
  change.callback(null, JSON.stringify({ schemaVersion: 1, ok: true, result: receipt }), "");
  await settle(); await settle();
  assert.deepEqual(readerDid(r).filter(([what]) => what === "request").slice(before), [["request", { live: true }]], "settled: one live read");
  assert.match(screenOf(r), /\[ Close \]|> Close </);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("a start on another machine is read by that machine's features, whatever this computer's kernel lists", async () => {
  const CLAIM = ["lifecycle-claim-stop", "lifecycle-claim-start"];
  const LOCAL = ["session-start", "session-restart", "server-probe-features"];
  const cli = (features) => cliRecord({ version: CLI.version, workspaceApi: CLI.workspaceApi, features: [...CLI.features, ...LOCAL, ...features], remote: ["roster", "session-start"] }, { bin: CLI.bin, source: "tui" });
  const busy = { schemaVersion: 1, ok: false, error: { code: "E_LIFECYCLE_BUSY", message: "a stop of dev-far is already running", details: { holder: "running", action: "stop" } } };
  for (const [name, here, host, said] of [
    ["the host lists it, this computer does not", [], [...CLI.features, ...CLAIM], "Nothing was started"],
    ["this computer lists it, the host does not", CLAIM, [...CLI.features], "E_LIFECYCLE_BUSY"],
  ]) {
    const answers = [];
    const r = await started({ kernel: { ok: true, cli: cli(here) }, confirm: reviewing(),
      start: (kernel, row, choices, options) => startInstance(kernel, row, choices, { ...options, start: async () => busy }).then((answer) => { answers.push(answer); return answer; }) });
    r.reader.answer(HOME_ENTRY);
    r.reader.collecting();
    r.reader.roster({ envelope: rosterAnswer([{ ...group("garnet:t1", "/srv/acme-platform", [remoteRow("dev-far", "/srv/acme-platform", { running: false, runtimeState: "stopped" })]), probe: { ok: true, features: host } }]) });
    await settle();
    for (const key of ["j", "j", "S", "\t", "\r"]) r.stdin.type(key);
    await settle(); await settle();
    assert.deepEqual([answers.length, answers[0]?.code, answers[0]?.outcome], [1, "E_LIFECYCLE_BUSY", said === "E_LIFECYCLE_BUSY" ? "uncertain" : "refused"], name);
    assert.match(screenOf(r), new RegExp(said), name);
    r.stdin.type("q"); r.stdin.type("q");
  }
});

test("a start runs the shared start rule once, over a change of this run: while its child runs the row opens no act, and its answer is said and asks for a live read", async () => {
  let answer;
  const r = await acting({ start: (cli, row, choices, options) => new Promise((resolve) => { answer = resolve; options.exec("/opt/oats/bin/oats.mjs", ["session", "start"], { timeout: 0, detached: true }, () => {}); }) });
  r.stdin.type("j");
  r.stdin.type("S");
  assert.match(screenOf(r), /Start acme-maintainer-ops\?/);
  r.stdin.type("\t");
  r.stdin.type("\r");
  await settle();
  assert.equal(r.starts.length, 1);
  const [cli, row, choices, options] = r.starts[0];
  assert.deepEqual([cli, row.instance, choices, options.restart, options.localCwd], [ACTS_CLI, "acme-maintainer-ops", {}, false, DEPLOYMENT]);
  assert.deepEqual(r.reader.changed[0].options.label, { verb: "start", name: "acme-maintainer-ops" });
  assert.match(screenOf(r), /Starting acme-maintainer-ops/);
  r.stdin.type("\x1b"); r.tick(50); r.timers.fire(); await settle();
  r.stdout.take();
  r.stdin.type("X");
  assert.match(sidebarOf(r), /The start of acme-maintainer-ops is still running\./, "the line, until the next key");
  const before = readerDid(r).filter(([what]) => what === "request").length;
  r.reader.changed[0].callback(null, "", "");
  answer({ ok: true, result: { started: true } });
  await settle(); await settle();
  assert.deepEqual(readerDid(r).filter(([what]) => what === "request").slice(before), [["request", { live: true }], ["request", { live: true }]], "the child's close and the answer: each asks");
  r.stdin.type("X");
  assert.equal(r.confirmations.length, 1, "the row opens its acts again");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("a change still running when the run ends is named after the screen is left, only to a terminal or a file; the status never depends on it", async () => {
  for (const [tell, lines] of [[true, ["oats: the stop of acme-expert-tui is still running; `oats status` shows its result.\n"]], [false, []]]) {
    const r = await acting({ tellable: () => tell });
    r.reader.running = [{ pid: 4242, label: { verb: "stop", name: "acme-expert-tui" } }];
    r.stdin.type("q");
    assert.equal(await r.status, 0, String(tell));
    assert.deepEqual(r.errors, lines, String(tell));
  }
});

// ── The Souls view's catalog (docs/tui.md, "The Souls view"; Spec 6-view, Done 1 and 4) ──────────

/** `oats souls --json` answering `names`, as the kernel prints it. */
const soulsDocument = (names) => ({ ok: true, document: { schemaVersion: 1, ok: true, result: { soulsApi: 1, workspace: { name: "acme-platform" }, problems: [], souls: names.map((name) => ({ name, origin: "member", kind: "member", repoKey: "acme/oats", work: "worktree", description: `The ${name} soul.` })) } } });
/** The entry of the fixture's deployment with its workspace at `commit`: a move of the catalog's key. */
const atCommit = (entry, commit) => ({ ...entry, deployment: { ...entry.deployment, workspaceStatus: { ...entry.deployment.workspaceStatus, workspace: { ...entry.deployment.workspaceStatus.workspace, commit } } } });

test("a run that never shows the Souls view or the Capabilities view never runs `oats souls`, however many reads of the workspace it takes", async () => {
  const r = await started();
  for (let i = 0; i < 3; i++) r.reader.answer(atCommit(ENTRY, `c${i}`));
  // Another view (the help) reads nothing: the Capabilities view would read the souls, its Used by's.
  r.stdin.type("?"); r.stdin.type("?"); await settle();
  assert.deepEqual(r.soulReads.length, 0);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the first show of the Souls view reads the catalog once, over the reader's own exec; it says Reading souls… until the read lands, then lists them; reads of the workspace as it was read nothing, one that moved its key reads once", async () => {
  const r = await started();
  r.reader.answer(ENTRY);
  r.stdin.type("2"); await settle();
  assert.equal(r.soulReads.length, 1, "one read at the first show");
  assert.equal(r.soulExec, r.reader.exec, "the reader's exec: a read of kind \"read\", ended on every way out");
  assert.match(textOf(written(r)), /Reading souls…/);
  r.soulReads[0].answer(soulsDocument(["dev", "ops"])); await settle();
  assert.match(screenOf(r), /\bops\b/);
  r.reader.answer(ENTRY); r.reader.answer(ENTRY); r.stdin.type("1"); r.stdin.type("2"); await settle();
  assert.equal(r.soulReads.length, 1, "the workspace as it was: nothing read");
  r.reader.answer(atCommit(ENTRY, "b2")); await settle();
  assert.equal(r.soulReads.length, 2, "its key moved: one read");
  r.reader.answer(atCommit(ENTRY, "b2")); await settle();
  assert.equal(r.soulReads.length, 2);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  assert.deepEqual(readerDid(r).at(-1), ["stop"], "the reader is stopped on the way out, the catalog's read with it");
});

test("a read of the catalog that a newer key replaced is never shown: the newer read lands first, the older after it, and the screen keeps the newer souls", async () => {
  const r = await started();
  r.reader.answer(ENTRY);
  r.stdin.type("2"); await settle();
  assert.equal(r.soulReads.length, 1, "the read at key A");
  r.reader.answer(atCommit(ENTRY, "b2")); await settle();
  assert.equal(r.soulReads.length, 2, "the read at key B");
  r.soulReads[1].answer(soulsDocument(["new-catalog-soul"])); await settle();
  assert.match(screenOf(r), /new-catalog-soul/);
  r.soulReads[0].answer(soulsDocument(["old-catalog-soul"])); await settle();
  assert.match(screenOf(r), /new-catalog-soul/, "the newer catalog stays");
  assert.doesNotMatch(screenOf(r), /old-catalog-soul/, "the replaced read is not shown");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the Souls view shown before the workspace was read waits for its first read; r reads the catalog again, once, and never while a read is in flight", async () => {
  const r = await started();
  r.stdin.type("2"); await settle();
  assert.equal(r.soulReads.length, 0, "no workspace status yet: nothing to settle with");
  r.reader.answer(ENTRY); await settle();
  assert.equal(r.soulReads.length, 1, "its first read settles the catalog");
  r.stdin.type("r"); r.stdin.type("r"); await settle();
  assert.equal(r.soulReads.length, 1, "r while the read is in flight starts nothing");
  r.soulReads[0].answer(soulsDocument(["dev"])); await settle();
  r.stdin.type("r"); await settle();
  assert.equal(r.soulReads.length, 2, "r after it landed: one read");
  r.stdin.type("r"); await settle();
  assert.equal(r.soulReads.length, 2, "and none beside it");
  assert.equal(readerDid(r).filter(([what]) => what === "request").length, 0, "r in the Souls view asks no read of the workspace");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("r in the Souls view keeps the souls it holds while it reads, and a read that fails keeps them under the failure (#1301)", async () => {
  const r = await started();
  r.reader.answer(ENTRY);
  r.stdin.type("2"); await settle();
  r.soulReads[0].answer(soulsDocument(["held-soul"])); await settle();
  assert.match(screenOf(r), /held-soul/);
  r.stdin.type("r"); await settle();
  assert.equal(r.soulReads.length, 2, "r: one read");
  assert.match(screenOf(r), /held-soul/, "the souls stand while it reads");
  assert.doesNotMatch(screenOf(r), /Reading souls…/);
  assert.equal(r.soulReads[1].asked.maxAge, 0, "a live read");
  r.stdin.type("r"); await settle();
  assert.equal(r.soulReads.length, 2, "r while it reads starts nothing");
  r.soulReads[1].answer({ ok: false, reason: { code: "E_CLI_FAILED", message: "re-read failed" } }); await settle();
  const screen = screenOf(r);
  assert.match(screen, /held-soul/, "the last good souls are kept");
  // The failure's heading above the rows, and its sentence whole in the detail (wrapped there).
  assert.match(screen, / Couldn't read this… +read \d\d:\d\d:\d\d │/, "under the failure's heading, its sentence from the margin");
  assert.doesNotMatch(screen, / Souls +Couldn't read/, "the heading has no word: the view's row above it names the view");
  assert.match(screen, /Couldn't read this workspace's souls:/);
  assert.match(screen, /│ +re-read failed/);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

// ── The Capabilities view's table (docs/tui.md, "The Capabilities view"; Spec 7, Done 1 and 4) ──────

/** `oats capabilities --json` answering `names`, member capabilities of one repository, as the kernel prints it. */
const capabilitiesDocument = (names) => ({ ok: true, document: { schemaVersion: 1, ok: true, result: { capabilitiesApi: 1, workspace: { name: "acme-platform" }, problems: [], capabilities: names.map((name) => ({ name, origin: "member", kind: "member", repoKey: "acme/oats", description: `The ${name} capability.` })) } } });

test("a run that never shows the Capabilities view never runs `oats capabilities`, however many reads of the workspace it takes, the Souls view's included", async () => {
  const r = await started();
  for (let i = 0; i < 3; i++) r.reader.answer(atCommit(ENTRY, `c${i}`));
  r.stdin.type("2"); r.stdin.type("1"); r.stdin.type("?"); r.stdin.type("?"); await settle();
  r.reader.answer(atCommit(ENTRY, "c9")); await settle();
  assert.equal(r.capabilityReads.length, 0);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the first show of the Capabilities view reads its table once, over the reader's own exec, and the souls catalog its Used by reads; it says Reading capabilities… until the read lands, then lists them; reads of the workspace as it was read nothing, one that moved its key reads once", async () => {
  const r = await started();
  r.reader.answer(ENTRY);
  r.stdin.type("3"); await settle();
  assert.deepEqual([r.capabilityReads.length, r.soulReads.length], [1, 1], "one read of each at the first show");
  assert.equal(r.capabilityReads[0].asked.action, "capabilities");
  assert.equal(r.capabilityExec, r.reader.exec, "the reader's exec: a read of kind \"read\", ended on every way out");
  assert.match(textOf(written(r)), /Reading capabilities…/);
  r.capabilityReads[0].answer(capabilitiesDocument(["aweb", "notes"])); await settle();
  assert.match(screenOf(r), /\bnotes\b/);
  r.reader.answer(ENTRY); r.reader.answer(ENTRY); r.stdin.type("1"); r.stdin.type("3"); await settle();
  assert.equal(r.capabilityReads.length, 1, "the workspace as it was: nothing read");
  r.reader.answer(atCommit(ENTRY, "b2")); await settle();
  assert.equal(r.capabilityReads.length, 2, "its key moved: one read");
  r.reader.answer(atCommit(ENTRY, "b2")); await settle();
  assert.equal(r.capabilityReads.length, 2);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  assert.deepEqual(readerDid(r).at(-1), ["stop"], "the reader is stopped on the way out, the table's read with it");
});

test("a read of the capabilities that a newer key replaced is never shown: the newer read lands first, the older after it, and the screen keeps the newer capabilities", async () => {
  const r = await started();
  r.reader.answer(ENTRY);
  r.stdin.type("3"); await settle();
  assert.equal(r.capabilityReads.length, 1, "the read at key A");
  r.reader.answer(atCommit(ENTRY, "b2")); await settle();
  assert.equal(r.capabilityReads.length, 2, "the read at key B");
  r.capabilityReads[1].answer(capabilitiesDocument(["new-catalog-cap"])); await settle();
  assert.match(screenOf(r), /new-catalog-cap/);
  r.capabilityReads[0].answer(capabilitiesDocument(["old-catalog-cap"])); await settle();
  assert.match(screenOf(r), /new-catalog-cap/, "the newer table stays");
  assert.doesNotMatch(screenOf(r), /old-catalog-cap/, "the replaced read is not shown");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("the Capabilities view shown before the workspace was read waits for its first read; r reads the table again, once, and never while a read is in flight; it reads neither the souls nor the workspace", async () => {
  const r = await started();
  r.stdin.type("3"); await settle();
  assert.equal(r.capabilityReads.length, 0, "no workspace status yet: nothing to settle with");
  r.reader.answer(ENTRY); await settle();
  assert.equal(r.capabilityReads.length, 1, "its first read settles the table");
  const souls = r.soulReads.length;
  r.stdin.type("r"); r.stdin.type("r"); await settle();
  assert.equal(r.capabilityReads.length, 1, "r while the read is in flight starts nothing");
  r.capabilityReads[0].answer(capabilitiesDocument(["aweb"])); await settle();
  r.stdin.type("r"); await settle();
  assert.equal(r.capabilityReads.length, 2, "r after it landed: one read");
  r.stdin.type("r"); await settle();
  assert.equal(r.capabilityReads.length, 2, "and none beside it");
  assert.equal(r.soulReads.length, souls, "r reads the capabilities only, not the souls");
  assert.equal(readerDid(r).filter(([what]) => what === "request").length, 0, "r in the Capabilities view asks no read of the workspace");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("r in the Capabilities view keeps the table it holds while it reads, and a read that fails keeps it under the failure", async () => {
  const r = await started();
  r.reader.answer(ENTRY);
  r.stdin.type("3"); await settle();
  r.capabilityReads[0].answer(capabilitiesDocument(["held-capability"])); await settle();
  assert.match(screenOf(r), /held-capability/);
  r.stdin.type("r"); await settle();
  assert.equal(r.capabilityReads.length, 2, "r: one read");
  assert.match(screenOf(r), /held-capability/, "the table stands while it reads");
  r.capabilityReads[1].answer({ ok: false, reason: { code: "E_CLI_FAILED", message: "re-read failed" } }); await settle();
  const screen = screenOf(r);
  assert.match(screen, /held-capability/, "the last good table is kept");
  // The failure's heading above the rows, and its sentence whole in the detail (wrapped there).
  assert.match(screen, / Couldn't read this… +read \d\d:\d\d:\d\d │/, "under the failure's heading, its sentence from the margin");
  assert.doesNotMatch(screen, / Capabilities +(Couldn't read|read \d)/, "the heading has no word: the view's row above it names the view");
  assert.match(screen, /Couldn't read this workspace's/);
  assert.match(screen, /capabilities: re-read failed/);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

// ── This run's retires in flight (#1247): the loop's one tracker, its marks and what lets a row go ──

/** The word of a retiring row, as the shared home gives it, and whether the screen shows one now. */
const RETIRING = heldHome({ instance: "any", retireInFlight: true }).state;
const retiringShown = (r) => screenOf(r).includes(RETIRING);
/** The retire confirmation of the selected row, opened and closed again (what it sent would go on):
 *  what the loop handed it. */
async function retireOpened(r) {
  r.stdin.type("D");
  const made = r.confirmations.at(-1);
  assert.equal(made.options.operation, "retire");
  r.stdin.type("\x1b"); r.tick(50); r.timers.fire(); await settle();
  return made.options;
}

test("a retire this run sends reads Retiring… from its send, before any read is asked for; a refusal or a changed plan lets the row go at once", async () => {
  const r = await acting();
  const { retires, target } = await retireOpened(r);
  assert.ok(retires, "the run's tracker is handed to the confirmation");
  assert.equal(target.instance, "acme-expert-tui");
  assert.equal(retiringShown(r), false);
  const requests = () => readerDid(r).filter(([what]) => what === "request").length, asked = requests();
  for (const kind of ["refused", "stale"]) {
    const own = retires.begin(target);
    assert.equal(retiringShown(r), true, `${kind}: from the send`);
    assert.equal(requests(), asked, `${kind}: no read was needed for it`);
    own.settle(kind);
    assert.equal(retiringShown(r), false, `${kind}: let go at once, the row as it was read`);
  }
  assert.equal((await retireOpened(r)).retires, retires, "one tracker for the whole run");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("an answered retire of this machine's row is let go only by a read of its deployment begun after the answer: not one begun before, not a failed one, not the roster", async () => {
  const r = await acting();
  const { retires, target } = await retireOpened(r);
  const own = retires.begin(target);
  const running = r.reader.cycle(); // a cycle begun while the retire runs
  own.settle("complete");
  assert.equal(retiringShown(r), true, "answered: still held until a read says what it left");
  r.reader.read(ENTRY, running);
  assert.equal(retiringShown(r), true, "a read begun before the answer");
  r.reader.answer(failed(ENTRY, { code: "E_DEPLOYMENT_BUSY", message: "busy" }));
  assert.equal(retiringShown(r), true, "a read that failed, whatever entry it kept");
  r.reader.cycle();
  r.reader.collecting();
  r.reader.roster({ envelope: rosterAnswer([garnet()]) });
  assert.equal(retiringShown(r), true, "a roster outcome covers no row of this machine");
  r.reader.read(ENTRY);
  assert.equal(retiringShown(r), false, "read after the answer: the row as the kernel reports it");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("an answered retire of another machine's row is let go only by a roster read begun after the answer that reached that machine: not this machine's reads, not one begun before, not one that failed", async () => {
  const r = await elsewhere({ confirm: reviewing() });
  const { retires, target } = await retireOpened(r);
  assert.deepEqual([target.instance, target.server], ["dev-far", "garnet"]);
  const own = retires.begin(target);
  assert.equal(retiringShown(r), true, "from the send");
  r.reader.cycle();
  r.reader.collecting(); // a roster read begun while the retire runs
  own.settle("partial");
  r.reader.roster({ envelope: rosterAnswer([garnet()]) });
  assert.equal(retiringShown(r), true, "a roster read begun before the answer");
  r.reader.read(HOME_ENTRY);
  assert.equal(retiringShown(r), true, "this machine's read covers no row of another");
  r.reader.cycle();
  r.reader.collecting();
  r.reader.roster({ thrown: "the read timed out" });
  assert.equal(retiringShown(r), true, "a roster read that failed reached no machine");
  r.reader.cycle();
  r.reader.collecting();
  r.reader.roster({ envelope: rosterAnswer([garnet()]) });
  assert.equal(retiringShown(r), false, "read after the answer, garnet reached: the row as garnet reports it");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

// ── Spawning an agent (docs/tui.md, "Spawning an agent"; Spec 6-spawn) ─────────────────────────────

const SPAWN_DATA = Object.freeze({ instance: "acme-expert-2", home: `${DEPLOYMENT}/agents/acme-expert/instances/acme-expert-2`, work: "worktree", harness: "claude", model: "claude-opus-5-5", modelSource: "soul",
  warnings: [], decision: Object.freeze({ spawnDecisionApi: 1, digest: "d".repeat(64) }) });
const SPAWN_SELECTOR = Object.freeze({ soul: "acme-expert", agentsRoot: `${DEPLOYMENT}/agents` });
/** A run with the workspace read and its catalog held, the spawn picker opened with n, the soul's
 *  name typed and picked, and its preview answered: each key a read of its own. */
async function previewing() {
  const r = await started();
  r.reader.answer(ENTRY);
  r.stdin.type("n"); await settle();
  r.soulReads[0].answer(soulsDocument(["acme-expert", "acme-maintainer"])); await settle();
  for (const ch of "expert") r.stdin.type(ch);
  r.stdin.type("\r"); await settle();
  r.spawn.reads.at(-1).answer({ spawnPreviewViewApi: 1, status: "available", target: null, data: SPAWN_DATA, reason: null }); await settle();
  return r;
}

test("a spawn through the loop: n reads the catalog, the preview is read once per choice over the shared preview made with the reader's exec, Enter submits the decision on screen, and the new row's terminal opens with the focus", async () => {
  const r = await previewing();
  assert.equal(r.spawn.previewExec, r.reader.exec, "the preview's kernel reads are reads");
  assert.equal(r.spawn.applyRead, r.spawn.preview.prepareRead, "the apply prepares through the same preview");
  const [read] = r.spawn.reads;
  assert.deepEqual(read.request, { action: "preview", selector: SPAWN_SELECTOR, choices: { model: { kind: "inherit" }, relation: { kind: "unrelated" } } });
  assert.deepEqual([read.context.workspace.id, read.context.cli, read.context.agents.map((a) => a.name), read.context.instances.length], [DEPLOYMENT, CLI, ["acme-expert", "acme-maintainer"], 2]);
  r.stdin.type("\r"); await settle();
  const [submit] = r.spawn.submits;
  assert.deepEqual(submit.intent, { address: DEPLOYMENT, selector: SPAWN_SELECTOR, input: { action: "prepare", selector: SPAWN_SELECTOR, choices: read.request.choices, task: "" }, decision: SPAWN_DATA.decision });
  assert.equal(submit.call.alive(), true);
  submit.call.progress("submitted", { address: DEPLOYMENT, spawnRef: "a".repeat(64) }); await settle();
  assert.match(screenOf(r), /Spawning acme-expert-2…/);
  const asked = readerDid(r).filter(([what]) => what === "request").length;
  submit.answer({ kind: "created", view: { status: "complete", receipt: { instance: "acme-expert-2", agent: "acme-expert", home: SPAWN_DATA.home, launched: true } }, reason: null, job: {} }); await settle();
  assert.equal(readerDid(r).filter(([what]) => what === "request").length, asked + 1, "the instances read at once");
  assert.doesNotMatch(screenOf(r), /Spawning/);
  r.reader.answer(observed([instanceRow("acme-expert", "acme-expert-tui"), instanceRow("acme-maintainer", "acme-maintainer-ops", { running: false, runtimeState: "stopped" }), instanceRow("acme-expert", "acme-expert-2")])); await settle();
  assert.equal(r.panel.opens.length, 1, "its terminal, in the panel");
  assert.equal(r.panel.opens[0].argv.some((arg) => String(arg).endsWith("/acme-expert-2")), true);
  // Its window made, what is typed is the agent's (before it, nothing has a window to take it).
  r.panel.opens[0].made("@1"); await settle();
  r.stdin.type("q"); await settle();
  assert.equal(r.log.some(([what, bytes]) => what === "panel" && bytes === "input"), true, "the q went to the agent: the terminal has the focus");
});

test("the preview scrolls on from where each movement key left it: three Downs in one read move three rows, and so do three reads while the output is blocked (round 1 of the polish's review)", async () => {
  const r = await started({ columns: 60, rows: 15 });
  r.reader.answer(ENTRY);
  r.stdin.type("n"); await settle();
  r.soulReads[0].answer(soulsDocument(["acme-expert", "acme-maintainer"])); await settle();
  for (const ch of "expert") r.stdin.type(ch);
  r.stdin.type("\r"); await settle();
  const warnings = Array.from({ length: 12 }, (_, i) => `Warning number ${i + 1}.`);
  r.spawn.reads.at(-1).answer({ spawnPreviewViewApi: 1, status: "available", target: null, data: { ...SPAWN_DATA, warnings }, reason: null }); await settle();
  const above = () => Number(/(\d+) more above/.exec(wholeScreen(r))?.[1] ?? 0);
  // Back from Spawn to the warnings' fold, opened, and on to Spawn again, which scrolls freely.
  r.stdin.type("\x1b[Z"); await settle();
  r.stdin.type("\r"); await settle();
  r.stdin.type("\t"); await settle();
  assert.match(wholeScreen(r), /> Spawn </);
  const start = above();
  r.stdin.type("\x1b[B\x1b[B\x1b[B"); await settle();
  assert.equal(above(), start + 3, "three Downs in one read: three rows");
  assert.match(wholeScreen(r), /more below/, "and room for three more");
  r.stdout.accepts = false;
  r.stdin.type("\x1b[B");
  r.stdout.accepts = true;
  r.stdin.type("\x1b[B"); r.stdin.type("\x1b[B"); await settle();
  r.stdout.emit("drain"); await settle();
  assert.equal(above(), start + 6, "three reads while blocked: three rows more");
  r.stdin.type("q");
  assert.equal(await r.status, 0);
});

test("a paste of n, a soul's name and two Enters in one read opens the picker and spawns nothing: no preview is read, nothing submitted", async () => {
  const r = await started();
  r.reader.answer(ENTRY);
  r.stdin.type("nexpert\r\r"); await settle();
  assert.deepEqual([r.spawn.reads.length, r.spawn.submits.length], [0, 0]);
  r.soulReads[0].answer(soulsDocument(["acme-expert"])); await settle();
  assert.deepEqual([r.spawn.reads.length, r.spawn.submits.length], [0, 0]);
});

test("the apply is a change of the run, labelled for the line after leaving; its deadline goes to changeExec as given; held previews go before an apply and when a pending one settles, which reads the rows again", async () => {
  const r = await previewing();
  r.stdin.type("\r"); await settle();
  const child = r.spawn.applyExec("/opt/oats/bin/oats.mjs", ["spawn", "--apply"], { detached: true, timeout: 70000, cwd: "/srv/deploy" }, () => {});
  const [change] = r.reader.changed;
  assert.deepEqual([change.options.label, change.options.timeout, change.options.detached, child.pid], [{ verb: "spawn", name: "acme-expert-2" }, 70000, undefined, 4001]);
  assert.throws(() => r.spawn.applyExec("/opt/oats/bin/oats.mjs", ["spawn", "--result"], { cwd: "/srv/deploy" }, () => {}), /starts nothing/, "anything else is a read");
  const before = r.log.length;
  await r.spawn.request({ action: "prepare" }, { address: DEPLOYMENT });
  assert.deepEqual(r.log.slice(before).filter(([what]) => what === "spawn"), [], "a prepare forgets nothing");
  await r.spawn.request({ action: "apply", spawnRef: "a".repeat(64) }, { address: DEPLOYMENT });
  assert.deepEqual(r.log.slice(before).filter(([what]) => what === "spawn"), [["spawn", "invalidate", DEPLOYMENT]]);
  const apply = r.spawn.applyCalls.at(-1);
  assert.equal(apply.context.workspace.id, DEPLOYMENT, "admitted against the job's workspace as it is now");
  const asked = readerDid(r).filter(([what]) => what === "request").length;
  apply.settled();
  assert.deepEqual(r.log.filter(([what]) => what === "spawn").at(-1), ["spawn", "invalidate", DEPLOYMENT]);
  assert.equal(readerDid(r).filter(([what]) => what === "request").length, asked + 1);
});

test("Spawn is armed by the frame that shows the ready preview, not by the answer: while the output is blocked an answer that landed spawns nothing, and once it is drawn an Enter of a later read does", async () => {
  const r = await started();
  r.reader.answer(ENTRY);
  r.stdin.type("n"); await settle();
  r.soulReads[0].answer(soulsDocument(["acme-expert"])); await settle();
  for (const ch of "expert") r.stdin.type(ch);
  // The terminal stops taking frames: the one that says the preview is read blocks the next. The
  // answer lands meanwhile, and no frame shows it.
  r.stdout.accepts = false;
  r.stdin.type("\r"); await settle();
  assert.match(textOf(r.stdout.take()), /Reading the preview/);
  r.stdout.accepts = true;
  r.spawn.reads.at(-1).answer({ spawnPreviewViewApi: 1, status: "available", target: null, data: SPAWN_DATA, reason: null }); await settle();
  assert.equal(r.stdout.take(), "", "no frame was written: the output is blocked");
  r.stdin.type("\r"); await settle();
  assert.equal(r.spawn.submits.length, 0, "an Enter on a preview not drawn spawns nothing");
  // It drains: the frame shows the preview ready, and an Enter of a later read spawns.
  r.stdout.emit("drain"); await settle();
  assert.match(textOf(r.stdout.take()), /\[ Spawn \]|> Spawn </);
  r.stdin.type("\r"); await settle();
  assert.equal(r.spawn.submits.length, 1);
});

test("quitting with a spawn under way clears the timer the shared apply arms its deadline and grace on (the boundary's applyTimer): neither then signals the spawn let go, and no timer outlives the run", async () => {
  /** A run, and a deadline armed on its applyTimer as the shared apply arms it on a worktree-event
   *  kernel (test/client-spawn-apply-timer.test.mjs pins that it does): SIGTERM at 60 s, then the
   *  grace's SIGKILL 20 s later. */
  async function applying() {
    const r = await started();
    r.reader.answer(ENTRY); await settle();
    const signals = [];
    r.spawn.applyTimer(() => { signals.push("SIGTERM"); r.spawn.applyTimer(() => signals.push("SIGKILL"), 20000); }, 60000);
    assert.equal(r.timers.delays().includes(60000), true, "the deadline is on the run's timers");
    return { r, signals };
  }
  // Quit before the deadline: it goes with the run.
  const a = await applying();
  a.r.stdin.type("q");
  assert.equal(await a.r.status, 0);
  assert.equal(a.r.timers.delays().includes(60000), false, "the deadline went with the run");
  a.r.timers.fire();
  assert.deepEqual(a.signals, [], "a TUI that has gone signals no spawn");
  // The deadline passes while the run goes on: SIGTERM; quit in the grace, and SIGKILL never comes.
  const b = await applying();
  b.r.timers.fire();
  assert.deepEqual(b.signals, ["SIGTERM"]);
  assert.equal(b.r.timers.delays().includes(20000), true, "the grace is armed");
  b.r.stdin.type("q");
  assert.equal(await b.r.status, 0);
  b.r.timers.fire();
  assert.deepEqual(b.signals, ["SIGTERM"], "no SIGKILL after the TUI has gone");
  assert.equal(b.r.timers.count, 0, "no timer outlives the run");
});

test("the transaction's polls and the boundary's wait for an answer are on the run's timers too, and end with it", async () => {
  const r = await started();
  r.reader.answer(ENTRY); await settle();
  let slept = false, waited = false;
  void r.spawn.sleep(5000).then(() => { slept = true; });
  r.spawn.answerTimer(() => { waited = true; }, 50000);
  assert.deepEqual([r.timers.delays().includes(5000), r.timers.delays().includes(50000)], [true, true]);
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  r.timers.fire(); await settle();
  assert.deepEqual([slept, waited, r.timers.count], [false, false, 0]);
});

test("a workspace whose catalog key moved forgets the previews held for it", async () => {
  const r = await started();
  r.reader.answer(ENTRY);
  r.stdin.type("n"); await settle();
  r.reader.answer(ENTRY); await settle();
  assert.equal(r.log.some(([what, how]) => what === "spawn" && how === "invalidate"), false, "the workspace as it was");
  r.reader.answer(atCommit(ENTRY, "b2")); await settle();
  assert.deepEqual(r.log.filter(([what]) => what === "spawn"), [["spawn", "invalidate", DEPLOYMENT]]);
});

test("an outcome not known offers C, which checks the submitted job once; quitting with a spawn under way lets it go, its call's owner gone, and the line after leaving names it with `oats status`", async () => {
  const r = await previewing();
  r.stdin.type("\r"); await settle();
  const [submit] = r.spawn.submits, job = { address: DEPLOYMENT, spawnRef: "b".repeat(64) };
  submit.call.progress("submitted", job);
  submit.answer({ kind: "unknown", view: null, reason: { code: "E_OUTCOME_UNKNOWN" }, job }); await settle();
  // Read by a redraw that is no key: screenOf's Ctrl+L is a key bound to an action, which puts the line away.
  assert.match(sidebarOf(r), /Press C to check before spawning again\./);
  r.stdin.type("C"); await settle();
  assert.deepEqual([r.spawn.checks.length, r.spawn.checks[0].job], [1, job]);
  assert.match(screenOf(r), /Checking the spawn of acme-expert-2…/);
  r.reader.running = [{ label: { verb: "spawn", name: "acme-expert-2" } }];
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  assert.equal(r.spawn.checks[0].call.alive(), false, "nothing is reported to a TUI that has gone");
});

test("the line after leaving names a spawn still running", async () => {
  const r = await started({ tellable: () => true });
  r.reader.answer(ENTRY);
  r.reader.running = [{ label: { verb: "spawn", name: "acme-expert-2" } }];
  r.stdin.type("q");
  assert.equal(await r.status, 0);
  assert.deepEqual(r.errors, ["oats: the spawn of acme-expert-2 is still running; `oats status` shows its result.\n"]);
});
