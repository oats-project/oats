/** listInstances: every home under an agents root as a status row (its record, tmux liveness, retire
 *  state, waiting claim, colour, served identity, its launch recipe redacted), and the legacy layouts
 *  status warns about. A leaf (awebai/oats#1630): `oats status` lists homes without loading core.mjs,
 *  which imports what it still uses from here and re-exports what it exported. */
import { canonicalHomePath } from "./real-path.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, lstatSync, existsSync, statSync, openSync, constants as fsConstants, fstatSync, closeSync, accessSync, readlinkSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { noteRuntimeName } from "./deprecation.mjs";
import { createSessionPaneInspector, AGENT_PANE_OPTION } from "./session-input.mjs";
import { liveWaiting, validWaitingMessage } from "./instance-events.mjs";
import { processLiveness } from "./worktree-hooks.mjs";
import { shownHolder } from "./claim.mjs";
import { isInstant as isInstantString, readRetireState } from "./retire-state.mjs";
import { herdrInstanceRemoved, oatsError } from "./errors.mjs";
import { readInstanceColor } from "./instance-color.mjs";
import { readInstanceBackground } from "./instance-background.mjs";
import { sameWorkOf } from "./instance-same-work.mjs";
import { readSpawnedBy } from "./spawned-by.mjs";
import { sessionEndOf } from "./session-end.mjs";
import { recordSeen } from "./session-seen.mjs";
import { listAgents, capabilityAgentDirs } from "./soul-listing.mjs";
import { recordsHerdr, readJsonOrUndefined, findRetirementBaseline, instanceSessionTarget, harnessRunning, isPlainObject, instancesRetirementRoot } from "./session-inspect.mjs";

/** OATS 0.25 and earlier homed local souls and capability-defined agents at
 *  <scope>/local-agents/ (and <root>/local-agents|tmp-agents). The kernel never reads,
 *  spawns into or retires from them; it only detects them: `legacyLocalAgents` names
 *  what is left there so status/doctor say so. */
const LEGACY_LOCAL_AGENTS_DIR = "local-agents";
/** The names of the non-hidden directories in `d` ([] when it cannot be read). */
function subdirs(d) {
  try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name); } catch { return []; }
}
/** What OATS 0.25 left under <scope>/local-agents/ (and the nested <root>/local-agents|
 *  tmp-agents) for the agents root `root`: one `legacy-local-agents` problem naming the
 *  instance homes there, or null. Names only — nothing there is read, spawned into or
 *  retired from. */
export function legacyLocalAgents(root) {
  if (!root) return null;
  const bases = [join(dirname(root), LEGACY_LOCAL_AGENTS_DIR), join(root, LEGACY_LOCAL_AGENTS_DIR), join(root, "tmp-agents")];
  const dirs = [], instances = [];
  for (const base of bases) {
    let st; try { st = lstatSync(base); } catch { continue; }
    if (!st.isDirectory()) continue;
    dirs.push(base);
    for (const agent of subdirs(base)) for (const inst of subdirs(join(base, agent, "instances"))) instances.push(inst);
  }
  if (!dirs.length) return null;
  instances.sort();
  return { code: "legacy-local-agents", dirs, instances,
    message: `${instances.length} instance home${instances.length === 1 ? "" : "s"} under local-agents/ ${instances.length === 1 ? "is" : "are"} from OATS 0.25 and ${instances.length === 1 ? "is" : "are"} not managed by this kernel; retire ${instances.length === 1 ? "it" : "them"} with the 0.25 kernel or delete the directory once ${instances.length === 1 ? "it is" : "they are"} stopped${instances.length ? ` (${instances.join(", ")})` : ""}` };
}

/** The captured homes (the 0.24–0.25 captured/portable path, removed in 0.26) under the
 *  agents root `root`: one `legacy-captured-home` problem naming them, or null. They have
 *  no 0.26 runtime (start, inspect and in-home commands refuse them); retire still works.
 *  `records`: the records listInstances read in this same read (its `records`), each home's
 *  instance.json parsed once per read; a home it holds no record for is read here. */
