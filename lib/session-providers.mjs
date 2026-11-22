/** Session providers (docs/capabilities.md "Session providers"; docs/execution-targets.md "Backends"):
 *  a session backend a capability supplies. tmux is the kernel's built-in backend; a provider is a
 *  capability whose manifest declares `sessionProviders.<name>`, four of its own commands the kernel
 *  calls for an instance on that backend: `launch`, `inspect`, `input`, `stop` (and, optionally,
 *  `inspectMany` and `check`). The kernel keeps what a backend must not own: the receipts, the authority check,
 *  the lifecycle claims, the refusals and the JSON answers. This module is the manifest's validator,
 *  the wire and the answers' rules. A leaf: the hot reads (`session inspect`, `status`) call a
 *  provider without loading core.mjs.
 *
 *  Containment, as for `triggerSources`: a malformed `sessionProviders` never refuses the capability.
 *  It is validated where a provider is used; a problem inside one provider disables that provider
 *  only, a malformed top level every provider of the manifest.
 *
 *  The wire. Each call runs the KERNEL'S copy of the home's module, kept outside the home
 *  (lib/home-integrity.mjs: `node <instances>/.oats-retirement/modules/…/<capability>/<script>
 *  <args>`; never the home's own copy), with its working directory OUTSIDE the home (the filesystem root: a call is
 *  never one of the processes that "work in the home", which a resume and a retire look for; the
 *  home is in the request), with the environment a lifecycle hook of that capability gets
 *  there (lib/hook-env.mjs), `OATS_EVENT=session` and `OATS_BACKEND=<name>`; one JSON request on
 *  stdin; exactly one JSON document on stdout; SIGKILL at the verb's timeout. The request is
 *  `{ schemaVersion: 1, phase: "session", capability, provider, verb, input }`; the answer echoes
 *  those five and carries `ok: true, result` or `ok: false, error: { code, message? }`, and no other
 *  key. A call that does not end that way (another exit status, a signal, the timeout, no or
 *  malformed JSON, a wrong envelope, a result that breaks its verb's rules) is a FAILED call, which
 *  is never read as an answer: an inspect that failed is never "stopped". stderr is never read. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { canonicalJson, parseStrictJson } from "./canonical-json.mjs";
import { oatsError } from "./errors.mjs";
import { instanceSoulDir, lifecycleHookEnv } from "./hook-env.mjs";
import { capabilityRuntimeOf, moduleCopyProblem, providerHomeTrust, recordsModule, runDirOf } from "./home-integrity.mjs";
import { BUILTIN_SESSION_BACKENDS, SESSION_PROVIDERS_FEATURE, SESSION_PROVIDER_NAME_RE } from "./kernel-features.mjs";
import { REFUSED_TEXT, safeText } from "./refused-text.mjs";
import { dieAt, diesDuring } from "./provider-test-seams.mjs";
import { recordedTeams } from "./teams.mjs";

export { BUILTIN_SESSION_BACKENDS, SESSION_PROVIDERS_FEATURE, SESSION_PROVIDER_NAME_RE };
/** Names no provider may take: the built-in backend; the word a `requires` row's `backends` uses for
 *  any session provider (SESSION_PROVIDER_ANY); and the backend that was removed (`--backend herdr` is
 *  read only to be refused). */
export const SESSION_PROVIDER_ANY = "session-provider";
const RESERVED_NAMES = new Set(["tmux", SESSION_PROVIDER_ANY, "herdr"]);
/** Whether `name` is one a session provider can have: the one rule for a manifest's key, a
 *  receipt's or a record's `backend`, and a row another host relays. */
export const isSessionProviderName = (name) => typeof name === "string" && SESSION_PROVIDER_NAME_RE.test(name) && !RESERVED_NAMES.has(name);
const REQUIRED_VERBS = ["launch", "inspect", "input", "stop"];
const OPTIONAL_VERBS = ["inspectMany", "check"];
const PROVIDER_KEYS = ["commands", "harnesses", "description", "wire"];
/** The version of the wire this kernel speaks with a session provider (docs/capabilities.md "The
 *  call"). One version: a provider declares it (`sessionProviders.<name>.wire`), and one that
 *  declares none, or another, is never called (wireRefusal); every request carries it, so a
 *  provider can refuse a kernel that speaks another. */
export const SESSION_PROVIDER_WIRE = "1.3";
/** Why a provider is not called: it speaks another wire than this kernel → `{ code:
 *  "E_BACKEND_WIRE", message, details }` naming both versions, or null when they agree. A provider
 *  that declares no `wire` is one from before the key: wire 1.2. */
