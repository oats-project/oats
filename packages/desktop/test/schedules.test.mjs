import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { JSDOM } from "jsdom";
import { cliSchedule, cliSpawn } from "../../client/cli-adapter.mjs";
import { scheduleRequest } from "../server/schedules.mjs";
import { scheduleOutcome } from "../renderer/views/schedules.mjs";
import { wakeScheduleFields } from "../renderer/wake-schedule-fields.mjs";
import { setWorkspace } from "../renderer/views/common.mjs";
import { tick, cli, workspace, home, spec, job, setup, posts } from "./helpers/schedules-view.mjs";

test("schedule adapter passes private JSON and routes on the saved server without a shell", async () => {
  let file, call;
  const result = await cliSchedule(cli.bin, { operation: "add", id: "review", spec, workspaceDir: "/local", server: "builder" }, { exec(bin, argv, opts, cb) {
    file = argv[argv.indexOf("--file") + 1]; call = { bin, argv, opts };
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...spec, id: "review" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    cb(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { schedule: job } }));
  } });
  assert.equal(result.ok, true); assert.equal(existsSync(file), false);
  assert.equal(call.opts.shell, false); assert.equal(call.opts.cwd, "/local");
  assert.deepEqual(call.argv.slice(0, 3), ["schedule", "add", "review"]);
  assert.equal(call.argv.includes("--dir"), false);
  assert.deepEqual(call.argv.slice(-3), ["--server", "builder", "--json"]);
  for (const bad of [{ operation: "tick" }, { operation: "remove", id: "--force" }, { operation: "list", server: "--force" }]) {
    assert.equal((await cliSchedule(cli.bin, { workspaceDir: "/local", ...bad }, { exec: () => assert.fail("invalid operation executed") })).ok, false);
  }
});

test("spawn wake file preserves literal message and a partial schedule failure keeps the instance receipt", async () => {
  let taskFile, wakeFile;
  const wake = { cron: spec.cron, tz: spec.tz, message: "$(nothing) `literal`\nsecond line", enabled: true };
  const result = await cliSpawn(cli.bin, { agent: "reviewer", workspaceDir: "/team", task: "Review code", wake }, { exec(bin, argv, opts, cb) {
    taskFile = argv[argv.indexOf("--task-file") + 1]; wakeFile = argv[argv.indexOf("--wake-file") + 1];
    assert.deepEqual(JSON.parse(readFileSync(wakeFile, "utf8")), wake);
    assert.equal(statSync(wakeFile).mode & 0o777, 0o600); assert.equal(opts.shell, false);
    cb(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: "reviewer-seat", home, launched: true, wakeScheduleError: { code: "E_DISK", message: "Disk full" } } }));
  } });
  assert.equal(result.ok, true); assert.equal(result.result.home, home); assert.equal(result.result.wakeScheduleError.message, "Disk full");
  assert.equal(existsSync(taskFile), false); assert.equal(existsSync(wakeFile), false);
  assert.equal((await cliSpawn(cli.bin, { agent: "reviewer", workspaceDir: "/team", wake: { message: "" } }, { exec: () => assert.fail("invalid wake executed") })).ok, false);
});

test("schedule boundary resolves homes in the selected workspace and refuses unsupported CLIs", async () => {
  const calls = [];
  const context = { workspace, cli, localCwd: "/local", instances: [{ home }], invoke: async (bin, args) => { calls.push(args); return { ok: true, result: { schedule: job } }; } };
  await scheduleRequest({ operation: "add", id: "review", spec }, context);
  assert.equal(calls[0].spec.home, home); assert.equal(calls[0].workspaceDir, "/team");
  await assert.rejects(scheduleRequest({ operation: "add", id: "review", spec: { ...spec, home: "/other/home" } }, context), /existing agent home/);
  await assert.rejects(scheduleRequest({ operation: "remove", id: "review" }, { ...context, workspace: undefined }), /known workspace/);
  await assert.rejects(scheduleRequest({ operation: "remove", id: "review" }, { ...context, cli: { ...cli, scheduleApi: undefined } }), /Update/);
  await scheduleRequest({ operation: "add", id: "digest", spec: { ...spec, kind: "operation", operation: "knowledge:digest" } }, { ...context,
    inspect: async () => ({ capabilities: [{ layer: "knowledge", activation: { enabled: true }, operations: [{ name: "digest", kind: "action", available: true }] }] }),
  });
  assert.equal(calls.at(-1).spec.operation, "knowledge:digest");
  assert.equal(calls.at(-1).spec.home, home);
  assert.equal(calls.at(-1).spec.kind, "operation");
  await scheduleRequest({ operation: "remove", id: "review" }, { ...context, workspace: { ...workspace, server: "builder", registrationPresent: true } });
  assert.equal(calls.at(-1).server, "builder"); assert.equal(calls.at(-1).workspaceDir, "/local");
});

