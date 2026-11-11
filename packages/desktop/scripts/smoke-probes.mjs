// Packaged-app probe runners for dist-smoke — extracted so the execution
// discipline is CONTRACT-TESTED (review ac366f9: reverting the smoke to
// synchronous execution previously left every reaper test green).
//
// Contract: every probe of the packaged app runs through the injected
// reaper — asynchronous, detached, group-tracked. A one-shot probe (the ABI
// probe, the collector) uses runTracked, settled on close; the long-lived
// backend uses spawnTracked, and runBackendProbe reaps its group and awaits
// its exit in a finally, on every path. There is NO synchronous execution
// primitive in this module, and the tests import it to assert the probes go
// through the reaper.
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchServerChild, serverSpawnSpec } from "../server-host.mjs";
import { createBackendClient, watchReadyLine } from "../backend-client.mjs";
import { boundedTail } from "./launch-probe.mjs";

/**
 * How the packaged executable is run as Node. macos-15 runners are arm64:
 * for the x64 cross-build the packaged x64 Electron is invoked explicitly
 * through Rosetta — auto-translation is not a sufficient CI contract and may
 * not engage predictably. Executing the REAL x64 app catches a wrong-arch
 * native module. The caller adds ELECTRON_RUN_AS_NODE=1 to the environment.
 */
export function packagedNode(appExe, args, { targetArch, platform = process.platform, hostArch = process.arch } = {}) {
  const rosetta = platform === "darwin" && hostArch === "arm64" && targetArch === "x64";
  return rosetta
    ? { exe: "/usr/bin/arch", args: ["-x86_64", appExe, ...args], rosetta }
    : { exe: appExe, args, rosetta };
}

export function abiProbeSource(asarMainPath) {
  return `
    const { createRequire } = require("node:module");
    const req = createRequire(${JSON.stringify(asarMainPath)});
    const pty = req("node-pty");
    const p = pty.spawn("/bin/sh", ["-c", "echo pty-alive"], { cols: 20, rows: 5, cwd: "/tmp" });
    let out = "";
    p.onData((d) => { out += d; });
    p.onExit(() => { console.log(out.includes("pty-alive") ? "PTY_OK" : "PTY_NO_OUTPUT"); process.exit(0); });
    setTimeout(() => { console.log("PTY_TIMEOUT"); process.exit(1); }, 8000);
  `;
}

/**
 * Run the node-pty ABI probe against the packaged app.
 * `reaper` MUST provide runTracked (the group-tracked async runner); this
 * function never falls back to synchronous execution.
 * Returns { ok, detail }.
 */