export function wireRefusal(capability, provider) {
  if (provider.wire === SESSION_PROVIDER_WIRE) return null;
  const theirs = provider.wire ?? "1.2 (it declares none)";
  return { code: "E_BACKEND_WIRE", message: `${capability}'s session provider ${provider.name} speaks wire ${theirs}, and this kernel speaks ${SESSION_PROVIDER_WIRE}: they must be the same. Use the release of ${capability} that goes with this OATS`, details: { backend: provider.name, capability, wire: { provider: provider.wire ?? null, kernel: SESSION_PROVIDER_WIRE } } };
}
const HARNESS_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_PROVIDERS = 16, MAX_HARNESSES = 16, DESCRIPTION_MAX = 200;
/** An endpoint is a JSON object of at most this many bytes of canonical JSON (4 KiB). */
export const ENDPOINT_MAX_BYTES = 4096;
/** A capability id as a home's module directory is named (lib/package-catalog.mjs PACKAGE_ID_RE). */
const CAPABILITY_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const WIRE_LIMITS = Object.freeze({ maxBytes: 1024 * 1024, maxDepth: 32, maxEntries: 16384 });
const CODE_RE = /^E_[A-Z0-9_]{1,60}$/;
const MESSAGE_MAX = 500;
/** At most this many homes in one `inspectMany` call. */
export const INSPECT_MANY_MAX = 200;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const pointerOf = (...tokens) => tokens.map((t) => `/${String(t).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
const oneLine = (v, max) => typeof v === "string" && v.length > 0 && [...v].length <= max && !REFUSED_TEXT.test(v);

// ------------------------------------------------------------------------------------- the manifest

function checkProvider(manifest, name, decl, problems) {
  const at = (...tokens) => pointerOf("sessionProviders", name, ...tokens);
  const bad = (pointer, message) => problems.push({ provider: name, pointer, message: `session provider ${JSON.stringify(name)}: ${message}` });
  const sound = problems.length;
  if (!SESSION_PROVIDER_NAME_RE.test(name)) bad(at(), "the name must be 1 to 40 lowercase letters, digits and dashes, starting with a letter or digit");
  else if (RESERVED_NAMES.has(name)) bad(at(), `the name ${name} is reserved for the kernel`);
  if (!isObject(decl)) { bad(at(), "must be an object { commands, harnesses, description? }"); return null; }
  for (const k of Object.keys(decl)) if (!PROVIDER_KEYS.includes(k)) bad(at(k), `unknown key ${JSON.stringify(k)} (allowed: ${PROVIDER_KEYS.join(", ")})`);
  if (decl.description !== undefined && !oneLine(decl.description, DESCRIPTION_MAX)) bad(at("description"), `description must be one line of at most ${DESCRIPTION_MAX} characters`);
  // Any version is a sound declaration: one that is not this kernel's is refused where the provider is used (wireRefusal).
  if (decl.wire !== undefined && !(typeof decl.wire === "string" && /^[0-9]{1,3}\.[0-9]{1,3}$/.test(decl.wire))) bad(at("wire"), 'wire must be the wire version the provider speaks, as "<major>.<minor>"');

  const harnesses = decl.harnesses;
  if (!Array.isArray(harnesses) || harnesses.length < 1 || harnesses.length > MAX_HARNESSES) bad(at("harnesses"), `harnesses must list 1 to ${MAX_HARNESSES} harness names`);
  else harnesses.forEach((h, i) => {
    if (typeof h !== "string" || !HARNESS_NAME_RE.test(h)) bad(at("harnesses", i), "a harness name is 1 to 40 lowercase letters, digits and dashes, starting with a letter");
    else if (harnesses.indexOf(h) !== i) bad(at("harnesses", i), `harness ${JSON.stringify(h)} is listed twice`);
  });

  const manifestCommands = isObject(manifest.commands) ? manifest.commands : {};
  const commands = {};
  if (!isObject(decl.commands)) bad(at("commands"), `commands must be an object naming ${REQUIRED_VERBS.join(", ")} (and optionally ${OPTIONAL_VERBS.join(", ")})`);
  else {
    for (const k of Object.keys(decl.commands)) if (![...REQUIRED_VERBS, ...OPTIONAL_VERBS].includes(k)) bad(at("commands", k), `unknown verb ${JSON.stringify(k)} (verbs: ${[...REQUIRED_VERBS, ...OPTIONAL_VERBS].join(", ")})`);
    for (const verb of [...REQUIRED_VERBS, ...OPTIONAL_VERBS]) {
      const command = decl.commands[verb];
      if (command === undefined) { if (REQUIRED_VERBS.includes(verb)) bad(at("commands", verb), `commands.${verb} is required`); continue; }
      const spec = typeof command === "string" && Object.hasOwn(manifestCommands, command) ? manifestCommands[command] : undefined;
      if (typeof command !== "string" || !command) bad(at("commands", verb), `commands.${verb} must name one of the manifest's commands`);
      else if (typeof spec !== "string" || !spec.trim()) bad(at("commands", verb), `commands.${verb}: ${JSON.stringify(command)} is not one of the manifest's commands`);
      else { const [script, ...args] = spec.trim().split(/\s+/); commands[verb] = { command, script, args }; }
    }
  }
  if (problems.length > sound) return null;
  return { name, description: decl.description ?? null, harnesses: [...harnesses], commands, wire: decl.wire ?? null };
}

/** A manifest's session providers, validated where they are used. Never throws, whatever `manifest`
 *  is. → { providers: { <name>: { name, description, harnesses, commands: { <verb>: { command, script,
 *  args } } } }, problems: [{ provider, pointer, message }] }: `providers` holds only the well-formed
 *  ones; `provider` is null for a top-level problem. */
export function sessionProvidersOf(manifest) {
  const out = { providers: {}, problems: [] };
  const decl = isObject(manifest) ? manifest.sessionProviders : undefined;
  if (decl === undefined) return out;
  if (!isObject(decl)) { out.problems.push({ provider: null, pointer: "/sessionProviders", message: "sessionProviders must be an object of named session providers" }); return out; }
  const names = Object.keys(decl);
  if (names.length > MAX_PROVIDERS) { out.problems.push({ provider: null, pointer: "/sessionProviders", message: `sessionProviders declares ${names.length} providers; at most ${MAX_PROVIDERS}` }); return out; }
  for (const name of names) {
    const problems = [];
    const provider = checkProvider(manifest, name, decl[name], problems);
    if (provider) out.providers[name] = provider;
    else out.problems.push(...problems);
  }
  return out;
}

/** The session backends a set of capabilities offers: [{ name, capability, harnesses, description }],
 *  sorted by name then capability, with the problems of the malformed ones. `capabilities`:
 *  [{ id, manifest }]. A name two capabilities declare is listed twice: `--backend` refuses it. */
export function offeredSessionProviders(capabilities) {
  const providers = [], problems = [];
  for (const cap of capabilities || []) {
    const found = sessionProvidersOf(cap?.manifest);
    for (const p of Object.values(found.providers)) providers.push({ name: p.name, capability: cap.id, harnesses: p.harnesses, description: p.description });
    for (const problem of found.problems) problems.push({ capability: cap.id, ...problem });
  }
  providers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0));
  return { providers, problems };
}

/** E_BACKEND_AMBIGUOUS: two or more capabilities of one instance declare the provider `name`. */
export function ambiguousBackend(name, capabilities, nothing) {
  return Object.assign(oatsError("E_BACKEND_AMBIGUOUS", `session backend ${JSON.stringify(name)} is declared by ${capabilities.join(" and ")}; one name has one meaning in an instance: compose only one of them; ${nothing}`), { details: { backend: name, capabilities } });
}
/** What `--backend <name>` selects among `capabilities` ([{ id, manifest }]), for `harness`:
 *  `{ backend: "tmux" }` for the built-in one, else `{ backend: name, capability, provider }`.
 *  Refused before anything is created: E_BACKEND_UNKNOWN (no capability of this instance declares
 *  it, or declares it malformed; the message names the backends available), E_BACKEND_AMBIGUOUS
 *  (two capabilities declare the name), E_BACKEND_HARNESS (the provider does not list the harness).
 *  `nothing` ends each refusal: what the caller has not done ("nothing was created", a spawn's). */