test("scheduled spawn keeps same-named souls in different repositories distinct", async () => {
  const agents = ["first", "second"].map(name => ({ name: "reviewer", agentsRoot: `/team/${name}/agents`, repo: ".", work: "worktree" }));
  let saved;
  const context = { workspace, cli, agents, invoke: async (bin, args) => { saved = args.spec; return { ok: true, result: {} }; } };
  const spawn = { ...spec, kind: "spawn", agent: "reviewer", agentsRoot: "/team/second/agents", repo: ".", task: "Review this repository" };
  await scheduleRequest({ operation: "add", id: "review", spec: spawn }, context);
  assert.equal(saved.agentsRoot, "/team/second/agents");
  await assert.rejects(scheduleRequest({ operation: "add", id: "review", spec: { ...spawn, agentsRoot: "/other/agents" } }, context), /standalone soul/);
});

test("the spawn schedule form offers tmux as its only session backend, even from an older kernel that lists herdr", async () => {
  for (const sessionBackends of [["tmux"], ["tmux", "herdr"]]) {
    const s = setup({ cliFacts: { sessionBackends } });
    try {
      await tick(); s.el.querySelector(".schedule-new").click();
      const select = s.el.querySelector("form").elements.backend;
      assert.deepEqual([...select.options].map(o => [o.value, o.textContent]), [["", "Soul default"], ["tmux", "tmux"]], String(sessionBackends));
      assert.doesNotMatch(s.el.querySelector("form").textContent, /herdr/i);
    } finally { s.cleanup(); }
  }
});

test("wake form saves exact home/message and explicit refresh preserves unsaved input", async () => {
  const s = setup();
  try {
    await tick(); s.el.querySelector(".schedule-new").click(); const form = s.el.querySelector("form");
    form.elements.id.value = "check-work"; form.elements.task.value = "Check work <literally>";
    await s.view.refresh(); assert.equal(form.elements.task.value, "Check work <literally>");
    const reads = posts(s, "/api/automations").length;
    form.dispatchEvent(new s.dom.window.Event("submit", { cancelable: true })); await tick();
    const request = posts(s, "/api/schedules")[0];
    assert.equal(new URL(request.path, "http://local").searchParams.get("ws"), "/team");
    const body = JSON.parse(request.opts.body); assert.equal(body.operation, "add");
    assert.equal(body.spec.home, home); assert.equal(body.spec.message, "Check work <literally>");
    assert.equal(s.el.querySelector(".schedule-sheet").hidden, true);
    // Replaces the old "Wake message delivered" text check: the saved list is re-read instead.
    assert.equal(posts(s, "/api/automations").length, reads + 1, "a save re-reads the list");
  } finally { s.cleanup(); }
});

