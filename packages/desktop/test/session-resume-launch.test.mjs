// Lost sessions resumed, main side (session-resume-launch.mjs): the trigger's wiring, which shows nothing and logs
// a failed sweep, and how main.mjs wires it; neither main.mjs nor preload.cjs carries a notice. The module is driven
// with fakes (no Electron, no kernel, no sweep is ever run). main.mjs and preload.cjs are read as source and their
// shipped pieces run in a vm, as host-theme-main.test.mjs does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { createResumeTrigger, localDeploymentIds } from "../../client/session-resume-trigger.mjs";
import { RESUME_PROBE } from "./helpers/resume-sweep.mjs";
import { createResumeWiring } from "../session-resume-launch.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const CLI = Object.freeze({ ...RESUME_PROBE, probedAt: 1 });

// ── The reading's routing ────────────────────────────────────────────────────

/** The wiring over a fake trigger maker; `calls` records what the routing did, in order. */
function wiring() {
  const calls = [];
  let options = null;
  const made = { launch() {}, observed() {}, dispose() {} };
  const cli = () => CLI;
  const trigger = createResumeWiring({
    createTrigger: (o) => { options = o; return made; }, cli,
    error: (line) => calls.push(["error", line]),
  });
  assert.equal(trigger, made, "the wiring returns what the maker made");
  // The trigger's probe is gated (above the tested bound the sweep is held back: above-tested-gate.test.mjs);
  // within the bound it is the probe as given, and nothing is logged.
  assert.equal(options.cli(), CLI, "within the tested bound the CLI's probe is passed as given");
  assert.deepEqual(calls, [], "and nothing is logged");
  assert.deepEqual(Object.keys(options).sort(), ["cli", "onReading"], "run and read are the trigger's defaults");
  return { calls, onReading: options.onReading };
}

test("onReading: failed logs one line with its code only; a code that is not one is E_CLI_PROTOCOL", () => {
  for (const [code, logged] of [["E_CLI_FAILED", "E_CLI_FAILED"], ["E_SESSION_RESUME_9", "E_SESSION_RESUME_9"],
    ["kernel says: rm -rf /home/x", "E_CLI_PROTOCOL"], ["E_lower", "E_CLI_PROTOCOL"], [`E_${"A".repeat(65)}`, "E_CLI_PROTOCOL"],
    [undefined, "E_CLI_PROTOCOL"], [{ toString: () => "E_X" }, "E_CLI_PROTOCOL"], ["E_X\n", "E_CLI_PROTOCOL"]]) {
    const w = wiring();
    w.onReading({ kind: "failed", code, message: "stderr: /home/someone/secret" });
    assert.deepEqual(w.calls, [["error", `oats-desktop: the session resume sweep failed: ${logged}`]], String(code));
  }
});

test("onReading: answered, busy, unsupported and anything else leave nothing and log nothing", () => {
  for (const reading of [{ kind: "answered" }, { kind: "busy" }, { kind: "unsupported" },
    { kind: "later" }, {}, null, undefined]) {
    const w = wiring();
    w.onReading(reading);
    assert.deepEqual(w.calls, [], JSON.stringify(reading));
  }
});

test("the wiring over the real trigger: the launch's answered reading is dropped, a failed sweep logs its line", async () => {
  for (const [reading, logged] of [[{ kind: "answered" }, []], [{ kind: "failed", code: "E_CLI_FAILED" }, ["oats-desktop: the session resume sweep failed: E_CLI_FAILED"]]]) {
    const calls = [];
    let runs = 0;
    const trigger = createResumeWiring({
      createTrigger: (options) => createResumeTrigger({ ...options, run: async () => { runs++; return { envelope: true }; }, read: () => reading }),
      cli: async () => CLI, error: (line) => calls.push(line),
    });
    await trigger.launch();
    assert.equal(runs, 1, `${reading.kind}: the launch sweep ran`);
    assert.deepEqual(calls, logged, reading.kind);
    trigger.dispose();
  }
});

// ── main.mjs and preload.cjs (source) ─────────────────────────────────────────

const main = readFileSync(new URL("../main.mjs", import.meta.url), "utf8");
const preload = readFileSync(new URL("../preload.cjs", import.meta.url), "utf8");