export function selectSessionBackend(name, capabilities, harness, nothing = "nothing was created") {
  if (name === undefined || name === null || BUILTIN_SESSION_BACKENDS.includes(name)) return { backend: "tmux" };
  const { providers, problems } = offeredSessionProviders(capabilities);
  const matches = providers.filter((p) => p.name === name);
  if (matches.length > 1) throw ambiguousBackend(name, matches.map((p) => p.capability), nothing);
  if (!matches.length) {
    const available = [...BUILTIN_SESSION_BACKENDS, ...new Set(providers.map((p) => p.name))];
    const broken = problems.find((p) => p.provider === name || p.provider === null);
    throw Object.assign(oatsError("E_BACKEND_UNKNOWN", safeText(`unknown session backend ${JSON.stringify(name)}: ${broken ? `capability ${broken.capability} declares it malformed: ${broken.message} (at ${broken.pointer})` : "no capability of this instance declares it as a session provider"}; the backends available here: ${available.join(", ")}; ${nothing}`, 2000)), { details: { backend: String(name).slice(0, 80), available } });
  }
  const [match] = matches;
  const provider = sessionProvidersOf((capabilities || []).find((c) => c.id === match.capability).manifest).providers[name];
  const wire = wireRefusal(match.capability, provider);
  if (wire) throw Object.assign(oatsError(wire.code, `${wire.message}; ${nothing}`), { details: wire.details });
  if (harness !== undefined && !match.harnesses.includes(harness)) throw Object.assign(oatsError("E_BACKEND_HARNESS", `session backend ${name} (${match.capability}) does not run the ${harness} harness; it runs ${match.harnesses.join(", ")}; ${nothing}`), { details: { backend: name, capability: match.capability, harness, harnesses: match.harnesses } });
  return { backend: name, capability: match.capability, provider };
}

// --------------------------------------------------------------------------------------- the records

/** Whether `endpoint` is one the kernel records: a JSON object whose canonical JSON (sorted keys, no
 *  whitespace; its final line feed not counted) is at most ENDPOINT_MAX_BYTES. */
export function validEndpoint(endpoint) {
  if (!isObject(endpoint)) return false;
  try { return Buffer.byteLength(canonicalJson(endpoint, WIRE_LIMITS)) - 1 <= ENDPOINT_MAX_BYTES; } catch { return false; }
}
/** Two endpoints are the same JSON. */
export function sameEndpoint(a, b) {
  try { return canonicalJson(a, WIRE_LIMITS) === canonicalJson(b, WIRE_LIMITS); } catch { return false; }
}
/** A launch that was SENT to a provider and whose outcome OATS has not recorded: the instant it was
 *  sent (`runtime.launchSent`, in the home's receipt, outside the home), or null. The kernel writes
 *  it right before it calls the provider's launch and takes it away when the endpoint is recorded
 *  or the launch is known to have started nothing. One that is still there afterwards is a spawn or
 *  a start that ended first (killed, its host stopped): a session may run that no record names, so
 *  every verb that acts on the home first asks the provider to stop whatever session is rooted at
 *  it (`stop` with `endpoint: null`), and its reads are unknown, never "not launched". undefined
 *  when the field is there and is no instant.
 *
 *  On a home that was never launched the receipt reads `{ launched: true, backend, provider,
 *  launchSent }` meanwhile, with no endpoint: a kernel from before session providers refuses such
 *  a receipt (a launch with no tmux endpoint) instead of reading the home as one it may retire. */
export function launchSentOf(runtime) {
  const sent = runtime?.launchSent ?? null;
  return sent === null ? null : typeof sent === "string" && Number.isFinite(Date.parse(sent)) ? sent : undefined;
}
/** What a read says of a home whose provider was sent a launch that has no recorded outcome. True
 *  of both cases, which a read does not tell apart: the launch is in progress, or its command ended. */
export function unsettledLaunchSaid(name, backend, sent) {
  return `a launch of ${name} was sent to session backend ${backend} at ${sent} and its outcome is not recorded: a spawn or a start is launching it now, or ended before recording it, and whether a session runs is not known. If no such command is running, a stop (oats instance stop ${name} --plan, then --apply) or a start (oats session start --home) first asks the backend to stop whatever session that launch started`;
}
/** A receipt's `runtime` as a launched provider home's authority, or undefined when it is not one:
 *  `{ launched: true, backend, provider, endpoint, stoppedAt, launchSent }`. `backend` is the provider's name,
 *  `provider` the capability that supplies it; `stoppedAt` is an instant or null (OATS stopped this
 *  session, and no start has cleared it). Which stop wrote it (an operator's, or the host's
 *  shutdown, which a resume brings back) is the home's stop receipt's to say (lib/session-end.mjs),
 *  as for a tmux home, never a second field here. */
export function providerRuntimeOf(runtime) {
  if (!isObject(runtime) || runtime.launched !== true || runtime.tmux !== undefined || runtime.sessionTarget !== undefined) return undefined;
  if (!isSessionProviderName(runtime.backend)) return undefined;
  if (typeof runtime.provider !== "string" || !CAPABILITY_ID_RE.test(runtime.provider) || !validEndpoint(runtime.endpoint)) return undefined;
  const stoppedAt = runtime.stoppedAt ?? null;
  if (stoppedAt !== null && !(typeof stoppedAt === "string" && Number.isFinite(Date.parse(stoppedAt)))) return undefined;
  const launchSent = launchSentOf(runtime);
  if (launchSent === undefined) return undefined;
  return { launched: true, backend: runtime.backend, provider: runtime.provider, endpoint: runtime.endpoint, stoppedAt, launchSent };
}
/** The receipt's `runtime` for a launched provider home (`launchSent`: only while a launch that was
 *  sent has no recorded outcome, launchSentOf). */
export function providerRuntimeRecord({ backend, provider, endpoint, stoppedAt = null, launchSent = null }) {
  return { launched: true, backend, provider, endpoint, stoppedAt, ...(launchSent ? { launchSent } : {}) };
}
/** The fields of instance.json's session that differ from the one the receipt authorises, as fixed
 *  labels in a fixed order: `backend`, `session.provider`, `session.endpoint`. */
