// Is this bb fit to run an OATS home? (contract items 6a, 7, 8.) One set of checks, read by
// `oats readiness` (the provider's check command) and run by every launch before it
// touches anything. Each finding is {code, message, status}; `status` is the readiness
// wire's word for it (needs-configuration, authorization-required or unavailable).
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { bbClient } from "./bb.mjs";
import { checkDataDir, sandboxDeny } from "./deny.mjs";
import { ProviderError, bounded, isObject, someOf } from "./errors.mjs";
import { exposedListeners } from "./exposure.mjs";
import { BB_PROVIDER, harnessRefusal, modeRefusal, permissionMode, sandboxRefusal } from "./mode.mjs";
import { DELIVERY_VARIABLE, PI_AGENT_DIR_SHAPE, PI_AWEB_EXTENSION, absolutePath, piConfigurationProblems, piListMayBeOld, piListMayBePartial } from "./pi-config.mjs";
import { isModelId, piModelFinding } from "./pi-model.mjs";
import { gapList, missingRemedy, readSandbox, sandboxKeysOf } from "./local-settings.mjs";
import { DEFAULT_DAEMON_PORT, TRUST_VALUES, isLoopbackHost, loopbackOrigin, portOf } from "./settings.mjs";
import { isLive } from "./threads.mjs";

// Each read's own cap. Every read is also cut at the call's deadline (`left`), so a bb
// that hangs still gets a named problem inside the kernel's time, never a killed check.
const HTTP_TIMEOUT_MS = 4_000;
const PROVIDER_STATE_TIMEOUT_MS = 6_000;
// bb's provider health words (bb plugins/provider-claude-code provider-maintenance).
const PROVIDER_STATUS = { not_installed: "needs-configuration", unsupported_version: "needs-configuration", unauthenticated: "authorization-required", expired: "authorization-required", unknown: "unavailable" };

const HTTP_MAX_BYTES = 256 * 1024;

/** GET a JSON document from bb, read-only: a loopback address (the callers pass only
 *  origins that passed loopbackOrigin), no redirect followed, bounded in time and in size.
 *  Resolves { ok: true, value } or { ok: false, message }; never throws. */
