// The smoke's headless backend phase (scripts/smoke-probes.mjs runBackendProbe, #634), run
// against the SOURCE tree under plain Node: process.execPath stands in for the packaged
// executable, server/oats-web.mjs for the asar's entry and ../client/liveness-main.mjs for the
// collector beside it (the shared home, packages/client). The
// backend is started through the real serverSpawnSpec, with no CLI discoverable. Failure paths
// use tiny fixture servers started through the same spec (they read --port from its argv), or
// the real server with the lifeline flag dropped from the spec. Every process goes through a
// real reaper; each test checks, by exact pid, that the probe left none running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReaper } from "../scripts/proc-reaper.mjs";
import { runBackendProbe, runMainImportsProbe, relativeImportsOf, sharedHomeInventory, packagedNode, NO_CLI_ENV, createTokenOutputCapture, rendererControlEnvironment, browserProcessInfo } from "../scripts/smoke-probes.mjs";
import { serverSpawnSpec, LIFELINE_FLAG } from "../server-host.mjs";

const SERVER = fileURLToPath(new URL("../server/", import.meta.url));
const BIN = join(SERVER, "oats-web.mjs");
const COLLECTOR = fileURLToPath(new URL("../../client/liveness-main.mjs", import.meta.url));
const EXE = process.execPath;

/** A pid that is running: signal 0 reaches it and (on Linux) it is not a zombie awaiting its reaper. */
function alive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; }
}

