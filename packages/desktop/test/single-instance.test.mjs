import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { startSingleInstance, launchDirectory, launchInstance, createLaunchReporter, createLaunchOpener, ownLaunch, versionHandoffBox, relaunchOptions,
  createVersionHandoff } from "../single-instance.mjs";

function fixture(lock, version = "0.67.1") {
  const app = new EventEmitter();
  const calls = [];
  app.getVersion = () => version;
  app.requestSingleInstanceLock = (data) => { calls.push("lock"); app.lockData = data; return lock; };
  app.quit = () => calls.push("quit");
  app.whenReady = () => { calls.push("ready"); return Promise.resolve(); };
  return { app, calls };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("secondary launch quits without starting a backend, window, or readiness work", async () => {
  const { app, calls } = fixture(false);
  assert.equal(startSingleInstance(app, () => { throw new Error("must not handle a launch"); },
    () => { throw new Error("must not start the desktop"); }), false);
  await tick();
  assert.deepEqual(calls, ["lock", "quit"]);
  assert.equal(app.listenerCount("second-instance"), 0);
});

test("a repeated launch during startup waits for it, then is handed its argv and working directory", async () => {
  const { app, calls } = fixture(true);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const launches = [];
  assert.equal(startSingleInstance(app, (argv, cwd) => launches.push([argv, cwd]), async () => {
    calls.push("start"); await pending;
  }), true);
  app.emit("second-instance", {}, ["/Applications/OATS Desktop.app/Contents/MacOS/OATS Desktop", "--dir", "/d/a"], "/Users/juan");
  await tick();
  assert.deepEqual(calls, ["lock", "ready", "start"]); assert.deepEqual(launches, []);
  finish(); await tick();
  assert.deepEqual(launches, [[["/Applications/OATS Desktop.app/Contents/MacOS/OATS Desktop", "--dir", "/d/a"], "/Users/juan"]]);
  app.emit("second-instance", {}, [], "/"); await tick();
  assert.equal(calls.filter((x) => x === "start").length, 1, "one startup, one server");
  assert.equal(launches.length, 2);
});

// Chromium reorders a second instance's command line (switches first, loose arguments last), so the
// argv the running instance is handed can put another switch after --dir. The second instance sends its
// own argv and working directory with the lock request instead, and those are what a launch reads.
const REORDERED = ["/x/Electron", "--user-data-dir=/u", "--dir", "--allow-file-access-from-files", "--enable-avfoundation", "/app", "/d/beta"];

test("a second instance sends its own argv and working directory with the lock request", () => {
  const { app } = fixture(false);
  startSingleInstance(app, () => {}, () => {}, { argv: ["/x/Electron", "/app", "--dir", "/d/beta"], workingDirectory: "/Users/juan" });
  assert.deepEqual(app.lockData, { argv: ["/x/Electron", "/app", "--dir", "/d/beta"], workingDirectory: "/Users/juan" });
});

test("the running instance reads the launch's own argv, not Chromium's reordered one", async () => {
  const { app } = fixture(true);
  const launches = [];
  startSingleInstance(app, (argv, cwd) => launches.push([argv, cwd]), async () => {});
  await tick();
  app.emit("second-instance", {}, REORDERED, "/", { argv: ["/x/Electron", "/app", "--dir", "/d/beta"], workingDirectory: "/Users/juan" });
  await tick();
  assert.deepEqual(launches, [[["/x/Electron", "/app", "--dir", "/d/beta"], "/Users/juan"]]);
});

test("launch data of the wrong shape is not used: the event's own argv and directory are", async () => {
  for (const data of [undefined, null, "x", { argv: "nope" }, { argv: [1, 2] }, { argv: ["a"], workingDirectory: 7 }, { argv: Array(1001).fill("a") }]) {
    const { app } = fixture(true);
    const launches = [];
    startSingleInstance(app, (argv, cwd) => launches.push([argv, cwd]), async () => {});
    await tick();
    app.emit("second-instance", {}, ["/x/Electron"], "/w", data);
    await tick();
    assert.deepEqual(launches, [[["/x/Electron"], "/w"]], JSON.stringify(data));
  }
});

// ── A launch of another version (an installer replaced while Desktop runs) ──

test("a launch sends its version and what relaunches its copy: the AppImage file when there is one", () => {
  const proc = (env) => ({ argv: ["/tmp/.mount_x/oats-desktop", "--dir", "/d"], cwd: () => "/home/j", env, execPath: "/tmp/.mount_x/oats-desktop" });
  const app = { getVersion: () => "0.67.1" };
  assert.deepEqual(ownLaunch(app, proc({ APPIMAGE: "/home/j/OATS-Desktop-0.67.1.AppImage" })), { argv: ["/tmp/.mount_x/oats-desktop", "--dir", "/d"],
    workingDirectory: "/home/j", version: "0.67.1", execPath: "/home/j/OATS-Desktop-0.67.1.AppImage" });
  assert.equal(ownLaunch(app, proc({})).execPath, "/tmp/.mount_x/oats-desktop", "a DEB or a checkout: its executable");
  assert.equal(ownLaunch(app, proc({ APPIMAGE: "" })).execPath, "/tmp/.mount_x/oats-desktop");
});

test("the lock request carries the injected launch's version and execPath", () => {
  const { app } = fixture(false);
  const launch = { argv: ["/x/oats-desktop"], workingDirectory: "/w", version: "0.67.1", execPath: "/x/oats.AppImage" };
  startSingleInstance(app, () => {}, () => {}, launch);
  assert.deepEqual(app.lockData, launch);
});

/** A running 0.65.0 handed one launch; what onSecondLaunch and onOtherVersion saw, in order. */
async function handOver(data, { running = "0.65.0", handled = "win" } = {}) {
  const { app } = fixture(true, running);
  const log = [];
  startSingleInstance(app, async (argv) => { await tick(); log.push(["launch", argv]); return handled; }, async () => {},
    undefined, (launch, win) => log.push(["other-version", launch, win]));
  await tick();
  app.emit("second-instance", {}, ["/x/reordered"], "/", data);
  for (let i = 0; i < 4; i++) await tick();
  return log;
}
const SENT = { argv: ["/m/oats-desktop", "--dir", "/d/a"], workingDirectory: "/w", version: "0.67.1", execPath: "/home/j/OATS.AppImage" };

test("a different version: the launch is handled first, then handed on with its validated launch and window", async () => {
  assert.deepEqual(await handOver(SENT), [["launch", SENT.argv], ["other-version", SENT, "win"]]);
  const older = await handOver({ ...SENT, version: "0.65.0" }, { running: "0.67.1" });
  assert.equal(older[1][1].version, "0.65.0", "an older launch while a newer runs is told too");
});

test("same version, no version or a malformed one: handled as before, nothing more", async () => {
  for (const version of ["0.65.0", undefined, null, "", 65, ["0.67.1"], "0.67.1 beta", "0.67.1;rm", "v".repeat(65), "0.67.1\n"]) {
    const log = await handOver({ ...SENT, version });
    assert.deepEqual(log, [["launch", SENT.argv]], JSON.stringify(version));
  }
  assert.equal((await handOver({ ...SENT, version: "1".repeat(64) }))[1]?.[0], "other-version", "64 characters is a version");
  assert.equal((await handOver({ ...SENT, version: "1.0.0-rc.1+b.2" }))[1]?.[0], "other-version");
});

test("a relative, oversized, non-string or NUL-bearing execPath reads as none: the version is still told", async () => {
  for (const execPath of ["oats.AppImage", "./x", "/" + "a".repeat(4096), 7, null, undefined, "/x\0y"]) {
    const log = await handOver({ ...SENT, execPath });
    assert.equal(log[1]?.[0], "other-version", JSON.stringify(execPath));
    assert.equal(log[1][1].execPath, null, JSON.stringify(execPath));
  }
  assert.equal((await handOver({ ...SENT, execPath: "/" + "a".repeat(4095) }))[1][1].execPath.length, 4096);
});

test("a launch whose handling fails is not followed by the version box", async () => {
  const { app } = fixture(true, "0.65.0");
  const seen = [], logged = [];
  const original = console.error; console.error = (m) => logged.push(String(m));
  try {
    startSingleInstance(app, () => { throw new Error("boom"); }, async () => {}, undefined, () => seen.push("other"));
    await tick();
    app.emit("second-instance", {}, [], "/", SENT); await tick(); await tick();
  } finally { console.error = original; }
  assert.deepEqual(seen, []); assert.equal(logged.length, 1);
});

test("the box: Restart into the launched version (default) or Keep the running one (cancel, Esc)", () => {
  assert.deepEqual(versionHandoffBox("0.67.1", "0.65.0", "/home/j/OATS.AppImage"), {
    type: "info", title: "OATS Desktop", noLink: true,
    message: "OATS Desktop 0.67.1 was opened, but 0.65.0 is still running.",
    detail: "The version you opened takes effect only after this one quits. Restarting closes Desktop's windows and starts 0.67.1 from /home/j/OATS.AppImage; your agents keep running in their sessions.",
    buttons: ["Restart into 0.67.1", "Keep 0.65.0"], defaultId: 0, cancelId: 1,
  });
});

test("the box with no usable relaunch path: one OK, and how to switch by hand", () => {
  assert.deepEqual(versionHandoffBox("0.67.1", "0.65.0", null), {
    type: "info", title: "OATS Desktop", noLink: true,
    message: "OATS Desktop 0.67.1 was opened, but 0.65.0 is still running.",
    detail: "The version you opened takes effect only after this one quits. Quit OATS Desktop, then open it again.",
    buttons: ["OK"], defaultId: 0, cancelId: 0,
  });
});

test("relaunch options: the sent execPath and the sent argv after its executable", () => {
  assert.deepEqual(relaunchOptions(SENT), { execPath: "/home/j/OATS.AppImage", args: ["--dir", "/d/a"] });
  assert.deepEqual(relaunchOptions({ ...SENT, argv: ["/m/oats-desktop"] }).args, []);
  assert.deepEqual(relaunchOptions({ ...SENT, argv: [] }).args, []);
});

test("the running instance relaunches the sent argv, not Chromium's reordered one", async () => {
  const { app } = fixture(true, "0.65.0");
  const relaunched = [];
  const offer = createVersionHandoff({ running: "0.65.0", ask: async () => ({ response: 0 }), isRegularFile: () => true,
    relaunch: (o) => relaunched.push(o), quit: () => {} });
  startSingleInstance(app, async () => "win", async () => {}, undefined, offer);
  await tick();
  app.emit("second-instance", {}, REORDERED, "/", { ...SENT, argv: ["/x/Electron", "/app", "--dir", "/d/beta"] });
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(relaunched, [{ execPath: SENT.execPath, args: ["/app", "--dir", "/d/beta"] }]);
});

function handoff({ responses = [0], files = () => true, askFails = false } = {}) {
  const log = [];
  const pending = [];
  const offer = createVersionHandoff({
    running: "0.65.0",
    ask: (win, box) => {
      log.push(["ask", win, box.buttons]);
      if (askFails) return Promise.reject(new Error("window gone"));
      const response = responses.shift();
      if (response === "hold") return new Promise((resolve) => pending.push(resolve));
      return Promise.resolve({ response });
    },
    isRegularFile: (path) => { log.push(["stat", path]); return files(path); },
    relaunch: (options) => log.push(["relaunch", options]),
    quit: () => log.push(["quit"]),
  });
  return { offer, log, pending };
}

test("Restart relaunches the launched copy and quits through the normal path", async () => {
  const h = handoff({ responses: [0] });
  await h.offer(SENT, "win");
  assert.deepEqual(h.log, [["stat", SENT.execPath], ["ask", "win", ["Restart into 0.67.1", "Keep 0.65.0"]], ["stat", SENT.execPath],
    ["relaunch", { execPath: SENT.execPath, args: ["--dir", "/d/a"] }], ["quit"]]);
});

test("the box names the very path Restart relaunches", async () => {
  const shown = [], relaunched = [];
  const launch = { ...SENT, execPath: "/opt/OATS Desktop/oats-desktop" };
  const offer = createVersionHandoff({ running: "0.65.0", ask: async (_win, box) => { shown.push(box.detail); return { response: 0 }; },
    isRegularFile: () => true, relaunch: (o) => relaunched.push(o), quit: () => {} });
  await offer(launch, "win");
  assert.equal(relaunched.length, 1);
  assert.ok(shown[0].includes(` from ${relaunched[0].execPath};`), shown[0]);
  assert.equal(relaunched[0].execPath, launch.execPath, "the validated sent execPath, verbatim");
});

test("Keep (or Esc) changes nothing, and the next launch asks again", async () => {
  const h = handoff({ responses: [1, 1] });
  await h.offer(SENT, "win"); await h.offer(SENT, "win");
  assert.deepEqual(h.log.filter(([k]) => k !== "stat").map(([k]) => k), ["ask", "ask"]);
});

test("no window: the box is shown unparented", async () => {
  const h = handoff({ responses: [1] });
  await h.offer(SENT, undefined);
  assert.equal(h.log.find(([k]) => k === "ask")[1], null);
});

test("no usable relaunch path (none sent, missing, not a regular file, unreadable): OK only, never a relaunch", async () => {
  for (const [execPath, files] of [[null, () => assert.fail("nothing to check")], ["/gone", () => false], ["/dir", () => false],
    ["/denied", () => { throw new Error("EACCES"); }]]) {
    const h = handoff({ responses: [0], files });
    await h.offer({ ...SENT, execPath }, "win");
    assert.deepEqual(h.log.filter(([k]) => k !== "stat"), [["ask", "win", ["OK"]]], String(execPath));
  }
});

test("a relaunch path gone while the box was open is not run: the OK box says how instead", async () => {
  let present = true;
  const h = handoff({ responses: [0, 0], files: () => { const was = present; present = false; return was; } });
  await h.offer(SENT, "win");
  assert.deepEqual(h.log.filter(([k]) => k !== "stat"), [["ask", "win", ["Restart into 0.67.1", "Keep 0.65.0"]], ["ask", "win", ["OK"]]]);
});

test("while one box is open another launch does not stack a second; once it closes, the next one asks", async () => {
  const h = handoff({ responses: ["hold", 1] });
  const first = h.offer(SENT, "win");
  await h.offer({ ...SENT, version: "0.68.0" }, "win2");
  assert.equal(h.log.filter(([k]) => k === "ask").length, 1);
  h.pending[0]({ response: 1 }); await first;
  await h.offer(SENT, "win");
  assert.equal(h.log.filter(([k]) => k === "ask").length, 2);
});

test("a box that fails (its window closed underneath) is logged and changes nothing", async () => {
  const h = handoff({ askFails: true });
  const logged = [];
  const original = console.error; console.error = (m) => logged.push(String(m));
  try {
    await h.offer(SENT, "win");
    assert.deepEqual(h.log.filter(([k]) => k === "relaunch" || k === "quit"), []);
    assert.match(logged[0], /version message not shown: window gone/);
    h.log.length = 0;
    await h.offer(SENT, "win");
    assert.equal(h.log.filter(([k]) => k === "ask").length, 1, "not left marked open");
  } finally { console.error = original; }
});

// ── main.mjs's own wiring, evaluated from its source ──

const main = readFileSync(new URL("../main.mjs", import.meta.url), "utf8");

/** main.mjs's launch opener and its --instance select, evaluated over fakes that record every call they get. */
function mainOpener({ loading = false } = {}) {
  const start = main.indexOf("function selectLaunchInstance("), end = main.indexOf("// A repeated launch of another version", start);
  assert.ok(start >= 0 && end > start, "main.mjs builds the launch opener after its --instance select");
  const calls = [], once = new Map();
  const record = (name, value) => (...args) => { calls.push([name, ...args]); return typeof value === "function" ? value(...args) : value; };
  const win = (key) => ({ name: `window of ${key}`, isDestroyed: () => false,
    once: (event, fn) => once.set(event, fn), removeListener: (event) => once.delete(event),
    webContents: { isLoading: () => loading, send: record("send"), once: (event, fn) => { calls.push(["once", event]); once.set(event, fn); } } });
  const ctx = { createLaunchOpener, realpathSync: record("realpath", (p) => p), wsValidate: record("validate", (p) => (p === "/d/a" ? { id: p, path: p } : null)),
    performAdd: record("add", async () => ({ ok: true, workspace: { id: "/d/a" } })), resolveView: record("resolve", "ws:a"),
    panelWorkspaces: record("panel", async () => []), servedList: [],
    openWorkspaceWindow: record("open", (key) => ({ opened: true, win: win(key) })), windows: { focusRecent: record("focus-recent", "recent window") } };
  return { openLaunch: runInNewContext(`${main.slice(start, end)}\nopenLaunch`, ctx), calls, once };
}

test("main: the opener resolves with the window the launch opened or focused", async () => {
  const { openLaunch } = mainOpener();
  assert.equal((await openLaunch("/d/a")).name, "window of ws:a");
  assert.equal(await openLaunch("/home"), "recent window");
});

test("main: --instance sends the deployment's window its id and the validated name, or only that it was invalid", async () => {
  for (const [instance, message] of [[{ ok: true, name: "dev-2" }, { deployment: "/d/a", name: "dev-2" }], [{ ok: false }, { invalid: true }]]) {
    const { openLaunch, calls } = mainOpener();
    await openLaunch("/d/a", instance);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(([k]) => k === "send"))), [["send", "window:focus-instance", message]]);
  }
});