export function legacyCapturedHomes(root, { records } = {}) {
  if (!root) return null;
  const homes = [];
  for (const agent of subdirs(root)) for (const inst of subdirs(join(root, agent, "instances"))) {
    const home = join(root, agent, "instances", inst);
    let meta;
    if (records?.has(home)) meta = records.get(home);
    else try { meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8")); } catch { continue; }
    if (isCapturedHome(meta)) homes.push({ instance: inst, home });
  }
  if (!homes.length) return null;
  homes.sort((a, b) => a.instance.localeCompare(b.instance));
  const one = homes.length === 1;
  return { code: "legacy-captured-home", instances: homes.map((h) => h.instance), homes: homes.map((h) => h.home),
    message: `${homes.length} captured home${one ? "" : "s"} (0.24–0.25; the captured/portable path was removed in 0.26) ${one ? "has" : "have"} no 0.26 runtime: start, inspect and in-home commands refuse ${one ? "it" : "them"}; retire ${one ? "it" : "them"} (\`oats retire\` still works) and re-spawn from the deployment (${homes.map((h) => h.instance).join(", ")})` };
}
// The tmux session a new tmux instance opens its window in, when oats-local.yaml session.tmuxSession
// names none (0.31). PI_AGENTS_TMUX_SESSION is the pre-0.31 variable, still honoured. The Desktop keeps
// the same default in packages/client/tmux-status.mjs (it does not import lib/): change both.
export const DEFAULT_TMUX_SESSION = process.env.OATS_TMUX_SESSION || process.env.PI_AGENTS_TMUX_SESSION || "oats-agents";

/** tmuxWindows' read, keeping a missing socket file apart (#624): `{ windows }`, with `missingSocket`
 *  (tmux's words) when the default server's socket file is missing. Any other failure reads as no
 *  session. `has-session` first, as ever: it is the read-only probe a caller may expect for a home
 *  that records no socket, and it words a missing socket file as list-windows does. */
function defaultTmuxWindows(session) {
  const run = (args) => execFileSync("tmux", args, { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  try {
    run(["has-session", "-t", session]);
    return { windows: run(["list-windows", "-t", session, "-F", "#{window_name}"]).split("\n").filter(Boolean) };
  } catch (e) {
    // Either read: the socket file can go between the two.
    return tmuxServerAbsence(e) === "missing-socket" ? { windows: [], missingSocket: tmuxFailure(e, "tmux failed") } : { windows: [] };
  }
}

const tmuxFailure = (e, fallback) => String(e?.stderr ?? e?.message ?? "").trim() || fallback;

/** `name` as an exec looks it up on `path`: the first entry, in order, that holds a regular
 *  executable file of that name, as an absolute path; null when none does. A relative entry, and
 *  an empty one (an empty PATH is one empty entry), are `cwd`. Nothing is run. */
function lookupOnPath(name, path, cwd = process.cwd()) {
  for (const dir of path.split(":")) {
    const candidate = resolve(cwd, dir || ".", name);
    try { accessSync(candidate, fsConstants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  }
  return null;
}

// ---------- launch recipes ----------
// What a harness start is made of, recorded in instance.json (`launch`) so a
// later start or restart can re-render it, select another configuration, or
// switch harness without guessing from the command string. The rendered
// command (`command`) stays beside it, byte-identical to what spawn rendered
// before recipes existed when no configuration is selected. Version 2 (0.27.0)
// names the harness `harness`; version 1 (0.26.0 homes) said `runtime` and is
// read as version 2 (upgradeLaunchRecipe); the next start or restart rewrites it.
export const LAUNCH_RECIPE_VERSION = 2;
/** A recorded recipe as this kernel reads it: version 1 `{runtime}` (0.26.0) is
 *  version 2 `{harness}` (lead call 6: read either, write new). Anything else is
 *  returned as it is, for assertLaunchRecipe to judge. */
export function upgradeLaunchRecipe(recipe) {
  if (!isPlainObject(recipe) || recipe.version !== 1 || Object.hasOwn(recipe, "harness")) return recipe;
  const { runtime, ...rest } = recipe;
  return { ...rest, version: LAUNCH_RECIPE_VERSION, harness: runtime };
}
/** A home's instance.json as this kernel reads it: 0.26.0 recorded `runtime` and a
 *  version-1 recipe; both read as `harness` (lead call 6). Every reader of a home's
 *  harness goes through here; the next start or restart writes the new names. */
export function upgradeHomeMeta(meta, home) {
  if (!isPlainObject(meta)) return meta;
  const old = Object.hasOwn(meta, "runtime") || (isPlainObject(meta.launch) && meta.launch.version === 1 && !Object.hasOwn(meta.launch, "harness"));
  if (!old) return meta;
  noteRuntimeName(`instance.json of ${home || meta.home || meta.instance} (a 0.26.0 home: its next start or restart records harness)`);
  const { runtime, ...rest } = meta;
  return { ...rest, ...(runtime !== undefined || meta.harness !== undefined ? { harness: meta.harness ?? runtime } : {}), ...(meta.launch !== undefined ? { launch: upgradeLaunchRecipe(meta.launch) } : {}) };
}
/** A home's record (`<home>/instance.json`) as it is on disk. Total: it never throws, so that one
 *  home's record decides only for that home (awebai/oats#896). One of:
 *  - `{ state: "record", path, meta }`: the JSON object the file holds, as written (a reader of
 *    the home's harness passes it through upgradeHomeMeta);
 *  - `{ state: "absent", path }`: no entry of that name, or a home this process cannot look into,
 *    where whether there is one cannot be told (answered as a home without a record, as before);
 *  - `{ state: "unreadable", path, reason }`: an entry is there and gives no JSON object: cut off,
 *    empty, kept from this user, a directory, a link to nothing, or JSON that is not an object.
 *    `reason` is the system's or the parser's, in words, without the path.
 *  An unreadable record is never an absent one: the home may be a whole instance with work, and
 *  "cannot read" is not "is not there". */
export function readHomeRecord(home) {
  const path = join(home, "instance.json");
  const unreadable = (reason) => ({ state: "unreadable", path, reason });
  let text;
  try {
    // Only a regular file is read: a read of a directory fails, and one of a pipe would not return.
    const entry = statSync(path);
    if (!entry.isFile()) return unreadable(entry.isDirectory() ? "it is a directory" : "it is not a regular file");
    text = readFileSync(path, "utf8");
  } catch (e) {
    let entry;
    try { entry = lstatSync(path); } catch { return { state: "absent", path }; }
    if (entry.isSymbolicLink() && e?.code === "ENOENT") return unreadable("it is a symbolic link to nothing");
    // The system's words without the path, which the answer already names: `EACCES: permission denied`.
    return unreadable(String(e?.message ?? e).replace(/, [a-z]+ '.*'$/s, ""));
  }
  let value;
  try { value = JSON.parse(text); } catch (e) { return unreadable(String(e?.message ?? e)); }
  if (!isPlainObject(value)) return unreadable(`it holds ${value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`}, not a JSON object`);
  return { state: "record", path, meta: value };
}
/** What an answer says of a record that cannot be read (readHomeRecord): the file and the reason. */
const unreadableRecordSaid = (record) => `${record.path} cannot be read (${record.reason})`;

/** A persisted command with every environment value withheld (references
 *  stay references); a command the parser refuses is withheld whole. */
/** The identity environment every launch carries: public facts (instance
 *  name, home path), shown in public renderings; everything else is withheld. */
export const IDENTITY_LAUNCH_ENV = new Set(["OATS_INSTANCE", "OATS_INSTANCE_HOME"]);
export function redactLaunchCommand(command) {
  try { return parseLaunchCommand(command).tokens.map((t) => t.kind === "env" && !IDENTITY_LAUNCH_ENV.has(t.name) ? `${t.name}='<redacted>'` : t.text).join(" "); }
  catch { return "<unparseable launch command withheld>"; }
}
/** The recipe as answers carry it: every environment value withheld, and without `kernelBin`
 *  (the home's record keeps it; human `oats status` reads it from there). */
export function redactLaunchRecipe(recipe) {
  const env = Object.fromEntries(Object.keys(recipe.env || {}).sort().map((n) => [n, typeof recipe.env[n] === "string" ? { redacted: true } : { ...recipe.env[n] }]));
  const hooks = recipe.hooks ? { ...recipe.hooks, env: Object.fromEntries(Object.keys(recipe.hooks.env || {}).sort().map((n) => [n, { redacted: true }])) } : undefined;
  const { kernelBin: _recorded, ...answered } = recipe;
  return { ...answered, env, ...(hooks ? { hooks } : {}) };
}

/** Decision 27 (K2): the principal an instance ACTS AS, as its messaging-layer provider reported
 *  it — a documented layer contract `{ mode: "local"|"global", alias, team, address|null, resident|null,
 *  grant?: { id, expiresAt, scopes } }` under `identity` in the provider's hook meta. The kernel copies it
 *  through and never interprets `grant`. Preference: the capability whose captured layer is "messaging";
 *  else any capability that emitted an `identity` object. Null when none did. */
export function servedIdentityOf(meta) {
  const cm = meta?.capabilityMeta;
  if (!cm || typeof cm !== "object") return null;
  const harness = Array.isArray(meta.capabilityRuntime) ? meta.capabilityRuntime : [];
  const messaging = harness.filter((c) => c && c.layer === "messaging").map((c) => c.id);
  const pick = (ids) => { for (const id of ids) { const v = cm[id]?.identity; if (v && typeof v === "object" && !Array.isArray(v)) return { ...v, provider: id }; } return null; };
  return pick(messaging) ?? pick(Object.keys(cm));
}

const ATTRIBUTION_MODES = new Set(["human", "none", "unknown"]);
const opaqueId = (v) => typeof v === "string" && v.length > 0;
/** Feature spawn-attribution: the label of the human an instance's served identity is attributed to,
 *  or null. Read by slot, never by name: only the `identity` that a capability whose captured layer is
 *  "messaging" recorded counts, never servedIdentityOf's fallback to any capability, so no other
 *  capability can name a human on a row. Its optional `attribution` is the capability's,
 *  `{ mode: "human"|"none"|"unknown", human: { id, label }|null, parent: { id }|null }` (an omitted
 *  `human` or `parent` is null), opaque strings the kernel never interprets; only mode "human" names one.
 *  The label is untrusted text: a waiting claim's message rule (validWaitingMessage), else null. A
 *  malformed attribution reads as absent: null. It reports; no kernel decision reads it. */
export function attributedHumanOf(meta) {
  const cm = meta?.capabilityMeta;
  if (!isPlainObject(cm) || !Array.isArray(meta.capabilityRuntime)) return null;
  for (const { id } of meta.capabilityRuntime.filter((c) => c && c.layer === "messaging")) {
    const identity = cm[id]?.identity;
    if (!isPlainObject(identity)) continue;
    const a = identity.attribution;
    if (!isPlainObject(a) || !ATTRIBUTION_MODES.has(a.mode)) return null;
    const human = a.human ?? null, parent = a.parent ?? null;
    if (human !== null && !(isPlainObject(human) && opaqueId(human.id) && typeof human.label === "string")) return null;
    if (parent !== null && !(isPlainObject(parent) && opaqueId(parent.id))) return null;
    return a.mode === "human" && human && validWaitingMessage(human.label) ? human.label : null;
  }
  return null;
}

/** The window names of `session` on the tmux server at `socket`: `{ windows }`, empty when the server
 *  or the session is gone, with `missingSocket` (tmux's words) when the socket file is missing, which
 *  alone does not say the server is gone (#624); `{ error }` when the server could not be read. */
function recordedTmuxWindows(socket, session, io) {
  try { return { windows: tmuxOn(socket, ["list-windows", "-t", `=${session}`, "-F", "#{window_name}"], io).split("\n").filter(Boolean) }; }
  catch (e) {
    const absence = tmuxServerAbsence(e);
    if (absence === "missing-socket") return { windows: [], missingSocket: tmuxFailure(e, "tmux list-windows failed") };
    if (absence || /can't find session/i.test(String(e.stderr ?? ""))) return { windows: [] };
    return { error: String(e.stderr ?? e.message ?? "").trim() || "tmux list-windows failed" };
  }
}
/** A status row's harness liveness from its session's panes: unknown (not false) when the server could not
 *  be read, and, for a row whose server holds its endpoint (`endpoint`), when its socket file is
 *  missing while a process works in the home or the scan (`scanHome()`, processesInHome's answer for
 *  it) cannot tell (#624). */
function tmuxLiveness({ windows, error, missingSocket, panes, windowIds }, window, scanHome, endpoint, inspectPanes) {
  if (error) return { running: null, runtimeState: "unreachable", runtimeError: error };
  const running = windows.includes(window);
  const why = !running && missingSocket && endpoint ? missingSocketUnestablished(missingSocket, scanHome()) : null;
  if (why) return { running: null, runtimeState: "unreachable", runtimeError: why };
  if (!running) return { running: false };
  try {
    // Two windows of one name: tmux finds neither by name, so no session command reaches this one.
    if (windowIds?.get(window)?.size > 1) throw new Error(`the session has ${windowIds.get(window).size} windows named ${window}`);
    const observed = inspectPanes(panes.get(window) ?? [], { name: window });
    return { running: harnessRunning(observed), ...(observed.state === "shell" ? { runtimeState: "shell" } : {}) };
  } catch (e) { return { running: null, runtimeState: "unreachable", runtimeError: tmuxFailure(e, "tmux pane inspection failed") }; }
}
/** One extra read per socket/session, never per row. Keep window discovery's missing-socket
 *  handling; a failed pane read after successful discovery is unknown, not proof of a stop. */
function statusTmuxPanes(snapshot, socket, session, io) {
  if (!snapshot.windows?.length) return snapshot;
  try {
    const args = ["list-panes", "-s", "-t", `=${session}`, "-F", `#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{pane_current_command}\t#{pane_pid}\t#{${AGENT_PANE_OPTION}}`];
    const output = socket ? tmuxOn(socket, args, io) : (io?.exec || execFileSync)("tmux", ["-u", ...args], {
      encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    const panes = new Map(), windowIds = new Map();
    for (const line of output.split("\n").filter(Boolean)) {
      const [window, windowId, ...pane] = line.split("\t");
      if (!pane.length) throw new Error("invalid tmux pane response");
      if (!panes.has(window)) { panes.set(window, []); windowIds.set(window, new Set()); }
      panes.get(window).push(pane.join("\t"));
      windowIds.get(window).add(windowId);
    }
    return { ...snapshot, panes, windowIds };
  } catch (e) { return { error: tmuxFailure(e, "tmux list-panes failed") }; }
}
/** `records`, when given, a Map the listing fills with each home's record as read (home → the JSON
 *  object its instance.json holds, before upgradeHomeMeta), for the rest of the same read to reuse
 *  instead of reading the file again (legacyCapturedHomes). */
export function listInstances(root, tmuxSession = DEFAULT_TMUX_SESSION, io, { records } = {}) {
  // Liveness reads each home's RECORDED endpoint (a pre-0.31 home records pi-agents): the recorded
  // socket, never the ambient $TMUX server: one window read and one pane read per socket/session,
  // plus one lazy process scan for shell descendants, independent of the number of homes.
  // A home without a recorded socket reads the default server.
  // A row whose socket file is missing is checked against one process scan of the host, made the
  // first time a row needs it and shared by every row (`io` reaches it: processesInHome).
  let hostScan;
  const scanOf = (home) => () => {
    hostScan ??= hostProcesses(io);
    return hostScan.ok ? { ok: true, processes: processesWorkingIn(hostScan.processes, home) } : hostScan;
  };
  const inspectPanes = createSessionPaneInspector(io);
  const tmuxByEndpoint = new Map();
  const windowsOf = (session, socket) => {
    const key = JSON.stringify([socket ?? null, session]);
    if (!tmuxByEndpoint.has(key)) tmuxByEndpoint.set(key, statusTmuxPanes(
      socket ? recordedTmuxWindows(socket, session, io) : defaultTmuxWindows(session), socket, session, io));
    return tmuxByEndpoint.get(key);
  };
  const readInstancesOf = (agentDir) => {
    const instancesDir = join(agentDir, "instances");
    // An instance name starts with a letter or digit (INSTANCE_NAME_RE); a
    // dot-directory under instances/ is kernel bookkeeping (.oats-retirement
    // holds baselines and recoveries), never a home (oats-5xl).
    return (existsSync(instancesDir) ? readdirSync(instancesDir, { withFileTypes: true }) : [])
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => {
        const home = join(instancesDir, e.name);
        // The record decides for this home only: one that is there and cannot be read gives the
        // row of a home without a record, whose liveness says why (below), never a failed listing.
        const record = readHomeRecord(home);
        if (record.state === "record") records?.set(home, record.meta);
        const meta = record.state === "record" ? upgradeHomeMeta(record.meta, home) : { instance: e.name, home };
        const { rollbackIncomplete, spawnInProgress, retirePending, retire } = readRetireFacts(home);
        // A home opened in Herdr (removed in 0.31.0) is listed, never observed: its row says so.
        // A home whose record cannot be read is listed, never observed: where its session is, is in the record.
        const liveness = record.state === "unreadable" ? { running: null, runtimeState: "unreachable", runtimeError: `E_UNIDENTIFIED_INSTANCE_HOME: ${unreadableRecordSaid(record)}` }
          : recordsHerdr(meta, readJsonOrUndefined(findRetirementBaseline(home)))
          ? { running: null, runtimeState: "unsupported", runtimeError: `E_HERDR_REMOVED: ${herdrInstanceRemoved(e.name).message}` }
          : tmuxLiveness(windowsOf(meta.tmux?.session || tmuxSession, meta.tmux?.socket), meta.tmux?.window || meta.instance || e.name, scanOf(home),
            // A home that records no socket and no launch (--no-launch) reads the default server only
            // by default: that server's missing socket says nothing about it, and stays "not running".
            !!meta.tmux?.socket || meta.launched === true, inspectPanes);
        const identity = servedIdentityOf(meta);
        // Feature desktop-facts: `startedAt` — the last session start or restart (the receipt's restarts[]),
        // else the spawn's own launch (createdAt), else null (never launched); `identityAddress` — the
        // messaging identity's address (or alias) its capability recorded, null otherwise; `modelFrom` — null
        // for a home spawned before it was recorded.
        const lastStart = Array.isArray(meta.restarts) && meta.restarts.length ? meta.restarts[meta.restarts.length - 1]?.startedAt ?? null : null;
        const facts = { startedAt: lastStart ?? (meta.launched ? meta.createdAt ?? null : null), identityAddress: identity ? identity.address ?? identity.alias ?? null : null, modelFrom: meta.modelFrom ?? null, attributedHuman: attributedHumanOf(meta) };
        // The home IS the directory enumerated here, and the instance its name:
        // a file inside it cannot relocate or rename itself in the roster (every
        // consumer acting on `home` — retire, inspect --home, the Desktop's file
        // roots — would inherit the claim). A disagreeing claim survives only as
        // a diagnostic.
        const claims = {
          ...(meta.home !== undefined && meta.home !== home ? { recordedHome: meta.home } : {}),
          ...(meta.instance !== undefined && meta.instance !== e.name ? { recordedInstance: meta.instance } : {}),
        };
        // Feature waiting-on-you: a producer's live claim that the instance is
        // blocked on a human, read only for a running row (one bounded read of
        // its home log); null otherwise, and null means unknown. Pane liveness is
        // already observed in the batch; still require the independent receipt
        // to agree before showing a claim, just as session inspect does.
        let waitingOnYou = liveness.running === true ? liveWaiting(home, record.state === "record" ? { meta: record.meta } : {}) : null;
        if (waitingOnYou) {
          try { const s = instanceSessionTarget(home); if (!s.target) waitingOnYou = null; }
          catch { waitingOnYou = null; }
        }
        // `retire` is only ever the value read above, and `background` and `sameWork` the home's own records
        // (below): a record that carries any of them (hand-edited, or copied from a row) never stands in for it.
        const { retire: _recordedRetire, background: _recordedBackground, sameWork: _recordedSameWork, ...recorded } = meta;
        // `spawnedBy` (feature spawn-attribution) is the record's own, read in place by its rule (lib/spawned-by.mjs):
        // a malformed one is null, and a home spawned before the feature has no key.
        if (Object.hasOwn(recorded, "spawnedBy")) recorded.spawnedBy = readSpawnedBy(recorded.spawnedBy);
        // Feature session-resume: how the last session of a launched home that does not run ended
        // (lib/session-end.mjs): lost, stopped or exited. Absent while it runs or reads unknown, for a
        // home never launched, and for one being set up, retired or quarantined.
        const sessionEnd = record.state === "record" && liveness.running === false && meta.launched === true && !rollbackIncomplete && !spawnInProgress && !retirePending ? sessionEndOf(home, meta) : null;
        // Feature instance-color: the home's own colour record (lib/instance-color.mjs), a palette name or
        // null, after the record so that nothing in instance.json stands in for it.
        // Feature instance-same-work: `sameWork: true` only while the home's flag is bound to the parent
        // its readable record names (lib/instance-same-work.mjs sameWorkOf); absent otherwise, never false.
        const sameWork = record.state === "record" && sameWorkOf(home, meta.parentInstance);
        return { ...recorded, ...claims, home, instance: e.name, ...facts, color: readInstanceColor(home), ...(readInstanceBackground(home) ? { background: true } : {}), ...(sameWork ? { sameWork: true } : {}), ...(identity ? { identity } : {}), ...(meta.launch && typeof meta.launch === "object" ? { launch: redactLaunchRecipe(meta.launch) } : {}), ...(typeof meta.command === "string" ? { command: redactLaunchCommand(meta.command) } : {}), ...liveness, ...(sessionEnd ? { sessionEnd } : {}), waitingOnYou, ...(rollbackIncomplete ? { rollbackIncomplete } : {}), ...(spawnInProgress ? { spawnInProgress } : {}), ...(retirePending ? { retirePending } : {}), ...(retire ? { retire } : {}) };

      });
  };
  const withFailures = (entry, agentDir) => {
    const retireFailures = readRetireFailuresOf(agentDir);
    return retireFailures.length ? { ...entry, retireFailures } : entry;
  };
  const out = listAgents(root).map((a) => {
    const { _dir, ...soul } = a;
    return withFailures({ ...soul, dir: _dir, instances: readInstancesOf(a._dir) }, a._dir);
  });
  // Capability-defined agents home under <root>/<name>/ WITHOUT a soul there (it
  // lives read-only in the module) — surface their instances too. A soul-less dir
  // none of whose homes is a capability agent's is not one.
  const seen = new Set(out.map((a) => a.name));
  for (const { name, dir } of capabilityAgentDirs(root)) {
    if (seen.has(name)) continue;
    const instances = readInstancesOf(dir);
    const retireFailures = readRetireFailuresOf(dir);
    if (!instances.some((i) => i.kind === "capability") && !retireFailures.length) continue;
    const cap = instances.find((i) => i.capability)?.capability;
    out.push({ name, kind: "capability", capability: cap, description: cap ? `capability agent (${cap})` : "capability agent", dir, instances, ...(retireFailures.length ? { retireFailures } : {}) });
    seen.add(name);
  }
  // Feature session-resume: what this local listing saw of each home's session, for the sweep
  // (lib/session-seen.mjs). It never changes the listing, and never throws or prints.
  recordSeen(root, out.flatMap((a) => a.instances || []));
  return out;
}

/** What is beside and in `home` about a retire of it, as its status row reads it (listInstances,
 *  openRetirements): `rollbackIncomplete` (the quarantine marker), `spawnInProgress`,
 *  `retirePending` (the pending marker) and `retire` (retireStateOf). Each is undefined when it
 *  does not apply. Only read: no claim is taken, no file removed, no process signalled. */
function readRetireFacts(home) {
  // A home retained by an incomplete rollback is NOT a live instance: it
  // is preserved state awaiting cleanup, and must read that way.
  const fallback = directoryRollbackPath(home);
  const quarantine = existsSync(fallback) ? fallback : join(home, ".oats-rollback-incomplete.json");
  let rollbackIncomplete, spawnInProgress;
  if (existsSync(quarantine)) {
    try { rollbackIncomplete = JSON.parse(readFileSync(quarantine, "utf8")); }
    catch { rollbackIncomplete = { reason: "rollback incomplete" }; }
    // #796: a spawn still running its spawn or worktree hooks keeps a marker that names it
    // (`inProgress`). While that process is verifiably alive the home is a spawn in
    // progress, not a failed one; otherwise the marker reads as the quarantine. A process whose
    // start cannot be read is not shown in progress either: on a host that never reads it, the
    // row would say "setting up" forever. It reads as the quarantine (its `inProgress` names
    // the pid), and retire, which never takes it for gone, refuses it with the way out.
    if (rollbackIncomplete?.inProgress && processLiveness(rollbackIncomplete.inProgress).state === "alive") { rollbackIncomplete = undefined; spawnInProgress = true; }
  }
  // A self-retire that has been requested but not completed: the home is
  // owed a retirement, not live work. Read-only here — completion is the
  // detached child's or an operator's `oats retire`, never status.
  const { retirePending, marker } = readRetirePending(home);
  const retire = retireStateOf(home, marker);
  return { rollbackIncomplete, spawnInProgress, retirePending, retire };
}

/** The failed deferred self-retirements of the soul at `agentDir`: the outcome each left beside its
 *  home, whether the home is still there or not (a status listing's `retireFailures`). A successful
 *  one is evidence only and is not a problem to surface. */
function readRetireFailuresOf(agentDir) {
  const instancesDir = join(agentDir, "instances");
  if (!existsSync(instancesDir)) return [];
  const out = [];
  for (const e of readdirSync(instancesDir, { withFileTypes: true })) {
    const m = e.isFile() && /^\.oats-retired-(.+)\.json$/.exec(e.name);
    if (!m) continue;
    try {
      const r = JSON.parse(readFileSync(join(instancesDir, e.name), "utf8"));
      if (r.ok === false) out.push({ instance: m[1], completedAt: r.completedAt, error: r.error?.message, incomplete: r.result?.rollbackIncomplete, retry: r.retry, resultPath: join(instancesDir, e.name) });
    } catch { out.push({ instance: m[1], error: "unreadable result file", resultPath: join(instancesDir, e.name) }); }
  }
  return out;
}

/** The homes under `root` and what is beside each about a retire of it, read as `oats status` reads
 *  it and from the same souls' directories (listInstances), without its sessions, tmux or process
 *  scans and without recording what it saw: for `oats doctor` (lib/retire-incomplete.mjs). Only
 *  read. → [{ agent, dir, homes: [{ instance, home, record, rollbackIncomplete?, spawnInProgress?,
 *  retirePending?, retire? }], retireFailures }]: `record` is "record", "absent" or "unreadable"
 *  (readHomeRecord), with `recordSaid` for an unreadable one. */
export function openRetirements(root) {
  const homesOf = (agentDir) => {
    const instancesDir = join(agentDir, "instances");
    return (existsSync(instancesDir) ? readdirSync(instancesDir, { withFileTypes: true }) : [])
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => {
        const home = join(instancesDir, e.name);
        const record = readHomeRecord(home);
        return { instance: e.name, home, record: record.state, ...(record.state === "unreadable" ? { recordSaid: unreadableRecordSaid(record) } : {}), kind: record.state === "record" ? record.meta.kind : undefined, ...readRetireFacts(home) };
      });
  };
  const out = listAgents(root).map((a) => ({ agent: a.name, dir: a._dir, homes: homesOf(a._dir), retireFailures: readRetireFailuresOf(a._dir) }));
  // The capability-defined agents listInstances lists, by its rule.
  const seen = new Set(out.map((a) => a.agent));
  for (const { name, dir } of capabilityAgentDirs(root)) {
    if (seen.has(name)) continue;
    const homes = homesOf(dir), retireFailures = readRetireFailuresOf(dir);
    if (!homes.some((h) => h.kind === "capability") && !retireFailures.length) continue;
    out.push({ agent: name, dir, homes, retireFailures });
    seen.add(name);
  }
  for (const a of out) for (const h of a.homes) delete h.kind;
  return out;
}

// A substituted/missing home cannot hold its own receipt. This sibling fallback
// is independent of both home bytes and the recovery storage that may have failed.
function directoryRollbackPath(home) {
  return join(dirname(home), `.oats-directory-rollback-${basename(home)}.json`);
}

/** How a failed tmux call reads the server it addressed (#624). "gone": no server listens on the
 *  socket (`no server running on`, or a refused connection), which is definitive. "missing-socket":
 *  the socket file is not there (`No such file or directory`). After a reboot the server is gone,
 *  but a tmux server outlives its removed socket file, so that alone establishes nothing: a caller
 *  concludes stopped from it only when no process works in the home (missingSocketUnestablished).
 *  null: anything else. */
function tmuxServerAbsence(e) {
  const text = String(e?.stderr ?? e?.message ?? "");
  if (/no server running on |(?:error connecting to|failed to connect to) .*Connection refused/i.test(text)) return "gone";
  if (/(?:error connecting to|failed to connect to) .*No such file or directory/i.test(text)) return "missing-socket";
  return null;
}

/** tmux's own way back for a server that lost its socket file (tmux(1), `-S`). Named, never performed. */
const TMUX_SOCKET_REMEDY = "tmux recreates a removed socket file when its server process receives SIGUSR1";
/** Processes as a refusal names them: pid and program, at most five, then how many more. */
function namedProcesses(processes) {
  return `${processes.slice(0, 5).map((p) => `pid ${p.pid} ${p.command}`).join(", ")}${processes.length > 5 ? `, and ${processes.length - 5} more` : ""}`;
}
/** A missing socket file (`detail`, tmux's words) checked against `scan`, processesInHome's answer
 *  for the home (#624): null when it ran and found no process there, so the server is taken as gone,
 *  as after a reboot; otherwise why the state is not established. Any process working in the home
 *  counts, a person's shell included: the words name it, so the person can act on it. */
function missingSocketUnestablished(detail, scan) {
  if (!scan.ok) return `${detail}; whether a process still works in this home could not be established (${scan.error})`;
  if (scan.processes.length) return `${detail}; a process still works in this home (${namedProcesses(scan.processes)}), so its tmux server may still be running without its socket file: ${TMUX_SOCKET_REMEDY}`;
  return null;
}
/** Whether this host's /proc can be read: Linux, and this process's own `cwd` link resolves. */
function procReadable() {
  if (process.platform !== "linux") return { ok: false, error: "this host has no /proc to read (it is not Linux)" };
  try { readlinkSync("/proc/self/cwd"); return { ok: true }; }
  catch (e) { return { ok: false, error: `/proc/self/cwd cannot be read (${e.code || e.message})` }; }
}

/**
 * Every live process on the host (other than this one and its direct children) with its working
 * directory, from one scan: /proc on Linux (`io.procRoot` names another root), else one `lsof -a -d
 * cwd` listing; an injected `io.exec` stands in for the host's commands, so it is lsof's. Each cwd
 * is kept in its on-disk spelling (canonicalHomePath); one the kernel reports deleted (`<path>
 * (deleted)`) is kept as both spellings. A process this user may not inspect (another user's, or a
 * non-dumpable one) is not seen by either mechanism.
 * → { ok: true, processes: [{pid, command, cwds}] } | { ok: false, error }
 */
function hostProcesses(io) {
  const rows = typeof io?.procRoot === "string" ? procRows(io.procRoot)
    : !io?.exec && procReadable().ok ? procRows("/proc")
    : lsofRows(io);
  if (!rows.ok) return rows;
  const processes = [];
  for (const { pid, ppid, command, cwd } of rows.rows) {
    if (!pid || pid === process.pid || ppid === process.pid || typeof cwd !== "string") continue;
    const spellings = cwd.endsWith(" (deleted)") ? [cwd, cwd.slice(0, -" (deleted)".length)] : [cwd];
    processes.push({ pid, command: command ?? "?", cwds: spellings.map((p) => canonicalHomePath(p)) });
  }
  return { ok: true, processes };
}
/** The processes of a hostProcesses listing that work in `home`, compared in its on-disk spelling. */
function processesWorkingIn(processes, home) {
  const realHome = canonicalHomePath(home);
  return processes.filter((p) => p.cwds.some((cwd) => cwd === realHome || cwd.startsWith(`${realHome}/`))).map(({ pid, command }) => ({ pid, command }));
}
/** /proc read as a scan: each numeric entry's `cwd` link, `comm` and `stat` (its ppid is the second
 *  field after the last `)`, which ends the command). A pid that cannot be read (it ended meanwhile,
 *  this user may not inspect it, or any other failure on that one pid) is not seen. A root that
 *  cannot be listed, or one that lists no readable process, is a failed scan, never an empty one. */
function procRows(root) {
  let names;
  try { names = readdirSync(root); }
  catch (e) { return { ok: false, error: `${root} cannot be read (${e.code || e.message})` }; }
  const rows = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cwd = readlinkSync(join(root, name, "cwd"));
      const command = readFileSync(join(root, name, "comm"), "utf8").replace(/\n$/, "");
      const stat = readFileSync(join(root, name, "stat"), "utf8");
      rows.push({ pid: Number(name), ppid: Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[1]), command, cwd });
    } catch { /* not seen */ }
  }
  // A real /proc always lists at least this process.
  if (!rows.length) return { ok: false, error: `${root} listed no process` };
  return { ok: true, rows };
}
function lsofRows(io) {
  let out;
  try { out = (io?.exec || execFileSync)("lsof", ["-a", "-d", "cwd", "-F", "pRcn", "-w"], { encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) {
    // lsof exits 1 with a full listing when some process could not be read. That is the one failure
    // whose output is a scan: lsof ended by itself with status 1 (no signal, and no error code, which
    // Node sets when the capture itself failed: a timeout, too much output). A scan that was cut off
    // is a failed scan whatever it printed first. The error says what happened, never a line of the
    // listing.
    const completed = e?.status === 1 && e.signal == null && e.code === undefined;
    if (completed && typeof e.stdout === "string") out = e.stdout;
    else return { ok: false, error: e?.code === "ENOENT" ? "lsof is not on PATH; install lsof"
      : e?.code === "ETIMEDOUT" ? "lsof timed out"
      : e?.code === "ENOBUFS" ? "lsof printed more output than the scan reads"
      : e?.signal ? `lsof was ended by ${e.signal}`
      : String(e?.stderr || e?.message || "lsof failed").trim().split("\n")[0] };
  }
  // A listing holds at least one process (lsof and its caller are always in it), whichever exit it came with.
  if (!/^p\d+$/m.test(String(out))) return { ok: false, error: "lsof listed no process" };
  const rows = [];
  let cur = {};
  for (const line of String(out).split("\n")) {
    const tag = line[0], value = line.slice(1);
    if (tag === "p") { cur = { pid: Number(value) }; rows.push(cur); }
    else if (tag === "R") cur.ppid = Number(value);
    else if (tag === "c") cur.command = value;
    else if (tag === "n") cur.cwd = value;
  }
  return { ok: true, rows };
}

/** The prompt token of a recorded claude or codex command that hands the harness the task's own
 *  text in argv, where any local user can read it: `"$(cat TASK.md)"`. It is parsed, and replaced
 *  when the home starts (withSafeTaskPrompt). */
const LAUNCH_PROMPT_TOKEN = '"$(cat TASK.md)"';

/** Tokenize a persisted OATS launch command. The grammar is exactly what
 *  spawn renders: space-separated tokens that are env assignments NAME='v',
 *  single-quoted words ('...' with '\'' escapes, i.e. shq output), bare words
 *  with no shell metacharacters (flags and capability launch args), the bare
 *  `--` separator, or the exact prompt token "$(cat TASK.md)". Anything else
 *  is refused with its position: the command was not one OATS
 *  generated, and rewriting it would be guessing. Re-rendering joins the
 *  tokens' original text, so untouched tokens are byte-identical. */
export function parseLaunchCommand(command) {
  if (typeof command !== "string" || !command.trim() || command.includes("\0")) throw oatsError("E_LAUNCH_COMMAND_UNSUPPORTED", "instance has no valid persisted launch command to start from");
  const bad = (at, why) => { throw oatsError("E_LAUNCH_COMMAND_UNSUPPORTED", `persisted launch command is not a shape this kernel re-renders (${why} at offset ${at}); inspect the saved command in instance.json before starting this home manually`); };
  const tokens = [];
  const n = command.length;
  let i = 0;
  while (i < n) {
    if (command[i] === " ") { i++; continue; }
    const start = i;
    if (command.startsWith(LAUNCH_PROMPT_TOKEN, i)) {
      i += LAUNCH_PROMPT_TOKEN.length;
      if (i < n && command[i] !== " ") bad(start, "text glued to the prompt token");
      tokens.push({ kind: "prompt", text: LAUNCH_PROMPT_TOKEN });
      continue;
    }
    // NAME="$SOURCE": an environment reference, resolved on the execution
    // host when the command runs; the persisted command carries no value.
    const ref = /^([A-Za-z_][A-Za-z0-9_]*)="\$([A-Za-z_][A-Za-z0-9_]*)"(?= |$)/.exec(command.slice(i));
    if (ref) { tokens.push({ kind: "envref", name: ref[1], source: ref[2], text: ref[0] }); i += ref[0].length; continue; }
    let envName;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)='/.exec(command.slice(i));
    if (m) { envName = m[1]; i += envName.length + 1; }
    if (command[i] === "'") {
      i++;
      let value = "";
      for (;;) {
        if (i >= n) bad(start, "unterminated single quote");
        if (command[i] === "'") {
          if (command.startsWith("'\\''", i)) { value += "'"; i += 4; continue; }
          i++; break;
        }
        value += command[i++];
      }
      if (i < n && command[i] !== " ") bad(start, "text glued to a quoted token");
      const text = command.slice(start, i);
      tokens.push(envName ? { kind: "env", name: envName, value, text } : { kind: "word", value, quoted: true, text });
      continue;
    }
    if (envName) bad(start, "unquoted env value");
    while (i < n && command[i] !== " ") {
      if (/[\s'"$`\\;|&<>(){}*?~#]/.test(command[i])) bad(start, "shell metacharacter outside quotes");
      i++;
    }
    const word = command.slice(start, i);
    tokens.push(word === "--" ? { kind: "sep", text: word } : { kind: "word", value: word, quoted: false, text: word });
  }
  let binary = -1;
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].kind === "env" || tokens[k].kind === "envref") { if (binary >= 0) bad(0, "env assignment after the binary"); continue; }
    if (binary < 0) { if (tokens[k].kind !== "word" || !tokens[k].quoted) bad(0, "no quoted binary after the env prefix"); binary = k; }
  }
  if (binary < 0) bad(0, "no binary");
  let modelIndex = -1;
  for (let k = binary + 1; k < tokens.length; k++) {
    if (tokens[k].kind === "sep") break;
    if (tokens[k].kind === "word" && !tokens[k].quoted && tokens[k].value === "--model") {
      const v = tokens[k + 1];
      if (!v || v.kind !== "word" || v.value.startsWith("-")) bad(0, "--model without a value");
      if (modelIndex >= 0) bad(0, "duplicate --model options");
      modelIndex = k + 1;
      k++;
    }
  }
  return { tokens, binary, modelIndex };
}

/** One tmux command on `socket`. With `env` (a window client: oatsWindowEnvironment, which has no
 *  PATH) the tmux is the absolute one this process's own PATH finds, so its lookup never depends on
 *  the environment it is passed; none found is reported as tmux being unavailable (ENOENT). */
function tmuxOn(socket, args, io, env) {
  let tmux = "tmux";
  if (env) {
    tmux = process.env.PATH === undefined ? null : lookupOnPath("tmux", process.env.PATH);
    if (!tmux) throw Object.assign(new Error("no tmux was found on this process's PATH"), { code: "ENOENT" });
  }
  return (io?.exec || execFileSync)(tmux, ["-u", "-S", socket, ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
}

/** Does this instance.json describe a captured home (the 0.24–0.25 captured/portable path,
 *  removed in 0.26)? It records its incarnation instead of modules. */
export function isCapturedHome(meta) {
  return !!meta && typeof meta === "object" && ["executionBinding", "incarnationId", "captured"].some((key) => Object.hasOwn(meta, key));
}

/** Marker a self-retiring instance leaves BESIDE its home: the retirement is
 *  requested and owed, and a detached completion is on its way. It is not
 *  written into the home, so the caller changes no instance bytes and the
 *  completion's work inspection sees exactly what the instance left. */
export function retirePendingMarkerPath(home) {
  return join(dirname(home), `.oats-retire-pending-${basename(home)}.json`);
}

/** The retire-pending marker of `home` as a status row reads it → `{ retirePending, marker }`: both
 *  undefined when there is none; `retirePending` what it parsed as (a placeholder when it did not
 *  parse), `marker` what retireStateOf takes. */
function readRetirePending(home) {
  const pending = retirePendingMarkerPath(home);
  if (!existsSync(pending)) return {};
  try { const read = JSON.parse(readFileSync(pending, "utf8")); return { retirePending: read, marker: { read } }; }
  catch { return { retirePending: { reason: "retire pending" }, marker: { read: undefined } }; }
}

/** A status row's `retire` (feature status-retire-state, lib/retire-state.mjs): whether a retire of
 *  `home` runs, could not be told, failed or was interrupted, read from what is beside the home
 *  (`marker`: `{ read }` when its retire marker is there, `read` what its file parsed as, undefined
 *  when it did not parse; the row's own read, so `retirePending` and this agree). Only read: no
 *  claim is taken, no file removed, no process signalled. → the value, or undefined when no retire
 *  runs, is scheduled or is owed.
 *  - The marker of a self-retire comes first, whatever the claim says (its completion holds the
 *    claim for its own retire), and gives `self: true`. A completion's result that says `ok:
 *    false` is `failed`, with its time, code and message. Otherwise, a result that says anything
 *    else included, the marker's completion decides: `running` while it lives (pid and recorded
 *    start), `interrupted` once it is gone, and `unknown` when that cannot be read or the marker
 *    names no completion. A marker that does not parse is `unknown`.
 *  - Without a marker, the home's claim held for a retire is `running` while its holder lives and
 *    `unknown` when that cannot be read, with `self: false`. A holder that is gone, a stop's claim
 *    or no claim gives no value.
 *  `since` is required (a reader drops a value without one): the recorded time when it is an
 *  instant as `toISOString()` gives it (the result's `completedAt`, then the marker's
 *  `requestedAt`; the claim's `at`), else the marker's or the claim file's mtime. When none can be
 *  read there is no value at all. */
function retireStateOf(home, marker) {
  const mtimeOf = (path) => { try { return statSync(path).mtime.toISOString(); } catch { return undefined; } };
  // A file beside the home as JSON, only when it is a regular file: opened without blocking and
  // checked on the open descriptor, so a pipe (whose open or read would not return) or a device put
  // there is no value, never a status that hangs. Anything that does not read is undefined.
  const regularJson = (path) => {
    let fd;
    try {
      fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
      return fstatSync(fd).isFile() ? JSON.parse(readFileSync(fd, "utf8")) : undefined;
    } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
  };
  const instantOr = (...times) => times.find((t) => isInstantString(t));
  if (marker) {
    const pending = marker.read, markerTime = () => mtimeOf(retirePendingMarkerPath(home));
    if (!isPlainObject(pending)) return readRetireState({ state: "unknown", self: true, since: markerTime() });
    const result = regularJson(deferredRetireResultPath(home));
    if (isPlainObject(result) && result.ok === false) {
      return readRetireState({ state: "failed", self: true, since: instantOr(result.completedAt, pending.requestedAt) ?? markerTime(), code: result.error?.code, message: result.error?.message });
    }
    const pid = pending.completionPid;
    const state = !Number.isSafeInteger(pid) || pid <= 0 ? "unknown"
      : { alive: "running", gone: "interrupted" }[processLiveness({ pid, processStart: pending.completionStart }).state] ?? "unknown";
    return readRetireState({ state, self: true, since: instantOr(pending.requestedAt) ?? markerTime() });
  }
  // Most rows have no claim: asked without the throw of a read that finds none, which is most of
  // what reading it costs. A path that is not there (a dangling link too) reads as no claim either way.
  // The claim is read as homeClaimHolder reads it (claimAction, processLiveness), through regularJson.
  const lock = retireClaimPath(home);
  if (!existsSync(lock)) return undefined;
  const holder = regularJson(lock);
  if (!isPlainObject(holder) || claimAction(holder) !== "retire") return undefined;
  const { state } = processLiveness(holder);
  if (state !== "alive" && state !== "unknown") return undefined;
  return readRetireState({ state: state === "alive" ? "running" : "unknown", self: false, since: shownHolder(holder).since ?? mtimeOf(lock) });
}

/** Where a deferred self-retirement writes its explicit outcome: a FILE beside
 *  the (former) home, so it survives the home's removal and never reads as an
 *  instance directory. */
export function deferredRetireResultPath(home) {
  return join(dirname(home), `.oats-retired-${basename(home)}.json`);
}

/** The lifecycle claim file of `home`: `<instances>/.oats-retirement/claims/<name>.lock`. Beside
 *  the homes, never inside one: a home's bytes are what its retire observes, copies and removes.
 *  One file for every verb that holds a home (a retire, a stop, an upgrade, a resume): its record
 *  names the holder's verb (`action`) from the instant it exists (lib/claim.mjs `facts`). One file
 *  for every spelling of the home: `<instances>` is the instances directory's own spelling on disk
 *  (canonicalHomePath), and `<name>` the home's name once `.` and `..` are resolved, so that
 *  `H/.`, or `H` through a link to its deployment, names H's claim. */
export function retireClaimPath(home) {
  const at = resolve(home);
  return join(instancesRetirementRoot(canonicalHomePath(dirname(at))), "claims", `${basename(at)}.lock`);
}

/** The verbs that take a home's lifecycle claim: what claimHomeFor accepts, and so every `action`
 *  a claim of the kernel's names. `resume` is a `session start --resume`; `start` is every other
 *  `session start` and `session restart`, a scheduled start included (feature
 *  `lifecycle-claim-start`). A kernel without that feature reads `start` as a retire (claimAction):
 *  its verbs then answer E_INSTANCE_RETIRING beside a start, still before any effect. */
const CLAIM_VERBS = Object.freeze(["retire", "stop", "upgrade", "resume", "start"]);
/** The verb the holder of a home's claim recorded (`action`): one of CLAIM_VERBS, never the
 *  record's text. A claim is read back as whatever is in its file, which other instances of the
 *  deployment can write, and this goes into messages, remedies and `details` (lib/claim.mjs
 *  shownHolder, the same rule for the holder's own fields). Anything else is a retire's, as a
 *  record without one is: a kernel before feature `lifecycle-claim-stop` wrote none, and only its
 *  retire took the claim. */
const claimAction = (holder) => CLAIM_VERBS.includes(holder?.action) ? holder.action : "retire";

/** The kernel a home's last launch pointed its `oats` at (instance.json launch.kernelBin), or null. */
export function recordedKernelBin(home) {
  try { const bin = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"))?.launch?.kernelBin; return typeof bin === "string" ? bin : null; }
  catch { return null; }
}

/** One line for a roster/inspect: `acts as <address> via grant, expires <t>` or `alias <alias> on <team>`. */
export function servedIdentityLine(identity) {
  if (!identity) return null;
  if (identity.mode === "global" && identity.grant) return `acts as ${identity.address || identity.alias || identity.resident || "?"} via grant${identity.grant.expiresAt ? `, expires ${identity.grant.expiresAt}` : ""}`;
  return `alias ${identity.alias || "?"} on ${identity.team || "?"}`;
}

export { CLAIM_VERBS, claimAction, defaultTmuxWindows, directoryRollbackPath, hostProcesses, lookupOnPath, missingSocketUnestablished, namedProcesses, procReadable, processesWorkingIn, readRetirePending, retireStateOf, subdirs, tmuxFailure, tmuxOn, tmuxServerAbsence, unreadableRecordSaid };
