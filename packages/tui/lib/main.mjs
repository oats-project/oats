// `oats tui` (preview): the loop. Events from the keyboard and from the reader go through one
// pure reduce(state, event); what only the loop can do comes back as an effect; the frame is
// drawn from the state. This version shows a workspace's instances, on this machine and on the
// machines registered here, follows them, opens agents' terminals as tabs of a panel beside the
// list (up to four, each the kernel's own viewer in a pane of the run's private tmux server:
// lib/panel.mjs; `viewers` maps each tab's instance to its window), in one group or two (a split;
// after every frame `fitPanel` tells the panel which windows the frame's regions display, at what
// size, and which has the keys), stops,
// starts, restarts and retires an instance after a confirmation, through the shared lifecycle
// boundary and start rule, and spawns an agent on this machine from the shared preview and apply
// (docs/tui.md).
import { homedir } from "node:os";
import { resolve } from "node:path";
import { bindings } from "./actions.mjs";
import { TERMS, capabilityCatalogKey, cliDeploymentList, deploymentsListSupported, createCapabilityCatalog, createLifecycleBoundary, createLifecycleConfirmation, createRetiresInFlight, createSoulCatalog, createSpawnApplyBoundary, createSpawnPreview, createSpawnTransaction, createResumeTrigger, displayLine, heldHome, pendingEntry, prepareRemoteTerm, runResumeSweep, sessionAttachArgv, soulCatalogKey, startInstance, pinInstance } from "./client.mjs";
import { loadConfig, loadKeys } from "./config.mjs";
import { ACT_WORDS, LIST_WORDS, actContext, actCwd, listRowsOf, localDeployments, model, outcomeOf, reachedMachines, resumeObservation, roster, spawnContext } from "./model.mjs";
import { createPanel, sweep } from "./panel.mjs";
import { CHANGE_FILES, admitDeployment, createIdentityReads, createReader, findDeployment, leaveInstance, probeKernel, realpath, startExec, tellable } from "./read.mjs";
import { initialState, reduce } from "./store.mjs";
import { captureRows } from "./term/capture.mjs";
import { createKeyParser, keyId } from "./term/keys.mjs";
import { confirmed } from "./term/kitty.mjs";
import { createScreen, glyphs } from "./term/screen.mjs";
import { colorEnabled } from "./term/style.mjs";
import { backKeySequences, createThrough } from "./term/through.mjs";
import { createGuard, isTerminal } from "./term/tty.mjs";
import { frame, layout, mainArea, panelPlace } from "./views/frame.mjs";

export const USAGE = "oats tui [--dir <path>] [--ascii]";
const HELP = `Usage:
  ${USAGE}

The OATS terminal client (preview): a full-screen view of a workspace's instances,
on this machine and on the machines registered here. It follows them, opens
agents' terminals beside the list with Enter, as tabs, stops, retires, starts or
restarts an instance (X, D, S, R) after a confirmation, and spawns an agent
on this machine (n, or N for another of the selected one's soul).
Keys: ? help, Enter open, w workspaces, q quit.
docs/tui.md has the rest.

  --dir <path>   the deployment, or a directory inside one (default: where you are)
  --ascii        draw rules and marks in ASCII, whatever the locale
`;
export const NO_TERMINAL = "oats: `oats tui` needs a terminal on stdin and stdout (E_NO_TERMINAL); `oats status` prints the instances once";
/** A path is echoed only when it is plain: these lines go to a terminal. */
const plainPath = (path) => (typeof path === "string" && /^[\x20-\x7e]{1,200}$/.test(path) ? path : "that directory");
export const noDeployment = (dir) => `oats: no OATS deployment at or above ${plainPath(dir)} (E_NO_DEPLOYMENT); name one with \`oats tui --dir <path>\``;
/** A start outside every deployment, with no `--dir`, when this computer's deployments list holds none (awebai/oats#1390). */
export const noDeploymentListed = (dir) => `oats: no deployment at or above ${plainPath(dir)}, and this computer's list of deployments holds none (E_NO_DEPLOYMENT): \`oats tui --dir <path>\` opens one (and lists it), \`oats onboard <dir> --workspace <ref>\` creates one`;
/** The same start, when the list could not be read: the kernel's code and its message, which says what to do. */
export const noList = (reason) => `oats: \`oats tui\` could not read this computer's list of deployments (${/^E_[A-Z0-9_]{1,62}$/.test(reason?.code ?? "") ? reason.code : NOT_ASKED.code}): ${displayLine(reason?.message) ?? "it gave no reason"}`;
export const noKernel = (reason) => `oats: \`oats tui\` could not use its own kernel (E_TUI_KERNEL): ${displayLine(reason) ?? "it gave no reason"}`;

/** The arguments: `--ascii`, `--help`/`-h`, `--dir <path>` and `--dir=<path>`. Everything else is
 *  refused, `--server` included: a run names no machine, it reads every one registered here. */
export function parseArgs(argv) {
  const options = { ascii: false, help: false, dir: null };
  // The argument is echoed only when it is plain: this line goes to a terminal.
  const refused = (arg) => ({ error: `oats: \`oats tui\` takes no argument ${/^[\x21-\x7e]{1,40}$/.test(arg) ? arg : "like that one"} (E_BAD_ARGS); usage: ${USAGE}` });
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ascii") options.ascii = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dir" && typeof argv[i + 1] === "string" && argv[i + 1] !== "") options.dir = argv[++i];
    else if (arg.startsWith("--dir=") && arg.length > "--dir=".length) options.dir = arg.slice("--dir=".length);
    else if (arg === "--dir" || arg === "--dir=") return { error: `oats: \`oats tui --dir\` takes a path (E_BAD_ARGS); usage: ${USAGE}` };
    else return refused(arg);
  }
  return { options };
}

/** The label of a change to this computer's deployments list (an add or a remove), for the line after leaving. */
const LIST_CHANGE = Object.freeze({ verb: "list" });
/** The label of the kernel's machine sweep (`oats session resume --json`), every one the run starts: a
 *  change, never signalled, and never named after leaving (the TUI says nothing of a sweep). */
const RESUME_CHANGE = Object.freeze({ verb: "resume" });
/** Why a call to this computer's deployments list has no answer at all: it threw before the kernel
 *  could answer. The shared adapter's own code for a kernel call that failed (deployment-list-cli.mjs). */
const NOT_ASKED = Object.freeze({ code: "E_CLI_FAILED", message: "the kernel could not be asked" });

/** An error as lines fit for a terminal: its stack, each line through the display filter. */
function errorLines(error) {
  const text = error instanceof Error ? error.stack || error.message : String(error);
  return String(text).split("\n", 12).map((line) => displayLine(line)).filter(Boolean);
}

/** What the loop does outside the terminal, each replaceable by a test. `realpath` is the one the
 *  shared start rule checks a local home with; `startInstance` and `createLifecycleConfirmation`
 *  are the shared home's, replaceable so a test can drive the loop's wiring. `runDir` makes the
 *  run's private directory (the reader's change output and the panel's tmux server share it), and
 *  `removeDir` removes it on the way out once both have removed their files; `sweep` removes what
 *  runs that are gone left of theirs (lib/panel.mjs). `createSoulCatalog` is the shared home's
 *  catalog of a workspace's souls, and `createCapabilityCatalog` its table of capabilities, each
 *  replaceable so a test can count its reads; the three spawn
 *  factories are the shared home's preview, apply boundary and transaction, replaceable so a test
 *  can answer them. `deploymentList` is the shared cliDeploymentList (this computer's deployments
 *  list, through the kernel: awebai/oats#1390), and `startExec` the exec it is handed before the
 *  terminal is taken; replaceable so a test can answer the list. `loadKeys` reads keys.json, the
 *  chord family (lib/config.mjs), replaceable so no test reads a user's file. `createResumeTrigger`
 *  is the shared trigger of the kernel's machine sweep (packages/client session-resume-trigger.mjs). */