export function providerEndpointDifferences(meta, authority) {
  return [
    ...(meta?.backend === authority.backend ? [] : ["backend"]),
    ...(meta?.session?.provider === authority.provider ? [] : ["session.provider"]),
    ...(isObject(meta?.session?.endpoint) && sameEndpoint(meta.session.endpoint, authority.endpoint) ? [] : ["session.endpoint"]),
  ];
}

// ------------------------------------------------------------------------------------------ the wire

/** A verb's timeout in ms: launch 120 s, the others 20 s; a stop also gets the grace it gives its
 *  session. OATS_TEST_SESSION_PROVIDER_TIMEOUT_MS (a test's seam) shortens every one: a value
 *  above the kernel's own limit is that limit, so the seam never makes a call wait longer. */
export function sessionProviderTimeout(verb, { graceSeconds = 0 } = {}) {
  const own = verb === "launch" ? 120_000 : verb === "stop" ? 20_000 + graceSeconds * 1000 : 20_000;
  const seam = Number(process.env.OATS_TEST_SESSION_PROVIDER_TIMEOUT_MS);
  return seam > 0 ? Math.min(seam, own) : own;
}

/** A provider as one home runs it → `{ binding }`, or `{ problem }` (one sentence) when the home
 *  cannot: its module copy or manifest is missing or unreadable (a capability an upgrade removed),
 *  or the manifest no longer declares the provider soundly. `meta`: the home's record (instance.json)
 *  as the caller holds it; `capability` and `name` come from the receipt, never from the record alone.
 *  binding: `{ home, meta, capability, name, provider, moduleDir, cap, digest }`: `cap` the
 *  capability's runtime row (its captured settings), `digest` what tells its module copy from
 *  another home's (for a provider home, the module's source as its receipt records it).
 *
 *  A home whose receipt names a session provider is bound from that receipt
 *  (lib/home-integrity.mjs): `moduleDir` is the KERNEL's copy of the capability, outside the home,
 *  whose manifest is read and whose commands are run, never the home's own copy; with no such
 *  copy `{ problem }` names the module (a read then shows the home unavailable, never stopped);
 *  and `cap` is the receipt's row, never the home's own record's. A home with no receipt yet (a
 *  spawn, before it writes one) is bound from its own fresh copy and the rows the spawn holds. */
export function homeSessionProvider(home, meta, capability, name) {
  if (typeof capability !== "string" || !CAPABILITY_ID_RE.test(capability)) return { problem: `the session provider's capability id ${JSON.stringify(capability)} is not a capability id` };
  const trust = providerHomeTrust(home);
  const moduleDir = runDirOf(home, capability, trust);
  const gone = () => `capability ${capability}, which supplies this home's session backend ${name}, is not among the home's modules (${moduleDir}); respawn the instance from a deployment that composes it`;
  // (A capability an upgrade removed: the receipt records no copy of it any more.)
  if (trust?.composition && !recordsModule(trust, capability)) return { problem: gone() };
  const untrusted = moduleCopyProblem(home, capability, trust);
  if (untrusted) return { problem: untrusted };
  let manifest;
  try { manifest = parseStrictJson(readFileSync(join(moduleDir, "oats.json")), WIRE_LIMITS); }
  catch (e) { return { problem: e?.code === "ENOENT" ? gone() : `the manifest of capability ${capability} in ${moduleDir} cannot be read (${safeText(e?.message ?? e, 200)})` }; }
  if (!isObject(manifest) || manifest.capability !== capability) return { problem: `${join(moduleDir, "oats.json")} is not the manifest of capability ${capability}` };
  const { providers, problems } = sessionProvidersOf(manifest);
  const provider = Object.hasOwn(providers, name) ? providers[name] : null;
  if (!provider) {
    const broken = problems.find((p) => p.provider === name || p.provider === null);
    return { problem: safeText(broken ? `capability ${capability} declares session provider ${name} malformed: ${broken.message} (at ${broken.pointer})` : `capability ${capability} no longer declares session provider ${name}`, 1000) };
  }
  const row = capabilityRuntimeOf(home, meta, trust).find((c) => c?.id === capability);
  // (`providers`: what a home from before `capabilityRuntime` recorded; never read for a provider home.)
  const settings = isObject(row?.settings) ? row.settings : !trust && isObject(meta?.providers?.[capability]) ? meta.providers[capability] : {};
  const cap = { id: capability, layer: row?.layer ?? manifest.layer ?? "", level: row?.level ?? "", settings, settingsOrigins: isObject(row?.settingsOrigins) ? row.settingsOrigins : {} };
  // (`digest`: what tells two homes' copies of a provider apart, for one inspectMany call. For a
  // provider home, whose own record is not read: the module's source, and with none recorded the
  // store of the kernel's copy, which is this home's alone.)
  const source = trust ? trust.composition.modules[capability] : null;
  const digest = trust ? (source.from || source.commit ? canonicalJson(source) : `store:${trust.composition.store}`) : typeof meta?.modules?.[capability]?.digest === "string" ? meta.modules[capability].digest : null;
  return { binding: { home, meta: meta ?? {}, capability, name, provider, moduleDir, cap, digest } };
}

/** An executable inside the module copy: both sides realpath'd (a symlink out of the module is an
 *  escape), a regular file; null otherwise. */
function moduleExecutable(dir, script) {
  let root, file;
  try { root = realpathSync(dir); file = realpathSync(resolve(dir, script)); } catch { return null; }
  const rel = relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}

/** The environment a provider's command runs with in its home: a lifecycle hook's (lib/hook-env.mjs),
 *  as the home's launch hooks get it, with OATS_EVENT=session and OATS_BACKEND. */
function providerEnvironment({ home, meta, cap, name, soulId }) {
  const workspace = isObject(meta.workspace) ? meta.workspace : null;
  return lifecycleHookEnv("session", cap, {
    home, instance: typeof meta.instance === "string" ? meta.instance : basename(home), agentName: typeof meta.agent === "string" ? meta.agent : "",
    // (`soulId`: a spawn's, for a call it makes before the home's record names its soul.)
    soulDir: instanceSoulDir(home, meta), ...(typeof soulId === "string" && soulId ? { soulId } : {}), contextDir: home, rootDir: dirname(dirname(dirname(home))),
    resolved: { workspace, ...recordedTeams(meta), teamsSource: "recorded" },
    priorMeta: isObject(meta.capabilityMeta) ? meta.capabilityMeta : {},
    extraEnv: { OATS_BACKEND: name, ...(typeof meta.harness === "string" ? { OATS_HARNESS: meta.harness } : {}) },
  });
}