test("editing only a spawn cron preserves its purpose and recurring wake through the server boundary", async () => {
  const wake = { cron: "*/10 * * * *", tz: "UTC", message: "Check pending work" };
  const original = { id: "review", kind: "spawn", enabled: true, cron: "0 3 * * *", tz: "UTC", agent: "reviewer", agentsRoot: "/team/src/agents", repo: "src", task: "Review work", purpose: "sweep", wake };
  let saved;
  const s = setup({ read: async () => ({ schedules: [original], scheduler: { installed: true, active: true, registered: true } }), mutate: async (path, body) => {
    return scheduleRequest(body, { workspace, cli, agents: [{ name: "reviewer", agentsRoot: "/team/src/agents", repo: "src", work: "worktree" }], invoke: async (bin, args) => {
      saved = args.spec; return { ok: true, result: { schedule: { ...args.spec, id: "review" } } };
    } });
  } });
  try {
    await tick(); s.rowAction("review", "edit").click(); await tick();
    const form = s.el.querySelector("form"); assert.equal(form.elements.id.value, "review"); form.elements.cron.value = "0 4 * * *";
    form.dispatchEvent(new s.dom.window.Event("submit", { cancelable: true })); await tick();
    assert.equal(saved.cron, "0 4 * * *"); assert.equal(saved.purpose, "sweep"); assert.deepEqual(saved.wake, wake);
    assert.equal(saved.agentsRoot, original.agentsRoot);
  } finally { s.cleanup(); }
});

test("schedule name form and CLI accept 100 characters and reject 101 without changing other name rules", async () => {
  const s = setup();
  try {
    await tick(); s.el.querySelector(".schedule-new").click(); await tick();
    const input = s.el.querySelector("form").elements.id;
    for (const [id, valid] of [["a".repeat(100), true], ["a".repeat(101), false], ["-leading", false], ["Upper", false], ["with.dot", false], ["with_underscore", false]]) {
      input.value = id; assert.equal(input.checkValidity(), valid, id);
      let invoked = false;
      const result = await cliSchedule(cli.bin, { operation: "remove", id, workspaceDir: "/team" }, { exec(bin, argv, opts, cb) {
        invoked = true; assert.equal(argv[2], id); cb(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { removed: true } }));
      } });
      assert.equal(invoked, valid, id); assert.equal(result.ok, valid, id);
    }
  } finally { s.cleanup(); }
});

test("double submit dispatches once; late result from prior workspace cannot erase the next draft", async () => {
  let finish; const s = setup({ mutate: () => new Promise(resolve => { finish = resolve; }) });
  try {
    await tick(); s.el.querySelector(".schedule-new").click(); await tick(); const form = s.el.querySelector("form");
    form.elements.id.value = "check-work"; form.elements.task.value = "Check work";
    const submit = () => form.dispatchEvent(new s.dom.window.Event("submit", { cancelable: true }));
    submit(); submit(); assert.equal(posts(s, "/api/schedules").length, 1);
    setWorkspace("/other"); await tick(); s.el.querySelector(".schedule-new").click(); form.elements.task.value = "New workspace draft";
    finish({ schedule: job }); await tick();
    assert.equal(s.el.querySelector(".schedule-sheet").hidden, false); assert.equal(form.elements.task.value, "New workspace draft");
  } finally { s.cleanup(); }
});

test("host installation is explicit and a saved job does not imply a functioning timer", async () => {
  const s = setup({ host: { installed: true, active: true, registered: false } });
  try {
    await tick(); assert.match(s.el.querySelector(".auto-banner").textContent, /scheduler is not running on this computer/);
    assert.equal(posts(s, "/api/schedules").length, 0);
    s.el.querySelector(".auto-banner button").click(); await tick();
    assert.equal(JSON.parse(posts(s, "/api/schedules")[0].opts.body).operation, "host-install");
  } finally { s.cleanup(); }
});

test("read failures disable mutations; schedule failures stay visible with the draft", async () => {
  const s = setup({ mutate: async () => { throw new Error("Invalid cron: month"); } });
  try {
    await tick(); s.el.querySelector(".schedule-new").click(); await tick(); const form = s.el.querySelector("form");
    form.elements.id.value = "check-work"; form.elements.task.value = "Keep me";
    form.dispatchEvent(new s.dom.window.Event("submit", { cancelable: true })); await tick();
    assert.equal(s.el.querySelector(".schedule-sheet").hidden, false); assert.equal(form.elements.task.value, "Keep me");
    assert.match(s.el.querySelector(".schedule-form-error").textContent, /Invalid cron/);
  } finally { s.cleanup(); }
  const failed = setup({ read: async () => { throw new Error("Update oats"); } });
  try { await tick(); assert.equal(failed.el.querySelector(".schedule-new").disabled, true); assert.match(failed.el.querySelector(".auto-status.error").textContent, /Update oats/); }
  finally { failed.cleanup(); }
});