test("main: a window still loading is asked once its page has loaded", async () => {
  const { openLaunch, calls, once } = mainOpener({ loading: true });
  await openLaunch("/d/a", { ok: true, name: "dev-2" });
  assert.deepEqual(calls.filter(([k]) => k === "send"), []);
  once.get("did-finish-load")();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(([k]) => k === "send"))), [["send", "window:focus-instance", { deployment: "/d/a", name: "dev-2" }]]);
});

test("main: --instance adds only that one message: the launch's adds, reads and opens are the same without it", async () => {
  const plain = mainOpener(), focused = mainOpener();
  await plain.openLaunch("/d/a");
  await focused.openLaunch("/d/a", { ok: true, name: "dev-2" });
  const io = (calls) => calls.filter(([k]) => !["send", "realpath", "validate"].includes(k)).map((c) => JSON.stringify(c));
  assert.deepEqual(io(focused.calls), io(plain.calls), "no add, read or open of its own");
  assert.deepEqual(focused.calls.filter(([k]) => k === "send").length, 1);
});

test("main: the first launch's --instance is read with the same reader and goes to the --dir deployment's window", () => {
  assert.match(main, /const startupInstance = launchInstance\(process\.argv\);\n  const reportLaunch = createLaunchReporter\(process\.argv, WORKSPACE\);\n  if \(startupInstance && launchKey\) selectLaunchInstance\(windows\.windowOf\(launchKey\), startupInstance, WORKSPACE, reportLaunch\);/);
  assert.ok(main.indexOf("const startupInstance") > main.indexOf("restoreWindows(launchKey);"), "after the launch's window is opened");
  assert.match(main, /if \(startupIsDeployment\) launchKey = resolveView/, "launchKey is set only for a deployment");
});