export async function runAbiProbe(reaper, appExe, asarMainPath, {
  timeout = 30000, env = process.env, targetArch,
  platform = process.platform, hostArch = process.arch,
} = {}) {
  if (typeof reaper?.runTracked !== "function") {
    return { ok: false, detail: "probe runner requires a reaper with runTracked (async group-tracked execution is the contract)" };
  }
  // Through Rosetta on the macOS x64 cross-build (packagedNode).
  const { exe, args, rosetta } = packagedNode(appExe, ["-e", abiProbeSource(asarMainPath)], { targetArch, platform, hostArch });
  const r = await reaper.runTracked(exe, args, {
    timeout,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const mode = rosetta ? " under Rosetta x86_64" : "";
  if (r.timedOut) return { ok: false, detail: `node-pty ABI probe${mode} timed out (group killed)` };
  if (!r.stdout.includes("PTY_OK")) {
    const combined = `${String(r.stdout)}\n${String(r.stderr || "")}`.trim().slice(-500);
    return { ok: false, detail: `node-pty ABI probe${mode} failed (exit ${r.code}): ${combined}` };
  }
  return { ok: true, detail: `node-pty loads and spawns under the packaged Electron ABI${mode} (via app.asar)` };
}

/**
 * Phase 1's check of the shared home (packages/client, which the builder places beside app.asar as
 * client/): the package holds exactly the module files the repository's directory has. `packaged`
 * and `source` are the two directories; nothing is read but their listings.
 * Returns { ok, detail }.
 */
export function sharedHomeInventory(packaged, source, { readdirSync, existsSync }) {
  if (!existsSync(packaged)) return { ok: false, detail: `the package has no shared home: ${packaged} does not exist` };
  const want = readdirSync(source).filter((name) => name.endsWith(".mjs")).sort();
  const have = readdirSync(packaged).sort();
  if (want.length === 0) return { ok: false, detail: `${source} holds no module: nothing to compare the package with` };
  const missing = want.filter((name) => !have.includes(name)), extra = have.filter((name) => !want.includes(name));
  if (missing.length || extra.length) {
    const parts = [missing.length ? `missing ${missing.join(", ")}` : "", extra.length ? `not in the repository's directory: ${extra.join(", ")}` : ""].filter(Boolean);
    return { ok: false, detail: `the packaged shared home (${packaged}) does not hold exactly the repository's ${want.length} modules: ${parts.join("; ")}` };
  }
  return { ok: true, detail: `the packaged shared home (client/, beside app.asar) holds exactly the repository's ${want.length} modules` };
}

/**
 * The relative imports of a module's source, each with the names the module takes from it
 * (`default` for a default import, none for a namespace or a bare import). Self-contained: its
 * text is also run inside the packaged executable (mainImportsSource).
 */
export function relativeImportsOf(source) {
  const out = [];
  const statement = /^[ \t]*import\s+([^;"']*?)\s*from\s*["'](\.{1,2}\/[^"']+)["']|^[ \t]*import\s*["'](\.{1,2}\/[^"']+)["']/gm;
  for (const m of source.matchAll(statement)) {
    const clause = m[1] ?? "", names = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const part of braces[1].split(",")) { const name = part.trim().split(/\s+as\s+/)[0].trim(); if (name) names.push(name); }
    if (clause.replace(/\{[^}]*\}/, "").replace(/\*\s*as\s+[\w$]+/, "").replace(/,/g, "").trim()) names.push("default");
    out.push({ specifier: m[2] ?? m[3], names });
  }
  return out;
}

export function mainImportsSource(entry) {
  return `
    const { readFileSync } = require("node:fs");
    const { pathToFileURL } = require("node:url");
    ${relativeImportsOf.toString()}
    const entry = ${JSON.stringify(entry)};
    Promise.all(relativeImportsOf(readFileSync(entry, "utf8")).map(async ({ specifier, names }) => {
      const loaded = await import(new URL(specifier, pathToFileURL(entry)).href);
      for (const name of names) if (!(name in loaded)) throw new Error(specifier + " has no export " + name);
      return specifier;
    })).then((list) => { console.log("MAIN_IMPORTS_OK " + JSON.stringify(list)); process.exit(0); }, (e) => { console.error(e.message); process.exit(1); });
  `;
}

/**
 * What MAIN loads, without a display (phase 4b). Main imports electron, so it cannot run as Node;
 * everything else it imports can. The probe reads the packaged `entry` (app.asar/main.mjs) inside
 * the packaged executable, and imports each module it names by a relative path, from where main
 * names it: the same loader main has, resolving the same `./` and `../client/` from the same
 * directory, and each with its own imports. Every name main takes from a module must be an export
 * of it. The list is main's own, read from the package: there is none here to keep up to date.
 * `home` is the prefix of the specifiers that leave the app directory for the shared home; a main
 * that names none of them would make this phase prove nothing about it, and fails.
 * `reaper` MUST provide runTracked. Returns { ok, detail, imports }.
 */