/** A provider's refusal as it gives it (`{ code, message? }`: an envelope's `error`, an inspectMany
 *  entry's) → `{ code, message }`, the message made safe to print and cut (`fallback` when it gives
 *  none), or null when it is no refusal in the wire's shape. */
function refusalOf(e, fallback) {
  if (!isObject(e) || typeof e.code !== "string" || !CODE_RE.test(e.code) || (e.message !== undefined && typeof e.message !== "string") || Object.keys(e).some((k) => k !== "code" && k !== "message")) return null;
  return { code: e.code, message: safeText(e.message ?? fallback, MESSAGE_MAX) };
}
/** What runs a provider's command: the kernel's own process, the leader of a process group made
 *  for the call (lib/provider-call-child.mjs). */
const PROVIDER_CALL_CHILD = fileURLToPath(new URL("./provider-call-child.mjs", import.meta.url));
/** One call of a provider's verb → `{ ok: true, result }` (the result as answered, not yet judged
 *  by its verb's rules), `{ ok: false, refused: { code, message } }` (the provider's own refusal,
 *  made safe to print) or `{ ok: false, failed: "<why, one sentence>" }` (a failed call). Never
 *  throws. `io.spawnSync` is the process seam.
 *
 *  The command runs in a process group of its own, which a timeout ends whole. `groupFile`: where
 *  the group's leader records who it is before the provider runs (a path outside the home, of a
 *  file that does not exist yet), for a call whose effects must be ended if this kernel is killed
 *  while it waits: a launch, an input, a stop (lib/core.mjs markProviderCall). */
export function callSessionProvider(binding, verb, input, { timeoutMs = sessionProviderTimeout(verb), io, groupFile = null } = {}) {
  // `binding.home` is null, with `binding.env`, for a soul's readiness check: no home exists yet.
  const { capability, name, provider, moduleDir, home } = binding;
  const said = `${capability}'s session provider ${name}`;
  // A provider that speaks another wire is never called: every read of its session is unavailable.
  const wire = wireRefusal(capability, provider);
  if (wire) return { ok: false, failed: wire.message };
  const declared = provider.commands[verb];
  if (!declared) return { ok: false, failed: `${said} declares no ${verb} command` };
  const file = moduleExecutable(moduleDir, declared.script);
  if (!file) return { ok: false, failed: `${said}: the ${verb} command ${declared.command} (${declared.script}) is not a file inside ${home ? "the home's" : "this"} copy of ${capability}` };
  const request = { schemaVersion: 1, wire: SESSION_PROVIDER_WIRE, phase: "session", capability, provider: name, verb, input };
  let r;
  try {
    // (SIGTERM at the timeout: the group's leader answers it by ending the whole group, by SIGKILL.)
    // Tests' seams, for the leader (lib/provider-call-child.mjs): it starts late; it kills this kernel.
    const lateLeader = groupFile ? process.env.OATS_TEST_PROVIDER_LEADER_DELAY_MS : undefined;
    const seams = { ...(lateLeader ? { OATS_TEST_PROVIDER_LEADER_DELAY_MS: lateLeader } : {}), ...(diesDuring(verb) ? { OATS_TEST_PROVIDER_KILL_KERNEL: "1" } : {}) };
    dieAt(`call:${verb}:before`);
    r = (io?.spawnSync || spawnSync)(process.execPath, [PROVIDER_CALL_CHILD, groupFile ?? "-", file, ...declared.args], { cwd: parse(file).root, env: { ...(binding.env ?? providerEnvironment(binding)), ...seams }, input: JSON.stringify(request), encoding: "utf8", timeout: Math.max(1, timeoutMs), killSignal: "SIGTERM", detached: true, maxBuffer: WIRE_LIMITS.maxBytes, stdio: ["pipe", "pipe", "ignore"] });
  } catch (e) { return { ok: false, failed: `${said}: the ${verb} command could not be run (${safeText(e?.code ?? e?.message ?? e, 120)})` }; }
  dieAt(`call:${verb}:after`);
  if (r.error?.code === "ETIMEDOUT") return { ok: false, timedOut: true, failed: `${said} did not answer ${verb} within ${Math.round(timeoutMs / 1000)} s and was killed` };
  if (r.error?.code === "ENOBUFS") return { ok: false, failed: `${said} answered ${verb} with more than the wire's 1 MiB` };
  if (r.error) return { ok: false, failed: `${said}: the ${verb} command could not be run (${safeText(r.error.code ?? r.error.message, 120)})` };
  if (r.signal) return { ok: false, failed: `${said}: the ${verb} command ended on signal ${r.signal}` };
  if (r.status === 125) return { ok: false, failed: `${said}: the ${verb} command was not run (the call could not be recorded, or was ended before it began)` };
  if (r.status !== 0) return { ok: false, failed: `${said}: the ${verb} command exited ${r.status}` };
  let doc;
  try { doc = parseStrictJson(r.stdout || "", WIRE_LIMITS); } catch { return { ok: false, failed: `${said} did not answer ${verb} with exactly one JSON document` }; }
  const malformed = (why) => ({ ok: false, failed: `${said} answered ${verb} with a malformed envelope: ${why}` });
  if (!isObject(doc)) return malformed("not a JSON object");
  const keys = doc.ok === true ? ["schemaVersion", "phase", "capability", "provider", "verb", "ok", "result"] : doc.ok === false ? ["schemaVersion", "phase", "capability", "provider", "verb", "ok", "error"] : null;
  if (!keys) return malformed("ok must be true or false");
  if (Object.keys(doc).some((k) => !keys.includes(k)) || keys.some((k) => !Object.hasOwn(doc, k))) return malformed(`its keys must be exactly ${keys.join(", ")}`);
  for (const k of ["schemaVersion", "phase", "capability", "provider", "verb"]) if (doc[k] !== request[k]) return malformed(`${k} must echo the request's ${JSON.stringify(request[k])}`);
  if (doc.ok === false) {
    const refused = refusalOf(doc.error, `${said} refused ${verb}`);
    return refused ? { ok: false, refused } : malformed("error must be { code, message? }, its code E_ and capitals, digits or underscores");
  }
  return { ok: true, result: doc.result };
}
/** What a call that gave no result says, in one sentence: the failure, or the provider's refusal. */
export const providerSaid = (answer) => answer.failed ?? `${answer.refused.code}: ${answer.refused.message}`;