test("main: the version box is native, over the launch's window when it is alive, and Restart relaunches then quits", async () => {
  const start = main.indexOf("const offerVersionRestart = createVersionHandoff({"), end = main.indexOf("const primaryInstance = startSingleInstance(", start);
  assert.ok(start >= 0 && end > start, "main.mjs builds the version handoff just before the lock");
  const calls = [];
  const ctx = { createVersionHandoff,
    app: { getVersion: () => "0.65.0", relaunch: (o) => calls.push(["relaunch", o]), quit: () => calls.push(["quit"]) },
    dialog: { showMessageBox: (...args) => { calls.push(["box", args.length === 2 ? args[0].name : null, args.at(-1).buttons]); return Promise.resolve({ response: 0 }); } },
    statSync: (path) => ({ isFile: () => path === SENT.execPath }) };
  const offer = runInNewContext(`${main.slice(start, end)}\nofferVersionRestart`, ctx);
  await offer(SENT, { name: "win", isDestroyed: () => false });
  assert.deepEqual(calls, [["box", "win", ["Restart into 0.67.1", "Keep 0.65.0"]], ["relaunch", { execPath: SENT.execPath, args: ["--dir", "/d/a"] }], ["quit"]]);
  calls.length = 0;
  await offer({ ...SENT, execPath: "/a/dir" }, { name: "closed", isDestroyed: () => true });
  assert.deepEqual(calls, [["box", null, ["OK"]]], "a destroyed window: unparented; not a regular file: OK only");
});

