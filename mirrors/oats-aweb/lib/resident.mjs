// `oats aweb resident create <name>`: provisions a GLOBAL resident identity in
// an existing hosted team from the dashboard's API key, serves it with a
// per-user custody unit, and records it as settings.oats.aweb.residents.<name>.
//
// The key is read from AWEB_API_KEY, or, with no key in the environment and a
// terminal, from a prompt that does not echo. It goes into the environment of
// one child only, `aw init`, whose environment is built from nothing, and it is
// scrubbed from everything written or printed. No flag takes a key.
//
// Stages, each with its own error codes: arguments, deployment, aw, preflight
// (no remote effect), key, init (one run, no retry), verify, custody, record.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { awFloorMessage, onPath } from "./binding-wire.mjs";
import { parseAwJson } from "./grant-custody.mjs";
import { assertAwebSettingRecordable, recordAwebSetting } from "./local-settings.mjs";
import { querySelectedKernel } from "./session-readiness.mjs";
import { sameAwebTeamId } from "./aweb-team-id.mjs";
import { selectedTeamKernel } from "./setup-team-default.mjs";
import { normalizeAwebTeamName, selectedDeployment } from "./team-roots.mjs";
import { conflictMessage, custodyLabel, ensureCustodyUnit, foreignUnitMessage, handStep, lingerProblem, ownUnitServes, residentUnits, retireUnitStep, samePath, unitManager, unitPath, waitForCustody } from "./custody-unit.mjs";

export const RESIDENT_USAGE = "usage: AWEB_API_KEY=<key> AWEB_URL=<url> oats aweb resident create <name> [--dir <deployment>] [--root <dir>] [--team-label <label>] [--plan] [--json]";
const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ALIAS_RULE = "aweb aliases must be 1-64 characters, start with a letter or digit, and then contain only letters, digits, '-' or '_'";
const LABEL_RE = /^[a-z0-9][a-z0-9._-]*$/;
const INIT_ARGS = (name) => ["init", "--global", "--name", name, "--do-not-touch-agents-md", "--json"];
const INIT_TIMEOUT_MS = 300000;
const MAX_KEY_LENGTH = 4096; // aw's own limit for a workspace API key
/** The files a complete identity has in its .aw (aw init's certificate connect). */
const COMPLETE = ["identity.yaml", "signing.key", "workspace.yaml"];
const CAPTURE_DIR = ".oats-resident";
const LOCK = "partial-init.yaml.lock";
/** A real directory or regular file at path, by lstat: never through a link. */
const realDir = (path) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
const realFile = (path) => { try { return lstatSync(path).isFile(); } catch { return false; } };

const failure = (code, stage, message, details = {}) => Object.assign(new Error(message), { code, stage, details });
const hostname = (s) => typeof s === "string" && s.length <= 253 && s.split(".").every((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l));
const canonicalTeam = (s) => { const m = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([^:]+)$/.exec(String(s ?? "")); return !!m && hostname(m[2]); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function parseResidentArgs(argv) {
  const usage = () => failure("E_RESIDENT_ARGUMENT", "arguments", RESIDENT_USAGE);
  const [sub, ...rest] = argv;
  if (sub !== "create") throw usage();
  const opts = { plan: false, json: false };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) { if (opts.name !== undefined) throw usage(); opts.name = arg; continue; }
    const [flag, ...inline] = arg.split("=");
    if (seen.has(flag)) throw usage();
    seen.add(flag);
    if (flag === "--plan" || flag === "--json") { if (inline.length) throw usage(); opts[flag.slice(2)] = true; continue; }
    // --soul is the kernel's operator dispatch, forwarded to every command.
    if (!["--dir", "--root", "--team-label", "--soul"].includes(flag)) throw usage();
    const value = inline.length ? inline.join("=") : rest[++i];
    if (!value || value.startsWith("--")) throw usage();
    if (flag === "--dir") opts.dir = value;
    if (flag === "--root") opts.root = value;
    if (flag === "--team-label") opts.teamLabel = value;
  }
  if (opts.name === undefined) throw usage();
  if (!ALIAS_RE.test(opts.name)) throw failure("E_RESIDENT_ARGUMENT", "arguments", `invalid resident name ${JSON.stringify(opts.name)}: ${ALIAS_RULE}`);
  if (opts.teamLabel !== undefined && !LABEL_RE.test(opts.teamLabel)) throw failure("E_RESIDENT_ARGUMENT", "arguments", `invalid --team-label ${JSON.stringify(opts.teamLabel)}: a team label is lowercase letters, digits, '.', '_' or '-', starting with a letter or digit`);
  return opts;
}

/** What R holds: create (empty or missing, or what an init that minted
 *  nothing leaves: our captures and at most an .aw holding only aw's recovery
 *  lock), continue (aw's partial init), rejected (quarantined signing
 *  material), adopt (a complete identity), or anything else, which is refused
 *  naming what is there. */