const EFFECTS = Object.freeze({ loadConfig, loadKeys, findDeployment, probeKernel, createReader, createIdentityReads, deploymentList: cliDeploymentList, startExec, admitDeployment, prepareRemoteTerm, createPanel, sweep,
  runDir: CHANGE_FILES.dir, removeDir: CHANGE_FILES.remove, realpath, tellable, startInstance, pinInstance, createLifecycleConfirmation, createLifecycleBoundary, createSoulCatalog,
  createCapabilityCatalog, createSpawnPreview, createSpawnApplyBoundary, createSpawnTransaction, createResumeTrigger });

/** The timers a run lends the shared spawn: the apply's deadline and its grace (the boundary's
 *  `applyTimer`), the boundary's wait for an answer (`timer`) and the transaction's polls
 *  (`sleep`). They are the run's: `end()`, as the run ends, clears every one still armed, so a
 *  TUI that has gone neither signals a spawn it let go nor is kept alive by one: the spawn
 *  finishes, or the kernel's own limits bound it (Spec 6-spawn, Settled 4). `timer(fn, ms)`
 *  returns its cancel, as the shared home's timers do. */
export function createRunTimers({ setTimer, clearTimer }) {
  const armed = new Set();
  let over = false;
  function timer(fn, ms) {
    if (over) return () => {};
    const handle = setTimer(() => { armed.delete(handle); if (!over) fn(); }, ms);
    armed.add(handle);
    return () => { if (armed.delete(handle)) clearTimer(handle); };
  }
  return {
    timer,
    sleep: (ms) => new Promise((resolve) => { timer(resolve, ms); }),
    end() { over = true; for (const handle of armed) clearTimer(handle); armed.clear(); },
  };
}

/** Run. Resolves with the exit status; never calls process.exit, so what was written drains.
 *  Before the alternate screen, in this order, each failure one line on stderr and status 1:
 *  the arguments; the instance variables removed from the environment (a TUI started in an
 *  agent's pane must read the deployment it was asked about, and so must every child it starts);
 *  the terminal; the user's tui.json; the deployment; the kernel it shipped with; and, for a start
 *  outside every deployment with no `--dir`, this computer's deployments list, read through that
 *  kernel. */
/** How long a run waits for the terminal's answer to the kitty keyboard protocol's query, in
 *  milliseconds, before it pops the protocol and reads keys as before for the rest of the run
 *  (docs/tui.md, "Chords"). A terminal answers as it reads the query, before any key typed after
 *  it, so the wait only bounds a terminal that never answers; it is long enough for a slow link. */
export const KEYBOARD_WAIT_MS = 2000;

/** `keyboard`: whether the run asks the terminal for the kitty keyboard protocol (term/tty.mjs PUSH,
 *  QUERY). Every run does; a test of a terminal that is never asked passes false. */