test("main: the lock request sends ownLaunch and different versions go to the handoff", () => {
  assert.match(main, /\n\}, ownLaunch\(app\), offerVersionRestart\);\n\nif \(primaryInstance\) app\.on\("window-all-closed"/);
  assert.match(main, /return openLaunch\(dir, launchInstance\(argv\), createLaunchReporter\(argv, dir\)\);/);
});

test("a launch whose handler fails is reported, never swallowed", async () => {
  const { app } = fixture(true);
  const logged = [];
  const original = console.error; console.error = (m) => logged.push(String(m));
  try {
    startSingleInstance(app, () => { throw new Error("boom"); }, async () => {});
    await tick();
    app.emit("second-instance", {}, [], "/"); await tick(); await tick();
  } finally { console.error = original; }
  assert.equal(logged.length, 1); assert.match(logged[0], /second launch.*boom/);
});

test("launchDirectory: a --dir followed by another switch (a reordered argv) is no --dir", () => {
  assert.equal(launchDirectory(REORDERED, "/w"), "/w");
});

test("launchDirectory: --dir (relative to the launch's working directory), else that directory", () => {
  assert.equal(launchDirectory(["app", "--dir", "/d/a"], "/x"), "/d/a");
  assert.equal(launchDirectory(["app", "--some-flag", "--dir", "a/b"], "/x/y"), "/x/y/a/b");
  assert.equal(launchDirectory(["app"], "/d/b"), "/d/b");
  assert.equal(launchDirectory(["app", "--dir"], "/d/b"), "/d/b", "a --dir with no value is no --dir");
  assert.equal(launchDirectory(["app"], ""), null);
  assert.equal(launchDirectory(undefined, undefined), null);
});