// ------------------------------------------------------------------------------ the answers' rules

const exactKeys = (v, required, optional = []) => isObject(v) && required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
const STATES = ["unknown", "shell", "stopped"];
/** `open`: what a client may show instead of a terminal, `{ label, url }`: a one-line label of at
 *  most 100 characters and an http(s) URL of at most 2000, printable ASCII, without credentials. */
function validOpen(open) {
  if (!exactKeys(open, ["label", "url"]) || !oneLine(open.label, 100)) return false;
  if (typeof open.url !== "string" || open.url.length > 2000 || !/^[\x21-\x7e]+$/.test(open.url)) return false;
  let u; try { u = new URL(open.url); } catch { return false; }
  return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
}
/** A status row's session-provider facts as ANOTHER host reports them (a remote roster's relay,
 *  lib/servers.mjs), each kept only in the shape this kernel itself answers: `backend` a provider's
 *  name, `session` `{ provider }` and nothing more, `open` `{ label, url }` or null, `runtimeState`
 *  one of the row's words. A provider's own locator never leaves its host: no endpoint and no thread
 *  id is relayed, whatever the host sent. → those keys, or null when the row is not a session
 *  provider's (a tmux row, or a host that does not send these). */
export function relayedProviderRow(row) {
  if (!isObject(row) || row.tmux || !isSessionProviderName(row.backend)) return null;
  const session = row.session;
  if (!isObject(session) || typeof session.provider !== "string" || !CAPABILITY_ID_RE.test(session.provider) || session.provider.length > 128) return null;
  return {
    backend: row.backend, session: { provider: session.provider },
    open: row.open !== null && row.open !== undefined && validOpen(row.open) ? { label: row.open.label, url: row.open.url } : null,
    ...(["unknown", "shell", "stopped", "unreachable"].includes(row.runtimeState) ? { runtimeState: row.runtimeState } : {}),
  };
}
/** A stop input's `reason` for the stop given with the host (`oats host run`'s shutdown). */
export const STOP_REASON_HOST = "host";
/** The one code of `outsideOats` (feature provider-outside-oats). */
export const OUTSIDE_OATS_CODE = "running-outside-oats";
/** Whether a provider's answer for a session says a harness is alive there: the session is there,
 *  and it runs a turn or the provider cannot tell a live idle session from a settled one. Never a
 *  session that is gone, nor one whose harness ended (`shell`). */
export const harnessAlive = (observed) => observed.present === true && observed.running !== false;
/** `outsideOats` (feature provider-outside-oats): what a status row says of a provider home OATS
 *  recorded stopped whose provider answers a live harness (a person's message in the provider's own
 *  product can start one again, behind OATS's back). `{ code, backend, message }`; the message names
 *  the remedy. It is a report and nothing else: the row's other fields, the home's records and what
 *  OATS refuses or resumes stay what OATS recorded. */
export function outsideOatsOf(instance, backend) {
  return { code: OUTSIDE_OATS_CODE, backend, message: `a harness runs in ${instance} on ${backend}, and OATS recorded this instance stopped: stop it with \`oats instance stop ${instance}\`, or start it from OATS` };
}
/** A row's `outsideOats` as another kernel reported it (a remote roster's row), read by this
 *  kernel's own rule → the value, or undefined when it is not one: exactly the three keys, the one
 *  code, `backend` a session provider's name and `message` one line of at most 500 characters. */
export function readOutsideOats(value) {
  if (!exactKeys(value, ["code", "backend", "message"]) || value.code !== OUTSIDE_OATS_CODE) return undefined;
  if (!isSessionProviderName(value.backend) || !oneLine(value.message, MESSAGE_MAX)) return undefined;
  return { code: OUTSIDE_OATS_CODE, backend: value.backend, message: value.message };
}
/** An answer of a routed command (`--server`: a spawn's, a start's, an inspect's result) with a
 *  provider home's `session` cut to `{ provider }`: the endpoint is for the host where the home
 *  lives. Any other answer is returned as it is. */
export function withoutRelayedEndpoint(result) {
  if (!isObject(result) || !isObject(result.session) || typeof result.session.provider !== "string") return result;
  return { ...result, session: { provider: result.session.provider } };
}
/** Whether a home's record (instance.json) says it is on a session provider: it records the
 *  provider's `session` and a backend that is no built-in one. The receipt, never this, is the authority. */
export const recordsSessionProvider = (meta) => isObject(meta?.session) && isSessionProviderName(meta.backend);
/** Whether a status row is a provider home's. */
export const isProviderRow = (row) => isObject(row?.session) && isSessionProviderName(row.backend);
/** A local status row's `session` for a provider home: the capability and, when the recorded
 *  endpoint names one (`threadId`, a string of at most 200 characters), the thread id alone, so a
 *  tool on the same host can match a session to its instance. Never the endpoint. */
export function rowSession(provider, endpoint) {
  const threadId = isObject(endpoint) && typeof endpoint.threadId === "string" && endpoint.threadId.length > 0 && endpoint.threadId.length <= 200 && !REFUSED_TEXT.test(endpoint.threadId) ? endpoint.threadId : null;
  return { provider, ...(threadId !== null ? { threadId } : {}) };
}
/** An inspect result by the contract's words → `{ present, state, running, open }` (`open` null when
 *  the provider offers none), or null when it breaks them. */
export function judgeInspect(result) {
  if (!exactKeys(result, ["present", "state", "running"], ["open"])) return null;
  if (typeof result.present !== "boolean" || !STATES.includes(result.state) || ![true, false, null].includes(result.running)) return null;
  // Only a row of the contract's table: a session that is not there is stopped and runs nothing.
  if (!result.present && (result.state !== "stopped" || result.running !== false)) return null;
  if (result.open !== undefined && !validOpen(result.open)) return null;
  return { present: result.present, state: result.state, running: result.running, open: result.open ? { label: result.open.label, url: result.open.url } : null };
}