export function rootState(root) {
  if (!existsSync(root)) return { state: "create" };
  if (!statSync(root).isDirectory()) throw failure("E_RESIDENT_ROOT", "preflight", `${root} is not a directory`);
  const entries = readdirSync(root).sort();
  if (!entries.length) return { state: "create" };
  const dotAw = join(root, ".aw");
  const inAw = existsSync(dotAw) && statSync(dotAw).isDirectory() ? readdirSync(dotAw) : [];
  const rejected = inAw.filter((n) => n.startsWith("partial-init.yaml.") && n.endsWith(".rejected")).sort();
  const partial = inAw.includes("partial-init.yaml");
  const complete = COMPLETE.every((n) => inAw.includes(n));
  const others = entries.filter((n) => n !== ".aw" && n !== CAPTURE_DIR);
  // Our captures are a real directory or nothing: never a file or a link that
  // a capture write would follow out of R.
  if (entries.includes(CAPTURE_DIR) && !realDir(join(root, CAPTURE_DIR))) throw failure("E_RESIDENT_ROOT", "preflight", `${join(root, CAPTURE_DIR)} is not a directory of this command's captures: never write into it: choose another --root or empty it yourself`);
  if (rejected.length) return { state: "rejected", rejected: join(dotAw, rejected[0]) };
  if (complete && !partial) return { state: "adopt" };
  if (partial && !complete && !others.length) return { state: "continue" };
  // aw 1.36.53 takes .aw/partial-init.yaml.lock before an API key's team read;
  // a refused read mints nothing and leaves that lock. Only those exact
  // remnants count, by type, never through a link; nothing is deleted.
  const nothingMinted = !others.length && (!entries.includes(".aw") || (realDir(dotAw) && inAw.every((n) => n === LOCK && realFile(join(dotAw, n)))));
  if (nothingMinted) return { state: "create" };
  throw failure("E_RESIDENT_ROOT", "preflight", `${root} is neither empty, a partial aw init nor a complete global identity: it contains ${entries.join(", ")}; never init into it: choose another --root or empty it yourself`);
}
const needsInit = (state) => state === "create" || state === "continue" || state === "rejected";