test("launchInstance: --instance beside a --dir with a value; a valid name, an invalid one (never kept), or none", () => {
  assert.deepEqual(launchInstance(["app", "--dir", "/d/a", "--instance", "dev-2"]), { ok: true, name: "dev-2" });
  assert.deepEqual(launchInstance(["app", "--instance", "dev-2", "--dir", "rel/a"]), { ok: true, name: "dev-2" }, "either order");
  for (const bad of ["Dev", "a--b", "-", "a b", "<b>x</b>", "x".repeat(65), ""]) {
    const read = launchInstance(["app", "--dir", "/d/a", "--instance", bad]);
    assert.deepEqual(read, bad ? { ok: false } : null, JSON.stringify(bad));
  }
  assert.equal(launchInstance(["app", "--instance", "dev-2"]), null, "no --dir: as today");
  assert.equal(launchInstance(["app", "--dir", "--instance", "dev-2"]), null, "a --dir whose value is a switch is no --dir");
  assert.equal(launchInstance(["app", "--dir", "/d/a", "--instance", "--dir"]), null, "a value that is itself a switch is no value");
  assert.equal(launchInstance(["app", "--dir", "/d/a", "--instance"]), null);
  assert.equal(launchInstance(["app", "--dir", "/d/a"]), null);
  assert.equal(launchInstance(undefined), null);
  assert.equal(launchInstance(["app", "--dir", "/d/a", "--instance", 7]), null);
});