test("main builds one trigger with the settled CLI and the error log, and nothing else", async () => {
  const start = main.indexOf("const resumeTrigger = createResumeWiring({"), tail = "\n});";
  const end = main.indexOf(tail, start);
  assert.ok(start >= 0 && end > start, "main.mjs wires the trigger");
  const calls = {}, readServedCli = () => {}, createResumeTrigger = () => {};
  const made = { launch() {}, observed() {} };
  const out = runInNewContext(`${main.slice(start, end + tail.length)}\n;({ resumeTrigger })`, {
    readServedCli, createResumeTrigger,
    settledCli: (read, options) => { calls.settled = [read, options]; return "cli"; },
    createResumeWiring: (io) => { calls.io = io; return made; },
    console: { log: () => assert.fail("nothing is logged as log"), error: (line) => { calls.errored = line; } },
  });
  assert.equal(out.resumeTrigger, made);
  const io = calls.io;
  assert.equal(io.createTrigger, createResumeTrigger, "the shared trigger, with its own run and read");
  assert.deepEqual(Object.keys(io).sort(), ["cli", "createTrigger", "error"]);
  assert.equal(await io.cli(), "cli");
  assert.equal(calls.settled[0], readServedCli);
  assert.equal(JSON.stringify(calls.settled[1]), '{"attempts":60}', "as startupDeploymentList reads it");
  io.error("b");
  assert.equal(calls.errored, "b");
});

test("main and preload carry nothing of a notice or the preference: no channel, no queue, no bridge", () => {
  for (const [name, source] of [["main.mjs", main], ["preload.cjs", preload]]) {
    assert.doesNotMatch(source, /session-resume:|ResumeNotice|resumeNotices|installResumeHandlers|sendToLiveWindows/, name);
    assert.doesNotMatch(source, /resumeAtLaunch|ResumeAtLaunch|ResumePreference|RESUME_PREFERENCE|session-resume\.json/, name);
  }
});

/** The primary instance's startup callback, from its source. */
function startupCallback() {
  const start = main.indexOf("const primaryInstance = startSingleInstance(app,"), end = main.indexOf("}, ownLaunch(app), offerVersionRestart);", start);
  assert.ok(start >= 0 && end > start, "main.mjs has the primary instance's startup");
  return { start, end, source: main.slice(start, end) };
}
const CHAIN = /void startupDeploymentList\(launchedPath\)\.catch\(\(e\) => console\.error\(`oats-desktop: \$\{e\?\.message \|\| e\}`\)\)\s*\.finally\(\(\) => resumeTrigger\.launch\(\)\);/;
/** main's `api` IPC handler, from its source. */
function apiHandler() {
  const start = main.indexOf('ipcMain.handle("api", async (e, pathname, opts) => {'), end = main.indexOf("\n});\n", start);
  assert.ok(start >= 0 && end > start, "main.mjs has its api handler");
  return { start, end, source: main.slice(start, end) };
}
const ACCEPTED = "if (epoch === serverEpoch && !serverHost.inTransition() && r.ok && route === 'panel') {";
/** The accepted-panel-reply block of the api handler, from its source. */
function acceptedBlock() {
  const api = apiHandler(), start = api.source.indexOf(ACCEPTED);
  assert.ok(start >= 0, "the api handler accepts a panel reply under the epoch, transition, ok and route checks");
  const end = api.source.indexOf("\n  }\n", start);
  assert.ok(end > start);
  return { start: api.start + start, end: api.start + end, source: api.source.slice(start, end + 4) };
}