export async function main({ argv, stdin, stdout, stderr, env, proc = process, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, cwd = () => process.cwd(), home = homedir(), keyboard = true, effects: given = EFFECTS }) {
  const effects = given === EFFECTS ? EFFECTS : { ...EFFECTS, ...given };
  const { options, error } = parseArgs(argv);
  if (error) { stderr.write(`${error}\n`); return 1; }
  if (options.help) { stdout.write(HELP); return 0; }
  leaveInstance(env);
  if (!isTerminal({ stdin, stdout, env })) { stderr.write(`${NO_TERMINAL}\n`); return 1; }
  const config = effects.loadConfig({ env, home, platform: proc.platform });
  if (!config.ok) { stderr.write(config.lines.map((line) => `${line}\n`).join("")); return 1; }
  // keys.json, the chord family (docs/tui.md, "Switch family"): read once, here, and never
  // a reason not to start: what is wrong with it is the default, and the help says why.
  const keysRead = effects.loadKeys({ env, home });
  const found = effects.findDeployment(resolve(cwd(), options.dir ?? "."));
  // A `--dir` that is in no deployment is refused as it is: what was asked for is not there.
  if (!found.ok && options.dir !== null) { stderr.write(`${noDeployment(found.dir)}\n`); return 1; }
  // The kernel is asked once: an upgrade under a running TUI is met by starting it again.
  const probe = await effects.probeKernel({ env });
  if (!probe.ok) { stderr.write(`${noKernel(probe.reason)}\n`); return 1; }
  // Outside every deployment, and with none named: the switcher, when this computer's deployments
  // list holds a row, read through the kernel just asked. A list that cannot be read is no empty one.
  let listedAtStart = null;
  if (!found.ok) {
    const listed = await effects.deploymentList(probe.cli, { action: "list" }, { exec: effects.startExec, env });
    if (!listed.ok) { stderr.write(`${noList(listed.reason)}\n`); return 1; }
    if (!listed.value.rows.length) { stderr.write(`${noDeploymentListed(found.dir)}\n`); return 1; }
    listedAtStart = listed.value.rows;
  }

  const clock = () => new Date(now()).toISOString();
  const look = glyphs(env, { ascii: options.ascii || config.ascii });
  const screen = createScreen({ ...look, color: colorEnabled(env) });
  let state = initialState({ deployment: found.ok ? found.deployment : null, cli: probe.cli, home, entry: found.ok ? pendingEntry(null, clock()) : null, actions: config.actions, ascii: look.ascii, colour: colorEnabled(env), platform: proc.platform, detachKey: config.detachKey, keysRead });
  const keymap = bindings(state.actions);
  // THE KITTY KEYBOARD PROTOCOL (docs/tui.md, "Chords"): asked for as the terminal is taken (the
  // guard's PUSH and QUERY), "asking" until it answers or KEYBOARD_WAIT_MS passes, then the flags
  // it confirmed (flag 1 held), or null for the rest of the run. The key parser and the scanner
  // below are made with it, and each reads the answer itself when it comes through it.
  let kb = keyboard ? "asking" : null, kbTimer = null;
  /** The clock time the wait for the answer ends: what may begin it is held up to then. */
  const answerBy = keyboard ? now() + KEYBOARD_WAIT_MS : null;
  const newParser = () => createKeyParser({ now, keyboard: kb, chords: state.chords, leader: state.leaderKey, answerBy });
  let parser = newParser();
  // While a terminal has the focus the bytes typed go to the agent: this scanner takes from them
  // only the back key, the chords and a bracketed paste (term/through.mjs). A new one each time the
  // terminal takes the focus, so nothing held from before is typed into it.
  const backKey = backKeySequences(state.detachKey);
  const newThrough = () => createThrough({ sequences: backKey, now, keyboard: kb, leader: state.leaderKey, chords: state.chords, answerBy });
  let through = newThrough(), throughTimer = null;
  if (listedAtStart) state = reduce(state, { listed: { rows: listedAtStart } }, keymap).state;
  // What the last frame drew, for the store: how tall the list pane is and how far the other
  // pane scrolls. The store holds no size of its own; the panel's room goes with each key as it
  // is when the key is read (placed), whatever the last frame drew.
  let drawn = { page: 1, extent: 0, room: 1, cols: 1, area: 1 };
  let full = true, escTimer = null, ended = false, reads = 0;
  /** The preflight of another machine's agent under way: `{ id, controller, prepared }`, where
   *  `prepared` is what it answered (`{ binary, args }`) once it has; or null. */
  let preflight = null;
  /** The run's private directory, made at the first change (with a kernel that lists this
   *  computer's deployments, the add of the deployment the run started in, at the start) or the
   *  first open (lib/read.mjs
   *  CHANGE_FILES): the reader writes a change's output there, and the panel keeps its tmux
   *  server's socket there. */
  let dir = null;
  const runDir = () => (dir ??= effects.runDir());

  // THIS RUN'S RETIRES IN FLIGHT (#1247, packages/client retire-in-flight.mjs): a row whose retire
  // this run sent reads Retiring… from the send, before any read says so, until its answer is in
  // and a read begun after that answer covers the row; a refused or stale answer lets it go at once.
  // The mark is the reader's count of cycles begun (lib/read.mjs `begun`), never the clock: the
  // live read a settled answer asks for begins in the same millisecond. The store holds the ids.
  const retires = createRetiresInFlight({ mark: () => reader.begun(), onChange: () => heard({ retiring: retires.ids() }) });
  /** The cycle that began the roster read in flight: lib/read.mjs says `collecting` as it begins one. */
  let rosterBegun = 0;
  /** A served deployment's entry: taken, then, when it is a read the store took (its cycle is the
   *  newest of that deployment), it covers that deployment's rows of this machine. A failed read
   *  covers nothing, whatever entry it kept. */
  function entered(event) {
    heard(event);
    if (event.read !== true || state.numbers.get(event.id) !== event.number) return;
    retires.landed(event.number, (t) => !t.server && t.workspace === event.id);
    // The rows of the view that holds it, with its deployments of this machine: a lost row of one of those
    // sweeps again; another machine's row never does (the shared trigger's locality).
    if (ended) return;
    const { rows, localDeploymentIds } = resumeObservation(state, event.id, clock());
    resume.observed(rows, { localDeploymentIds });
  }
  /** An event of the roster read: taken, then an outcome covers the rows of each machine it reached
   *  (a read that failed marks every machine not reached, and covers none). */
  function rostered(event) {
    if (event.collecting === true) rosterBegun = reader.begun();
    heard(event);
    if (event.roster === undefined || ended) return;
    const reached = reachedMachines(state, clock());
    if (reached.size) retires.landed(rosterBegun, (t) => !!t.server && reached.has(t.workspace));
  }
  // What the reader reads for, it asks of the state at that moment: the served deployments, the
  // entry a failed read keeps, and the roster and the memory the next outcome is made from.
  const reader = effects.createReader({
    cli: probe.cli, env, clock, now,
    getServed: () => state.ctxs,
    getEntry: (id) => state.entries.get(id) ?? null,
    getRoster: () => ({ remote: state.remote, memory: state.memory, notes: state.notes }),
    onEntry: entered, onRoster: rostered,
    files: { ...CHANGE_FILES, dir: runDir },
  });
  // LOST SESSIONS RESUMED (docs/tui.md, "Resuming lost sessions"; #1559): the kernel's machine sweep,
  // `oats session resume --json`, which resumes every lost session of every local deployment of this
  // computer. The shared trigger decides when: once the run has started (`launch`, after the add of the
  // deployment it started in has settled, so the sweep's registry holds it), then whenever a read of a
  // served deployment shows a row of a deployment of this machine whose session was lost (`observed`,
  // given the view's rows and its local deployment ids: lib/model.mjs resumeObservation), never two at
  // a time nor more often than its floor, and only with a kernel that has the sweep. The TUI decides nothing of what
  // resumes. The sweep is a change of the run (the reader's changeExec: detached, its output in files,
  // never signalled), which outlives the TUI and is let go in silence on the way out; what it read goes
  // to the store as `{ resumed }`, which says nothing of it and at most reads the rows live.
  const resume = effects.createResumeTrigger({
    cli: () => probe.cli,
    run: (cli) => runResumeSweep(cli, { exec: (bin, argv, options, callback) => reader.changeExec(bin, argv, { ...options, label: RESUME_CHANGE }, callback), env }),
    now,
    onReading: (reading) => heard({ resumed: reading }),
  });
  // THE TABS AND THE SPLIT (docs/tui.md, "Tabs", "Splits"): the terminals open in the panel, at
  // most the store's TAB_LIMIT across its groups. `viewers` maps each tab's instanceId to its
  // viewer, `{ id, panel, cols, rows }` (the panel's own id once the window exists, null before,
  // and the size its window was last given); the store holds their groups, their order and which
  // are shown, and after every frame the panel is brought to what the frame drew (fitPanel): the
  // tabs it displays (each group's shown one, as the frame has room for), the one that takes the
  // keys (the focused group's), and each group's size for every tab of it. `screens` is each
  // displayed tab's last capture (`{ lines, cursor }`), drawn until the next; `displayed`, `keysTo`
  // and `panelShown` what the panel was last told.
  const viewers = new Map(), screens = new Map(), displayed = new Set();
  let keysTo = null, panelShown = true;
  const viewerOf = (panelId) => [...viewers.values()].find((each) => each.panel === panelId) ?? null;
  const panel = effects.createPanel({
    dir: runDir, env, capture: captureRows,
    onScreen: ({ id, screen: lines, cursor }) => { const v = viewerOf(id); if (!ended && v !== null && displayed.has(id)) { screens.set(v.id, { lines, cursor }); guard.attempt(() => guard.draw()); } },
    // A hidden tab's agent wrote: its mark.
    onActivity: ({ id }) => { const v = viewerOf(id); if (!ended && v !== null) heard({ activity: { id: v.id } }); },
    // A viewer ended. The store is told, whatever ended it; a tab the person closed is no longer
    // in `viewers`, and the store says nothing of it.
    onClosed: ({ id, status = null, stderr = "", asked = false }) => {
      const v = viewerOf(id);
      if (v === null) return;
      forgetViewer(v);
      heard({ returned: { id: v.id, status, stderr, asked } });
    },
  });
  // THE ACTS (docs/tui.md, "Stopping, starting, restarting and retiring"). One lifecycle boundary
  // per run: its plans, its kept answers and its one apply at a time are this run's. Its exec runs
  // a plan read as a read the loop asked for (kind "read", ended on every way out) and an apply
  // (`detached: true`, cliLifecycle's own mark of a change) as a change, which the TUI never ends.
  // `applying` is the label of the apply this run's confirmation just sent: only one confirmation
  // is open at a time, and the boundary calls its exec in the same turn as the request.
  let applying = null;
  const boundary = effects.createLifecycleBoundary({ terms: TERMS, exec: (bin, argv, { detached, ...options }, callback) => (detached
    ? reader.changeExec(bin, argv, { ...options, label: applying }, callback)
    : reader.exec(bin, argv, options, callback)) });
  /** The confirmation open now: `{ n, made }`, `made` the shared confirmation; or null. */
  let confirmation = null;

  // THE SOULS (docs/tui.md, "The Souls view"): one catalog per run, the shared home's, over the
  // reader's exec: its `oats souls` is a read like any other (kind "read", the reader's time limit,
  // ended on every way out). It is settled for the open workspace with that workspace's own
  // `workspace status`, so it is read only when nothing is held for the workspace as it is now
  // (the shared key), and never before the Souls view was first shown.
  const souls = effects.createSoulCatalog({ terms: TERMS, exec: reader.exec });
  /** The catalog of workspace `id` settled now, and the store told what is held and whether a read
   *  is in flight; once that read lands, told again. Nothing for a workspace not read yet: its
   *  first observed entry settles it. */
  function settleSouls(id) {
    const deployment = state.entries.get(id)?.deployment;
    if (ended || deployment?.status !== "observed") return;
    // The workspace moved (its catalog's key): what the spawn preview holds of it goes too (Settled 7).
    const key = soulsKeyNow(id);
    if (catalogKeys.has(id) && catalogKeys.get(id) !== key) { try { preview.cache.invalidate(id); } catch { /* never blocks a read */ } }
    catalogKeys.set(id, key);
    let settled;
    try { settled = souls.settle(id, probe.cli, deployment.workspaceStatus); } catch { return; } // the reader has stopped
    const { entry, pending } = settled;
    heard({ souls: { id, entry, reading: pending !== null } });
    // A read lands with its own entry, even one a newer key has since replaced (the shared
    // catalog keeps its held entry from it): only the read of the workspace as it is now is told.
    if (pending) pending.then((landed) => { if (landed?.key === soulsKeyNow(id)) heard({ souls: { id, entry: landed, reading: souls.refreshing(id) } }); }, () => {});
  }
  /** The catalog's key for the workspace as the loop holds it now, or null when it is not observed. */
  function soulsKeyNow(id) {
    const deployment = state.entries.get(id)?.deployment;
    return deployment?.status === "observed" ? soulCatalogKey(probe.cli, deployment.workspaceStatus) : null;
  }
  /** `r` in the Souls view, as `r` in the Capabilities view: one live read, never a second while one
   *  is in flight. What is held stays held beside it (the shared catalog's refresh), so a read that
   *  fails keeps the last good souls under the failure, as a failed read of the workspace's moved key
   *  does. */
  function rereadSouls(id) {
    const deployment = state.entries.get(id)?.deployment;
    if (ended || deployment?.status !== "observed" || souls.refreshing(id)) return;
    let pending;
    try { pending = souls.refresh(id, probe.cli, deployment.workspaceStatus); } catch { return; } // the reader has stopped
    heard({ souls: { id, entry: souls.held(id), reading: true } });
    pending.then((landed) => { if (landed?.key === soulsKeyNow(id)) heard({ souls: { id, entry: landed, reading: souls.refreshing(id) } }); }, () => {});
  }

  // THE CAPABILITIES (docs/tui.md, "The Capabilities view"; Spec 7): as the souls, one table per run,
  // the shared home's, over the reader's exec (its `oats capabilities` a read of kind "read", ended on
  // every way out), settled for the open workspace with its own `workspace status`, so read only when
  // nothing is held for the workspace as it is now (capabilityCatalogKey), and never before the
  // Capabilities view was first shown. Its "Used by" reads the souls catalog above, settled with it.
  const capabilities = effects.createCapabilityCatalog({ terms: TERMS, exec: reader.exec });
  /** The table of workspace `id` settled now, and the store told what is held and whether a read is
   *  in flight; once that read lands, told again, when it is of the workspace as it is now. */
  function settleCapabilities(id) {
    const deployment = state.entries.get(id)?.deployment;
    if (ended || deployment?.status !== "observed") return;
    let settled;
    try { settled = capabilities.settle(id, probe.cli, deployment.workspaceStatus); } catch { return; } // the reader has stopped
    const { entry, pending } = settled;
    heard({ capabilities: { id, entry, reading: pending !== null } });
    if (pending) pending.then((landed) => { if (landed?.key === capabilitiesKeyNow(id)) heard({ capabilities: { id, entry: landed, reading: capabilities.refreshing(id) } }); }, () => {});
  }
  /** The table's key for the workspace as the loop holds it now, or null when it is not observed. */
  function capabilitiesKeyNow(id) {
    const deployment = state.entries.get(id)?.deployment;
    return deployment?.status === "observed" ? capabilityCatalogKey(probe.cli, deployment.workspaceStatus) : null;
  }
  /** `r` in the Capabilities view: one live read, never a second while one is in flight. What is
   *  held stays held beside it (the shared catalog's refresh), so a read that fails keeps the last
   *  good table under the failure, as a failed read of the workspace's moved key does. */
  function rereadCapabilities(id) {
    const deployment = state.entries.get(id)?.deployment;
    if (ended || deployment?.status !== "observed" || capabilities.refreshing(id)) return;
    let pending;
    try { pending = capabilities.read(id, probe.cli, deployment.workspaceStatus, { refresh: true }); } catch { return; } // the reader has stopped
    heard({ capabilities: { id, entry: capabilities.held(id), reading: true } });
    pending.then((landed) => { if (landed?.key === capabilitiesKeyNow(id)) heard({ capabilities: { id, entry: landed, reading: capabilities.refreshing(id) } }); }, () => {});
  }

  // THE SPAWN (docs/tui.md, "Spawning an agent"; Spec 6-spawn). One preview, one apply boundary and
  // one transaction per run, the shared home's. The preview's kernel reads are reads (the reader's
  // exec, ended on every way out). The apply is a change (`detached: true`, the shared apply's
  // mark), which the reader never ends on its own: on a kernel without worktree-event it honours
  // the deadline the shared apply gives it (lib/read.mjs changeExec); on one with it, the shared
  // boundary ends it at its deadline through the child returned. `spawnLabel` names the spawn for
  // the line after leaving (one at a time); `job` is the transaction's record of the last spawn,
  // kept for a check (C) in this run only: the TUI keeps nothing on disk. `catalogKeys`: the key
  // each workspace's catalog was last settled at, to tell when the workspace moved. Every timer
  // the shared spawn arms is the run's (`spawnTimers`), cleared as the run ends: a spawn let go is
  // never signalled after the TUI has gone, on any kernel.
  const spawnTimers = createRunTimers({ setTimer, clearTimer });
  const preview = effects.createSpawnPreview({ exec: reader.exec });
  let spawnLabel = null, job = null;
  const catalogKeys = new Map();
  const spawnApply = effects.createSpawnApplyBoundary({ read: preview.prepareRead, exec: (bin, argv, { detached, ...options }, callback) => (detached
    ? reader.changeExec(bin, argv, { ...options, label: spawnLabel }, callback)
    : reader.exec(bin, argv, options, callback)),
  timer: spawnTimers.timer, applyTimer: spawnTimers.timer });
  /** As the Desktop's (server/oats-web.mjs): a spawn in the air changes what a preview answers, so
   *  held previews go when it is applied, and again when a pending apply settles, with a read. */
  const forgetPreviews = (id) => { try { preview.cache.invalidate(id); } catch { /* never blocks a spawn */ } };
  const transaction = effects.createSpawnTransaction({ request: (body, tx) => {
    if (body?.action === "apply") forgetPreviews(tx.address);
    return spawnApply(body, () => spawnContext(state, tx.address, clock()), { settled: () => { forgetPreviews(tx.address); refresh({ live: true }); } });
  }, sleep: spawnTimers.sleep });
  /** What a spawn's call is told: its owner is gone once the TUI leaves (`alive`), and the job is
   *  kept once it is submitted, for a check. */
  const spawnCall = { alive: () => !ended, progress: (event, made) => { if (event === "submitted") { job = made; heard({ spawnProgress: { event } }); } } };
  /** A transaction's outcome as the store takes it: the shared one, with the instance it names. */
  const spawnTold = (outcome) => {
    const receipt = outcome.view?.receipt ?? null, prepared = outcome.view?.preview ?? null;
    return { kind: outcome.kind, view: outcome.view, reason: outcome.reason, instance: receipt?.instance ?? prepared?.instance ?? null, home: receipt?.home ?? prepared?.home ?? null };
  };
  /** A call that threw instead of answering: what it did is not known. */
  const UNKNOWN = Object.freeze({ kind: "unknown", reason: Object.freeze({ code: "E_OUTCOME_UNKNOWN" }) });
  /** The preview the store asked for (`{ n, workspace, request }`), read against the workspace as
   *  it is at that moment; its answer goes to the store. It arms Spawn only once a frame that
   *  shows it is written (the guard's `frame`). */
  function previewRead({ n, workspace, request }) {
    Promise.resolve()
      .then(() => preview.read(request, () => spawnContext(state, workspace, clock())))
      .then((answer) => heard({ spawnRead: { n, answer } }), () => heard({ spawnRead: { n, answer: null } }));
  }
  /** The spawn the store decided on: submitted once; its outcome goes to the store. */
  function spawnNow({ workspace, selector, input, decision, name }) {
    spawnLabel = { verb: "spawn", name };
    job = null;
    Promise.resolve()
      .then(() => transaction.submit({ address: workspace, selector, input, decision }, spawnCall))
      .then((outcome) => { if (outcome) heard({ spawnDone: spawnTold(outcome) }); }, () => heard({ spawnDone: UNKNOWN }));
  }
  /** C: the last spawn's result read once (an unknown one applies the same reference again). */
  function checkSpawn() {
    const mine = job;
    if (mine === null) return void heard({ spawnDone: UNKNOWN });
    Promise.resolve()
      .then(() => transaction.check(mine, spawnCall))
      .then((outcome) => { if (outcome) heard({ spawnDone: spawnTold(outcome) }); }, () => heard({ spawnDone: UNKNOWN }));
  }

  /** What the reader gave, into the state, and the screen after it. A read of the open workspace,
   *  once the Souls view (or the Capabilities view, or a spawn) wanted its catalog, settles it, and
   *  once the Capabilities view was shown its table: each read again only when its key moved. */
  function heard(event) {
    if (ended) return;
    guard.attempt(() => {
      if (took(reduce(state, event, keymap))) return;
      if (event.entry !== undefined && event.id === state.open && state.souls.wanted) settleSouls(event.id);
      if (event.entry !== undefined && event.id === state.open && state.capabilities.wanted) settleCapabilities(event.id);
      guard.draw();
    });
  }
  /** One step of the reducer taken: the state, then what only the loop can do. True once the
   *  TUI is leaving. Asking whether a picked row is a deployment reads the file system
   *  (lib/read.mjs), and reading or changing this computer's deployments list asks the kernel; what
   *  each finds is an event of its own. */
  function took(step) {
    state = step.state;
    const effect = step.effect;
    if (effect === "quit") { guard.finish(0); return true; }
    if (effect === "suspend") guard.suspend();
    if (effect === "redraw") guard.reassert(); // the modes again, then the whole screen
    if (effect === null || typeof effect !== "object") return false;
    if (effect.list) readList({ identify: effect.identify === true });
    if (effect.remove) removeListed(effect.remove);
    if (effect.admit !== undefined) {
      const admitted = effects.admitDeployment(effect.admit);
      took(reduce(state, admitted.ok ? { admitted: admitted.deployment, at: clock() } : { refused: effect.admit }, keymap));
    }
    if (effect.join) {
      // Each listed deployment of the workspace picked, asked whether it is a deployment now, as a picked row is.
      const answers = effect.join.paths.map((path) => [path, effects.admitDeployment(path)]);
      const canonical = new Map(answers.filter(([, a]) => a.ok).map(([path, a]) => [path, a.deployment]));
      took(reduce(state, { joined: { admitted: [...canonical.values()], opens: effect.join.opens.map((id) => canonical.get(id) ?? id) }, at: clock() }, keymap));
    }
    if (effect.abandon) giveUpPreflight();
    // A tab shown (`show`) needs nothing here: the frame after it brings the panel to it (fitPanel).
    if (effect.close !== undefined) for (const id of effect.close) closeTerminal(id);
    if (effect.open) open(effect.open);
    if (effect.panel !== undefined) {
      const ready = preflight;
      preflight = null;
      if (ready?.id === effect.panel && ready.prepared) view(effect.panel, ready.prepared.binary, ready.prepared.args);
    }
    // The leader twice from the terminal's focus: its own bytes to the agent, as what is typed goes.
    if (effect.input) { if (keysReady()) panel.input(effect.input); }
    if (effect.dismiss !== undefined) dismiss(effect.dismiss);
    if (effect.act) openConfirmation(effect.act);
    if (effect.call) callConfirmation(effect.call);
    if (effect.start) startAct(effect.start);
    if (effect.pin) pinAct(effect.pin);
    if (effect.refresh) refresh(effect.refresh);
    if (effect.souls === "settle" && state.open !== null) settleSouls(state.open);
    if (effect.souls === "reread" && state.open !== null) rereadSouls(state.open);
    if (effect.capabilities === "settle" && state.open !== null) settleCapabilities(state.open);
    if (effect.capabilities === "reread" && state.open !== null) rereadCapabilities(state.open);
    if (effect.spawnPreview) previewRead(effect.spawnPreview);
    if (effect.spawn) spawnNow(effect.spawn);
    if (effect.spawnCheck) checkSpawn();
    return false;
  }

  // THIS COMPUTER'S DEPLOYMENTS LIST (docs/tui.md, "The switcher"; awebai/oats#1390), the kernel's,
  // through the shared cliDeploymentList. A read of it is a read (the reader's exec, ended on every
  // way out), and one runs at a time: a read asked for while one is on its way is one more, after
  // it, however many times it was asked, and the answer of the one on its way is not taken, since
  // it may be of the list as it was before what asked again (a Remove). An add or a remove is a
  // change (the reader's changeExec: never ended by the TUI, only at the adapter's own deadline),
  // labelled so the line after leaving names the list. The kernel this TUI shipped with lists
  // this computer's deployments in every release; one that does not (a checkout between the
  // kernel's change and this one) is asked nothing in the run, and its "Update oats" is not said
  // of the TUI's own kernel.
  const listing = deploymentsListSupported(probe.cli);
  /** The read on its way: `{ again }`, `again` once another was asked for meanwhile; or null. */
  let listRead = null;
  const listChange = (bin, argv, options, callback) => reader.changeExec(bin, argv, { ...options, label: LIST_CHANGE }, callback);
  /** `identify`: once the list has answered, read the identities of its rows (`identify` below). A read asked
   *  for while one is on its way keeps the wish of either. */
  function readList({ identify: wanted = false } = {}) {
    if (ended || !listing) return;
    if (listRead !== null) { listRead.again = true; listRead.identify ||= wanted; return; }
    const mine = listRead = { again: false, identify: wanted };
    Promise.resolve()
      .then(() => effects.deploymentList(probe.cli, { action: "list" }, { exec: reader.exec, env }))
      .then((answer) => (answer.ok ? { rows: answer.value.rows } : { failure: answer.reason }), () => ({ failure: NOT_ASKED }))
      .then((listed) => {
        listRead = null;
        if (mine.again) return readList({ identify: mine.identify });
        heard({ listed });
        if (mine.identify) identify();
      });
  }
  // THE IDENTITY READS (lib/read.mjs createIdentityReads; docs/tui.md, "The switcher"): the rows of this
  // computer's list that this run does not serve and that the kernel says are deployments, each read for
  // its workspace's identity, one at a time, so the switcher puts it in its workspace's row. At the start
  // and when the switcher is opened or refreshed, never on a timer; their answers come in as the screen
  // is used. A suspend gives the run up (what a stopped TUI reads is no evidence), as it does the cycles.
  const identities = effects.createIdentityReads({ cli: probe.cli, exec: reader.exec, env, onRead: (identity) => heard({ identity }) });
  function identify() {
    if (ended) return;
    identities.start(state.listed.rows.filter((row) => row.state === "ok" && !state.ctxs.includes(row.path)).map((row) => row.path));
  }
  /** Remove the row the store asked about (`{ path, name }`) from the list: nothing on disk is
   *  touched. Its answer goes to the store, which asks for the list again. */
  function removeListed({ path, name }) {
    Promise.resolve()
      .then(() => effects.deploymentList(probe.cli, { action: "remove", path }, { exec: listChange, env }))
      .then((answer) => heard({ removed: { path, name, ok: answer.ok, reason: answer.ok ? null : answer.reason } }), () => heard({ removed: { path, name, ok: false, reason: NOT_ASKED } }));
  }
  /** The deployment the run started in (from where it was started, or `--dir`), added to the list
   *  once, as the TUI's: best effort. A failure opens nothing less, and is said once, in the line
   *  under the sidebar's title. A row opened from the switcher is on the list already. Settles once
   *  the add has, whatever it answered; at once without one. */
  function listStart(path) {
    if (!listing) return Promise.resolve();
    return Promise.resolve()
      .then(() => effects.deploymentList(probe.cli, { action: "add", path, via: "tui" }, { exec: listChange, env }))
      .then((answer) => { if (!answer.ok) heard({ notListed: answer.reason }); }, () => heard({ notListed: NOT_ASKED }));
  }

  /** What the boundary admits a request of deployment `id` against, read at every admission. */
  const contextOf = (id) => actContext(state, id, clock());
  /** Open the shared confirmation of a stop or a retire the store decided on (`{ n, verb, row,
   *  label }`). Every step it tells goes to the store as `{ acted }`; an answer that settles asks
   *  for a live read of the rows (onSettled), and nothing else after an apply does. A retire's
   *  apply is held in `retires` from its send, whether or not the confirmation is still open. */
  function openConfirmation({ n, verb, row, label }) {
    dismiss(confirmation?.n);
    const id = row.deployment?.id, name = row.instance;
    const target = { workspace: id, instance: name, agent: row.agent, agentsRoot: row.agentsRoot, home: row.home, server: row.server ?? null };
    const mine = { n, made: null };
    const tell = () => { if (mine.made && confirmation === mine) heard({ acted: { n, confirmation: { ...mine.made.state(), view: mine.made.view() } } }); };
    confirmation = mine;
    mine.made = effects.createLifecycleConfirmation({
      request: (body) => { if (body?.action === "apply") applying = { verb, name }; return boundary(body, () => contextOf(id)); },
      target, operation: verb, terms: TERMS, label, leftover: heldHome(row)?.kind === "spawn-incomplete",
      onChange: tell, onSettled: () => refresh({ live: true }), retires,
    });
    tell();
  }
  /** A button pressed in the confirmation: its call, when it is still the open one. */
  function callConfirmation({ n, method, args = [] }) {
    if (confirmation?.n === n) confirmation.made[method](...args);
  }
  /** The confirmation closed: what it sent goes on, and what it answers is no longer told. */
  function dismiss(n) {
    if (confirmation === null || confirmation.n !== n) return;
    const { made } = confirmation;
    confirmation = null;
    made?.close();
  }
  /** Start or restart the row (`{ n, verb, id, row }`) through the shared start rule, once, with no
   *  launch choice. Its child is a change of this run: the store hears when it is spawned and when
   *  it closes (`starting`), and the answer, whatever it is, asks for a live read. */
  function startAct({ n, verb, id, row }) {
    const label = { verb, name: row?.instance ?? "" };
    const exec = (bin, argv, options, callback) => {
      const child = reader.changeExec(bin, argv, { ...options, label }, (...answer) => { heard({ acted: { closed: id } }); callback(...answer); });
      heard({ acted: { spawned: { id, verb }, at: now() } });
      return child;
    };
    Promise.resolve()
      .then(() => effects.startInstance(probe.cli, row, {}, { restart: verb === "restart", deployments: localDeployments(state, clock()), realpath: effects.realpath, localCwd: actCwd(state), exec, terms: TERMS, group: contextOf(row?.deployment?.id).workspace?.group }))
      .then((answer) => heard({ acted: { n, answer } }), () => heard({ acted: { n, answer: null } }));
  }
  /** Pin or unpin the row the store decided on (feature instance-pin; lib/model.mjs pinDecision): the kernel's verb,
   *  through the shared pinInstance, on this machine with `--dir` its deployment, on another routed with `--server`,
   *  as a stop is. It is a change (reader.changeExec): never ended by the TUI, and named on the way out while it
   *  runs. Its answer goes to the store as `{ pinned }`, which reads the rows again. */
  function pinAct({ id, row, pinned }) {
    const name = row.instance, workspace = contextOf(row.deployment?.id).workspace;
    const remote = !!(workspace?.remote || workspace?.server);
    const args = { instance: name, home: row.home, pinned, ...(remote ? { server: workspace?.server } : { context: workspace?.scope }) };
    const exec = (bin, argv, options, callback) => reader.changeExec(bin, argv, { ...options, label: { verb: "pin", name } }, callback);
    Promise.resolve()
      .then(() => effects.pinInstance(probe.cli.bin, args, { exec, ...(remote ? { cwd: actCwd(state) } : {}) }))
      .then((answer) => heard({ pinned: { id, name, pinned, answer } }), () => heard({ pinned: { id, name, pinned, answer: null } }));
  }

  /** Open the agent the store decided on (lib/model.mjs openDecision). On this machine the viewer
   *  starts in the panel at once. On another, the shared preflight runs first over the reader's
   *  exec (a read like any other, ended on every way out), and what it prepared waits for the
   *  store's `panel`, which comes only if the open was not given up and the row is still there.
   *  The viewer is given no key of its own: the TUI takes the back key before the pane sees it.
   *  Nor its status line, where the kernel can leave it out (--no-status-line): the cheat sheet
   *  names the scroll keys. */
  function open(decision) {
    if (!decision.routed) {
      let args;
      // A target the shared home refuses (no absolute home) starts nothing; the line after says
      // the viewer ended without saying why.
      try { args = sessionAttachArgv(probe.cli, decision.target, { statusLine: false }); } catch { return void heard({ returned: { id: decision.id, status: null, stderr: "" } }); }
      return view(decision.id, probe.cli.bin, args);
    }
    giveUpPreflight();
    const mine = preflight = { id: decision.id, controller: new AbortController(), prepared: null };
    Promise.resolve()
      .then(() => effects.prepareRemoteTerm(probe.cli, decision.target, { exec: reader.exec, signal: mine.controller.signal, statusLine: false }))
      .then((prepared) => { if (preflight === mine) { mine.prepared = prepared; heard({ prepared: { id: mine.id } }); } },
        (error) => { if (preflight === mine) { preflight = null; heard({ prepared: { id: mine.id, error } }); } });
  }
  /** The preflight under way, given up: its child is ended through the signal, and whatever it
   *  answers is dropped. */
  function giveUpPreflight() {
    if (preflight === null) return;
    preflight.controller.abort();
    preflight = null;
  }
  /** Start the viewer of row `id` (`node <bin> <args…>`) in the panel, at the size the frame gives
   *  the focused group, and tell the store when its window exists. The tab it takes the place of is
   *  no longer displayed from then on (the frame for the new state is fitted first). One the panel
   *  could not start is a viewer that ended, with the panel's refusal: no tmux (or one too old), or
   *  tmux's own words. Nothing is lent: the reads and the screen go on. */
  function view(id, bin, args) {
    const size = guard.size();
    // The focused group's screen as the Instances view gives it, also behind the help or another
    // overlay, which draw no panel (round 1 of T3's review).
    const region = placed()?.focused ?? { cols: Math.max(1, size.cols), rows: Math.max(1, size.rows - 6) };
    const mine = { id, panel: null, asked: false, cols: region.cols, rows: region.rows };
    viewers.set(id, mine);
    // Shown or hidden as this frame draws the panel: behind an overlay it shows once that closes.
    fitPanel(composed().made);
    // The window is asked for after this step's effects: one closed by then (a workspace left in the
    // same read of input) is never asked for, and a window made for a viewer the loop no longer
    // holds (closed, or replaced) is closed, not left open in the panel.
    Promise.resolve()
      .then(() => { if (viewers.get(id) !== mine) return null; mine.asked = true; return panel.open({ argv: [process.execPath, bin, ...args], cols: region.cols, rows: region.rows, instead: null }); })
      .then((opened) => {
        if (opened === null) return;
        const made = opened.id;
        if (viewers.get(id) !== mine) { panel.close(made); return; }
        mine.panel = made;
        // The panel displays it, and it takes the keys; a frame of another size meanwhile is the
        // next fitPanel's.
        displayed.add(made);
        keysTo = made;
        heard({ shown: { id } });
      },
        (error) => { if (viewers.get(id) === mine) { forgetViewer(mine); heard({ returned: { id, status: null, stderr: typeof error?.detail === "string" ? error.detail : "", refused: error?.code === "E_PANEL_TMUX" ? "tmux" : "start" } }); } });
  }
  /** What the loop holds of viewer `v` let go: the panel no longer displays it, or gives it keys. */
  function forgetViewer(v) {
    viewers.delete(v.id);
    screens.delete(v.id);
    if (v.panel !== null) { displayed.delete(v.panel); if (keysTo === v.panel) keysTo = null; }
  }
  /** Close tab `id`'s viewer (also one whose window is still being made: the open under way): the
   *  agent keeps running, and the panel reports the end as asked for, which nobody waits for. */
  function closeTerminal(id) {
    const v = viewers.get(id);
    if (v === undefined) return;
    forgetViewer(v);
    if (v.panel !== null) panel.close(v.panel);
    else if (v.asked) panel.close();
  }
  /** The panel brought to what the frame drew (`made.regions`, one per group drawn): shown or not
   *  (no capture runs while it is hidden, and one runs when it shows again); every tab of a drawn
   *  group at that group's size (the viewer's window follows it); each region's shown tab
   *  displayed, and no other; and the focused region's taking the keys. A group not drawn (the
   *  focused one alone, zoomed or with no room for both) keeps its tabs at their size, and its
   *  shown tab only marks. */
  function fitPanel(made) {
    if (viewers.size === 0) return;
    const regions = made.regions ?? [];
    if ((regions.length > 0) !== panelShown) { panelShown = regions.length > 0; panel.setVisible(panelShown); }
    if (!panelShown) return;
    const groupOf = (id) => state.tabs.find((tab) => tab.id === id)?.group ?? null;
    for (const r of regions) {
      const resized = [...viewers.values()].filter((v) => v.panel !== null && groupOf(v.id) === r.group && (v.cols !== r.cols || v.rows !== r.rows));
      if (resized.length === 0) continue;
      panel.resize(r.cols, r.rows, resized.map((v) => v.panel));
      for (const v of resized) { v.cols = r.cols; v.rows = r.rows; }
    }
    const wanted = regions.map((r) => ({ r, v: r.id === null ? null : viewers.get(r.id) ?? null })).filter(({ v }) => v !== null && v.panel !== null);
    const pids = new Set(wanted.map(({ v }) => v.panel));
    // The shown tab hidden: the panel shows the other displayed one, or none (lib/panel.mjs hide).
    for (const pid of [...displayed]) if (!pids.has(pid)) { panel.hide(pid); displayed.delete(pid); if (keysTo === pid) keysTo = [...displayed][0] ?? null; const v = viewerOf(pid); if (v) screens.delete(v.id); }
    for (const { v } of wanted) if (!displayed.has(v.panel)) { panel.show(v.panel, { instead: null }); displayed.add(v.panel); keysTo = v.panel; }
    const keys = wanted.find(({ r }) => r.focused)?.v.panel ?? null;
    if (keys !== null && keys !== keysTo) { panel.focus(keys); keysTo = keys; }
  }
  /** The frame for the state now, with what the loop needs of it: the layout first, because the
   *  model's window is as tall, and its sentences as wide, as the sidebar's list it gives, and an
   *  overlay's window as tall as the area it gives (`body`). The open view of the sidebar is the
   *  one under the help or a confirmation; the switcher opens none and has no notice of a
   *  deployment. The last captures of the displayed tabs go with the model: they are the panel's,
   *  not the store's. */
  function composed() {
    const { size, g, m, area } = modelled();
    return { size, g, area, made: frame(m, size) };
  }
  /** The model for the state and the size now, and the width of the main area (`area`,
   *  views/frame.mjs mainArea), which the switcher stands in: the lines above its choices wrap to it. */
  function modelled() {
    const size = guard.size(), at = clock();
    const under = state.view === "help" || state.view === "act" ? state.back : state.view;
    const listing = under === "switcher";
    const r = listing ? { notice: null, note: null } : roster(state, at);
    const g = layout(r.notice, size, { note: r.note, ascii: state.ascii, outcome: listing ? null : outcomeOf(state), terminal: state.tabs.length > 0, open: listing ? null : under, list: listRowsOf(state, at) });
    const area = mainArea(g, size.cols).cols;
    const m = { ...model(state, { page: g.page, body: g.body, now: now(), at, cols: g.listCols, area }), screen: screens.get(state.terminal?.id) ?? null, screens };
    return { size, g, m, area };
  }
  /** Where the panel stands for the state and the size now, as the Instances view gives it with
   *  the terminal's focus (views/frame.mjs panelPlace): measured whatever is drawn over it, and
   *  while no frame can be written. */
  function placed() {
    const { size, m } = modelled();
    return panelPlace(m, size);
  }
  /** Whether what is typed goes to the agent: the open terminal has the focus, and the leader
   *  does not wait for its key (docs/tui.md, "The leader"). */
  const typing = () => state.terminal?.focus === "terminal" && state.view === "instances" && state.leader?.waiting !== true && state.palette === null && state.spawn === null;
  /** Bytes typed while the terminal has the focus: to the agent as they came, a paste as a paste,
   *  and the leader to the store, which waits for the key after it: from the next read on, the
   *  bytes are read as keys, by a parser that starts afresh. What came after the leader in its own
   *  read is dropped: it cancels the leader (a paste), and it is not the agent's either. */
  function typed(events) {
    for (const event of events) {
      if (event.input) { if (keysReady()) panel.input(event.input); passed(); }
      else if (event.paste !== undefined) { if (keysReady()) panel.paste(event.paste); passed(); }
      else if (event.keyboard !== undefined) answered(event.keyboard);
      else if (event.back) {
        parser = newParser();
        if (took(reduce(state, { back: true, read: ++reads, rest: event.rest.length > 0 }, keymap))) return;
        guard.draw();
      } else if (event.chord !== undefined) {
        // A chord from the terminal's focus is the leader then its key (the store's `led`): it never
        // reaches the agent, and the rest of its read is dropped, as after the leader's key.
        parser = newParser();
        if (took(reduce(state, { chord: event.chord, read: ++reads, ...drawn, panel: placed()?.panel ?? null }, keymap))) return;
        guard.draw();
      }
    }
    watchThrough();
  }
  /** What the store does not see, a key typed to the agent or a resize, told to it while a line of
   *  one key stands (the store's `passed`): it goes, and the frame with it. */
  function passed() {
    if (state.outcome?.once !== true) return;
    took(reduce(state, { passed: true }, keymap));
    guard.draw();
  }
  /** The terminal's answer to the protocol's query (`flags`), or none in time (null): the protocol is
   *  read from now on when the answer holds flag 1, and popped otherwise; an answer after that is
   *  not taken. The parser or the scanner that read the answer reads the rest of its read as it
   *  says; the other is made again. */
  function answered(flags) {
    if (kb !== "asking") return;
    if (kbTimer !== null) { clearTimer(kbTimer); kbTimer = null; }
    kb = confirmed(flags) ? flags : null;
    guard.keyboardAnswered(kb !== null);
    if (parser.keyboard === "asking") parser = newParser();
    // What the scanner held as a possible beginning of the answer is the agent's after all.
    const released = through.giveUp();
    if (released.length && typing()) typed(released);
    if (kb !== null) { state = reduce(state, { keyboard: kb }, keymap).state; guard.draw(); }
  }
  /** Whether the keys typed now reach the agent the state gives them to, the focused group's shown
   *  tab: the panel is fitted to the state first when it was not, also while no frame is written
   *  (the output blocked), so a tab or a group switched to takes what is typed after the switch,
   *  never the one before it. A tab whose window is still being made takes nothing (round 1 of
   *  T3's review). */
  function keysReady() {
    const v = state.terminal === null ? undefined : viewers.get(state.terminal.id);
    if (v === undefined || v.panel === null) return false;
    const ready = () => keysTo === v.panel && displayed.has(v.panel);
    if (!ready()) fitPanel(composed().made);
    return ready();
  }
  /** A beginning of the back key that nothing has followed for the parser's timeout is the agent's. */
  function watchThrough() {
    if (throughTimer !== null) { clearTimer(throughTimer); throughTimer = null; }
    const due = through.timeoutAt();
    if (due !== null) throughTimer = setTimer(() => { throughTimer = null; guard.attempt(() => { if (typing()) typed(through.expire()); }); }, Math.max(0, due - now()));
  }
  const guard = createGuard({
    stdin, stdout, proc, setTimer, clearTimer, keyboard: kb === "asking",
    frame() {
      const { size, g, area, made } = composed();
      drawn = { page: made.page, extent: made.extent, room: made.room, cols: g.listCols, area };
      fitPanel(made);
      const bytes = screen.render(made.rows, size, { full, cursor: made.cursor });
      full = false;
      // This frame is written (the guard makes one only to write it): a ready preview on it is
      // seen, and Enter on Spawn is taken from the next read of input on (the paste guard).
      if (made.armed && state.spawn !== null) state = reduce(state, { spawnDrawn: { n: state.spawn.n, read: reads } }, keymap).state;
      // The preview's window as painted, which keeps a focused fold in sight: the store's `top`
      // from now on, so the next movement key goes on from what is on the screen.
      if (made.drawnTop !== undefined && state.spawn !== null) state = reduce(state, { spawnTop: { n: state.spawn.n, top: made.drawnTop } }, keymap).state;
      // The capability detail's window as painted, which keeps the marked soul in sight: the same.
      if (made.capabilitiesTop !== undefined) state = reduce(state, { capabilitiesTop: made.capabilitiesTop }, keymap).state;
      return bytes;
    },
    onInput(bytes) {
      reader.touch();
      if (typing()) return typed(through.feed(bytes));
      act(parser.feed(bytes)); watchEscape();
    },
    onResize() { full = true; passed(); guard.draw(); },
    // Ctrl+L and the return from a stop: the whole screen, and the open terminal captured afresh.
    onRedraw() { full = true; if (viewers.size) panel.refresh(); guard.draw(); },
    // A cycle in flight when the process stops is no evidence about the deployment (lib/read.mjs):
    // it is dropped before the stop, and again after a stop nobody here asked for; the return
    // reads at once.
    // A preflight is given up first, by the TUI itself: ended as a read it would answer as a
    // timeout. The person opens the agent again.
    // The open terminal's server and viewer live on through a stop; the panel stops sending output
    // while nothing reads it, and captures afresh on the way back.
    onStop() { stopPreflight(); dropReads(); if (viewers.size) panel.pause(); },
    onResume(asked) { if (!asked) { stopPreflight(); dropReads(); } if (viewers.size) panel.resume(); refresh({ live: true }); },
    // On the way out the confirmation is closed, the private tmux server is ended (its viewer with
    // it) and the reads end; a change in flight is let go, never signalled (lib/read.mjs
    // changeExec), and named after the screen is left.
    // The run's directory goes last, made for whichever of the two needed it first: the reader
    // removes it only when it wrote a change there, and one it cannot remove (a change still
    // writing) stays.
    // The machine sweep in flight is let go with the other changes: its answer is no longer shown.
    onEnd() { ended = true; resume.dispose(); spawnTimers.end(); dismiss(confirmation?.n); panel.end(); identities.stop(); reader.stop(); if (dir !== null) { try { effects.removeDir(dir); } catch { /* not empty, or gone */ } } },
  });
  function refresh(how) { Promise.resolve(reader.request(how)).catch(() => {}); }
  /** A preflight under way when the process stops: given up, and the store told. Its state alone is
   *  taken, as of the other events the store names UNTAKEN (store.mjs): a restore steps on none. */
  function stopPreflight() {
    if (preflight === null) return;
    giveUpPreflight();
    state = reduce(state, { given: true }, keymap).state;
  }
  /** Every read in flight is void (lib/read.mjs), the roster's with them: the reader says nothing
   *  for a void read, so the state is told here that none is in flight. */
  function dropReads() { reader.voidInFlight(); identities.stop(); state = reduce(state, { collecting: false }, keymap).state; }
  /** The events of one batch of input, in order. Once one of them gave the terminal the focus,
   *  the rest are dropped: they were typed before it had it, and neither the list nor the agent
   *  is to have them (a `q` behind the Enter would end the run). Each batch is one read of input,
   *  numbered (`read`): a confirmation ignores the press of its act in the read that moved the
   *  focus onto it, so a paste cannot both move and press. */
  function act(events) {
    const read = ++reads;
    for (const event of events) {
      if (event.keyboard !== undefined) { answered(event.keyboard); continue; }
      if (took(reduce(state, "paste" in event ? { paste: event.paste, read } : { key: keyId(event), ...(typeof event.text === "string" && !event.alt ? { text: event.text } : {}), read, ...drawn, panel: placed()?.panel ?? null }, keymap))) return;
      if (typing()) {
        if (escTimer !== null) { clearTimer(escTimer); escTimer = null; }
        through = newThrough();
        break;
      }
    }
    guard.draw();
  }
  /** A lone ESC is the Esc key once nothing has followed it for the parser's timeout. */
  function watchEscape() {
    if (escTimer !== null) { clearTimer(escTimer); escTimer = null; }
    const due = parser.timeoutAt();
    if (due !== null) escTimer = setTimer(() => { escTimer = null; if (!typing()) guard.attempt(() => { act(parser.expire()); watchEscape(); }); }, Math.max(0, due - now()));
  }

  guard.start();
  // At the wait's end what the key parser kept as a possible beginning of the answer is read as typed.
  if (kb === "asking" && !ended) kbTimer = setTimer(() => { kbTimer = null; guard.attempt(() => { const released = parser.giveUp(); answered(null); if (released.length && !typing()) act(released); watchEscape(); }); }, Math.max(0, answerBy - now()));
  guard.attempt(() => { if (!ended) Promise.resolve(reader.start()).catch(() => {}); });
  // The machine sweep, once the add of the deployment the run started in has settled (a start in the
  // switcher has none): after the first frame and the first read cycle have begun, never before them.
  let added = Promise.resolve();
  if (found.ok) guard.attempt(() => { if (!ended) added = listStart(found.deployment); });
  added.then(() => { if (!ended) guard.attempt(() => { resume.launch(); }); });
  // Once a run, at the start: the identities of this computer's listed deployments, the list read first
  // when the run did not read it before the terminal was taken.
  guard.attempt(() => { if (!ended) { if (listedAtStart) identify(); else readList({ identify: true }); } });
  guard.attempt(() => guard.draw());
  // Once a run, after the first frame: what runs that are gone left of their private servers
  // (lib/panel.mjs sweep, which signals nothing and removes only what it can prove is dead).
  guard.attempt(() => { if (!ended) { try { effects.sweep({ env }); } catch { /* nothing swept */ } } });
  const end = await guard.done;
  if (escTimer !== null) clearTimer(escTimer);
  if (throughTimer !== null) clearTimer(throughTimer);
  if (kbTimer !== null) clearTimer(kbTimer);
  // After the alternate screen is left, so the message stays on the screen the user returns to.
  // One line per change still running, to a terminal or a file only; the status never depends on it.
  // The machine sweep is no change of the person's: none for it.
  const running = (reader.changes?.() ?? []).filter(({ label }) => label !== RESUME_CHANGE);
  if (running.length && effects.tellable(stderr)) {
    try { stderr.write(running.map(({ label }) => `${label === LIST_CHANGE ? LIST_WORDS.leaving : ACT_WORDS.leaving(label?.verb ?? "change", displayLine(label?.name) ?? "an instance")}\n`).join("")); } catch { /* nothing to tell it to */ }
  }
  if (end.error !== undefined) stderr.write(`oats: \`oats tui\` stopped on an internal error; the terminal was restored\n${errorLines(end.error).map((line) => `  ${line}\n`).join("")}`);
  return end.status;
}