async function getJson(url, timeoutMs = HTTP_TIMEOUT_MS) {
  // The time limit is a timer of this process's own, not AbortSignal.timeout: that one
  // does not keep the process alive, and on Node 20 a fetch whose connection is dropped as it is accepted
  // never settles, so the process ended, with status 0 and no answer, while it waited.
  const limit = new AbortController();
  const timer = setTimeout(() => limit.abort(new DOMException("timed out", "TimeoutError")), Math.max(1, timeoutMs));
  try {
    const response = await fetch(url, { method: "GET", signal: limit.signal, redirect: "error", headers: { accept: "application/json" } });
    if (!response.ok) { await response.body?.cancel(); return { ok: false, message: `HTTP ${response.status}` }; }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > HTTP_MAX_BYTES) return { ok: false, message: `an answer larger than ${HTTP_MAX_BYTES} bytes` };
      chunks.push(chunk);
    }
    try { return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }; }
    catch { return { ok: false, message: "an answer that is not JSON" }; }
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message;
    return { ok: false, message: error?.name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : cause ? `${error.message} (${cause})` : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Every reason this bb must not run a home now, in the order a person would fix them.
 *  → { problems, server, daemon, bb, listable, credential } (the addresses as origins,
 *  null when refused; `listable` when bb's CLI runs and its server answers; `credential`
 *  names where bb's agent takes its credential from, when bb reports it ready).
 *  `harness`: whose launch this is asked for (claude or pi): bb's provider for that
 *  harness is the one that must be ready. With none (a readiness read with no planned
 *  launch) it is Claude's, as it was before the provider ran pi. */
export async function backendProblems(settings, { deadline = Date.now() + 16_000, env = process.env, http = getJson, exposure = exposedListeners, harness = null } = {}) {
  const bbProvider = BB_PROVIDER[harness ?? "claude"] ?? BB_PROVIDER.claude;
  const problems = [];
  const add = (code, status, message) => problems.push({ code, message, status });
  const left = (cap) => Math.min(cap, deadline - Date.now());

  // Trust: bb's loopback port is open to every local user's processes, unlike tmux's
  // socket in its 0700 directory. Someone must have said who shares this machine.
  if (!TRUST_VALUES.includes(settings.trust)) {
    add("E_BACKEND_TRUST", "needs-configuration", settings.trust == null
      ? "settings.oats.bb.trust is not set. bb's API has no login and its loopback port is reachable by every local user's processes: set it in oats-local.yaml to single-user (this host is one person's) or container (one OATS team container with one bb server)"
      : `settings.oats.bb.trust is ${JSON.stringify(settings.trust)}; it must be single-user or container`);
  }
  // A host-only path of the provider's is an absolute path, whichever harness is asked for
  // (contract r23, A13(2)): the pi configuration directory bb's server runs pi with.
  if (!absolutePath(settings.piAgentDir)) add(PI_AGENT_DIR_SHAPE.code, PI_AGENT_DIR_SHAPE.status, PI_AGENT_DIR_SHAPE.message);
  if (settings.version == null) {
    add("E_BACKEND_VERSION", "needs-configuration", "settings.oats.bb.version is not set: pin the bb-app version this deployment runs (the output of `bb --version`)");
  }

  let server = null, daemon = null, cliRuns = settings.version == null, credential = null;
  for (const [name, set] of [["server", (origin) => { server = origin; }], ["daemon", (origin) => { daemon = origin; }]]) {
    try { set(loopbackOrigin(settings[name], name)); }
    catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      add(error.code, "needs-configuration", error.message);
    }
  }

  const bb = bbClient({ cli: settings.cli, hostDaemonPort: settings.hostDaemonPort, server: server ?? undefined, deadline, env });
  if (settings.version != null) {
    try {
      const version = await bb.version();
      cliRuns = true;
      if (version !== settings.version) {
        add("E_BACKEND_VERSION", "needs-configuration", `bb is ${version}, and settings.oats.bb.version pins ${settings.version}: install bb-app@${settings.version}, or move the pin with the image's`);
      }
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      add("E_BACKEND_VERSION", "needs-configuration", `the bb version could not be read (${error.message})`);
    }
  }

  if (server && daemon) {
    const open = await exposure([portOf(server), portOf(daemon)]);
    if (open.length > 0) {
      add("E_BACKEND_EXPOSED", "needs-configuration", `bb answers off loopback, at ${open.join(", ")}. Its API has no login and runs commands: bind it to 127.0.0.1 (no BB_SERVER_BIND_HOST=0.0.0.0), and reach it from other devices through a Tailscale Serve route`);
    }
  }

  if (server) {
    const health = await http(`${server}/health`, left(HTTP_TIMEOUT_MS));
    if (!health.ok || !isObject(health.value) || health.value.ok !== true) {
      add("E_BACKEND_UNREACHABLE", "unavailable", `bb's server at ${server} does not answer (${health.ok ? "its /health is not ok" : health.message}): start bb-app, or set settings.oats.bb.server`);
      return { problems, server, daemon, bb, listable: false, credential };
    }
  }
  if (daemon) {
    // The server's /health answers before the host daemon is up; threads need the daemon.
    // What a finding tells a person to set is the setting that decided the daemon's
    // address: `daemon` where it is given (with `hostDaemonPort` beside it where that is
    // set too: the two must agree), `hostDaemonPort` where it alone is. Where
    // neither is (the address is bb's default), it is `hostDaemonPort`: a bb whose daemon
    // is elsewhere was started with --host-daemon-port, and that key is the one that also
    // tells bb's CLI (`daemon` follows it).
    const PORT_KEY = "settings.oats.bb.hostDaemonPort (the port bb-app was started with: its --host-daemon-port)";
    const setKey = settings.daemonKey === "daemon" ? (settings.hostDaemonPort != null ? `settings.oats.bb.daemon and ${PORT_KEY}, which name one daemon` : "settings.oats.bb.daemon")
      : settings.daemonKey === "hostDaemonPort" ? PORT_KEY : `${PORT_KEY} where this bb's host daemon is not on bb's default port`;
    const status = await http(`${daemon}/status`, left(HTTP_TIMEOUT_MS));
    if (!status.ok) {
      add("E_BACKEND_UNREACHABLE", "unavailable", `bb's host daemon at ${daemon} does not answer (${status.message}): start bb-app, or set ${setKey}`);
    } else if (!isObject(status.value) || typeof status.value.connected !== "boolean") {
      add("E_BACKEND_NOT_READY", "unavailable", `bb's host daemon at ${daemon} answered a /status this provider cannot read (no "connected": true or false)`);
    } else if (status.value.connected !== true) {
      add("E_BACKEND_NOT_READY", "unavailable", `bb's host daemon at ${daemon} is not connected to its server yet`);
    } else if (!usableOrigin(status.value.serverUrl)) {
      // Without the server the daemon names, nothing says it serves this one. An address
      // that is no http(s) origin names none.
      add("E_BACKEND_NOT_READY", "unavailable", `bb's host daemon at ${daemon} answered a /status this provider cannot read (no "serverUrl" that is an http or https address)`);
    } else if (server && !sameServer(status.value.serverUrl, server)) {
      add("E_BACKEND_NOT_READY", "needs-configuration", `the host daemon at ${daemon} serves ${new URL(status.value.serverUrl).origin}, not settings.oats.bb.server ${server}: point both at one bb, settings.oats.bb.server and ${setKey}`);
    } else if (server && settings.hostDaemonPort != null && cliRuns) {
      // (Where bb's CLI could not be run, that is said already, once: its hosts are not asked for.)
      // With a port for bb's CLI, the question is the one bb itself asks at `bb project
      // create`: is the daemon at that port a host of THIS server? "Something answers
      // there" is not that: another bb's daemon answers too. Two facts of bb's decide it,
      // from the two sides: the daemon says which host it is (its /status, `hostId`) and
      // which server it serves (checked above); the server says which hosts it has (`bb
      // host list`). Only a host the server lists, connected, is this bb's daemon.
      const problem = await daemonOfServer(bb, status.value.hostId, { daemon, server, port: settings.hostDaemonPort });
      if (problem !== null) problems.push(problem);
    }
  }
  if (server) {
    const { problem, provider } = await providerState(server, bbProvider, http, left(PROVIDER_STATE_TIMEOUT_MS));
    if (problem !== null) problems.push(problem);
    else if (bbProvider === BB_PROVIDER.pi) {
      // bb reports no account for pi: pi keeps its own logins and model configuration.
      credential = "pi's own logins and model configuration, of bb's user, or a credential in the bb server's environment";
    } else {
      // Where the credential comes from, by bb's own report; never the credential, and
      // no account name.
      credential = typeof provider.accountEmail === "string" && provider.accountEmail
        ? "a Claude login of bb's user"
        : "no Claude login: a credential in bb's own configuration or in the bb server's environment";
    }
  }
  // A pi launch also needs bb's pi to load the home's skills and to leave the agent's
  // mail alone: read from the pi configuration bb's server runs with, never changed here.
  if (harness === "pi") problems.push(...await piConfiguration(settings, bb));
  return { problems, server, daemon, bb, listable: server !== null && cliRuns, credential };
}

/** Whether the host daemon that answered at `daemon` (its /status named `hostId`) is a
 *  connected host of bb's server at `server`, by the server's own list. → null, or the
 *  problem, which names the server and the key first, then the daemon and why. A daemon
 *  that does not say which host it is, or a list that cannot be read, proves nothing: not
 *  ready. */
async function daemonOfServer(bb, hostId, { daemon, server, port }) {
  // What to change first, then why: bb's own words may be long, and a message is cut.
  const not = (status, why) => ({ code: "E_BACKEND_NOT_READY", status, message: `settings.oats.bb.server (${server}) and settings.oats.bb.hostDaemonPort (${port}, the port bb-app was started with: its --host-daemon-port) must name one bb, and ${why}` });
  if (typeof hostId !== "string" || hostId === "") return not("unavailable", `nothing shows they do: bb's host daemon at ${daemon} answered a /status that does not say which host it is (no "hostId")`);
  let hosts;
  try { hosts = await bb.hosts(); }
  catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return not("unavailable", `nothing shows they do: the host daemon at ${daemon} is host ${hostId}, and the hosts of that server could not be read (${error.message})`);
  }
  const host = hosts.find((row) => row.id === hostId);
  if (host === undefined) return not("needs-configuration", `they do not: the host daemon at ${daemon} is host ${hostId}, which that server does not have (its hosts: ${hosts.length > 0 ? someOf(hosts.map((row) => row.id), 3) : "none"}). It is another bb's daemon`);
  if (host.status !== "connected") return not("unavailable", `the host daemon at ${daemon} is host ${hostId}, which that server shows as ${JSON.stringify(host.status)}, not connected`);
  return null;
}