test("Delete asks in the app, removes by the local name, and Cancel returns focus", async () => {
  const s = setup({ mutate: async () => ({ removed: true }) });
  try {
    await tick(); const menuItem = s.rowAction("review", "remove"); menuItem.focus(); menuItem.click();
    const sheet = s.el.querySelector(".schedule-delete-sheet"); assert.equal(sheet.hidden, false);
    assert.match(sheet.textContent, /review is removed from this computer/);
    assert.equal(s.dom.window.document.activeElement, s.el.querySelector(".schedule-delete-cancel"), "the safe choice has focus");
    s.el.querySelector(".schedule-delete-cancel").click(); assert.equal(sheet.hidden, true); assert.equal(posts(s, "/api/schedules").length, 0);
    s.rowAction("review", "remove").click(); s.el.querySelector(".schedule-delete-confirm").click(); await tick();
    assert.deepEqual(JSON.parse(posts(s, "/api/schedules")[0].opts.body), { operation: "remove", id: "review" });
  } finally { s.cleanup(); }
});

test("spawner wake fields are opt-in and preserve the literal message", () => {
  const dom = new JSDOM("<body></body>");
  try {
    const f = wakeScheduleFields(dom.window.document); dom.window.document.body.append(f.el);
    assert.equal(f.read(), undefined); f.el.querySelector(".fwake-enabled").click();
    assert.throws(() => f.read(), /message/);
    f.el.querySelector(".fwake-message").value = "Check pending work.\nNo interruption.";
    assert.equal(f.read().message, "Check pending work.\nNo interruption."); assert.equal(f.read().cron, "*/15 * * * *");
  } finally { dom.window.close(); }
  assert.equal(scheduleOutcome({ outcome: "ended" }), "Run ended");
  assert.doesNotMatch(scheduleOutcome({ outcome: "ended" }), /success/i);
});

test("checking an unknown run preserves the returned remedy across refresh and clears it on workspace change", async () => {
  const unknown = { ...job, lastRun: { outcome: "unknown", error: "Command answered no envelope" } };
  const remedy = "Check the host, then run oats schedule reconcile review --clear";
  const s = setup({ read: async () => ({ schedules: [unknown], scheduler: { installed: true, active: true, registered: true } }), mutate: async () => ({ reconciled: "unknown", remedy }) });
  try {
    await tick(); s.rowAction("review", "reconcile").click(); await tick();
    assert.deepEqual(JSON.parse(posts(s, "/api/automations").at(-2).opts.body), { kind: "schedule", action: "reconcile", key: "local/review" }, "the kernel's reconcile, by qualified id");
    assert.equal(s.el.querySelector(".auto-notice").textContent, "Run state is still unknown. " + remedy);
    await s.view.refresh(); assert.match(s.el.querySelector(".auto-notice").textContent, /--clear/);
    setWorkspace("/other"); await tick(); assert.equal(s.el.querySelector(".auto-notice"), null);
  } finally { s.cleanup(); }
});

// Spec F audit: the schedule form is a modal dialog; Tab and Shift+Tab stay inside it.
test("keyboard: the schedule form is a modal dialog that keeps Tab inside", async () => {
  const s = setup();
  try {
    await tick(); s.el.querySelector(".schedule-new").click(); await tick();
    const form = s.el.querySelector("form.schedule-form"), doc = s.dom.window.document;
    assert.equal(form.getAttribute("role"), "dialog"); assert.equal(form.getAttribute("aria-modal"), "true");
    const tab = (target, shiftKey = false) => { const e = new s.dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }); target.dispatchEvent(e); return e; };
    const cancel = form.querySelector(".schedule-cancel"); cancel.focus();
    assert.equal(tab(cancel).defaultPrevented, true);
    const first = doc.activeElement; assert.ok(form.contains(first) && first !== cancel, "Tab from the last control wraps to the first");
    tab(first, true); assert.equal(doc.activeElement, cancel, "Shift+Tab from the first wraps to the last");
  } finally { s.cleanup(); }
});
