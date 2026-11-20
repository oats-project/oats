import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createInstanceStarter } from "../renderer/start-instance.mjs";
import { setWorkspace } from "../renderer/views/common.mjs";
import { cliStart } from "../../client/cli-adapter.mjs";
import { START_UNCONFIRMED } from "../renderer/start-unconfirmed.mjs";
import { MARKUP, CONTROL, DETAIL_WITHHELD, shown } from "./helpers/speaker-cases.mjs";

const tick = () => new Promise((r) => setImmediate(r));
function setup({ running = false, cli = { ok: true, features: ["session-start"], remote: ["session-start"] }, start, ready = true, restart = false, server, row = {} } = {}) {
  const dom = new JSDOM("<body><button id='opener'>Start</button></body>");
  setWorkspace("/workspace");
  const instance = { instance: "accountant-minerva", home: "/workspace/agents/accountant/instances/accountant-minerva", runtime: "claude", model: "sonnet", running, ...(server ? { server, addressable: true } : {}), ...row };
  const calls = [], opened = [], notified = [];
  const ctx = { api: async (path, opts) => {
    calls.push({ path, opts });
    if (path === "/api/cli") return cli;
    if (path.startsWith("/api/panel")) return { instances: [instance] };
    if (path === "/api/models") return { models: [{ id: "opus" }] };
    if (path.startsWith("/api/launch-configs")) return { context: "/workspace", configurations: [{ name: "personal", runtime: "codex", source: "/workspace" }] };
    if (path.startsWith("/api/start/") || path.startsWith("/api/restart/")) return start ? start() : { instance: instance.instance, home: instance.home };
    assert.fail(path);
  }, openTerminal: async (ref) => opened.push(ref), notify: (message) => notified.push(message) };
  const opener = dom.window.document.querySelector("#opener"); opener.focus();
  const open = createInstanceStarter(dom.window.document, ctx, { waitForReady: typeof ready === "function" ? ready : async () => ready });
  const modal = open(instance, { restart });
  const submit = () => modal.querySelector("form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  const cleanup = () => { setWorkspace("/finished"); dom.window.close(); };
  return { dom, instance, calls, opened, notified, modal, submit, cleanup, open };
}

test("Start chooses a model for the exact existing home then opens its terminal", async () => {
  const s = setup();
  try {
    await tick();
    assert.equal(s.modal.querySelector(".start-submit").disabled, false);
    assert.equal(s.modal.querySelector(".start-model").placeholder, "sonnet");
    s.modal.querySelector(".start-model").value = "opus";
    s.submit(); await tick();
    const call = s.calls.find((c) => c.path.startsWith("/api/start/"));
    const url = new URL(call.path, "http://localhost");
    assert.equal(url.searchParams.get("home"), s.instance.home);
    assert.equal(url.searchParams.get("ws"), "/workspace");
    assert.deepEqual(JSON.parse(call.opts.body), { model: "opus" });
    assert.deepEqual(s.opened, [s.instance]);
    assert.equal(s.modal.isConnected, false);
    assert.equal(s.dom.window.document.activeElement.id, "opener");
  } finally { s.cleanup(); }
});

test("explicit restart chooses a new configuration and permission setting in the same home", async () => {
  const s = setup({ running: true, restart: true, cli: { ok: true, features: ['session-start', 'session-restart', 'launch-config'] } });
  try {
    await tick();
    assert.equal(s.modal.querySelector('.start-submit').textContent, 'Restart');
    assert.match(s.modal.querySelector('.start-status').textContent, /stops the current harness/);
    const config = s.modal.querySelector('.launch-config-select'); config.value = 'personal';
    config.dispatchEvent(new s.dom.window.Event('change'));
    s.modal.querySelector('.start-yolo').value = 'true';
    s.submit(); await tick();
    const call = s.calls.find(c => c.path.startsWith('/api/restart/'));
    assert.ok(call); assert.equal(new URL(call.path, 'http://localhost').searchParams.get('home'), s.instance.home);
    assert.deepEqual(JSON.parse(call.opts.body), { launchConfig: 'personal', yolo: true });
    assert.equal(s.calls.some(c => c.path.startsWith('/api/retire/') || c.path.startsWith('/api/spawn')), false);
  } finally { s.cleanup(); }
});

test("restart is refused by the dialog on an old CLI even if the instance is running", async () => {
  const s = setup({ running: true, restart: true });
  try {
    await tick(); s.submit(); await tick();
    assert.equal(s.modal.querySelector('.start-submit').disabled, true);
    assert.match(s.modal.querySelector('.start-status').textContent, /Update OATS/);
    assert.equal(s.calls.some(c => c.path.startsWith('/api/restart/')), false);
    assert.equal(s.opened.length, 0);
  } finally { s.cleanup(); }
});

test("already running opens the terminal, and unknown status never starts", async () => {
  for (const running of [true, null]) {
    const s = setup({ running });
    try {
      await tick(); s.submit(); await tick();
      assert.equal(s.calls.some((c) => c.path.startsWith("/api/start/")), false);
      assert.equal(s.opened.length, running ? 1 : 0);
      if (running === null) assert.match(s.modal.querySelector(".start-status").textContent, /verify/);
    } finally { s.cleanup(); }
  }
});

test("old CLI explains the update rather than sending an unsupported start", async () => {
  const s = setup({ cli: { ok: true, features: [], install: "npm install -g @awebai/oats@0.22.9" } });
  try {
    await tick(); s.submit(); await tick();
    assert.equal(s.modal.querySelector(".start-submit").disabled, true);
    assert.match(s.modal.querySelector(".start-status").textContent, /npm install/);
    assert.equal(s.calls.some((c) => c.path.startsWith("/api/start/")), false);
  } finally { s.cleanup(); }
});

test("double submit launches once; workspace switch cannot open the old instance", async () => {
  let finish;
  const s = setup({ start: () => new Promise((r) => { finish = r; }) });
  try {
    await tick(); s.submit(); s.submit();
    assert.equal(s.calls.filter((c) => c.path.startsWith("/api/start/")).length, 1);
    setWorkspace("/elsewhere"); finish({}); await tick();
    assert.equal(s.modal.isConnected, false);
    assert.equal(s.opened.length, 0);
  } finally { s.cleanup(); }
});

test("failed start requires a status refresh before retry and preserves the chosen model", async () => {
  const s = setup({ start: () => { throw new Error("Start timed out"); } });
  try {
    await tick(); s.modal.querySelector(".start-model").value = "opus";
    s.submit(); await tick();
    assert.match(s.modal.querySelector(".start-status").textContent, /timed out/);
    assert.equal(s.modal.querySelector(".start-submit").disabled, true);
    assert.equal(s.modal.querySelector(".start-model").value, "opus");
    s.modal.querySelector(".start-retry").click(); await tick();
    assert.equal(s.modal.querySelector(".start-submit").disabled, false);
  } finally { s.cleanup(); }
});

test("start adapter preserves saved home/server and treats the model as one argv value", async () => {
  let call;
  const exec = (bin, argv, opts, cb) => { call = { bin, argv, opts }; cb(null, '{"schemaVersion":1,"ok":true,"result":{"launched":true}}'); };
  const result = await cliStart("/installed/oats", { home: "/saved/home", workspaceDir: "/local", server: "remote", model: "provider/model" }, { exec });
  assert.equal(result.ok, true);
  assert.deepEqual(call.argv, ["session", "start", "--home", "/saved/home", "--server", "remote", "--model", "provider/model", "--json"]);
  assert.equal(call.opts.cwd, "/local");
  assert.equal(call.opts.shell, false);
  for (const model of ["--force", { nested: true }, "bad\0model"]) {
    const r = await cliStart("/installed/oats", { home: "/saved/home", model }, { exec: () => assert.fail("must not execute") });
    assert.equal(r.error.code, "E_BAD_ARGS");
  }
});

test("an accepted launch whose terminal never becomes ready closes the dialog and says so without a modal (#525)", async () => {
  const s = setup({ ready: false });
  try {
    await tick(); s.submit(); await tick(); await tick();
    assert.equal(s.modal.isConnected, false, "accepted: the dialog does not wait on the harness");
    assert.equal(s.opened.length, 0);
    assert.deepEqual(s.notified, ["accountant-minerva was started, but its terminal isn't ready yet. Open it from its row when it is."]);
    assert.equal(s.dom.window.document.activeElement.id, "opener");
  } finally { s.cleanup(); }
});

test("accepted, the dialog closes at once; the terminal opens when the row is ready, whatever the harness shows (#525)", async () => {
  for (const restart of [false, true]) {
    let ready;
    const s = setup({ running: restart, restart, cli: { ok: true, features: ["session-start", "session-restart"] },
      ready: () => new Promise((r) => { ready = r; }) });
    try {
      await tick(); s.submit(); await tick(); await tick();
      assert.equal(s.modal.isConnected, false, `${restart ? "restart" : "start"} accepted: the dialog closed before readiness`);
      assert.equal(s.dom.window.document.activeElement.id, "opener");
      assert.equal(s.opened.length, 0, "not ready yet");
      ready(true); await tick(); await tick();
      assert.deepEqual(s.opened, [s.instance], "its terminal opens: a confirmation or an error there is visible");
      assert.deepEqual(s.notified, []);
    } finally { s.cleanup(); }
  }
});

test("a workspace switch while the started terminal is getting ready opens nothing and says nothing (#525)", async () => {
  let ready;
  const s = setup({ ready: (_s, _ref, stillHere) => new Promise((r) => { ready = () => r(stillHere()); }) });
  try {
    await tick(); s.submit(); await tick(); await tick();
    assert.equal(s.modal.isConnected, false);
    setWorkspace("/elsewhere"); ready(); await tick(); await tick();
    assert.deepEqual(s.opened, []); assert.deepEqual(s.notified, []);
  } finally { s.cleanup(); }
});

test("a start whose wait ended reads as not confirmed, in the Desktop's own words under no speaker, and needs a status refresh before another start", async () => {
  // As the route answers it (server/oats-web.mjs: cliStart's E_START_UNCONFIRMED, worded by the Desktop) and the shell raises it for a 409.
  const s = setup({ start: () => { throw Object.assign(new Error(START_UNCONFIRMED.message), { code: START_UNCONFIRMED.code, answered: START_UNCONFIRMED.message }); } });
  try {
    await tick(); s.submit(); await tick();
    assert.equal(s.modal.isConnected, true);
    assert.equal(s.modal.querySelector(".start-status").textContent, "OATS didn't confirm the start. It may still be running: check the roster before you start it again.");
    assert.doesNotMatch(s.modal.textContent, /OATS says|in time|timed out/, "not the kernel's words, and not a timeout");
    assert.equal(s.modal.querySelector(".start-kernel-says"), null);
    assert.equal(s.modal.querySelector(".start-submit").disabled, true, "no second start before the row is read again");
    assert.deepEqual(s.opened, []); assert.deepEqual(s.notified, []);
  } finally { s.cleanup(); }
});

test("a refused launch keeps the dialog with the error (#525)", async () => {
  const s = setup({ start: () => { throw Object.assign(new Error("E_LAUNCH_REFUSED: the harness is not installed"), { code: "E_LAUNCH_REFUSED" }); } });
  try {
    await tick(); s.submit(); await tick();
    assert.equal(s.modal.isConnected, true);
    assert.match(s.modal.querySelector(".start-status").textContent, /not installed/);
    assert.deepEqual(s.opened, []); assert.deepEqual(s.notified, []);
  } finally { s.cleanup(); }
});

test("the start dialog offers the default checkbox only when this computer's OATS has launch-config-default", async () => {
  for (const [features, hidden] of [[['session-start', 'launch-config'], true], [['session-start', 'launch-config', 'launch-config-default'], false]]) {
    const s = setup({ cli: { ok: true, features } });
    try {
      await tick();
      assert.equal(s.modal.querySelector('.lc-default-label').hidden, hidden, features.join(','));
    } finally { s.cleanup(); }
  }
});

test("a remote home never offers the default checkbox: this computer can't tell whether that host has the feature", async () => {
  const s = setup({ server: 'build', cli: { ok: true, features: ['session-start', 'launch-config', 'launch-config-default'], remote: ['session-start', 'launch-config'] } });
  try {
    await tick();
    assert.equal(s.modal.querySelector('.start-configurations').hidden, false);
    assert.equal(s.modal.querySelector('.lc-default-label').hidden, true);
  } finally { s.cleanup(); }
});

/* ── #982: the status of a start that cannot be checked says who made the row's text ── */
test("an instance whose state is not known: the dialog's status carries the row's text with its speaker, as text, and Start stays off", async () => {
  const status = async (row) => {
    const s = setup({ running: null, row });
    try { await tick(); assert.equal(s.modal.querySelector(".start-submit").disabled, true); return s.modal.querySelector(".start-status"); } finally { s.cleanup(); }
  };
  const text = "the session did not answer";
  for (const [origin, line] of shown(text)) assert.equal((await status({ runtimeError: text, ...(origin ? { runtimeErrorOrigin: origin } : {}) })).textContent, line, String(origin));
  const own = "Could not verify whether this instance is running. Refresh its status before starting.";
  assert.equal((await status({})).textContent, own, "a row with no text keeps the sentence written here");
  assert.equal((await status({ runtimeErrorOrigin: "kernel" })).textContent, own, "a mark beside no text names nobody");
  const markup = await status({ runtimeError: MARKUP, runtimeErrorOrigin: "terminal-probe" });
  assert.equal(markup.textContent, `Desktop's terminal check says: ${MARKUP}`); assert.equal(markup.querySelector("b, script"), null);
  assert.equal((await status({ runtimeError: CONTROL, runtimeErrorOrigin: "kernel" })).textContent, DETAIL_WITHHELD);
});

// Session providers (spec C1): a row whose `backend` is a provider's name has no terminal.
test("a started instance on a session provider: the dialog closes, no terminal is opened or waited for, and nothing is said of one", async () => {
  for (const ready of [true, false, async () => assert.fail("no terminal is waited for")]) {
    const s = setup({ ready, row: { backend: "bb", tmux: null, session: { provider: "oats.bb", threadId: "thr_x" } } });
    try {
      await tick(); s.submit(); await tick(); await tick();
      assert.ok(s.calls.some((c) => c.path.startsWith("/api/start/")), "the start is sent, as for any row");
      assert.equal(s.modal.isConnected, false);
      assert.deepEqual([s.opened, s.notified], [[], []]);
    } finally { s.cleanup(); }
  }
});

test("a start answered on a session provider, for a row the dialog was opened with as a tmux row: no terminal is waited for or opened, and nothing is said of one; a receipt on tmux, or with no backend, follows as before", async () => {
  const receipt = backend => ({ instance: "accountant-minerva", home: "/workspace/agents/accountant/instances/accountant-minerva", ...(backend === undefined ? {} : { backend }) });
  for (const ready of [false, async () => assert.fail("no terminal is waited for")]) {
    const s = setup({ ready, start: () => ({ ...receipt("bb"), session: { provider: "oats.bb" }, target: null }) });
    try {
      await tick(); s.submit(); await tick(); await tick();
      assert.equal(s.modal.isConnected, false);
      assert.deepEqual([s.opened, s.notified], [[], []], "the receipt's backend decides, not the captured row");
    } finally { s.cleanup(); }
  }
  for (const backend of ["tmux", undefined, ""]) {
    const s = setup({ start: () => receipt(backend) });
    try {
      await tick(); s.submit(); await tick(); await tick();
      assert.deepEqual(s.opened, [s.instance], String(backend));
    } finally { s.cleanup(); }
  }
  // The other way: the dialog was opened on a provider row, and the home moved back to tmux meanwhile. A receipt
  // that names tmux is followed as any start; one that names no backend keeps the captured row's answer (none).
  const bbRow = { backend: "bb", tmux: null, session: { provider: "oats.bb", threadId: "thr_x" } };
  for (const [backend, opens] of [["tmux", true], [undefined, false], ["", false], ["bb", false]]) {
    const s = setup({ row: bbRow, start: () => receipt(backend) });
    try {
      await tick(); s.submit(); await tick(); await tick();
      assert.deepEqual([s.opened, s.notified], [opens ? [s.instance] : [], []], String(backend));
    } finally { s.cleanup(); }
  }
  const late = setup({ row: bbRow, ready: false, start: () => receipt("tmux") });
  try {
    await tick(); late.submit(); await tick(); await tick();
    assert.deepEqual([late.opened, late.notified], [[], ["accountant-minerva was started, but its terminal isn't ready yet. Open it from its row when it is."]], "a tmux start is waited for, as any");
  } finally { late.cleanup(); }
});