/** What bb says of one of its providers. → { problem: {code, status, message} | null,
 *  provider: bb's entry | null }. */
async function providerState(server, bbProvider, http, timeoutMs) {
  const problem = (status, message) => ({ problem: { code: "E_BACKEND_NOT_READY", message, status }, provider: null });
  const state = await http(`${server}/api/v1/system/providers/state?providerId=${bbProvider}`, timeoutMs);
  const provider = state.ok && isObject(state.value) && Array.isArray(state.value.providers)
    ? state.value.providers.find((entry) => isObject(entry) && entry.providerId === bbProvider) : null;
  if (!provider || typeof provider.status !== "string") {
    return problem("unavailable", `bb did not report its ${bbProvider} provider's status (${state.ok ? `no ${bbProvider} entry` : state.message})`);
  }
  if (provider.status !== "ready") {
    const hint = typeof provider.loginCommand === "string" && PROVIDER_STATUS[provider.status] === "authorization-required" ? `: run \`${provider.loginCommand}\` as bb's user, or give bb's server the credential in its environment` : "";
    const detail = typeof provider.statusMessage === "string" && provider.statusMessage ? ` (${provider.statusMessage.slice(0, 300)})` : "";
    return { ...problem(PROVIDER_STATUS[provider.status] ?? "unavailable", `bb reports its ${bbProvider} provider as ${provider.status}${detail}${hint}`), provider };
  }
  return { problem: null, provider };
}