/** Inspect one home's session → `{ observed: { present, state, running, open } }`, or
 *  `{ unavailable: "<why>" }`: a refusal, a failed call and a result that breaks the words are all
 *  unknown, never stopped. */
export function inspectProviderSession(binding, endpoint, { io, timeoutMs = sessionProviderTimeout("inspect") } = {}) {
  const answer = callSessionProvider(binding, "inspect", { home: binding.home, endpoint }, { io, timeoutMs });
  if (!answer.ok) return { unavailable: providerSaid(answer) };
  const observed = judgeInspect(answer.result);
  return observed ? { observed } : { unavailable: `${binding.capability}'s session provider ${binding.name} answered inspect with a result that is not { present, state, running, open? } in the contract's words` };
}

/** The key of the homes one `inspectMany` call may hold: one module copy's content (capability and
 *  digest), one provider, one set of settings (the call's environment is the first home's). */
export function inspectManyGroup(binding) {
  if (!binding.provider.commands.inspectMany || !binding.digest) return null;
  try { return canonicalJson([binding.capability, binding.digest, binding.name, binding.cap.settings], WIRE_LIMITS); } catch { return null; }
}
/** Inspect the sessions of `entries` ([{ binding, endpoint }], one inspectManyGroup, at most
 *  INSPECT_MANY_MAX) with one call → one inspectProviderSession answer per entry, in order. Each
 *  entry of the batch is judged as one inspect's answer would be. A batch that fails or is
 *  malformed (a failed call, `results` that are not one per home), and an entry that is neither an
 *  inspect result in the contract's words nor a well-formed refusal, fall back to that home's own
 *  `inspect`: a bad batch is never read as "stopped", and never as an answer for another home.
 *  A batch that TIMED OUT is not asked again home by home: a provider that does not answer one call
 *  would cost its timeout once more per home, so every entry is `unavailable`. `timeoutFor()` gives
 *  each call's timeout in ms (a listing's remaining time), 0 or less meaning none is left.
 *  An entry with `batchOnly: true` (a home OATS stopped, whose presence a listing reads: feature
 *  provider-outside-oats) is answered by the batch or not at all: it never falls back to its own
 *  `inspect`, which would be one more wait per home, and is `unavailable` instead. */
export function inspectProviderSessions(entries, { io, timeoutFor = () => sessionProviderTimeout("inspect") } = {}) {
  const [first] = entries;
  const spent = "the time this listing gives its session providers was spent before this one was asked";
  const own = ({ binding, endpoint, batchOnly }) => {
    if (batchOnly) return { unavailable: "the batch did not answer for this home, and a home OATS stopped is not asked on its own" };
    const timeoutMs = timeoutFor();
    return timeoutMs > 0 ? inspectProviderSession(binding, endpoint, { io, timeoutMs }) : { unavailable: spent };
  };
  const batchMs = timeoutFor();
  if (!(batchMs > 0)) return entries.map(() => ({ unavailable: spent }));
  const answer = callSessionProvider(first.binding, "inspectMany", { homes: entries.map(({ binding, endpoint }) => ({ home: binding.home, instance: typeof binding.meta.instance === "string" ? binding.meta.instance : basename(binding.home), endpoint })) }, { io, timeoutMs: batchMs });
  if (answer.timedOut) return entries.map(() => ({ unavailable: answer.failed }));
  const results = answer.ok && exactKeys(answer.result, ["results"]) && Array.isArray(answer.result.results) && answer.result.results.length === entries.length ? answer.result.results : null;
  if (!results) return entries.map(own);
  return results.map((result, i) => {
    if (exactKeys(result, ["error"])) {
      const refused = refusalOf(result.error, `${first.binding.capability}'s session provider ${first.binding.name} refused inspect`);
      return refused ? { unavailable: `${refused.code}: ${refused.message}` } : own(entries[i]);
    }
    const observed = judgeInspect(result);
    return observed ? { observed } : own(entries[i]);
  });
}

/** The four statuses of a provider's readiness (`check`), the binding check's own. */
export const CHECK_STATUSES = Object.freeze(["ready", "needs-configuration", "authorization-required", "unavailable"]);
const codeMessages = (list) => Array.isArray(list) && list.every((x) => exactKeys(x, ["code", "message"]) && typeof x.code === "string" && x.code.length > 0 && x.code.length <= 128 && !/[\x00-\x1f\x7f]/.test(x.code) && typeof x.message === "string");
/** A provider's readiness, where it declares the optional `check` command (docs/capabilities.md,
 *  "check (optional)"): for a
 *  home (`{ home, soul: null, settings }`) or, before any home exists, a soul (`{ home: null, soul,
 *  settings }`). → `{ result: { status, problems, warnings } }` in the readiness `providers` shape
 *  (`status` one of CHECK_STATUSES; `problems` and `warnings` `[{ code, message }]`, messages made
 *  safe to print; no problem on `ready`), `{ unavailable: "<why>" }` when the provider failed,
 *  refused or answered outside those rules, or null when the provider declares no check. */
export function checkProviderSession(binding, input, { io, timeoutMs = sessionProviderTimeout("check") } = {}) {
  if (!binding.provider.commands.check) return null;
  const answer = callSessionProvider(binding, "check", input, { io, timeoutMs });
  // (`timedOut`: it did not answer in the time it was given, which a preview counts against its budget.)
  if (!answer.ok) return { unavailable: providerSaid(answer), ...(answer.timedOut ? { timedOut: true } : {}) };
  const r = answer.result;
  const sound = exactKeys(r, ["status", "problems"], ["warnings"]) && CHECK_STATUSES.includes(r.status) && codeMessages(r.problems) && (r.warnings === undefined || codeMessages(r.warnings)) && !(r.status === "ready" && r.problems.length);
  if (!sound) return { unavailable: `${binding.capability}'s session provider ${binding.name} answered check with a result that is not { status, problems, warnings? } in the readiness words` };
  const safe = (list) => list.map((x) => ({ code: x.code, message: safeText(x.message, MESSAGE_MAX) }));
  return { result: { status: r.status, problems: safe(r.problems), warnings: safe(r.warnings ?? []) } };
}
/** The refusal of a launch whose provider is not ready, or null when it is (or declares no check):
 *  the kernel asks a provider's readiness for the home right before every launch, so a launch is
 *  never sent to a backend that says it cannot take it. `{ code, message }`: the first problem's
 *  own code when it is an E_BACKEND_* one, else E_BACKEND_NOT_READY; the message carries every
 *  problem the provider named, or why its readiness could not be read. `launch`: the launch that
 *  is planned, `{ harness, yolo, args, sandbox }` as its launch input will carry them, so a provider
 *  can refuse HERE what it would refuse at the launch (a session it would sandbox whose allowances
 *  are `unavailable` or have `missing` entries: only it knows its mode), before a restart stops
 *  anything. `timeoutMs`: a preview's, what is left of its budget; the refusal of a provider that
 *  did not answer in time carries `timedOut`. */