export async function runMainImportsProbe(reaper, appExe, entry, {
  home = "../client/", timeout = 60_000, env = process.env, targetArch,
  platform = process.platform, hostArch = process.arch,
} = {}) {
  if (typeof reaper?.runTracked !== "function") {
    return { ok: false, detail: "probe runner requires a reaper with runTracked (async group-tracked execution is the contract)" };
  }
  const { exe, args, rosetta } = packagedNode(appExe, ["-e", mainImportsSource(entry)], { targetArch, platform, hostArch });
  const r = await reaper.runTracked(exe, args, { timeout, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } });
  const mode = rosetta ? " under Rosetta x86_64" : "";
  if (r.timedOut) return { ok: false, detail: `main-imports probe${mode} timed out (group killed)` };
  const line = String(r.stdout).split("\n").find((l) => l.startsWith("MAIN_IMPORTS_OK "));
  if (r.code !== 0 || !line) {
    const combined = `${String(r.stdout)}\n${String(r.stderr || "")}`.trim().slice(-800);
    return { ok: false, detail: `main-imports probe${mode} failed (exit ${r.code}): ${combined}` };
  }
  const imports = JSON.parse(line.slice("MAIN_IMPORTS_OK ".length));
  const shared = imports.filter((specifier) => specifier.startsWith(home));
  if (shared.length === 0) return { ok: false, imports, detail: `main-imports probe${mode}: ${entry} names no module under ${home}, so this phase does not load the shared home as main does` };
  return {
    ok: true, imports,
    detail: `the ${imports.length} modules main imports by a relative path load, with the names main takes from each, as Node under the packaged executable${mode}: ${shared.length} directly from the shared home (${shared.join(", ")}), the rest from the asar, each with its own imports`,
  };
}

/** As the hermetic tests start the backend: no oats CLI is discoverable, no login shell runs. */
export const NO_CLI_ENV = Object.freeze({ OATS_DESKTOP_OATS_BIN: "", PATH: "/nonexistent", SHELL: "/bin/false" });

/** Whether something accepts a connection on the Unix socket at `path`. */
function socketOpen(path) {
  return new Promise((done) => {
    const c = createConnection({ path });
    const end = (open) => { c.destroy(); done(open); };
    c.once("connect", () => end(true));
    c.once("error", () => end(false));
    c.setTimeout(2000, () => end(false));
  });
}

/**
 * The TCP ports `pid` listens on (Linux): its socket descriptors (/proc/<pid>/fd) matched by inode
 * against the LISTEN rows of /proc/net/tcp and tcp6. null where /proc cannot be read (not Linux,
 * or the process is gone). `fs` is injectable for tests.
 */
export function listeningTcpPorts(pid, fs = { readdirSync, readlinkSync, readFileSync }) {
  let inodes;
  try {
    inodes = new Set(fs.readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
      try { const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); return m ? [m[1]] : []; } catch { return []; }
    }));
  } catch { return null; }
  const ports = [];
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text; try { text = fs.readFileSync(table, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== "0A") continue; // 0A: LISTEN
      if (inodes.has(cols[9])) ports.push(parseInt(cols[1].split(":").pop(), 16));
    }
  }
  return ports;
}

/** The pid of `parent`'s child whose command line matches `pattern` (Linux /proc), or null. */
export function childPidMatching(parent, pattern, fs = { readdirSync, readFileSync }) {
  let names; try { names = fs.readdirSync("/proc"); } catch { return null; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (ppid !== parent) continue;
      if (pattern.test(fs.readFileSync(`/proc/${name}/cmdline`, "utf8").replace(/\0/g, " "))) return Number(name);
    } catch { /* gone */ }
  }
  return null;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** `promise`'s value, or null after `ms`; the timer never outlives the wait. */
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((ok) => { timer = setTimeout(() => ok(null), ms); })]); }
  finally { clearTimeout(timer); }
}
const seconds = (ms) => `${Math.round(ms / 100) / 10}s`;