/** The problems of the pi configuration bb's server runs with (lib/pi-config.mjs). bb's
 *  machine env is read only where @awebai/pi is listed; a bb that cannot give it is a
 *  problem of its own: nothing then says the extension is silenced. */
async function piConfiguration(settings, bb) {
  // A setting of the wrong shape is every launch's problem already (backendProblems).
  if (!absolutePath(settings.piAgentDir)) return [];
  try { return await piConfigurationProblems(settings.piAgentDir, () => bb.machineEnvNames()); }
  catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    // The remedy before bb's own words, which may be long.
    return [{ code: "E_BACKEND_PI_LISTENER", status: "unavailable", message: `bb's pi may take this agent's mail: ${PI_AWEB_EXTENSION} is in bb's pi configuration, and bb's machine env could not be read to see whether ${DELIVERY_VARIABLE} silences it there. Make \`bb machine env list\` answer, or give bb's server a pi configuration without ${PI_AWEB_EXTENSION}. bb said: ${error.message}` }];
  }
}

/** What a readiness read with no planned launch says of pi (it cannot know which harness
 *  a launch would run): nothing where bb has no pi installed, and otherwise, as ONE
 *  warning, what a pi launch would be refused for. A warning here, because a deployment
 *  that runs Claude alone is ready; the launch itself, and the check of a planned pi
 *  launch, refuse. → warnings. */
async function piWarnings(settings, { server, bb, http = getJson, deadline = Date.now() + 16_000 }) {
  if (!server) return [];
  const { problem, provider } = await providerState(server, BB_PROVIDER.pi, http, Math.min(PROVIDER_STATE_TIMEOUT_MS, deadline - Date.now()));
  // No word of bb's on pi, or pi not installed in it: this bb runs no pi, and nothing is said.
  if (provider === null || provider.status === "not_installed") return [];
  const found = [...(problem !== null ? [problem] : []), ...await piConfiguration(settings, bb)];
  if (found.length === 0) return [];
  // Short, and before the finding's own words: those end with the path that was read, which is what a cut may take.
  return [{ code: "session-provider-pi-not-ready", message: `a pi launch would be refused here (${found.map((entry) => entry.code).join(", ")}); Claude launches are not held up. ${found[0].message}` }];
}