function opener({ deployments = ["/d/new", "/d/open"], views = { "/d/new": "ws:new", "/d/open": "ws:open" }, admitFails = false } = {}) {
  const log = [];
  const open = createLaunchOpener({
    isDeployment: (dir) => deployments.includes(dir),
    admit: async (dir) => { log.push(["admit", dir]); return admitFails ? null : views[dir]; },
    open: (key) => { log.push(["open", key]); return `window of ${key}`; },
    focusRecent: () => { log.push(["focus-recent"]); return "recent window"; },
    select: (win, instance, dir) => log.push(["select", win, instance, dir]),
  });
  return { open, log };
}

test("second launch with --dir and --instance: the workspace's window is opened or focused, then asked to select", async () => {
  for (const instance of [{ ok: true, name: "dev-2" }, { ok: false }]) {
    const o = opener();
    assert.equal(await o.open("/d/open", instance), "window of ws:open");
    assert.deepEqual(o.log, [["admit", "/d/open"], ["open", "ws:open"], ["select", "window of ws:open", instance, "/d/open"]]);
  }
});

test("--instance only selects in the --dir deployment's window: no deployment, or a failed add, selects nothing", async () => {
  const instance = { ok: true, name: "dev-2" };
  for (const [dir, o] of [["/Users/juan", opener()], [null, opener()], ["/d/new", opener({ admitFails: true })]]) {
    assert.equal(await o.open(dir, instance), "recent window");
    assert.ok(!o.log.some(([k]) => k === "select"), String(dir));
  }
  const o = opener();
  await o.open("/d/new");
  assert.deepEqual(o.log, [["admit", "/d/new"], ["open", "ws:new"]], "no --instance: as today, nothing to select");
});