/**
 * The headless backend phase: what the packaged app runs as Node, run
 * without a display (#634).
 *  1. the backend (`bin`, app.asar/server/oats-web.mjs) is started THROUGH
 *     THE PRODUCTION SPEC (`serverSpawnSpec`, as main starts it, its fresh
 *     credential on fd 3 and a private socket: launchServerChild) with the
 *     packaged executable as execPath, no deployment, a temporary home and no
 *     CLI discoverable, must print its ready line and answer GET /api/cli
 *     through the backend client (backend-client.mjs, the authenticated
 *     socket path) within `readyMs`; on Linux it must hold no listening TCP
 *     socket;
 *  2. its stdin is then closed, as the kernel closes it when main ends, and
 *     it must exit 0 with its socket closed within `exitMs` (#698's lifeline);
 *  3. the collector (`collector`, client/liveness-main.mjs beside app.asar,
 *     the entry the backend starts) is run as Node with `[]` on stdin and must
 *     print `[]` within `collectorMs`.
 * Every process goes through the reaper (spawnTracked/runTracked: detached,
 * group-tracked) and is reaped, and the backend awaited, before this returns,
 * on every path. `spec` is injectable so a test can start a server without
 * the lifeline. Returns { ok, detail, lines, pids }: on success `lines` are
 * the phase's evidence, what was proven and what was not.
 */