test("main launches the trigger once, in the startup callback only, after the deployments-list step settles", () => {
  const startup = startupCallback();
  const launches = [...main.matchAll(/\.launch\(/g)].map((m) => m.index);
  assert.equal(launches.length, 1, "one launch in main.mjs");
  assert.ok(launches[0] > startup.start && launches[0] < startup.end, "inside the primary instance's startup callback");
  assert.match(startup.source, CHAIN, "chained after the list step, whether it succeeded or failed, and void");
  assert.ok(startup.source.indexOf("await ensureServer();") < startup.source.search(CHAIN), "after the server is ensured");
  // Nowhere else: the trigger is named only where it is made, launched and observed.
  assert.equal([...main.matchAll(/\bresumeTrigger\b/g)].length, 3);
  assert.equal([...main.matchAll(/\bcreateResumeTrigger\b/g)].length, 2, "imported, and given only to the wiring");
  assert.doesNotMatch(main, /resume\w*\.dispose\(/i, "the trigger is never disposed in main");
  // Not on focus, window creation, activate, a workspace switch or a server replacement.
  for (const [what, re] of [
    ["browser-window-focus", /app\.on\("browser-window-focus", \(\) => \{[^]*?\n {2}\}\);/],
    ["browser-window-created", /app\.on\("browser-window-created", [^]*?\n {2}\}\);/],
  ]) {
    const block = startup.source.match(re)?.[0];
    assert.ok(block, `${what} is in the startup`);
    assert.doesNotMatch(block, /resume/i, what);
  }
  for (const name of ["function restoreWindows(", "function openWorkspaceWindow(", "async function ensureServer("]) {
    const at = main.indexOf(name);
    assert.ok(at >= 0, `main.mjs has ${name}`);
    assert.doesNotMatch(main.slice(at, main.indexOf("\n}\n", at)), /resume/i, name);
  }
  const replacement = main.match(/^const replaceServer = .*$/m)?.[0];
  assert.ok(replacement, "main.mjs replaces its server through the adapter");
  assert.doesNotMatch(replacement, /resume/i);
  for (const channel of ["workspace:add", "window:claim-workspace", "window:open-workspace", "workspace:onboard"]) {
    const at = main.search(new RegExp(`ipcMain\\.handle\\(["']${channel}["']`));
    assert.ok(at >= 0, `main.mjs handles ${channel}`);
    assert.doesNotMatch(main.slice(at, main.indexOf("\n});", at)), /resume/i, channel);
  }
});

test("main's shipped chain launches the trigger after the list step resolves, and after it rejects, without waiting on it", async () => {
  const chain = startupCallback().source.match(CHAIN)[0];
  for (const outcome of ["resolve", "reject"]) {
    const order = [];
    let settle;
    const listed = new Promise((resolve, reject) => { settle = () => (outcome === "resolve" ? resolve() : reject(new Error("list failed"))); });
    runInNewContext(chain, {
      launchedPath: "/d",
      startupDeploymentList: (path) => { order.push(["list", path]); return listed; },
      resumeTrigger: { launch: () => { order.push("launch"); return new Promise(() => {}); } },
      console: { error: (line) => order.push(["error", line]) },
    });
    order.push("startup goes on");
    await tick();
    assert.deepEqual(order, [["list", "/d"], "startup goes on"], `${outcome}: not before the list step settles`);
    settle();
    await tick(); await tick();
    assert.deepEqual(order, outcome === "resolve"
      ? [["list", "/d"], "startup goes on", "launch"]
      : [["list", "/d"], "startup goes on", ["error", "oats-desktop: list failed"], "launch"], outcome);
  }
});

test("main observes once, in the api handler, inside the accepted-panel-reply condition, on an instances array", () => {
  const observed = [...main.matchAll(/observed\(/g)].map((m) => m.index);
  assert.equal(observed.length, 1, "one observed call in main.mjs");
  const api = apiHandler(), block = acceptedBlock();
  assert.ok(observed[0] > api.start && observed[0] < api.end, "inside the api handler");
  assert.ok(observed[0] > block.start && observed[0] < block.end, "inside the accepted-panel-reply condition");
  assert.match(block.source, /^ {4}if \(Array\.isArray\(json\?\.instances\)\) void resumeTrigger\.observed\(json\.instances, \{ localDeploymentIds: localDeploymentIds\(json\) \}\);$/m,
    "on the reply's instances array, with the reply's own local deployments, void");
  assert.match(main, /^import \{ createResumeTrigger, localDeploymentIds \} from "\.\.\/client\/session-resume-trigger\.mjs";$/m, "the shared reading of the reply's local deployments");
  assert.match(block.source, /^ {4}if \(Array\.isArray\(json\?\.workspaces\)\) \{\n {6}allowedWs = servedSelectors\(json\.workspaces\);\n {6}noteServed\(json\.workspaces\);\n {4}\}$/m,
    "the workspaces update keeps its own condition");
  assert.equal(api.source.split(ACCEPTED).length, 2, "one accepted-panel-reply condition");
});

test("main's shipped accepted-panel block observes only accepted panel replies, with their local deployments, and updates workspaces as before", () => {
  const { source } = acceptedBlock();
  const instances = [{ home: "/h/a" }], workspaces = [{ id: "w" }];
  const deployments = [{ id: "/d", local: true }, { id: "remote:altair:a1", local: false }, { id: "/e", local: true }];
  const run = ({ epoch = 7, serverEpoch = 7, transition = false, ok = true, route = "panel", json = { instances, workspaces, deployments } } = {}) => {
    const seen = { observed: [], options: [], served: [] };
    const context = {
      epoch, serverEpoch, r: { ok }, route, json, allowedWs: "before",
      serverHost: { inTransition: () => transition },
      servedSelectors: (list) => `selectors of ${list.length}`,
      noteServed: (list) => seen.served.push(list),
      resumeTrigger: { observed: (rows, options) => { seen.observed.push(rows); seen.options.push(options); return Promise.resolve(); } },
      localDeploymentIds,
    };
    runInNewContext(source, context);
    return { ...seen, allowedWs: context.allowedWs };
  };
  const accepted = run();
  assert.equal(accepted.observed.length, 1); assert.equal(accepted.observed[0], instances, "the reply's own rows");
  const plain = (v) => JSON.parse(JSON.stringify(v)); // made in the vm's realm
  assert.deepEqual(plain(accepted.options), [{ localDeploymentIds: ["/d", "/e"] }], "the reply's local deployments, never a remote one");
  for (const odd of [undefined, null, "x", [{ id: "/d" }], [{ id: "/d", local: "true" }]]) {
    assert.deepEqual(plain(run({ json: { instances, deployments: odd } }).options), [{ localDeploymentIds: [] }], JSON.stringify(odd));
  }
  assert.deepEqual(accepted.served, [workspaces]); assert.equal(accepted.allowedWs, "selectors of 1");
  const noWorkspaces = run({ json: { instances } });
  assert.equal(noWorkspaces.observed[0], instances, "the instances need only the accepted reply");
  assert.deepEqual(noWorkspaces.served, []); assert.equal(noWorkspaces.allowedWs, "before");
  for (const odd of [{ workspaces }, { instances: "rows", workspaces }, { instances: { length: 1 }, workspaces }, null, { raw: "text" }]) {
    const r = run({ json: odd });
    assert.deepEqual(r.observed, [], JSON.stringify(odd));
  }
  for (const [what, refused] of [["a non-panel reply", { route: "roster" }], ["another route", { route: "instance-events" }], ["no route", { route: null }],
    ["a non-ok reply", { ok: false }], ["a stale epoch", { epoch: 6 }], ["a request sent during a transition", { epoch: null }], ["in transition", { transition: true }]]) {
    const r = run(refused);
    assert.deepEqual(r.observed, [], what);
    assert.deepEqual(r.served, [], what);
    assert.equal(r.allowedWs, "before", what);
  }
});

test("shutdown leaves the sweeps' children alone: quit names nothing of the trigger", () => {
  const at = main.indexOf("async function shutdown() {");
  assert.ok(at >= 0);
  const body = main.slice(at, main.indexOf("\n}\n", at));
  assert.doesNotMatch(body, /resume/i);
  const quit = main.slice(main.indexOf("let quitStarted = false"), main.indexOf("process.on(sig, () => app.quit());"));
  assert.ok(quit.length > 0);
  assert.doesNotMatch(quit, /resume/i);
});

// ── preload.cjs ──────────────────────────────────────────────────────────────

test("preload: the bridge offers nothing of a resume notice or the preference", () => {
  const require = createRequire(import.meta.url);
  let api = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "oatsDesktop"); api = value; } },
    ipcRenderer: { invoke: () => Promise.resolve(), on() {}, removeListener() {}, send() {} },
    webUtils: {},
  };
  runInNewContext(preload,
    { process: { argv: [] }, require: (name) => (name === "electron" ? electron : require(name === "./terminal-bridge.cjs" ? "../terminal-bridge.cjs" : name)) });
  assert.ok(api, "the bridge is exposed");
  assert.deepEqual(Object.keys(api).filter((key) => /resume/i.test(key)), []);
});