test("second launch with --dir for a new workspace: admitted through the add path, then its window opened", async () => {
  const o = opener();
  await o.open("/d/new");
  assert.deepEqual(o.log, [["admit", "/d/new"], ["open", "ws:new"]]);
});

test("second launch with --dir for an open workspace: the add path finds it served; its window is opened or focused", async () => {
  const o = opener();
  await o.open("/d/open");
  assert.deepEqual(o.log, [["admit", "/d/open"], ["open", "ws:open"]], "open() focuses the window that holds it (window-set)");
});

test("second launch with a non-deployment, or no dir: nothing is admitted; the most recent window is focused", async () => {
  for (const dir of ["/Users/juan", null]) {
    const o = opener();
    await o.open(dir);
    assert.deepEqual(o.log, [["focus-recent"]], String(dir));
  }
});

test("second launch whose add fails: the most recent window is focused", async () => {
  const o = opener({ admitFails: true });
  await o.open("/d/new");
  assert.deepEqual(o.log, [["admit", "/d/new"], ["focus-recent"]]);
});

test("a check that throws is not a deployment", async () => {
  const log = [];
  const open = createLaunchOpener({ isDeployment: () => { throw new Error("EACCES"); }, admit: async () => "x",
    open: () => log.push("open"), focusRecent: () => log.push("focus-recent") });
  await open("/d/x");
  assert.deepEqual(log, ["focus-recent"]);
});