/** The key, from AWEB_API_KEY or a prompt that does not echo. */
async function readKey({ env, stdin, stderr, name }) {
  const fromEnv = typeof env.AWEB_API_KEY === "string" ? env.AWEB_API_KEY.trim() : "";
  const key = fromEnv || (stdin.isTTY && stderr.isTTY ? await promptHidden(stdin, stderr) : undefined);
  if (key === undefined) throw failure("E_RESIDENT_KEY", "key", `no AWEB_API_KEY in the environment and no terminal to ask for it on: run AWEB_API_KEY=<key> AWEB_URL=<url> oats aweb resident create ${name}`);
  if (!key) throw failure("E_RESIDENT_KEY", "key", "no API key was entered");
  if (key.length > MAX_KEY_LENGTH || /[\x00-\x1f\x7f]/.test(key)) throw failure("E_RESIDENT_KEY", "key", `the API key must be one line of at most ${MAX_KEY_LENGTH} characters`);
  return key;
}
/** Reads one line from the terminal in raw mode, echoing nothing. */
function promptHidden(stdin, stderr) {
  return new Promise((done, reject) => {
    let value = "";
    const finish = (error) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      // Terminals in bracketed-paste mode wrap a paste in these markers.
      if (error) reject(error); else done(value.replace(/\x1b\[20[01]~/g, "").trim());
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(failure("E_RESIDENT_KEY", "key", "cancelled"));
        if (ch === "\u0004") { if (!value) return finish(failure("E_RESIDENT_KEY", "key", "no API key was entered")); continue; }
        if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    // Echo goes off before the prompt shows, so nothing typed after it is echoed.
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
    stderr.write("aweb API key (input hidden): ");
  });
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const KINDS = ["stdout", "stderr", "exit"];
/** Whether anything, a link included, is at path. */
const present = (path) => { try { lstatSync(path); return true; } catch { return false; } };
/** Keeps aw init's streams and exit under R only, owner-readable. Every file
 *  is new: a stem any earlier capture used, complete or not, is skipped, and
 *  each file is created exclusively, so nothing is overwritten or followed. */
export function writeCaptures(root, r, scrub, second = stamp()) {
  const dir = join(root, CAPTURE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!realDir(dir)) throw failure("E_RESIDENT_ROOT", "init", `${dir} is not a directory of this command's captures`);
  chmodSync(dir, 0o700);
  let at = second;
  for (let n = 2; KINDS.some((kind) => present(join(dir, `init-${at}.${kind}`))); n++) at = `${second}-${n}`;
  const exit = r.error ? (r.error.code === "ETIMEDOUT" ? `timed out after ${INIT_TIMEOUT_MS / 1000} s` : `failed: ${r.error.code || r.error.message}`) : r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
  const files = { stdout: scrub(r.stdout || ""), stderr: scrub(r.stderr || ""), exit: `${exit}\n` };
  const written = Object.entries(files).map(([kind, text]) => {
    const file = join(dir, `init-${at}.${kind}`);
    writeFileSync(file, text, { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    return file;
  });
  return { files: written, exit };
}
/** Replaces every secret's value in text. */
export function scrubber(secrets) {
  const values = [...new Set(secrets.filter((v) => typeof v === "string" && v.length))].sort((a, b) => b.length - a.length);
  return (text) => values.reduce((acc, v) => acc.split(v).join("<redacted>"), String(text ?? ""));
}

/** A field check over aw's answer: throws E_RESIDENT_VERIFY naming the field. */
function expectFields(what, doc, name, fields) {
  const wrong = (field, want) => failure("E_RESIDENT_VERIFY", "verify", `${what} answered ${field} ${JSON.stringify(doc?.[field] ?? null)}, not ${want}`);
  if (!object(doc)) throw failure("E_RESIDENT_VERIFY", "verify", `${what} printed no JSON object`);
  if (fields.includes("status") && doc.status !== "connected") throw wrong("status", "connected");
  if (doc.identity_scope !== "global") throw wrong("identity_scope", "global");
  if (doc.alias !== name) throw wrong("alias", name);
  if (doc.name !== undefined && doc.name !== name) throw wrong("name", name);
  if (fields.includes("team_id") && !canonicalTeam(doc.team_id)) throw wrong("team_id", "a canonical <name>:<namespace> team id");
  if (typeof doc.stable_id !== "string" || !doc.stable_id.startsWith("did:aw:")) throw wrong("stable_id", "a did:aw stable id");
  const [namespace, alias, ...rest] = String(doc.address ?? "").split("/");
  if (!hostname(namespace) || alias !== name || rest.length) throw wrong("address", `<namespace>/${name}`);
  return { address: doc.address, stableId: doc.stable_id, ...(fields.includes("team_id") ? { team: doc.team_id } : {}) };
}

/** aw init's answer: a connected global identity named `name` in a canonical
 *  team, with a stable id and an address. */
export const checkInitAnswer = (doc, name) => expectFields("aw init", doc, name, ["status", "team_id"]);

/** Every offline identity check must be ok: with no identity at all, aw's
 *  doctor answers status ok with each check `info`. */
function identityDoctor(doc, name) {
  const what = "aw doctor identity --offline";
  if (!object(doc) || !Array.isArray(doc.checks)) throw failure("E_RESIDENT_VERIFY", "verify", `${what} printed no checks`);
  const identityChecks = doc.checks.filter((c) => object(c) && String(c.id || "").startsWith("identity."));
  const notOk = identityChecks.filter((c) => c.status !== "ok");
  if (!identityChecks.length) throw failure("E_RESIDENT_VERIFY", "verify", `${what} ran no identity checks`);
  if (notOk.length || doc.status !== "ok") {
    const why = notOk.map((c) => `${c.id} is ${c.status}, not ok${c.message ? ` (${c.message})` : ""}`);
    throw failure("E_RESIDENT_VERIFY", "verify", `${what}: ${why.length ? why.join("; ") : `status is ${doc.status}, not ok`}`);
  }
  const subject = object(doc.subject) ? doc.subject : {};
  if (subject.identity_scope !== "global" || subject.alias !== name) throw failure("E_RESIDENT_VERIFY", "verify", `${what} examined ${subject.alias ?? "no identity"} (${subject.identity_scope ?? "no scope"}), not the global identity ${name}`);
  if (!canonicalTeam(subject.team_id)) throw failure("E_RESIDENT_VERIFY", "verify", `${what} shows team ${JSON.stringify(subject.team_id ?? null)}, not a canonical team id`);
  if (typeof subject.workspace_id !== "string" || !subject.workspace_id) throw failure("E_RESIDENT_VERIFY", "verify", `${what} shows no workspace: the identity is not connected`);
  return { team: subject.team_id };
}

function registryWarnings(read) {
  const what = "aw doctor registry --online";
  let doc;
  try { doc = parseAwJson(read(["doctor", "registry", "--online", "--json"]), what); }
  catch (e) { return [`${what} could not be read (${String(e.message || e).slice(0, 200)}); this can be publication lag`]; }
  if (doc?.status === "ok") return [];
  const failing = (Array.isArray(doc?.checks) ? doc.checks : []).filter((c) => object(c) && !["ok", "info"].includes(c.status));
  return failing.length ? failing.map((c) => `${what}: ${c.id} is ${c.status} (this can be publication lag)`) : [`${what}: status is ${doc?.status ?? "unknown"} (this can be publication lag)`];
}

const SPAWN = (name) => `oats spawn <soul> --provider oats.aweb identity.mode=global --provider oats.aweb identity.resident=${name}`;
const NEXT = (name) => `spawn a seat on this resident: ${SPAWN(name)}`;
const commitLines = (entries) => ["This workspace does not allow local teams; commit the team in oats-workspace.yaml:", ...entries];
const KERNEL_LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONDITIONAL_DEFAULT = "teams-conditional-default";

/** The selected kernel's team commands, failing as E_RESIDENT_TEAM_LABEL at
 *  `stage`. The kernel child gets no aweb or awid variable, the key least of all. */
const kernelEnvOf = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(AWEB_|AWID_)/.test(k)));
function teamKernel(deployment, env, stage) {
  const failed = (e) => failure("E_RESIDENT_TEAM_LABEL", stage, e.message);
  let kernel;
  try { kernel = selectedTeamKernel(deployment, kernelEnvOf(env)); } catch (e) { throw failed(e); }
  const guarded = (f) => (...args) => { try { return f(...args); } catch (e) { throw failed(e); } };
  return { read: guarded(kernel.read), addMapping: guarded(kernel.addMapping), setDefaultIfAbsent: kernel.setDefaultIfAbsent };
}

/** Mapping a team must never replace a default: a plain `oats teams add`
 *  makes the first local team the default, over the workspace's. The kernel's
 *  `--no-default` and `--if-absent` (feature teams-conditional-default, OATS
 *  0.48.0) are the only safe verbs, and an older kernel ignores those flags.
 *  So an older kernel is refused wherever the record stage writes through the
 *  kernel: everywhere but a workspace that allows no local teams, where the
 *  command only prints what to commit. */
function preflightKernel(deployment, env) {
  let version;
  try { version = querySelectedKernel(["--version", "--json"], { env: kernelEnvOf(env) }); }
  catch { throw failure("E_RESIDENT_TEAM_LABEL", "preflight", "the selected OATS kernel (OATS_CLI_BIN) did not answer oats --version --json: run this command as oats aweb resident create"); }
  if (Array.isArray(version?.features) && version.features.includes(CONDITIONAL_DEFAULT)) return;
  if (teamKernel(deployment, env, "preflight").read().localTeams === false) return;
  throw failure("E_RESIDENT_TEAM_LABEL", "preflight", `oats aweb resident create needs OATS 0.48.0 or later (${CONDITIONAL_DEFAULT}), so that mapping the resident's team never replaces a default team; the selected kernel is ${typeof version?.version === "string" ? version.version : "unknown"}: upgrade OATS with \`npm install -g @awebai/oats@latest\`, then rerun`);
}

/** Before an init, a label that already maps to a team is refused: the new
 *  resident's team is known only after aw init, which is a remote effect. */
function preflightTeamLabel(deployment, env, label) {
  const row = teamKernel(deployment, env, "preflight").read().teams.find((r) => r.label === label);
  if (row) throw failure("E_RESIDENT_TEAM_LABEL", "preflight", `team label ${label} already maps to ${row.team ?? "no team"}, and a new resident's team is known only after aw init: run without --team-label if the resident joins that team, or choose another label`);
}

/** The label a team is mapped under without --team-label: its name, the part
 *  of the id before ':', as an aweb team name, and a kernel team label. */
export function derivedTeamLabel(team) {
  let label;
  try { label = normalizeAwebTeamName(String(team).split(":")[0]); } catch { /* refused below */ }
  if (!label || !KERNEL_LABEL_RE.test(label)) throw new Error(`the name of team ${team} is not a team label of at most 64 characters`);
  return label;
}

/** Maps the resident's team under --team-label, or under its derived label,
 *  through the selected kernel, and makes that label the default team only
 *  where the deployment has none. An existing default is never changed. */
function recordTeam(deployment, env, opts, team, { root, custody, localYaml }) {
  const derived = opts.teamLabel === undefined;
  const rerun = () => ["oats aweb resident create", opts.name, ...(opts.dir ? ["--dir", opts.dir] : []), ...(opts.root ? ["--root", opts.root] : []), "--team-label <other>"].join(" ");
  // The identity, custody and residents setting are in place: only the mapping is missing.
  const served = custody.label ? `its custody unit ${custody.label} (${custody.path})` : `its custody, running in ${root}`;
  const refuse = (why) => failure("E_RESIDENT_TEAM_LABEL", "record", `${why}. This check runs after aw init and before the label is written. Already in place: the resident's identity in ${root}, ${served}, and settings.oats.aweb.residents.${opts.name} in ${localYaml}; only the team mapping is missing. Rerun with another label: ${rerun()}. That rerun needs no API key: it verifies the resident and adds the mapping; it is not a second create`);
  let label = opts.teamLabel;
  if (derived) { try { label = derivedTeamLabel(team); } catch (e) { throw refuse(e.message); } }
  const kernel = teamKernel(deployment, env, "record");
  let doc = kernel.read();
  const row = doc.teams.find((r) => r.label === label);
  if (row && !sameAwebTeamId(row.team, team)) {
    if (derived) throw refuse(`the team label ${label}, derived from the name of team ${team}, already maps to ${row.team ?? "no team"}`);
    throw failure("E_RESIDENT_TEAM_LABEL", "record", `team label ${label} already maps to ${row.team ?? "no team"}, not ${team}; choose another --team-label`);
  }
  const result = { label, team, status: row ? "reused" : doc.localTeams === false ? "commit" : "added", derived };
  const other = doc.defaultTeam && doc.defaultTeam.label !== label ? doc.defaultTeam : undefined;
  if (doc.localTeams === false) {
    const entries = [...(row ? [] : ["    teams:", `      ${JSON.stringify(label)}: { team: ${JSON.stringify(team)} }`]), ...(doc.defaultTeam ? [] : [`    defaultTeam: ${JSON.stringify(label)}`])];
    // `oats teams default` is refused there too: a different default is the workspace's to change.
    return { teamLabel: { ...result, default: doc.defaultTeam ? (other ? "kept" : "already") : "commit", ...(entries.length ? { lines: commitLines(entries) } : {}) }, other };
  }
  if (!row) {
    kernel.addMapping(label, team);
    doc = kernel.read();
    if (!sameAwebTeamId(doc.teams.find((r) => r.label === label)?.team, team)) throw failure("E_RESIDENT_TEAM_LABEL", "record", `oats teams add ${label} did not read back as ${team}`);
  }
  if (doc.defaultTeam?.label === label) return { teamLabel: { ...result, default: "already" } };
  if (!doc.defaultTeam) {
    // --if-absent refuses when a default appeared meanwhile: the readback decides.
    let refused;
    try { kernel.setDefaultIfAbsent(label); } catch (e) { refused = e; }
    doc = kernel.read();
    if (doc.defaultTeam?.label === label) return { teamLabel: { ...result, default: "set" } };
    if (!doc.defaultTeam) throw failure("E_RESIDENT_TEAM_LABEL", "record", `oats teams default ${label} --if-absent did not make ${label} the default team${refused ? ` (${refused.message})` : ""}`);
  }
  return { teamLabel: { ...result, default: "kept" }, other: doc.defaultTeam, defaultStep: `oats teams default ${label}` };
}

/** The whole command. Returns the result document; throws a staged failure. */
export async function createResident(opts, { env, stdin, stderr, platform }) {
  const { name } = opts;
  let deployment;
  try { deployment = selectedDeployment(env, opts.dir); }
  catch (e) { throw failure("E_RESIDENT_DEPLOYMENT", "deployment", e.message); }
  let settings;
  try { settings = JSON.parse(env.OATS_SETTINGS || "{}"); } catch { settings = {}; }
  const residents = object(settings) && object(settings.residents) ? settings.residents : {};
  const root = opts.root ? resolve(opts.root) : join(deployment, ".aweb-residents", name);
  // Every failure from here on names the resident's directory, and the
  // captures of the init run when there was one.
  const captures = [];
  try {
    const localYaml = join(deployment, "oats-local.yaml");
    const recorded = typeof residents[name] === "string" ? residents[name] : undefined;
    if (recorded !== undefined && !samePath(recorded, root)) throw failure("E_RESIDENT_ROOT", "preflight", `settings.oats.aweb.residents.${name} already records ${recorded}, not ${root}: pass --root ${recorded} to verify that resident, or choose another name`);

    // Every aw child but init runs with PATH and HOME, and the init's registry
    // when one is set: no key, no identity selector.
    const readEnv = { PATH: env.PATH || "", HOME: env.HOME || "", AW_NO_UPDATE_CHECK: "1", ...(env.AWID_REGISTRY_URL ? { AWID_REGISTRY_URL: env.AWID_REGISTRY_URL } : {}) };
    const floor = await awFloorMessage({ env: readEnv });
    if (floor) throw failure("E_RESIDENT_AW_FLOOR", "aw", floor);
    const aw = onPath("aw", env);
    if (!aw) throw failure("E_RESIDENT_AW_FLOOR", "aw", "aw is not on PATH");
    const read = (args) => {
      const r = spawnSync(aw, args, { cwd: root, env: readEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
      if (r.status !== 0) throw new Error(`aw ${args.slice(0, 2).join(" ")} ${r.error ? `failed: ${r.error.code}` : `exited ${r.status}`}${r.stderr ? `: ${String(r.stderr).trim().slice(0, 300)}` : ""}`);
      return r.stdout;
    };
    const readJson = (args, what, stage = "verify") => {
      try { return parseAwJson(read(args), what); }
      catch (e) { throw failure("E_RESIDENT_VERIFY", stage, `${what}: ${e.message}`); }
    };

    // ---- preflight: nothing here has a remote effect
    const where = { platform, uid: process.getuid?.(), home: env.HOME || "", xdgConfigHome: env.XDG_CONFIG_HOME };
    const { state, rejected } = rootState(root);
    const awebUrl = typeof env.AWEB_URL === "string" && env.AWEB_URL.trim() ? env.AWEB_URL : undefined;
    // A plan has no remote effect: it names the URL the init would use.
    if (needsInit(state) && !awebUrl && !opts.plan) throw failure("E_RESIDENT_ARGUMENT", "preflight", `AWEB_URL is not set: copy the dashboard line, AWEB_API_KEY=<key> AWEB_URL=<url> oats aweb resident create ${name}`);
    const manager = unitManager(platform);
    if (manager) {
      const conflict = residentUnits(where, name).find((u) => !u.root || !samePath(u.root, root));
      if (conflict) throw failure("E_RESIDENT_UNIT_CONFLICT", "preflight", conflictMessage(conflict, root));
    }
    const linger = lingerProblem({ platform, user: userInfo().username, env });
    if (linger) throw failure("E_RESIDENT_LINGER", "preflight", linger);
    try { assertAwebSettingRecordable("residents", name, root, { start: deployment }); }
    catch (e) { throw failure("E_RESIDENT_RECORD", "preflight", e.message); }
    preflightKernel(deployment, env);
    if (opts.teamLabel && needsInit(state)) preflightTeamLabel(deployment, env, opts.teamLabel);
    /** Why the custody answering in R is not this command's unit, or nothing
     *  when our unit's process is what serves it. */
    const notOurCustody = async (label, status) => {
      const own = await ownUnitServes({ platform, label, root, home: env.HOME || "", xdgConfigHome: env.XDG_CONFIG_HOME, uid: process.getuid(), env, socketPath: String(status?.socket_path || "") });
      if (own.serves) return undefined;
      const units = residentUnits(where, name).filter((u) => u.root && samePath(u.root, root));
      // Our unit just failed ownership verification; retiring it cannot stop
      // the custody that is actually answering. Only name another unit.
      const supervisor = units.find((u) => u.label !== label);
      const step = supervisor
        ? `recognised custody unit ${supervisor.label} (${supervisor.path}) is configured for this root: ${retireUnitStep(supervisor, where)}, then rerun; a unit started beside it would restart in a loop against it`
        : `no ${units.length ? "other " : ""}recognised unit was found; find and stop any supervisor outside the recognised units: run \`aw custody stop\` in ${root} (or stop whatever supervises it), then rerun; a unit started beside it would restart in a loop against it`;
      return own.why === "no unit of this command serves it"
        ? `custody for ${name} is already running in ${root}, and not from this command's unit ${label}: ${step}`
        : `custody for ${name} is already running in ${root}, and this command's unit ${label} is not what serves it (${own.why}): ${step}`;
    };
    // A complete identity may already be served by a custody someone started
    // by hand or under another supervisor. A unit started beside it would
    // restart in a loop (aw refuses a second server on a socket that answers),
    // while that other custody answered the readiness check.
    const known = state === "adopt" ? expectFields("aw whoami", readJson(["whoami", "--json"], "aw whoami", "preflight"), name, []) : undefined;
    if (known && manager) {
      const label = custodyLabel(known.address, name);
      let status;
      try { status = parseAwJson(read(["custody", "status", "--json"]), "aw custody status"); } catch { /* unreadable is not running here */ }
      if (status?.status === "running") {
        const problem = await notOurCustody(label, status);
        if (problem) throw failure("E_RESIDENT_CUSTODY_RUNNING", "preflight", problem);
      }
    }

    // A same-root unit under another label must not remain to load at login.
    // Before init no address is known, so no existing label is ours to adopt.
    if (manager) {
      const label = known ? custodyLabel(known.address, name) : undefined;
      const foreign = residentUnits(where, name).find((u) => u.label !== label);
      if (foreign) throw failure("E_RESIDENT_UNIT_CONFLICT", "preflight", foreignUnitMessage(foreign, root, where));
    }

    if (opts.plan) {
      const label = known ? custodyLabel(known.address, name) : `ai.aweb.custody.<domain of the returned address>.${name}`;
      return {
        outcome: "plan", name, root, state,
        ...(rejected ? { rejected } : {}),
        init: needsInit(state) ? { argv: ["aw", ...INIT_ARGS(name)], cwd: root, awebUrl: awebUrl ?? "AWEB_URL from your dashboard line", env: ["PATH", "HOME", "AWEB_URL", "AWEB_API_KEY", "AW_NO_UPDATE_CHECK", ...(env.AWID_REGISTRY_URL ? ["AWID_REGISTRY_URL"] : [])] } : null,
        verify: ["aw whoami --json", "aw doctor identity --offline --json", "aw doctor registry --online --json"].map((c) => `${c} (in ${root}, environment ${env.AWID_REGISTRY_URL ? "PATH, HOME and AWID_REGISTRY_URL" : "PATH and HOME"} only)`),
        custody: manager
          ? { manager, label, path: unitPath(where, known ? label : `ai.aweb.custody.<domain>.${name}`), runs: `${aw} custody serve`, workingDirectory: root, env: ["PATH", "HOME"] }
          : { manager: null, handStep: handStep(root, name) },
        record: `settings.oats.aweb.residents.${name}: ${root} in ${localYaml}`,
        teamLabel: opts.teamLabel
          ? `${opts.teamLabel} → the returned team, with oats teams add --no-default where the workspace allows local teams; it becomes the default team only where there is none`
          : "derived from the returned team's name after aw init, mapped with oats teams add --no-default where the workspace allows local teams, and the default team only where there is none; if that label already maps to another team, the run stops there, after aw init, with the identity, its custody and the residents setting in place, and names the --team-label rerun",
      };
    }

    // ---- key and init
    let identity;
    if (needsInit(state)) {
      let key = await readKey({ env, stdin, stderr, name });
      let scrub = scrubber([key, env.AWEB_API_KEY]);
      const childEnv = { PATH: env.PATH || "", HOME: env.HOME || "", AWEB_URL: env.AWEB_URL, AWEB_API_KEY: key, AW_NO_UPDATE_CHECK: "1", ...(env.AWID_REGISTRY_URL ? { AWID_REGISTRY_URL: env.AWID_REGISTRY_URL } : {}) };
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const r = spawnSync(aw, INIT_ARGS(name), { cwd: root, env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: INIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
      // The key is held for this child only: aw's streams are scrubbed of it
      // here, before anything else reads them, and then it is dropped.
      const stdoutText = scrub(r.stdout || ""), stderrText = scrub(r.stderr || "");
      const written = writeCaptures(root, r, scrub);
      key = undefined; childEnv.AWEB_API_KEY = undefined; scrub = undefined;
      captures.push(...written.files);
      if (r.error || r.status !== 0) {
        let after;
        try { after = rootState(root).state; } catch { after = "other"; }
        const partial = join(root, ".aw", "partial-init.yaml");
        const awText = stderrText.trim() || stdoutText.trim() || `aw init ${written.exit}`;
        const details = { root, captures, partial: existsSync(partial) ? partial : null };
        // Nothing minted: a rerun inits again, once what aw reports is fixed.
        if (after === "create") throw failure("E_RESIDENT_NOTHING_TO_CONTINUE", "init", `${awText}\nnothing was created; fix what aw reports above, then rerun the same command (aw's output is kept in ${captures[1]})`, details);
        if (!["continue", "rejected", "adopt"].includes(after)) {
          throw failure("E_RESIDENT_NOTHING_TO_CONTINUE", "init", `${awText}\nprovisioning left nothing to continue; ${root} contains ${readdirSync(root).sort().join(", ") || "nothing"}; contact aweb with ${captures[1]}`, details);
        }
        throw failure("E_RESIDENT_INIT", "init", awText, details);
      }
      let answer;
      try { answer = parseAwJson(stdoutText, "aw init"); }
      catch (e) { throw failure("E_RESIDENT_VERIFY", "verify", e.message, { root, captures }); }
      identity = checkInitAnswer(answer, name);
    } else {
      identity = known;
    }

    // ---- verify, with the key absent
    const doctor = identityDoctor(readJson(["doctor", "identity", "--offline", "--json"], "aw doctor identity --offline"), name);
    if (identity.team && !sameAwebTeamId(identity.team, doctor.team)) throw failure("E_RESIDENT_VERIFY", "verify", `aw init answered team ${identity.team}, but the identity on disk is in ${doctor.team}`);
    const team = doctor.team;
    const warnings = registryWarnings(read);

    // ---- custody
    const label = custodyLabel(identity.address, name);
    const status = () => read(["custody", "status", "--json"]);
    let custody;
    let unsupported = manager ? undefined : `this host (${platform}) has no supported per-user service manager`;
    if (manager) {
      const conflict = residentUnits(where, name).find((u) => !u.root || !samePath(u.root, root));
      if (conflict) throw failure("E_RESIDENT_UNIT_CONFLICT", "custody", conflictMessage(conflict, root));
      const foreign = residentUnits(where, name).find((u) => u.label !== label);
      if (foreign) throw failure("E_RESIDENT_UNIT_CONFLICT", "custody", foreignUnitMessage(foreign, root, where));
      try {
        const unit = await ensureCustodyUnit({ platform, label, aw, root, home: env.HOME || "", address: identity.address, uid: process.getuid(), env, xdgConfigHome: env.XDG_CONFIG_HOME, rerun: `oats aweb resident create ${name}` });
        custody = { manager: unit.manager, label: unit.label, path: unit.path };
      } catch (e) {
        if (e.code !== "E_RESIDENT_UNIT_UNSUPPORTED") throw failure(e.code || "E_RESIDENT_UNIT", "custody", e.message);
        unsupported = e.message;
      }
    }
    // Ready means our unit's process is the server, not just that a custody answers.
    try { await waitForCustody({ status, resident: name, team, owner: custody ? (ready) => notOurCustody(label, ready) : undefined, timeoutMs: unsupported ? 0 : undefined }); }
    catch (e) {
      if (unsupported) throw failure("E_RESIDENT_UNIT_UNSUPPORTED", "custody", `${unsupported}: ${handStep(root, name)}`);
      throw failure(e.code === "E_RESIDENT_CUSTODY_RUNNING" ? e.code : "E_RESIDENT_CUSTODY", "custody", e.message);
    }
    custody = { status: "running", ...(custody || { manager: null, label: null, path: null }) };

    // ---- record
    if (recorded === undefined) {
      try { recordAwebSetting("residents", name, root, { start: deployment }); }
      catch (e) { throw failure("E_RESIDENT_RECORD", "record", e.message); }
    }
    const { teamLabel, other, defaultStep } = recordTeam(deployment, env, opts, team, { root, custody, localYaml });
    const outcome = state === "create" ? "created" : needsInit(state) ? "resumed" : recorded === undefined ? "adopted" : "already-exists";
    // A seat's grant is minted in the default team: with another default, making
    // this label the default is the operator's step, run first.
    const before = defaultStep ? [defaultStep] : [];
    return {
      outcome, name, root, address: identity.address, team, stableId: identity.stableId,
      custody, recorded: { file: localYaml, setting: `settings.oats.aweb.residents.${name}` },
      teamLabel,
      warnings, captures, next: NEXT(name), steps: [...before, SPAWN(name)],
      // The default step moves the whole deployment's default, not this seat's: say so.
      ...(other ? { stepsReason: `a seat's grant is minted in the deployment's default team, which is ${other.label} (${other.team}), not ${teamLabel.label}${before.length ? `. Running ${before[0]} moves the default team of the whole deployment: every later spawn of a soul without a default team of its own goes to ${teamLabel.label} (${team})` : `; making ${teamLabel.label} the default team is a change to oats-workspace.yaml (defaultTeam:), which this workspace commits`}` } : {}),
      ...(other ? { defaultTeam: { label: other.label, team: other.team } } : {}),
    };
  } catch (e) {
    if (e.stage) e.details = { root, ...(captures.length ? { captures } : {}), ...e.details };
    throw e;
  }
}

function renderText(r) {
  if (r.outcome === "plan") {
    const lines = [`Plan for resident ${r.name} in ${r.root} (${r.state}). Nothing was changed.`];
    if (r.rejected) lines.push(`  ${r.rejected} is quarantined signing material: init runs once and aw refuses it with its own reconciliation message.`);
    if (r.init) lines.push(`  init:    ${r.init.argv.join(" ")}  (in ${r.init.cwd}, against ${r.init.awebUrl}; environment ${r.init.env.join(", ")} only)`);
    for (const v of r.verify) lines.push(`  verify:  ${v}`);
    lines.push(r.custody.manager ? `  custody: ${r.custody.manager} unit ${r.custody.label} at ${r.custody.path}: ${r.custody.runs} in ${r.custody.workingDirectory}, environment PATH and HOME only` : `  custody: ${r.custody.handStep}`);
    lines.push(`  record:  ${r.record}`);
    lines.push(`  team label: ${r.teamLabel}`);
    return lines.join("\n") + "\n";
  }
  const how = { created: "", resumed: " (resumed)", adopted: " (adopted)", "already-exists": " (already exists)" }[r.outcome];
  const lines = [`PASS resident ${r.address} team ${r.team} custody running${how}`];
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  if (r.custody.path) lines.push(`custody: ${r.custody.manager} unit ${r.custody.label} at ${r.custody.path}`);
  lines.push(`recorded: ${r.recorded.setting} in ${r.recorded.file}`);
  const t = r.teamLabel;
  if (t.status === "commit") lines.push(`team label: ${t.label}${t.derived ? " (derived from the team's name)" : ""}, to commit for ${t.team}:`);
  if (t.lines) lines.push(...t.lines);
  if (t.status !== "commit") lines.push(`team label: ${t.label}${t.derived ? " (derived from the team's name)" : ""} ${t.status === "added" ? "mapped to" : "already maps to"} ${t.team}`);
  if (t.default === "set") lines.push(`default team: ${t.label} (set: the deployment had none)`);
  if (t.default === "kept") lines.push(`default team: ${r.defaultTeam.label} (kept; not changed by this command)`);
  if (r.steps.length === 1 && r.stepsReason) lines.push(`Before spawning: ${r.stepsReason}.`);
  if (r.steps.length === 1) lines.push(`Next: ${r.next}`);
  else lines.push(`Next, in order (${r.stepsReason}):`, ...r.steps.map((step, i) => `  ${i + 1}. ${step}`));
  return lines.join("\n") + "\n";
}

/** The command's entrypoint: one JSON-v1 envelope with --json, else text.
 *  Exit 2 for a usage error, 1 for any other failure. Everything printed is
 *  scrubbed of AWEB_API_KEY's value as a last line of defence. */
export async function residentMain(argv, { env = process.env, stdin = process.stdin, stderr = process.stderr, platform = process.platform } = {}) {
  const json = argv.includes("--json");
  const scrub = scrubber([env.AWEB_API_KEY, String(env.AWEB_API_KEY ?? "").trim()]);
  const print = (fd, text) => writeSync(fd, scrub(text));
  try {
    const result = await createResident(parseResidentArgs(argv), { env, stdin, stderr, platform });
    print(1, json ? JSON.stringify({ schemaVersion: 1, ok: true, result }) + "\n" : renderText(result));
    return 0;
  } catch (e) {
    const known = typeof e.code === "string" && e.code.startsWith("E_RESIDENT_");
    const code = known ? e.code : "E_RESIDENT_FAILED", stage = e.stage || "unknown";
    const message = known ? e.message : `resident create failed: ${e.message || e}`;
    if (json) print(1, JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message, details: { stage, ...(e.details || {}) } } }) + "\n");
    else print(2, message === RESIDENT_USAGE ? `${message}\n` : `FAIL ${stage}: ${message}\n`);
    return stage === "arguments" ? 2 : 1;
  }
}