/** Whether the value is an address a bb server can have: an http or https URL with a host. */
function usableOrigin(value) {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
}

/** The same server: the same origin, or (between loopback names, which differ only in how
 *  this machine is called) the same scheme and port. */
function sameServer(reported, server) {
  let url;
  try { url = new URL(reported); } catch { return false; }
  if (url.origin === server) return true;
  const mine = new URL(server);
  return url.protocol === mine.protocol && isLoopbackHost(url.hostname) && isLoopbackHost(mine.hostname) && portOf(url.origin) === portOf(server);
}

/** Live bb threads whose project root no longer exists: what a retire that could not
 *  reach bb, or an older kernel's retire, left behind. → warnings, one per root. */
async function orphanedThreads(bb, { exists = existsSync } = {}) {
  const [projects, threads] = [await bb.projects(), await bb.threads()];
  const warnings = [];
  for (const project of projects) {
    if (!isObject(project) || !Array.isArray(project.sources)) continue;
    const roots = project.sources.filter((source) => isObject(source) && typeof source.path === "string").map((source) => source.path);
    if (roots.length === 0 || roots.some((root) => exists(root))) continue;
    const ids = threads.filter((thread) => isLive(thread) && thread.projectId === project.id).map((thread) => thread.id);
    if (ids.length === 0) continue;
    warnings.push({ code: "session-provider-orphaned", message: `${ids.length} bb thread${ids.length > 1 ? "s" : ""} of project ${project.id} ${ids.length > 1 ? "have" : "has"} no home: the project root no longer exists. Archive ${ids.length > 1 ? "them" : "it"} in bb (bb thread archive <id>). Thread${ids.length > 1 ? "s" : ""}: ${someOf(ids)}. Root: ${someOf(roots, 1)}` });
  }
  return warnings;
}

/** Whether Claude Code's sandbox can start here. On Linux it runs commands under
 *  bubblewrap (`bwrap`); without it bb's sandboxed modes cannot auto-allow anything, and
 *  every command waits for a person in bb. Other platforms bring their own. */
export function sandboxCanStart({ platform = process.platform, path = process.env.PATH ?? "" } = {}) {
  if (platform !== "linux") return true;
  return path.split(delimiter).filter(Boolean).some((dir) => {
    try { accessSync(join(dir, "bwrap"), constants.X_OK); return true; } catch { return false; }
  });
}

/** What to say where the sandbox cannot start: a warning, never a refusal. */
function sandboxRuntimeWarning(settings, env) {
  if (sandboxCanStart({ path: env.PATH ?? "" })) return [];
  const then = settings.trust === "container"
    ? "In a team container, spawn bb agents with --yolo (bb full mode): the container is the boundary, as it is for tmux agents there"
    : "Install bubblewrap, or spawn bb agents with --yolo (bb full mode)";
  return [{ code: "session-provider-sandbox-unsupported", message: `bubblewrap (bwrap) is not on this host's PATH, so Claude's sandbox cannot start: in bb's sandboxed modes (auto, accept-edits) every command waits for a person in bb. ${then}` }];
}

/** The readiness result: {status, problems, warnings}, the shape `oats readiness` relays
 *  as a providers item. `status` is ready (no problem), needs-configuration,
 *  authorization-required or unavailable. `credential` is for a person's report only. */
/** A bb whose host daemon is not on bb's default port, and no `hostDaemonPort`: bb's CLI
 *  is then not told where that daemon is. Every check here passes (they ask the daemon's
 *  address, `daemon`), and the first launch of a home is refused by bb, on `bb project
 *  create`: "host not found" where another bb's daemon listens on the default port,
 *  "cannot reach local host daemon" where none does. A warning, not a problem: a
 *  deployment that sets no port is refused nothing new (contract A23). */