async function until(probe, ms) {
  for (const end = Date.now() + ms; ;) {
    if (probe()) return true;
    if (Date.now() > end) return false;
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

/** A real reaper for one test; anything the probe left is reported, then reaped. */
function reaperFor(t) {
  const reaper = createReaper({ spawn });
  t.after(() => reaper.reapAll());
  return reaper;
}

/** Nothing the probe started is running, and the reaper retains no group. */
function assertReaped(r, reaper, names) {
  for (const name of names) {
    assert.ok(Number.isInteger(r.pids[name]), `the probe reports the ${name}'s pid`);
    assert.equal(alive(r.pids[name]), false, `the ${name} (pid ${r.pids[name]}) is gone`);
  }
  assert.equal(reaper.pendingGroups().size, 0, "no process group left retained");
}

/** Fixture scripts, in a directory removed after the test. */
function fixtures(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "oats-backend-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  return (name) => join(dir, name);
}
// A server that answers on the spec's --port and, at EOF on stdin, exits 3.
const EXITS_3 = `
import { createServer } from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((req, res) => { res.statusCode = req.headers["x-oats-desktop-token"] ? 200 : 403; res.end("{}"); }).listen(port, "127.0.0.1");
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(3));
`;
const NEVER_LISTENS = `process.stderr.write("fixture: up, never listening\\n"); setInterval(() => {}, 1000);`;

test("success: the backend answers, exits when its stdin closes, and the collector answers [] to []", async (t) => {
  const real = reaperFor(t), collectorEnvs = [];
  const reaper = { ...real, runTracked: (bin, args, options) => {
    collectorEnvs.push(options.env);
    return real.runTracked(bin, args, options);
  } };
  const given = [];
  const spec = (o) => { given.push(o); return serverSpawnSpec(o); };
  const r = await runBackendProbe(reaper, EXE, { bin: BIN, collector: COLLECTOR, spec, platform: "linux",
    env: { ...process.env, OATS_DESKTOP_TOKEN: "ambient-token-".repeat(4) }, readyMs: 20_000, exitMs: 5000, collectorMs: 20_000 });
  assert.equal(r.ok, true, r.detail);
  assert.equal(given.length, 1, "the backend is started once, through the spec");
  const [o] = given;
  assert.equal(o.execPath, EXE, "the packaged executable is the spec's execPath");
  assert.equal(o.bin, BIN);
  assert.deepEqual(o.dirs, [], "no deployment");
  for (const [name, value] of Object.entries(NO_CLI_ENV)) assert.equal(o.env[name], value, `${name}: no CLI discoverable`);
  assert.equal(o.env.HOME, o.home, "a temporary home");
  assert.equal(o.env.OATS_DESKTOP_TOKEN, undefined, "the ambient environment carries no token");
  assert.match(o.controlToken, /^[a-f0-9]{64}$/, "the backend has its own private token");
  assert.equal(collectorEnvs.length, 1);
  assert.equal(collectorEnvs[0].OATS_DESKTOP_TOKEN, undefined, "the collector receives no token");
  assert.equal(JSON.stringify(r).includes(o.controlToken), false, "probe results never contain the token");
  assert.match(r.lines[4], /without it answered 403/);
  assert.equal(existsSync(o.home), false, "the temporary home is removed");
  assert.match(r.lines[0], /^backend: .*oats-web\.mjs started through serverSpawnSpec .* answered GET \/api\/cli \(HTTP \d{3}\)$/);
  assert.match(r.lines[1], /^lifeline \(#698\): closing the backend's stdin ended it \(exit 0\) and closed port \d+$/);
  assert.match(r.lines[2], /^collector: .*liveness-main\.mjs .* answered \[\] to \[\]$/);
  assert.match(r.lines[3], /^not exercised by this phase: the GUI \(phase 5\), nor the AppImage's launcher and runtime \(APPDIR, its PATH and library-path entries\)/,
    "what the phase does not prove is said");
  assertReaped(r, reaper, ["backend", "collector"]);
});

test("renderer environment evidence reads only the browser's renderer PIDs and returns booleans", () => {
  const token = "private-token-".repeat(4), reads = [];
  const information = [{ type: "browser", id: 10 }, { type: "GPU", id: 11 }, { type: "renderer", id: 12 }];
  const read = path => {
    reads.push(path);
    return path.endsWith("/cmdline") ? "/app\0--type=renderer\0" : "HOME=/private\0PATH=/bin\0";
  };
  assert.deepEqual(rendererControlEnvironment(information, token, read), {
    renderersObserved: true, tokenNameAbsent: true, tokenValueAbsent: true,
  });
  assert.deepEqual(reads, ["/proc/12/cmdline", "/proc/12/environ"]);
  const present = rendererControlEnvironment(information, token, path =>
    path.endsWith("/cmdline") ? "/app\0--type=renderer\0" : `OATS_DESKTOP_TOKEN=${token}\0`);
  assert.deepEqual(present, { renderersObserved: true, tokenNameAbsent: false, tokenValueAbsent: false });
  assert.equal(JSON.stringify(present).includes(token), false);
  for (const [environment, tokenNameAbsent, tokenValueAbsent] of [
    ["OATS_DESKTOP_TOKEN=other\0", false, true], [`OTHER=${token}\0`, true, false],
  ]) {
    assert.deepEqual(rendererControlEnvironment(information, token, path =>
      path.endsWith("/cmdline") ? "/app\0--type=renderer\0" : environment),
    { renderersObserved: true, tokenNameAbsent, tokenValueAbsent });
  }
});

test("renderer environment evidence refuses missing, malformed or non-renderer identities before reading an environment", () => {
  const token = "private-token-".repeat(4);
  for (const info of [null, [], [{ type: "renderer", id: "12" }], [{ type: "renderer", id: -1 }]]) {
    assert.throws(() => rendererControlEnvironment(info, token, () => assert.fail("no /proc reads")));
  }
  const reads = [];
  assert.throws(() => rendererControlEnvironment([{ type: "renderer", id: 12 }], token, path => {
    reads.push(path); return "/app\0--type=gpu-process\0";
  }), /renderer identity did not match/);
  assert.deepEqual(reads, ["/proc/12/cmdline"]);
  assert.throws(() => rendererControlEnvironment([{ type: "renderer", id: 12 }], token, () => {
    throw new Error(token);
  }), error => !error.message.includes(token) && /renderer identity could not be read/.test(error.message));
});

test("browser process information uses the browser CDP command and closes its socket", async () => {
  let closed = false, request;
  class Socket {
    constructor(url) { assert.equal(url, "ws://127.0.0.1:1234/devtools/browser/probe"); queueMicrotask(() => this.onopen()); }
    send(value) { request = JSON.parse(value); queueMicrotask(() => this.onmessage({ data: JSON.stringify({
      id: 1, result: { processInfo: [{ type: "renderer", id: 12 }] },
    }) })); }
    close() { closed = true; }
  }
  const result = await browserProcessInfo("ws://127.0.0.1:1234/devtools/browser/probe", { WebSocketCtor: Socket });
  assert.deepEqual(request, { id: 1, method: "SystemInfo.getProcessInfo" });
  assert.deepEqual(result, [{ type: "renderer", id: 12 }]);
  assert.equal(closed, true);
});

test("output capture detects a split token before trimming and suppresses its diagnostics", () => {
  const token = "a1".repeat(32), captured = createTokenOutputCapture(token);
  captured.append("ordinary startup\n");
  assert.equal(captured.text(), "ordinary startup");
  assert.equal(captured.leaked, false);
  captured.append(token.slice(0, 30));
  captured.append(token.slice(30) + "x".repeat(5000));
  assert.equal(captured.leaked, true);
  assert.equal(captured.text(), "(output suppressed: control token present)");
  assert.equal(captured.text().includes(token), false);
});

test("a backend that prints its token fails without exposing it in diagnostics", async (t) => {
  const reaper = reaperFor(t);
  const at = fixtures(t, { "prints-token.mjs": `process.stderr.write(process.env.OATS_DESKTOP_TOKEN); process.exit(1);` });
  let token;
  const spec = o => { token = o.controlToken; return serverSpawnSpec(o); };
  const r = await runBackendProbe(reaper, EXE, { bin: at("prints-token.mjs"), collector: COLLECTOR, spec, readyMs: 20_000 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /output suppressed: control token present/);
  assert.equal(r.detail.includes(token), false);
  assertReaped(r, reaper, ["backend"]);
});

test("a backend that accepts a request without a token fails the smoke", async (t) => {
  const reaper = reaperFor(t);
  const source = EXITS_3.replace('res.statusCode = req.headers["x-oats-desktop-token"] ? 200 : 403;', 'res.statusCode = 200;');
  const at = fixtures(t, { "unguarded.mjs": source });
  const r = await runBackendProbe(reaper, EXE, { bin: at("unguarded.mjs"), collector: COLLECTOR, readyMs: 20_000 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /must refuse GET \/api\/cli without the token \(HTTP 200\)/);
  assertReaped(r, reaper, ["backend"]);
});

test("a bin that never listens: a bounded failure with the output tail, and the backend reaped", async (t) => {
  const reaper = reaperFor(t);
  const at = fixtures(t, { "never.mjs": NEVER_LISTENS });
  const started = Date.now();
  const r = await runBackendProbe(reaper, EXE, { bin: at("never.mjs"), collector: COLLECTOR, readyMs: 1500 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - started < 10_000, "bounded by the budget");
  assert.match(r.detail, /never answered GET \/api\/cli within 1\.5s/);
  assert.match(r.detail, /fixture: up, never listening/, "the output tail is reported");
  assertReaped(r, reaper, ["backend"]);
  assert.equal(r.pids.collector, undefined, "the collector is not run after a failed backend");
});

test("a backend that fails at startup (a missing import in the asar): it fails fast with the output tail", async (t) => {
  const reaper = reaperFor(t);
  const at = fixtures(t, { "broken.mjs": `import "./not-packaged.mjs";` });
  const started = Date.now();
  const r = await runBackendProbe(reaper, EXE, { bin: at("broken.mjs"), collector: COLLECTOR, readyMs: 20_000 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - started < 10_000, "does not wait out the budget");
  assert.match(r.detail, /^backend exited before answering GET \/api\/cli \(code 1, signal null\); output tail:\n[^]*not-packaged\.mjs/);
  assertReaped(r, reaper, ["backend"]);
});

test("a server that ignores its stdin closing (the spec without the lifeline flag): a failure naming the lifeline, then reaped", async (t) => {
  const reaper = reaperFor(t);
  const spec = (o) => { const s = serverSpawnSpec(o); return { ...s, args: s.args.filter((a) => a !== LIFELINE_FLAG) }; };
  const r = await runBackendProbe(reaper, EXE, { bin: BIN, collector: COLLECTOR, spec, readyMs: 20_000, exitMs: 1500 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /^lifeline \(#698\): the backend was still running 1\.5s after its stdin closed/);
  assertReaped(r, reaper, ["backend"]);
});

test("a server that exits non-zero when its stdin closes: a lifeline failure, not a pass", async (t) => {
  const reaper = reaperFor(t);
  const at = fixtures(t, { "exits3.mjs": EXITS_3 });
  const r = await runBackendProbe(reaper, EXE, { bin: at("exits3.mjs"), collector: COLLECTOR, readyMs: 20_000, exitMs: 5000 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /^lifeline \(#698\): the backend ended with code 3, signal null when its stdin closed, expected exit 0/);
  assertReaped(r, reaper, ["backend"]);
});

test("a server whose port stays open after it exits (a child holds the listener): a lifeline failure, the child reaped", async (t) => {
  const reaper = reaperFor(t);
  // The listener is a child in the server's process group; the server itself exits 0 at EOF.
  const at = fixtures(t, { "leaks.mjs": `
import { spawn } from "node:child_process";
const port = process.argv[process.argv.indexOf("--port") + 1];
const listener = spawn(process.execPath, ["-e", \`require("node:http").createServer((q, s) => { s.statusCode = q.headers["x-oats-desktop-token"] ? 200 : 403; s.end("{}"); }).listen(\${port}, "127.0.0.1")\`], { stdio: "ignore" });
process.stdout.write("listener pid " + listener.pid + "\\n");
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
` });
  const r = await runBackendProbe(reaper, EXE, { bin: at("leaks.mjs"), collector: COLLECTOR, readyMs: 20_000, exitMs: 5000 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /^lifeline \(#698\): port \d+ still accepts connections after the backend exited/);
  const listener = Number(r.detail.match(/listener pid (\d+)/)?.[1]);
  assert.ok(listener > 0, r.detail);
  // SIGKILLed with the group before the probe returned; an orphan is finished by its new parent, so allow it a moment.
  assert.equal(await until(() => !alive(listener), 2000), true, `the listener (pid ${listener}) is reaped with the server's group`);
  assertReaped(r, reaper, ["backend"]);
});

test("a collector that does not answer [] to []: a failure, every process reaped", async (t) => {
  const reaper = reaperFor(t);
  const at = fixtures(t, { "rows.mjs": `process.stdout.write('[{"running":true}]');` });
  const r = await runBackendProbe(reaper, EXE, { bin: BIN, collector: at("rows.mjs"), readyMs: 20_000, exitMs: 5000, collectorMs: 20_000 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /^collector answered "\[\{\\"running\\":true\}\]" to \[\], expected \[\]$/);
  assertReaped(r, reaper, ["backend", "collector"]);
});

test("a collector that fails: the failure carries its exit code and output", async (t) => {
  const reaper = reaperFor(t);
  const at = fixtures(t, { "throws.mjs": `throw new Error("fixture: collector import failed");` });
  const r = await runBackendProbe(reaper, EXE, { bin: BIN, collector: at("throws.mjs"), readyMs: 20_000, exitMs: 5000, collectorMs: 20_000 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /^collector failed \(exit 1\): [^]*fixture: collector import failed/);
  assertReaped(r, reaper, ["backend", "collector"]);
});

test("the macOS x64 cross-build runs the backend and the collector through Rosetta, as the ABI probe does", async (t) => {
  // A reaper that records each call and runs it with the Rosetta launcher stripped (no arch on this host).
  const real = reaperFor(t);
  const calls = [];
  const strip = (exe, args) => (exe === "/usr/bin/arch" ? [args[1], args.slice(2)] : [exe, args]);
  const reaper = {
    ...real,
    spawnTracked: (exe, args, opts) => { calls.push({ exe, args }); return real.spawnTracked(...strip(exe, args), opts); },
    runTracked: (exe, args, opts) => { calls.push({ exe, args }); return real.runTracked(...strip(exe, args), opts); },
  };
  const r = await runBackendProbe(reaper, EXE, { bin: BIN, collector: COLLECTOR, platform: "darwin", hostArch: "arm64", targetArch: "x64",
    readyMs: 20_000, exitMs: 5000, collectorMs: 20_000 });
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(calls.map((c) => [c.exe, ...c.args.slice(0, 3)]), [["/usr/bin/arch", "-x86_64", EXE, BIN], ["/usr/bin/arch", "-x86_64", EXE, COLLECTOR]]);
  for (const i of [0, 2]) assert.match(r.lines[i], /under Rosetta x86_64/, "the evidence says it ran under Rosetta");
  assert.equal(r.lines[3], "not exercised by this phase: the GUI (phase 5)", "no AppImage on macOS");
  assertReaped(r, real, ["backend", "collector"]);
});

test("packagedNode: Rosetta only for the x64 build on an arm64 mac", () => {
  assert.deepEqual(packagedNode("/A", ["x"], { platform: "darwin", hostArch: "arm64", targetArch: "x64" }), { exe: "/usr/bin/arch", args: ["-x86_64", "/A", "x"], rosetta: true });
  for (const how of [{ platform: "darwin", hostArch: "arm64", targetArch: "arm64" }, { platform: "linux", hostArch: "x64", targetArch: "x64" }, { platform: "darwin", hostArch: "x64", targetArch: "x64" }]) {
    assert.deepEqual(packagedNode("/A", ["x"], how), { exe: "/A", args: ["x"], rosetta: false }, JSON.stringify(how));
  }
});

test("the probe refuses to run without the reaper's group-tracked primitives", async () => {
  for (const bad of [undefined, {}, { runTracked: async () => ({}) }, { spawnTracked: () => ({}), runTracked: async () => ({}) }]) {
    const r = await runBackendProbe(bad, EXE, { bin: BIN, collector: COLLECTOR });
    assert.equal(r.ok, false);
    assert.match(r.detail, /requires a reaper with spawnTracked, runTracked and reapGroup/);
  }
});

test("dist-smoke runs the phase after the ABI probe and before the launch skip, so CI's build-verify runs reach it", () => {
  const src = readFileSync(new URL("../scripts/dist-smoke.mjs", import.meta.url), "utf8");
  const abi = src.indexOf("await runAbiProbe(reaper"), backend = src.indexOf("await runBackendProbe(reaper"), skip = src.indexOf("process.env.OATS_SMOKE_SKIP_LAUNCH");
  assert.ok(abi > 0 && backend > 0 && skip > 0, "all three are present");
  assert.ok(abi < backend && backend < skip, "ABI probe, then the backend phase, then the launch skip");
  assert.match(src, /bin: join\(server, "oats-web\.mjs"\), collector: join\(app\.resources, "client", "liveness-main\.mjs"\)/, "the asar's backend entry, and the collector's in the shared home beside the asar");
  assert.match(src, /const server = join\(app\.resources, "app\.asar", "server"\);/, "from app.asar");
});

// ── Phase 4b: what main loads, and phase 1's check of the shared home ────────

test("relativeImportsOf: each relative import of a source, with the names taken from it", () => {
  const source = [
    'import { app } from "electron";',
    'import { join } from "node:path";',
    'import { a, b as c } from "./one.mjs";',
    "import d, { e } from '../client/two.mjs';",
    'import * as all from "./three.mjs";',
    'import "./four.mjs";',
    'import { f,',
    '  g } from "../client/five.mjs";',
    '// import { no } from "./comment.mjs";',
    'const text = `import { no } from "./string.mjs"`;',
  ].join("\n");
  assert.deepEqual(relativeImportsOf(source), [
    { specifier: "./one.mjs", names: ["a", "b"] },
    { specifier: "../client/two.mjs", names: ["e", "default"] },
    { specifier: "./three.mjs", names: [] },
    { specifier: "./four.mjs", names: [] },
    { specifier: "../client/five.mjs", names: ["f", "g"] },
  ]);
});

test("the main-imports probe reads main.mjs: every module it imports loads from where main names it, the shared home among them", async (t) => {
  // The source tree stands in for the asar: its top level is where main and these modules are.
  const reaper = reaperFor(t), main = fileURLToPath(new URL("../main.mjs", import.meta.url));
  const r = await runMainImportsProbe(reaper, EXE, main);
  assert.equal(r.ok, true, r.detail);
  // The probe's list is main's own: every relative import statement of main.mjs, and nothing else.
  const source = readFileSync(main, "utf8");
  const stated = [...source.matchAll(/^import\b[^;]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(r.imports, stated);
  assert.ok(r.imports.length >= 25, `main's imports were found (${r.imports.length})`);
  const shared = r.imports.filter((specifier) => specifier.startsWith("../client/"));
  assert.ok(shared.includes("../client/workspace-cli.mjs") && shared.includes("../client/cli-environment.mjs"), "main imports the shared home directly");
  assert.match(r.detail, new RegExp(`^the ${r.imports.length} modules main imports by a relative path load, .* as Node under the packaged executable: ${shared.length} directly from the shared home \\(`));
  assert.equal(reaper.pendingGroups().size, 0, "no process group left retained");
});

test("the main-imports probe fails on a module that is not where main names it, on a missing export, and on a main that names no shared module", async (t) => {
  const reaper = reaperFor(t);
  const tree = (files) => {
    const at = fixtures(t, {}), top = join(at("."), "app"), home = join(at("."), "client");
    mkdirSync(top); mkdirSync(home);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(name.startsWith("client/") ? at(".") : top, name), text);
    return join(top, "main.mjs");
  };
  const good = await runMainImportsProbe(reaper, EXE, tree({
    "main.mjs": 'import { app } from "electron";\nimport { a } from "./a.mjs";\nimport { b } from "../client/b.mjs";\n',
    "a.mjs": 'export { b as a } from "../client/b.mjs";\n', "client/b.mjs": "export const b = 1;\n",
  }));
  assert.equal(good.ok, true, good.detail);
  assert.deepEqual(good.imports, ["./a.mjs", "../client/b.mjs"], "electron, which only main needs, is not loaded");

  const absent = await runMainImportsProbe(reaper, EXE, tree({ "main.mjs": 'import { b } from "../client/b.mjs";\n' }));
  assert.equal(absent.ok, false);
  assert.match(absent.detail, /^main-imports probe failed \(exit 1\): .*Cannot find module .*client\/b\.mjs/s);

  // A module of the shared home that the package lacks fails the module that imports it, too.
  const behind = await runMainImportsProbe(reaper, EXE, tree({
    "main.mjs": 'import { a } from "./a.mjs";\nimport { c } from "../client/c.mjs";\n',
    "a.mjs": 'export { b as a } from "../client/b.mjs";\n', "client/c.mjs": "export const c = 1;\n",
  }));
  assert.equal(behind.ok, false);
  assert.match(behind.detail, /Cannot find module .*client\/b\.mjs/);

  const noExport = await runMainImportsProbe(reaper, EXE, tree({
    "main.mjs": 'import { b, gone } from "../client/b.mjs";\n', "client/b.mjs": "export const b = 1;\n",
  }));
  assert.equal(noExport.ok, false);
  assert.match(noExport.detail, /^main-imports probe failed \(exit 1\): \.\.\/client\/b\.mjs has no export gone/);

  const none = await runMainImportsProbe(reaper, EXE, tree({ "main.mjs": 'import { a } from "./a.mjs";\n', "a.mjs": "export const a = 1;\n" }));
  assert.equal(none.ok, false);
  assert.match(none.detail, /names no module under \.\.\/client\/, so this phase does not load the shared home as main does$/);

  assert.equal((await runMainImportsProbe({}, EXE, "/nowhere/main.mjs")).ok, false, "a reaper without runTracked is refused");
  assert.equal(reaper.pendingGroups().size, 0, "no process group left retained");
});

test("the macOS x64 cross-build runs the main-imports probe through Rosetta", async () => {
  const calls = [];
  const reaper = { runTracked: async (exe, args, options) => { calls.push({ exe, args, options }); return { code: 0, stdout: 'MAIN_IMPORTS_OK ["./a.mjs","../client/b.mjs"]\n', stderr: "" }; } };
  const r = await runMainImportsProbe(reaper, "/A", "/R/app.asar/main.mjs", { platform: "darwin", hostArch: "arm64", targetArch: "x64", env: {} });
  assert.equal(r.ok, true, r.detail);
  assert.equal(calls[0].exe, "/usr/bin/arch");
  assert.deepEqual(calls[0].args.slice(0, 3), ["-x86_64", "/A", "-e"]);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.match(r.detail, /under the packaged executable under Rosetta x86_64: 1 directly from the shared home \(\.\.\/client\/b\.mjs\)/);
  const late = await runMainImportsProbe({ runTracked: async () => ({ timedOut: true, stdout: "", stderr: "" }) }, "/A", "/R/app.asar/main.mjs");
  assert.deepEqual(late, { ok: false, detail: "main-imports probe timed out (group killed)" });
});

test("sharedHomeInventory: the packaged client/ holds exactly the repository's modules", (t) => {
  const at = fixtures(t, {}), fs = { readdirSync, existsSync };
  const dir = (name, files) => { mkdirSync(at(name)); for (const file of files) writeFileSync(join(at(name), file), ""); return at(name); };
  const source = dir("source", ["a.mjs", "b.mjs"]);
  assert.deepEqual(sharedHomeInventory(dir("same", ["b.mjs", "a.mjs"]), source, fs),
    { ok: true, detail: "the packaged shared home (client/, beside app.asar) holds exactly the repository's 2 modules" });
  const missing = sharedHomeInventory(dir("short", ["a.mjs"]), source, fs);
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /does not hold exactly the repository's 2 modules: missing b\.mjs$/);
  const extra = sharedHomeInventory(dir("long", ["a.mjs", "b.mjs", "c.mjs", "notes.md"]), source, fs);
  assert.equal(extra.ok, false);
  assert.match(extra.detail, /: not in the repository's directory: c\.mjs, notes\.md$/);
  const both = sharedHomeInventory(dir("other", ["a.mjs", "z.mjs"]), source, fs);
  assert.match(both.detail, /: missing b\.mjs; not in the repository's directory: z\.mjs$/);
  const absent = sharedHomeInventory(at("nowhere"), source, fs);
  assert.deepEqual(absent, { ok: false, detail: `the package has no shared home: ${at("nowhere")} does not exist` });
  assert.equal(sharedHomeInventory(at("same"), dir("empty", ["README.md"]), fs).ok, false, "a source with no module proves nothing");
  // And the real directory against itself: what the smoke compares the package with.
  const home = fileURLToPath(new URL("../../client/", import.meta.url));
  assert.equal(sharedHomeInventory(home, home, fs).ok, true);
});

test("dist-smoke checks the shared home with the inventory, and runs main's imports after the backend phase and before the launch skip", () => {
  const src = readFileSync(new URL("../scripts/dist-smoke.mjs", import.meta.url), "utf8");
  const inventory = src.indexOf('sharedHomeInventory(join(app.resources, "client"), join(PKG, "..", "client"), { readdirSync, existsSync })');
  const codesign = src.indexOf("await verifyAppSignature(reaper"), backend = src.indexOf("await runBackendProbe(reaper");
  const main = src.indexOf('await runMainImportsProbe(reaper, app.exe, join(app.resources, "app.asar", "main.mjs")'), skip = src.indexOf("process.env.OATS_SMOKE_SKIP_LAUNCH");
  assert.ok(inventory > 0 && codesign > 0 && backend > 0 && main > 0 && skip > 0, "all are present");
  assert.ok(inventory < codesign, "the shared home's inventory is part of phase 1, before anything is run");
  assert.ok(backend < main && main < skip, "the backend phase, then main's imports, then the launch skip: CI's build-verify runs reach it");
});