export async function runBackendProbe(reaper, appExe, {
  bin, collector, env = process.env, spec = serverSpawnSpec,
  readyMs = 90_000, exitMs = 15_000, collectorMs = 60_000,
  targetArch, platform = process.platform, hostArch = process.arch,
} = {}) {
  const pids = {};
  if (typeof reaper?.spawnTracked !== "function" || typeof reaper?.runTracked !== "function" || typeof reaper?.reapGroup !== "function") {
    return { ok: false, detail: "backend probe requires a reaper with spawnTracked, runTracked and reapGroup (async group-tracked execution is the contract)", pids };
  }
  const how = { targetArch, platform, hostArch };
  const mode = packagedNode(appExe, [], how).rosetta ? " under Rosetta x86_64" : "";
  const home = mkdtempSync(join(tmpdir(), "oats-smoke-backend-"));
  let child = null, exited = null, tail = "", socket = null;
  let settle;
  const exit = new Promise((ok) => { settle = ok; });
  const fail = (detail) => ({ ok: false, detail, pids });
  const output = () => tail.trim().slice(-1500) || "(no output)";
  try {
    let s;
    const client = createBackendClient();
    const launched = launchServerChild({
      spawn: (command, args, options) => { const run = packagedNode(command, args, how); return reaper.spawnTracked(run.exe, run.args, options); },
      socketBase: tmpdir(),
      spec: (socketPath) => (s = spec({ execPath: appExe, bin, dirs: [], socketPath, cliChoiceFile: join(home, "oats-cli-choice.json"),
        pathSource: "inherited", pathError: null, remoteIdentityFile: join(home, "remote-identity.json"), home,
        env: { ...env, ...NO_CLI_ENV, HOME: home } })),
    });
    child = launched.child; socket = launched;
    pids.backend = child.pid;
    const lease = client.begin({ child, socketPath: launched.socketPath, secret: launched.secret });
    if (child.stdout) watchReadyLine(child.stdout, () => client.markReady(lease));
    child.on("exit", (code, signal) => { exited = { code, signal }; settle(exited); });
    child.on("error", (e) => { tail = boundedTail(tail, `\nspawn error: ${e.message}`); exited ??= { code: -1, signal: null }; settle(exited); });
    child.stdout?.on("data", (d) => { tail = boundedTail(tail, d); });
    child.stderr?.on("data", (d) => { tail = boundedTail(tail, d); });
    child.stdin?.on("error", () => { /* the server is gone; its exit is reported */ });

    // 1. The backend answers.
    const readyBy = Date.now() + readyMs;
    let status = null;
    while (status === null) {
      if (exited) return fail(`backend${mode} exited before answering GET /api/cli (code ${exited.code}, signal ${exited.signal}); output tail:\n${output()}`);
      const left = readyBy - Date.now();
      if (left <= 0) return fail(`backend${mode} never answered GET /api/cli within ${seconds(readyMs)} (reaped); output tail:\n${output()}`);
      if (!lease.ready) { await sleep(Math.min(200, Math.max(0, left))); continue; }
      try {
        const res = await client.fetch("/api/cli", { signal: AbortSignal.timeout(Math.min(2000, left)) });
        status = res.status;
      } catch { await sleep(Math.min(200, Math.max(0, readyBy - Date.now()))); }
    }
    if (status === 401) return fail(`backend${mode} refused the credential main handed it over fd 3 (HTTP 401); output tail:\n${output()}`);
    // No TCP listener: the backend listens on its socket alone (Linux, where /proc shows it).
    const tcp = platform === "linux" ? listeningTcpPorts(child.pid) : null;
    if (tcp && tcp.length) return fail(`backend${mode} listens on TCP port(s) ${tcp.join(", ")}; it must listen on its socket only; output tail:\n${output()}`);

    // 2. The lifeline: stdin closes, as when main ends; the server must go, port and all.
    child.stdin?.end();
    const gone = await within(exit, exitMs);
    if (!gone) return fail(`lifeline (#698): the backend${mode} was still running ${seconds(exitMs)} after its stdin closed (reaped); output tail:\n${output()}`);
    if (gone.code !== 0 || gone.signal !== null) return fail(`lifeline (#698): the backend${mode} ended with code ${gone.code}, signal ${gone.signal} when its stdin closed, expected exit 0; output tail:\n${output()}`);
    if (await socketOpen(launched.socketPath)) return fail(`lifeline (#698): the backend's socket still accepts connections after the backend${mode} exited (reaped); output tail:\n${output()}`);

    // 3. The collector: rows on stdin, one liveness per row on stdout; none in, none out.
    const col = packagedNode(s.command, [collector], how);
    const r = await reaper.runTracked(col.exe, col.args, { timeout: collectorMs, env: s.options.env, cwd: home, input: "[]" });
    pids.collector = r.pid;
    const said = `${String(r.stdout)}\n${String(r.stderr || "")}`.trim().slice(-500) || "(no output)";
    if (r.timedOut) return fail(`collector${mode} did not answer within ${seconds(collectorMs)} (group killed): ${said}`);
    if (r.code !== 0) return fail(`collector${mode} failed (exit ${r.code}): ${said}`);
    if (String(r.stdout).trim() !== "[]") return fail(`collector${mode} answered ${JSON.stringify(String(r.stdout).slice(0, 200))} to [], expected []`);

    const appImage = platform === "linux" ? ", nor the AppImage's launcher and runtime (APPDIR, its PATH and library-path entries): this ran the unpacked build" : "";
    return {
      ok: true, pids,
      detail: `backend, lifeline and collector run as Node under the packaged executable${mode}`,
      lines: [
        `backend: ${bin} started through serverSpawnSpec as Node under the packaged executable${mode} (credential on fd 3, private socket), no CLI discoverable, answered GET /api/cli through the backend client over the authenticated socket (HTTP ${status})`,
        tcp ? `backend: holds no listening TCP socket (/proc/${child.pid})` : `backend: TCP listeners not inspected on ${platform} (no /proc)`,
        `lifeline (#698): closing the backend's stdin ended it (exit 0) and closed its socket`,
        `collector: ${collector} run as Node under the packaged executable${mode} answered [] to []`,
        `not exercised by this phase: the GUI (phase 5)${appImage}`,
      ],
    };
  } finally {
    if (child) {
      reaper.reapGroup(child);
      if (!exited) await within(exit, 5000);
    }
    socket?.remove();
    rmSync(home, { recursive: true, force: true });
  }
}