function hostDaemonPortWarning(settings, daemon) {
  if (settings.hostDaemonPort != null) return [];
  if (daemon === null || portOf(daemon) === DEFAULT_DAEMON_PORT) return [];
  return [{ code: "session-provider-host-daemon-port", message: `settings.oats.bb.daemon names port ${portOf(daemon)}, not bb's default ${DEFAULT_DAEMON_PORT}, and settings.oats.bb.hostDaemonPort is not set: bb's CLI finds its host daemon by that port alone, so a home's first launch on this bb is refused by bb ("Host not found", or "Cannot reach local host daemon"). Set hostDaemonPort: ${portOf(daemon)} in oats-local.yaml (the port bb-app was started with: its --host-daemon-port)` }];
}

export async function readinessResult(settings, options = {}) {
  const { problems, bb, listable, credential, server, daemon } = await backendProblems(settings, options);
  // (Claude's sandbox is nothing a pi launch runs in: its planned launch is not told of bubblewrap.)
  const warnings = options.harness === "pi" ? [] : sandboxRuntimeWarning(settings, options.env ?? process.env);
  warnings.push(...hostDaemonPortWarning(settings, daemon));
  // With no planned launch, the harness is not known: Claude's state is the problem above, and pi's is said here.
  if ((options.harness ?? null) === null && !problems.some((problem) => problem.code === "E_BACKEND_UNREACHABLE")) warnings.push(...await piWarnings(settings, { server, bb, http: options.http, deadline: options.deadline }));
  if (listable) {
    try { warnings.push(...await orphanedThreads(bb, options)); }
    catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      // bb's own lists could not be read: a bb that cannot say what runs in it is not
      // ready, whatever else answered (a launch reads the same lists first).
      problems.push({ code: "E_BACKEND_NOT_READY", status: "unavailable", message: `bb's projects and threads could not be read, so this bb cannot be used and orphaned threads were not looked for (${error.message})` });
    }
  }
  for (const problem of options.extra?.problems ?? []) problems.push(problem);
  warnings.push(...(options.extra?.warnings ?? []));
  // The model of a planned pi launch (`options.model`, where the kernel hands the check
  // one): what the launch would refuse it for is a problem here, and a list that cannot
  // settle it a warning (lib/pi-model.mjs). Asked last, and only of a launch nothing else
  // refuses: one more read of bb, and none for another harness or a launch with no model.
  if (options.harness === "pi" && isModelId(options.model) && problems.length === 0) {
    const finding = await piModelFinding(options.model, bb, { partial: piListMayBePartial(settings.piAgentDir, { dataDir: settings.dataDir, server, home: options.home }), old: piListMayBeOld(settings.piAgentDir, (options.now ?? Date.now)()) });
    if (finding?.problem) problems.push(finding.problem);
    if (finding?.warning) warnings.push(finding.warning);
  }
  const order = ["needs-configuration", "authorization-required", "unavailable"];
  const status = problems.length === 0 ? "ready" : order.find((word) => problems.some((problem) => problem.status === word));
  // Every line is cut to what the kernel relays.
  return { result: { status, problems: problems.map(({ code, message }) => ({ code, message: bounded(message) })), warnings: warnings.map(({ code, message }) => ({ code, message: bounded(message) })) }, credential };
}

/** What a readiness read with no planned launch says, since it cannot know the mode a
 *  launch would run in (`oats readiness`, for a soul or a home; `oats bb doctor`): the
 *  backend launches in full mode only. A warning: a soul that launches with yolo is
 *  ready. */
export const FULL_MODE_ONLY = Object.freeze({ code: "session-provider-full-mode-only", message: "the bb backend launches in bb's full mode only (sandboxed modes are not offered): a spawn or start that does not choose it (--yolo, or a launch configuration's --permission-mode bypassPermissions) would run in bb's accept-edits or auto mode, which are sandboxed, and is refused before anything starts (E_BACKEND_SANDBOXED_MODE). bb lets a command leave its sandbox, so those modes are no boundary; full mode claims none" });

// Hosts that serve everyone's repositories: allowing one for a knowledge base's remote
// allows the whole forge, not only that base.
const GENERAL_FORGES = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "dev.azure.com", "git.sr.ht"]);

/** A team of the agent's, other than its default, whose service the deployment does not
 *  record: the launch goes on, and this says plainly what the agent then cannot do. */