export function launchReadinessRefusal(binding, { io, launch, timeoutMs } = {}) {
  const checked = checkProviderSession(binding, { home: binding.home, soul: null, settings: binding.cap.settings, ...(launch ? { launch } : {}) }, { io, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  if (checked === null || checked.result?.status === "ready") return null;
  const said = `${binding.capability}'s session provider ${binding.name}`;
  if (checked.unavailable) return { code: "E_BACKEND_NOT_READY", message: `${said} is not ready: its readiness could not be read (${checked.unavailable})`, ...(checked.timedOut ? { timedOut: true } : {}) };
  const own = checked.result.problems.find((x) => /^E_BACKEND_[A-Z0-9_]{1,50}$/.test(x.code));
  return { code: own?.code ?? "E_BACKEND_NOT_READY", message: `${said} is not ready (${checked.result.status})${checked.result.problems.length ? `: ${checked.result.problems.map((x) => `${x.code}: ${x.message}`).join("; ")}` : ""}` };
}
/** The provider's refusals of an input that the kernel relays as its own codes: nothing was sent. */
const INPUT_REFUSALS = new Set(["E_SESSION_PROMPT_OPEN", "E_SESSION_INPUT_QUEUED"]);
/** An input error's mark that the provider itself refused the input, so nothing was sent
 *  (inputWasRefused). Without it the input's fate is not known: the call failed, or answered
 *  outside the rules, and the provider may have dispatched it. */
const INPUT_NOT_SENT = Symbol("oats.inputNotSent");
/** Whether an error of inputProviderSession says the provider refused the input: nothing was sent. */
export const inputWasRefused = (error) => error?.[INPUT_NOT_SENT] === true;
/** Send `text` to one home's session → `{ submitted: true, verified }`. Throws E_SESSION_PROMPT_OPEN
 *  or E_SESSION_INPUT_QUEUED as the provider gives them, else E_SESSION_INPUT_FAILED. An error for
 *  the provider's own refusal says nothing was sent (inputWasRefused); any other leaves it unknown. */
export function inputProviderSession(binding, endpoint, text, { io, groupFile } = {}) {
  const answer = callSessionProvider(binding, "input", { home: binding.home, endpoint, text }, { io, groupFile });
  if (!answer.ok) {
    if (answer.refused) throw Object.assign(INPUT_REFUSALS.has(answer.refused.code) ? oatsError(answer.refused.code, answer.refused.message) : oatsError("E_SESSION_INPUT_FAILED", `cannot submit session input: ${providerSaid(answer)}`), { [INPUT_NOT_SENT]: true });
    throw oatsError("E_SESSION_INPUT_FAILED", `cannot submit session input: ${providerSaid(answer)}; whether the input was sent is not known`);
  }
  if (!exactKeys(answer.result, ["submitted", "verified"]) || answer.result.submitted !== true || typeof answer.result.verified !== "boolean") {
    throw oatsError("E_SESSION_INPUT_FAILED", `cannot submit session input: ${binding.capability}'s session provider ${binding.name} answered input with a result that is not { submitted: true, verified }; whether the input was sent is not known`);
  }
  return { submitted: true, verified: answer.result.verified };
}

/** Stop one home's session, giving it `graceSeconds` → `{ stopped: true }`, or `{ failed: "<why>" }`.
 *  `endpoint` null: whatever live session is rooted at the home (a launch whose answer was lost, or
 *  one that was sent and never recorded). `launchSent`, then: the instant the kernel recorded for
 *  that launch, so the provider can tell what the launch started from what was there before.
 *  `reason: "host"` (STOP_REASON_HOST): the stop `oats host run`'s shutdown gives, which a resume
 *  brings back through `input` to this same session. The input carries `reason: "host"` then, and
 *  no `reason` for any other stop, so a provider can keep that session resumable. */
export function stopProviderSession(binding, endpoint, graceSeconds, { io, launchSent = null, groupFile, reason = null } = {}) {
  const answer = callSessionProvider(binding, "stop", { home: binding.home, endpoint, graceSeconds, ...(endpoint === null && launchSent ? { launchSent } : {}), ...(reason === STOP_REASON_HOST ? { reason } : {}) }, { timeoutMs: sessionProviderTimeout("stop", { graceSeconds }), io, groupFile });
  if (!answer.ok) return { failed: providerSaid(answer) };
  if (!exactKeys(answer.result, ["stopped"]) || answer.result.stopped !== true) return { failed: `${binding.capability}'s session provider ${binding.name} answered stop with a result that is not { stopped: true }` };
  return { stopped: true };
}

/** Launch one home's session → `{ endpoint }`, or `{ refused: { code, message } }` (the provider's
 *  own E_BACKEND_* refusal: nothing was launched) or `{ failed: "<why>", uncertain }`: `uncertain`
 *  when the call did not end with an answer, so a session may have been started. */
export function launchProviderSession(binding, input, { io, groupFile } = {}) {
  const answer = callSessionProvider(binding, "launch", input, { io, groupFile });
  if (!answer.ok) {
    if (answer.refused) return /^E_BACKEND_[A-Z0-9_]+$/.test(answer.refused.code) ? { refused: answer.refused } : { failed: providerSaid(answer), uncertain: false };
    return { failed: answer.failed, uncertain: true };
  }
  if (!exactKeys(answer.result, ["endpoint"]) || !validEndpoint(answer.result.endpoint)) return { failed: `${binding.capability}'s session provider ${binding.name} answered launch with an endpoint that is not a JSON object of at most ${ENDPOINT_MAX_BYTES} bytes`, uncertain: true };
  // A plain copy: the strict decoder's objects have no prototype, and the endpoint is recorded as JSON.
  return { endpoint: JSON.parse(JSON.stringify(answer.result.endpoint)) };
}