test("launch disposition: each reason, validated names only, and one line per launch", () => {
  const argv = ["app", "--dir", "/d/a", "--instance", "dev-2"];
  for (const [args, reason, expected] of [
    [argv, null, "oats-desktop: launch --instance dev-2: selecting it in /d/a"],
    [argv, "--dir is not an OATS deployment", "oats-desktop: launch --instance: not selected (--dir is not an OATS deployment)"],
    [argv, "no window", "oats-desktop: launch --instance: not selected (no window for /d/a)"],
    [["--instance", "dev-2"], "no window", "oats-desktop: launch --instance: not selected (no --dir)"],
    [["--dir", "--instance", "dev-2"], "no window", "oats-desktop: launch --instance: not selected (no --dir)"],
    [["--dir", "/d/a", "--instance", "bad\nvalue"], null, "oats-desktop: launch --instance: not selected (not a valid instance name)"],
    [["--dir", "/d/a", "--instance"], "no window", "oats-desktop: launch --instance: not selected (not a valid instance name)"],
  ]) {
    const lines = [], report = createLaunchReporter(args, "/d/a", (s) => lines.push(s));
    report(reason); report("no window");
    assert.deepEqual(lines, [expected]);
  }
  const lines = [];
  createLaunchReporter(["app", "--dir", "/d/a"], "/d/a", (s) => lines.push(s))();
  assert.deepEqual(lines, [], "no --instance has no diagnostic");
  createLaunchReporter(argv, "/d/\na", (s) => lines.push(s))();
  assert.equal(lines[0], "oats-desktop: launch --instance dev-2: selecting it in /d/\\u000aa");
});

test("main: selection diagnostic follows the IPC send, including a loading window", async () => {
  for (const loading of [false, true]) {
    const { openLaunch, calls, once } = mainOpener({ loading });
    await openLaunch("/d/a", { ok: true, name: "dev-2" }, (reason) => calls.push(["report", reason]));
    if (loading) {
      assert.equal(calls.some(([k]) => k === "report"), false, "no claim before send");
      once.get("did-finish-load")();
    }
    assert.deepEqual(calls.slice(-2).map(([k]) => k), ["send", "report"]);
    assert.equal(calls.at(-1)[1], undefined);
  }
});

test("a repeated launch reports a non-deployment or absent window without selecting", async () => {
  for (const [dir, o, reason] of [["/d/missing", opener(), "--dir is not an OATS deployment"],
    ["/d/new", opener({ admitFails: true }), "no window"]]) {
    const reasons = [];
    await o.open(dir, { ok: true, name: "dev-2" }, (r) => reasons.push(r));
    assert.deepEqual(reasons, [reason]);
    assert.equal(o.log.some(([k]) => k === "select"), false);
  }
});

test("main: a loading window closed before delivery reports why it sent nothing", async () => {
  const { openLaunch, calls, once } = mainOpener({ loading: true });
  const lines = [], report = createLaunchReporter(["--dir", "/d/a", "--instance", "dev-2"], "/d/a", (s) => lines.push(s));
  await openLaunch("/d/a", { ok: true, name: "dev-2" }, report);
  once.get("closed")();
  assert.deepEqual(lines, ["oats-desktop: launch --instance: not selected (no window for /d/a)"]);
  assert.equal(calls.some(([k]) => k === "send"), false);
});

test("a rejected admission reports no window and preserves its rejection", async () => {
  const reasons = [], error = new Error("backend failed");
  const open = createLaunchOpener({ isDeployment: () => true, admit: async () => { throw error; } });
  await assert.rejects(open("/d/a", { ok: true, name: "dev-2" }, (r) => reasons.push(r)), (e) => e === error);
  assert.deepEqual(reasons, ["no window"]);
});