function otherTeamsWarning(mode, rows, unnamed) {
  const cannot = mode === "auto" ? "in bb's auto mode that team's mail is unreachable for this agent" : "in bb's accept-edits mode every command that reaches that team's mail raises a prompt for a person in bb";
  return { code: "session-provider-sandbox-team-unreachable", message: `the deployment records no host for a team that is not this agent's default: ${cannot}. ${missingRemedy(rows)}. Missing: ${gapList(rows, unnamed)}` };
}

/** What a home's own Claude settings say of the sandbox, for a person reading readiness
 *  (contract item 6c, A5a): a home is reported sandboxed only where BOTH additions that
 *  keep Claude's file tools inside its working directories stand there (the deny of bb's
 *  directory-move tool, and the switch). The sandbox block is not part of the condition:
 *  a sandboxed launch that was handed no allowances writes none. Read for the report only: nothing the provider writes or deletes depends
 *  on it, and the next launch rewrites all of it. → warnings. */
export function homeSandboxWarnings(home) {
  if (typeof home !== "string" || !isAbsolute(home)) return [];
  const keys = sandboxKeysOf(home);
  if (!keys.any) return [];
  if (keys.deny && keys.block) {
    return [{ code: "session-provider-sandboxed", message: "this home's .claude/settings.local.json holds the provider's deny rules and the switch that keeps Claude's Write and Edit tools inside its working directories: its last launch was written for one of bb's sandboxed modes. Those modes limit accidents, not a determined agent: they are not a security boundary between an agent and the operator's account" }];
  }
  const lacking = [keys.deny ? null : "the deny of bb's directory-move tool (permissions.deny)", keys.block ? null : "permissions.blockWritesOutsideWorkingDirectories"].filter(Boolean);
  return [{ code: "session-provider-sandbox-incomplete", message: `this home's .claude/settings.local.json holds some of the provider's sandbox keys but not ${lacking.join(" and not ")}: the home is not reported as sandboxed (without all of them Claude's Write and Edit tools can write outside the home). The file is the home's agent's to write, and the provider rewrites all of it at every launch: restart the home (oats session restart), and if this shows again, something in the home is changing the file` }];
}

/** What the planned launch the kernel hands the check would meet in the sandbox: the
 *  refusal a launch in that mode would answer, as a problem; optional rows, skipped
 *  capabilities and, in full mode, the gaps, as warnings. `settings` and `home` are the
 *  check's own: with them a sandboxed launch's deny rules are built as the launch builds
 *  them, and what would refuse there is a problem here. → {problems, warnings}. */
export function plannedLaunchFindings(planned, { sandboxedModes = false, settings = null, home = null } = {}) {
  const problems = [], warnings = [];
  const unsupported = harnessRefusal(planned.harness);
  if (unsupported !== null) return { problems: [{ ...unsupported, status: "needs-configuration" }], warnings };
  let mode, allowances;
  try {
    mode = permissionMode(planned.args, planned.yolo, planned.harness);
    // A mode the command does not launch in (not offered), or one bb's pi does not have:
    // that is the whole answer, as it is the launch's own first refusal.
    const notOffered = modeRefusal(mode, planned.harness, { sandboxedModes });
    if (notOffered !== null) return { problems: [{ ...notOffered, status: "needs-configuration" }], warnings };
    allowances = planned.harness === "pi" ? null : readSandbox(planned.sandbox, { sandboxed: mode !== "full" });
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return { problems: [{ code: error.code, message: error.message, status: "needs-configuration" }], warnings };
  }
  // A planned pi launch that got here runs in full mode, and bb's pi has no sandbox: nothing
  // of the allowances, the deny rules or the gaps is said of it.
  if (planned.harness === "pi") return { problems, warnings };
  const refusal = sandboxRefusal(mode, allowances);
  if (refusal !== null) problems.push({ ...refusal, status: refusal.code === "E_BACKEND_SANDBOX_UNAVAILABLE" ? "unavailable" : "needs-configuration" });
  else if (allowances.unavailable !== null) {
    warnings.push({ code: "session-provider-sandbox-unavailable", message: `the deployment's configuration could not be resolved for the sandbox (${allowances.unavailable}). The planned launch runs in full mode, which has no sandbox; a launch in auto or accept-edits would be refused` });
  } else if (allowances.missing.length + allowances.unnamed > 0) {
    warnings.push({ code: "session-provider-sandbox-host-missing", message: `the deployment records no host for some of what a sandbox would need. The planned launch runs in full mode, which has no sandbox; a launch in auto or accept-edits is refused. ${missingRemedy(allowances.missing)}. Missing: ${gapList(allowances.missing, allowances.unnamed)}` });
  }
  if (mode !== "full" && settings !== null) {
    // The deny rules of a sandboxed launch (contract item 6c): what the launch would refuse
    // for, said before it. The home's trees and what the kernel keeps outside the home are
    // the kernel's to name: where the planned launch carries either, the whole set is
    // built, as the launch builds it; where it carries neither, only this host's part is
    // checked, and the launch itself refuses a missing list.
    try {
      if ((planned.trees !== undefined || planned.protected !== undefined) && typeof home === "string" && isAbsolute(home)) sandboxDeny({ mode, home, trees: planned.trees, protected: planned.protected, dataDir: settings.dataDir });
      else checkDataDir(mode, settings.dataDir);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      problems.push({ code: error.code, message: error.message, status: "needs-configuration" });
    }
  }
  if (mode !== "full" && !isObject(planned.sandbox)) {
    // A kernel that hands the launch no sandbox at all: nothing will be added, and bb's
    // sandbox then blocks OATS's own commands.
    warnings.push({ code: "session-provider-sandbox-missing", message: `the planned launch runs in bb's ${mode} mode and carries no sandbox allowances: bb's sandbox will block the agent's aw (no network to the messaging server) and oats instance attention (no write to the deployment's events). Launch in full mode (--yolo), or on a kernel that hands the launch its allowances` });
  }
  if (mode !== "full" && allowances.otherTeams.length > 0) warnings.push(otherTeamsWarning(mode, allowances.otherTeams, 0));
  const optionalCount = allowances.optional.length + allowances.unnamedOptional;
  if (optionalCount > 0) {
    warnings.push({ code: "session-provider-sandbox-host-optional", message: `the deployment records no host for ${gapList(allowances.optional, allowances.unnamedOptional)}, which ${optionalCount > 1 ? "are" : "is"} optional: the launch goes on, and what needs ${optionalCount > 1 ? "them" : "it"} is blocked in bb's sandboxed modes` });
  }
  if (allowances.skipped.length + allowances.unnamedSkipped > 0) {
    const names = gapList(allowances.skipped, allowances.unnamedSkipped, { describe: (entry) => `${entry.capability}${entry.reason ? ` (${entry.reason})` : ""}`, noun: ["capability", "capabilities"] });
    warnings.push({ code: "session-provider-sandbox-skipped", message: `no sandbox host was taken for ${names}` });
  }
  // What a sandboxed launch would write into the home, with who asked for each entry. The
  // provider keeps no record of an earlier launch (the home is its agent's to write), so
  // readiness speaks of the launch the kernel plans, never of what the home holds.
  if (mode !== "full" && (allowances.domains.length > 0 || allowances.write.length > 0)) {
    const plain = (value) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(value);
    const hosts = gapList(allowances.domains, 0, { describe: (entry) => `${entry.host} (${entry.capability}${plain(entry.setting) ? `, its setting ${entry.setting}` : ""})`, noun: ["host", "hosts"] });
    const paths = gapList(allowances.write, 0, { describe: (entry) => entry.path, noun: ["path", "paths"] });
    warnings.push({ code: "session-provider-sandbox", message: `in bb's ${mode} mode this launch lets the home's Claude also reach ${allowances.domains.length ? hosts : "no added host"} and write ${allowances.write.length ? paths : "no added path"}: what OATS's own operation needs, written by the provider into the home's .claude/settings.local.json` });
    const forges = allowances.domains.filter((entry) => GENERAL_FORGES.has(entry.host.split(":")[0]));
    if (forges.length > 0) {
      warnings.push({ code: "session-provider-sandbox-forge", message: `${gapList(forges, 0, { describe: (entry) => `${entry.host} (${entry.capability})`, noun: ["host", "hosts"] })} ${forges.length > 1 ? "are general forges" : "is a general forge"}: allowing it opens every repository there to this agent's commands, not only the one it was allowed for` });
    }
  }
  return { problems, warnings };
}

