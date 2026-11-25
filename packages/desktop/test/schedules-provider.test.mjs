// Spec C1b: the Schedules form edits a schedule that spawns on a session provider. The form offers the soul's
// session providers (its inspection's `sessionProviders`), keeps a stored one, sets YOLO for a provider that
// launches only in full mode, and drops an Edit that is still reading when anything else moves on.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { scheduleRequest } from "../server/schedules.mjs";
import { setWorkspace } from "../renderer/views/common.mjs";
import { createAutomationsView } from "../renderer/views/automations.mjs";
import { automationRows, fullModeRefusal, scheduleRefusal } from "../renderer/automation-rows.mjs";
import { FULL_MODE_ONLY_PROVIDERS, fullModeOnly, fullModeProblem } from "../../client/session-backends.mjs";
import { tick, cli, workspace, home, setup, posts } from "./helpers/schedules-view.mjs";

const scheduler = { installed: true, active: true, registered: true };
const reviewer = { name: "reviewer", agentsRoot: "/team/src/agents", repo: "src", work: "worktree" };
const onBb = { id: "bb-review", kind: "spawn", enabled: true, cron: "0 3 * * *", tz: "UTC", agent: "reviewer", agentsRoot: "/team/src/agents", repo: "src", task: "Review work", backend: "bb", yolo: true };
const listsBb = { operationsApi: 2, sessionProviders: [{ name: "bb", capability: "oats.bb" }] };
const ticks = async (n = 3) => { for (let i = 0; i < n; i++) await tick(); };
const sheetOf = s => s.el.querySelector(".schedule-sheet:not(.schedule-delete-sheet)");
const options = select => [...select.options].map(o => o.value);
const submit = s => s.el.querySelector("form").dispatchEvent(new s.dom.window.Event("submit", { cancelable: true }));
const change = (s, control, value) => { control.value = value; control.dispatchEvent(new s.dom.window.Event("change", { bubbles: true })); };
/** A reply that waits: `release()` answers (or, with `fail`, rejects) every request held so far and after. */
function deferred(answer, fail = false) {
  let release; const held = new Promise((resolve, reject) => { release = () => (fail ? reject(new Error("inspect failed")) : resolve(answer)); });
  return { held, release: () => release() };
}
/** The server boundary's save, as the Desktop server runs it; `saved` holds what reached the CLI. */
const saver = saved => body => scheduleRequest(body, { workspace, cli, agents: [reviewer], instances: [{ home }],
  invoke: async (bin, args) => { saved.push(args.spec); return { ok: true, result: { schedule: { ...args.spec, id: args.id } } }; } });

test("the one list of providers that launch only in full mode, and what a spawn's choice means on one", () => {
  assert.deepEqual([...FULL_MODE_ONLY_PROVIDERS], ["bb"]);
  assert.equal(fullModeOnly("bb"), true);
  for (const other of ["tmux", "", "BB", "bb2", null, undefined, 7, ["bb"]]) assert.equal(fullModeOnly(other), false, String(other));
  assert.equal(fullModeProblem({ backend: "bb", yolo: true }), null);
  assert.equal(fullModeProblem({ backend: "bb", yolo: false }), "refused");
  for (const none of [undefined, null, "true", 1]) assert.equal(fullModeProblem({ backend: "bb", yolo: none }), "default", String(none));
  for (const spawn of [{ backend: "tmux", yolo: false }, { yolo: false }, { backend: "other" }, null, "bb", []]) assert.equal(fullModeProblem(spawn), null);
  assert.equal(fullModeRefusal({ backend: "bb", yolo: true }), null);
  assert.deepEqual(fullModeRefusal({ backend: "bb", yolo: false }), { tag: "Refused at each run", reason: "Every run is refused: bb launches only in full mode, and this schedule sets the native permission policy.",
    sentence: "Every run is refused: bb launches only in full mode, and this schedule sets the native permission policy. Set its permissions to YOLO (yolo: true)." });
  assert.deepEqual(fullModeRefusal({ backend: "bb" }), { tag: "Needs YOLO", reason: "bb launches only in full mode, and this schedule makes no permission choice: a run is refused unless its launch configuration sets YOLO.",
    sentence: "bb launches only in full mode, and this schedule makes no permission choice: a run is refused unless its launch configuration sets YOLO. Set its permissions to YOLO (yolo: true)." });
  // A row: a spawn schedule's only.
  assert.equal(scheduleRefusal({ kind: "schedule", run: "spawn", backend: "bb", yolo: null })?.tag, "Needs YOLO");
  for (const row of [{ kind: "trigger", run: "spawn", backend: "bb", yolo: false }, { kind: "schedule", run: "wake", backend: "bb", yolo: false }, { kind: "schedule", run: "spawn", backend: "bb", yolo: true }, null]) assert.equal(scheduleRefusal(row), null);
});

test("a new spawn schedule is offered tmux and each session provider of its soul; choosing one that launches only in full mode sets YOLO, says why, and saves both", async () => {
  const saved = [], inspected = [];
  const s = setup({ mutate: async (path, body) => { if (path.startsWith("/api/capabilities")) { inspected.push([path, body]); return { operationsApi: 2, sessionProviders: [{ name: "bb", capability: "oats.bb" }, { name: "other", capability: "x.other" }, { name: "herdr" }, { name: "Bad Name" }] }; } return saver(saved)(body); } });
  try {
    await tick(); s.el.querySelector(".schedule-new").click(); await ticks();
    const form = s.el.querySelector("form"), note = s.el.querySelector(".schedule-yolo-note");
    assert.deepEqual(options(form.elements.backend), ["", "tmux"], "a wake reads no soul");
    assert.equal(inspected.length, 0);
    change(s, form.elements.kind, "spawn");
    assert.equal(s.el.querySelector(".schedule-backend-note").textContent, "Reading the session backends of reviewer…");
    assert.equal(s.el.querySelector(".schedule-backend-note").getAttribute("role"), "status");
    await ticks();
    assert.equal(new URL(inspected[0][0], "http://local").searchParams.get("ws"), "/team");
    assert.deepEqual(inspected[0][1], { action: "inspect", selector: { soul: "reviewer", agentsRoot: "/team/src/agents" } });
    assert.deepEqual(options(form.elements.backend), ["", "tmux", "bb", "other"], "the names the contract allows, never herdr");
    assert.equal(s.el.querySelector(".schedule-backend-note").hidden, true);
    assert.equal(note.hidden, true); assert.equal(form.elements.yolo.disabled, false);
    // A provider that takes any mode leaves Permissions alone.
    change(s, form.elements.backend, "other"); assert.equal(form.elements.yolo.value, ""); assert.equal(note.hidden, true);
    form.elements.yolo.value = "false";
    change(s, form.elements.backend, "bb");
    assert.equal(form.elements.yolo.value, "true"); assert.equal(form.elements.yolo.disabled, true, "kept set while bb is chosen");
    assert.equal(note.hidden, false);
    assert.equal(note.textContent, "bb launches only in full mode, so this schedule is saved with YOLO (permission prompts are skipped). Without it every run is refused.");
    assert.equal(note.classList.contains("schedule-warn"), false);
    assert.equal(form.elements.yolo.getAttribute("aria-describedby"), note.id); assert.equal(form.elements.backend.getAttribute("aria-describedby"), note.id);
    // Leaving bb gives the earlier choice back; coming back sets YOLO again.
    change(s, form.elements.backend, "tmux"); assert.equal(form.elements.yolo.value, "false"); assert.equal(form.elements.yolo.disabled, false); assert.equal(note.hidden, true);
    change(s, form.elements.backend, "bb");
    // Another action keeps the choice, unseen, and reads nothing again for the same soul.
    change(s, form.elements.kind, "wake"); assert.equal(form.elements.yolo.value, "false", "no lock outside a launch");
    change(s, form.elements.kind, "spawn"); await ticks();
    assert.equal(inspected.length, 1); assert.equal(form.elements.backend.value, "bb"); assert.equal(form.elements.yolo.value, "true");
    form.elements.id.value = "nightly"; form.elements.task.value = "Review work";
    submit(s); await ticks();
    assert.equal(saved.length, 1); assert.equal(saved[0].backend, "bb"); assert.equal(saved[0].yolo, true); assert.equal(saved[0].agent, "reviewer");
    assert.equal(sheetOf(s).hidden, true);
  } finally { s.cleanup(); }
});

test("a soul's providers are read for the soul chosen: a later choice wins over an earlier read, on its answer and on its failure, and a failed read offers tmux alone", async () => {
  const second = { name: "builder", repo: "src", repoName: "src", agentsRoot: "/team/src/agents", work: "worktree" };
  for (const outcome of ["answers", "fails"]) {
    const first = deferred(listsBb, outcome === "fails");
    const s = setup({ agents: [{ ...reviewer, repoName: "src" }, second], mutate: async (path, body) => (body.selector?.soul === "reviewer" ? first.held : { operationsApi: 2, sessionProviders: [{ name: "other" }] }) });
    try {
      await tick(); s.el.querySelector(".schedule-new").click(); await ticks();
      const form = s.el.querySelector("form");
      change(s, form.elements.kind, "spawn"); await tick();
      change(s, form.elements.agent, form.elements.agent.options[1].value); await ticks();
      assert.deepEqual(options(form.elements.backend), ["", "tmux", "other"]);
      first.release(); await ticks();
      assert.deepEqual(options(form.elements.backend), ["", "tmux", "other"], `${outcome}: the earlier soul's read changes nothing`);
      assert.equal(s.el.querySelector(".schedule-backend-note").hidden, true, outcome);
      // Back on the first soul: its providers are read again, and the other soul's go at once.
      change(s, form.elements.backend, "other");
      change(s, form.elements.agent, form.elements.agent.options[0].value);
      assert.deepEqual(options(form.elements.backend), ["", "tmux"]); assert.equal(form.elements.backend.value, "", "a choice the soul may not offer is not kept");
      await ticks();
      assert.deepEqual(options(form.elements.backend), outcome === "answers" ? ["", "tmux", "bb"] : ["", "tmux"]);
      assert.equal(s.el.querySelector(".schedule-backend-note").textContent, outcome === "answers" ? "" : "Could not read the session providers of reviewer: only tmux is offered.");
      assert.equal(s.el.querySelector(".schedule-save").disabled, false, "a failed read leaves the form usable");
    } finally { s.cleanup(); }
  }
});

test("a form closed, or another workspace, while a soul's providers are read: the late answer or failure changes nothing", async () => {
  for (const outcome of ["answers", "fails"]) for (const meanwhile of ["closed and reopened", "workspace switched"]) {
    const gate = deferred(listsBb, outcome === "fails"); let reads = 0;
    const s = setup({ mutate: async () => (++reads === 1 ? gate.held : { operationsApi: 2, sessionProviders: [] }) });
    try {
      await tick(); s.el.querySelector(".schedule-new").click(); await ticks();
      const form = s.el.querySelector("form"); change(s, form.elements.kind, "spawn"); await tick();
      if (meanwhile === "workspace switched") { setWorkspace("/elsewhere"); await tick(); }
      else { s.el.querySelector(".schedule-cancel").click(); s.el.querySelector(".schedule-new").click(); await ticks(); change(s, form.elements.kind, "spawn"); await ticks(); }
      gate.release(); await ticks();
      assert.deepEqual(options(form.elements.backend), ["", "tmux"], `${outcome}, ${meanwhile}`);
      assert.equal(sheetOf(s).hidden, meanwhile === "workspace switched");
      if (!sheetOf(s).hidden) assert.equal(s.el.querySelector(".schedule-backend-note").hidden, true, `${outcome}, ${meanwhile}: and nothing is said`);
    } finally { setWorkspace("/team"); s.cleanup(); }
  }
});

test("Edit of a schedule on a session provider: the form opens at once, waits for the soul's inspection, then keeps the backend through a save", async () => {
  const saved = [], inspected = [], gate = deferred(listsBb);
  const s = setup({ read: async () => ({ schedules: [onBb], scheduler }), mutate: async (path, body) => { if (path.startsWith("/api/capabilities")) { inspected.push(body); return gate.held; } return saver(saved)(body); } });
  try {
    await tick(); s.rowAction("bb-review", "edit").click(); await ticks();
    const form = s.el.querySelector("form");
    assert.equal(sheetOf(s).hidden, false, "modal from the press on: nothing else is pressed while it reads");
    assert.equal(form.elements.id.value, "bb-review");
    assert.deepEqual(options(form.elements.backend), ["", "tmux", "bb"]); assert.equal(form.elements.backend.value, "bb");
    assert.equal(s.el.querySelector(".schedule-save").disabled, true, "not usable before the answer");
    for (const name of ["kind", "agent", "backend", "yolo"]) assert.equal(form.elements[name].disabled, true, name);
    assert.equal(form.elements.cron.disabled, false);
    assert.equal(s.el.querySelector(".schedule-backend-note").textContent, "Reading the session backends of reviewer…");
    submit(s); await tick(); assert.equal(saved.length, 0, "a submit by another way sends nothing either");
    assert.deepEqual(inspected, [{ action: "inspect", selector: { soul: "reviewer", agentsRoot: "/team/src/agents" } }], "the schedule's own soul, once");
    gate.release(); await ticks();
    assert.equal(s.el.querySelector(".schedule-save").disabled, false);
    for (const name of ["kind", "agent", "backend"]) assert.equal(form.elements[name].disabled, false, name);
    assert.deepEqual(options(form.elements.backend), ["", "tmux", "bb"]); assert.equal(form.elements.backend.value, "bb");
    assert.equal(form.elements.yolo.value, "true"); assert.equal(form.elements.yolo.disabled, true);
    assert.equal(s.el.querySelector(".schedule-yolo-note").classList.contains("schedule-warn"), false, "stored with YOLO: nothing to warn of");
    form.elements.cron.value = "0 4 * * *"; submit(s); await ticks();
    assert.equal(saved.length, 1); assert.equal(saved[0].cron, "0 4 * * *"); assert.equal(saved[0].backend, "bb"); assert.equal(saved[0].yolo, true); assert.equal(saved[0].task, "Review work");
    assert.equal(inspected.length, 1);
  } finally { s.cleanup(); }
});

test("a schedule made with the CLI, stored without its repository, shows its soul and saves: the one soul of that name under that agents root", async () => {
  const saved = [], bare = { ...onBb }; delete bare.repo;
  const twin = { name: "reviewer", repo: "other", repoName: "other", agentsRoot: "/team/src/agents", work: "worktree" };
  for (const [agents, soul] of [[undefined, JSON.stringify(["reviewer", "src", "/team/src/agents"])], [[{ ...reviewer, repoName: "src" }, twin], ""]]) {
    // With two souls of that name under one agents root the inspect boundary answers for neither
    // (packages/client/inspect-boundary.mjs: "Select one soul and its agents root in this workspace").
    const inspect = async () => { if (soul) return listsBb; throw new Error("Select one soul and its agents root in this workspace"); };
    const s = setup({ agents, read: async () => ({ schedules: [bare, { ...bare, id: "plain", backend: "tmux" }], scheduler }), mutate: async (path, body) => (path.startsWith("/api/capabilities") ? inspect() : saver(saved)(body)) });
    try {
      await tick(); s.rowAction("bb-review", "edit").click(); await ticks();
      const form = s.el.querySelector("form");
      if (!soul) {
        // A decision, pinned: the provider schedule cannot be kept here, and the sentence sends the person to the CLI.
        assert.equal(sheetOf(s).hidden, true);
        assert.equal(s.el.querySelector(".auto-notice").textContent, "Could not read the session backends of reviewer, so this editor cannot tell whether it keeps bb-review. Try Edit again; if it fails again, edit it with the CLI.");
        s.rowAction("plain", "edit").click(); await ticks();
        assert.equal(sheetOf(s).hidden, false); assert.equal(form.elements.agent.value, "", "two of that name: none is chosen for the person");
        continue;
      }
      assert.equal(form.elements.agent.value, soul, "the one soul");
      assert.equal(form.elements.backend.value, "bb"); assert.equal(form.checkValidity(), true);
      submit(s); await ticks();
      assert.equal(saved.length, 1); assert.equal(saved[0].agent, "reviewer"); assert.equal(saved[0].backend, "bb"); assert.equal(saved[0].yolo, true);
    } finally { s.cleanup(); }
  }
});

test("a schedule whose backend the kernel does not list for its soul is not kept: an unlisted provider, an answer without the list, a malformed list, a failed read", async () => {
  const cannot = /^bb-review carries settings this editor cannot keep; edit it with the CLI\.$/;
  for (const [answer, said] of [[async () => ({ operationsApi: 2, sessionProviders: [{ name: "other" }] }), cannot], [async () => ({ operationsApi: 2 }), cannot],
    [async () => ({ operationsApi: 2, sessionProviders: { bb: { capability: "oats.bb" } } }), cannot],
    [async () => { throw new Error("inspect failed"); }, /^Could not read the session backends of reviewer, so this editor cannot tell whether it keeps bb-review\. Try Edit again; if it fails again, edit it with the CLI\.$/]]) {
    const s = setup({ read: async () => ({ schedules: [onBb], scheduler }), mutate: async path => { assert.ok(path.startsWith("/api/capabilities"), path); return answer(); } });
    try {
      await tick(); const edit = s.rowAction("bb-review", "edit"); edit.focus(); edit.click(); await ticks();
      assert.equal(sheetOf(s).hidden, true, "the form closes");
      assert.match(s.el.querySelector(".auto-notice").textContent, said);
      assert.equal(posts(s, "/api/schedules").length, 0);
    } finally { s.cleanup(); }
  }
  // Never admitted, so never read: a removed backend, and a value that is no provider's name.
  for (const backend of ["herdr", "Not A Name", "session-provider"]) {
    const s = setup({ read: async () => ({ schedules: [{ ...onBb, backend }], scheduler }), mutate: async path => assert.fail(path) });
    try {
      await tick(); s.rowAction("bb-review", "edit").click(); await ticks();
      assert.equal(sheetOf(s).hidden, true, backend); assert.match(s.el.querySelector(".auto-notice").textContent, cannot);
    } finally { s.cleanup(); }
  }
});

test("a schedule stored without YOLO on a provider that launches only in full mode: its row and its page say it is refused, and the form sets YOLO and says so", async () => {
  for (const [yolo, tag, sentence, formSays] of [
    [false, "Refused at each run", /^Every run is refused: bb launches only in full mode, and this schedule sets the native permission policy\./, "As saved: Every run is refused: bb launches only in full mode, and this schedule sets the native permission policy. Saving it here sets YOLO (permission prompts are skipped)."],
    [undefined, "Needs YOLO", /^bb launches only in full mode, and this schedule makes no permission choice: a run is refused unless its launch configuration sets YOLO\./, "As saved: bb launches only in full mode, and this schedule makes no permission choice: a run is refused unless its launch configuration sets YOLO. Saving it here sets YOLO (permission prompts are skipped)."]]) {
    const stored = { ...onBb }; if (yolo === undefined) delete stored.yolo; else stored.yolo = yolo;
    const saved = [], fine = { ...onBb, id: "fine" }, plain = { ...onBb, id: "plain", yolo: false }; delete plain.backend;
    const s = setup({ read: async () => ({ schedules: [stored, fine, plain], scheduler }), mutate: async (path, body) => (path.startsWith("/api/capabilities") ? listsBb : saver(saved)(body)) });
    try {
      await tick();
      const row = id => s.el.querySelector(`.auto-row[data-id="local/${id}"]`);
      const mark = row("bb-review").querySelector(".auto-full-mode");
      assert.equal(mark.textContent, tag, "said in words, not by colour alone"); assert.match(mark.title, sentence); assert.ok(mark.classList.contains("warn"));
      for (const id of ["fine", "plain"]) assert.equal(row(id).querySelector(".auto-full-mode"), null, id);
      row("bb-review").querySelector(".auto-open").click(); await tick();
      const line = s.el.querySelector(".auto-page .auto-full-mode-line");
      assert.match(line.textContent, sentence); assert.ok(line.classList.contains("warn"));
      assert.equal(s.el.querySelector(".auto-page .auto-full-mode").textContent, tag);
      s.el.querySelector(".auto-page button[data-verb=edit]").click(); await ticks();
      const form = s.el.querySelector("form"), note = s.el.querySelector(".schedule-yolo-note");
      assert.equal(form.elements.backend.value, "bb"); assert.equal(form.elements.yolo.value, "true"); assert.equal(form.elements.yolo.disabled, true);
      assert.equal(note.textContent, formSays); assert.ok(note.classList.contains("schedule-warn"));
      // On tmux the stored choice is back, and nothing is said.
      change(s, form.elements.backend, "tmux"); assert.equal(form.elements.yolo.value, yolo === false ? "false" : ""); assert.equal(note.hidden, true);
      change(s, form.elements.backend, "bb"); assert.equal(note.textContent, formSays);
      submit(s); await ticks();
      assert.equal(saved.length, 1); assert.equal(saved[0].backend, "bb"); assert.equal(saved[0].yolo, true);
    } finally { s.cleanup(); }
  }
});

test("a wake to a home on a session provider is edited as any wake, and the form says a home OATS stopped is started at the due minute, and one stopped with the host waits", async () => {
  const bbHome = "/team/agents/reviewer/instances/bb-seat", saved = [];
  const wake = { id: "nudge", kind: "wake", enabled: true, cron: "*/15 * * * *", tz: "UTC", home: bbHome, message: "Anything new?" };
  const s = setup({ read: async () => ({ schedules: [wake], scheduler }), instances: [{ home, instance: "reviewer-seat" }, { home: bbHome, instance: "bb-seat", backend: "bb", running: false }],
    mutate: async (path, body) => { assert.ok(path.startsWith("/api/schedules"), path); return scheduleRequest(body, { workspace, cli, instances: [{ home }, { home: bbHome }], invoke: async (bin, args) => { saved.push(args.spec); return { ok: true, result: {} }; } }); } });
  try {
    await tick(); s.rowAction("nudge", "edit").click(); await ticks();
    const form = s.el.querySelector("form"), note = s.el.querySelector(".schedule-home-note");
    assert.equal(sheetOf(s).hidden, false); assert.equal(form.elements.home.value, bbHome); assert.equal(s.el.querySelector(".schedule-save").disabled, false);
    assert.equal(note.hidden, false);
    assert.equal(note.textContent, "This home runs on bb, not in a terminal: the wake is sent as its session's input. A home OATS stopped is started at the wake's due minute, in a fresh conversation, and gets the message once it runs; one stopped with the host waits until it is resumed.");
    assert.equal(form.elements.home.getAttribute("aria-describedby"), note.id);
    change(s, form.elements.home, home); assert.equal(note.hidden, true, "a tmux home: nothing to add");
    change(s, form.elements.home, bbHome); assert.equal(note.hidden, false);
    change(s, form.elements.kind, "spawn"); assert.equal(note.hidden, true); change(s, form.elements.kind, "wake");
    form.elements.task.value = "Anything new today?"; submit(s); await ticks();
    assert.deepEqual(saved, [{ cron: "*/15 * * * *", tz: "UTC", enabled: true, kind: "wake", home: bbHome, message: "Anything new today?" }]);
  } finally { s.cleanup(); }
});

// THE RACE (spec C1b, 4). An Edit that is still reading its soul's inspection holds the definition as the list had
// it at the press. Whatever moves on meanwhile drops it, whether the read then answers or fails: no form is left
// that could save the old definition back (its `enabled`, for one), and nothing is said of the dropped Edit.
const MEANWHILE = ["a later Edit", "Delete asked", "Delete confirmed", "the list read again", "the workspace switched", "Turn off here", "Turn on here", "Run now", "Test", "Check run state"];
test("an Edit still reading its soul's inspection is dropped by whatever moves on meanwhile, on the read's answer and on its failure", async () => {
  for (const outcome of ["answers", "fails"]) for (const meanwhile of MEANWHILE) {
    const say = `${outcome}, ${meanwhile}`, gate = deferred(listsBb, outcome === "fails"), acts = [];
    const stored = { ...onBb, enabled: meanwhile !== "Turn on here", ...(meanwhile === "Check run state" ? { lastRun: { outcome: "unknown", error: "no envelope" } } : {}) };
    const plain = { ...onBb, id: "plain" }; delete plain.backend; delete plain.yolo;
    const s = setup({ read: async () => ({ schedules: [stored, plain], scheduler }), mutate: async (path, body) => {
      if (path.startsWith("/api/capabilities")) return gate.held;
      if (path.startsWith("/api/automations")) { acts.push(body.action); if (body.action === "enable" || body.action === "disable") stored.enabled = body.action === "enable"; return body.action === "test" ? { ok: true, problems: [], warnings: [] } : {}; }
      return { removed: true };
    } });
    try {
      await tick(); s.rowAction("bb-review", "edit").click(); await ticks();
      const form = s.el.querySelector("form");
      assert.equal(sheetOf(s).hidden, false, say); assert.equal(form.elements.id.value, "bb-review"); assert.equal(s.el.querySelector(".schedule-save").disabled, true, say);
      if (meanwhile === "a later Edit") s.rowAction("plain", "edit").click();
      else if (meanwhile === "the workspace switched") setWorkspace("/elsewhere");
      else if (meanwhile === "the list read again") s.el.querySelector('button[aria-label="Refresh schedules"]').click();
      else if (meanwhile.startsWith("Delete")) {
        s.rowAction("bb-review", "remove").click();
        assert.equal(s.el.querySelector(".schedule-delete-sheet").hidden, false, `${say}: the confirmation is up`);
        if (meanwhile === "Delete confirmed") s.el.querySelector(".schedule-delete-confirm").click();
      } else s.rowAction("bb-review", { "Turn off here": "disable", "Turn on here": "enable", "Run now": "run", Test: "test", "Check run state": "reconcile" }[meanwhile]).click();
      if (meanwhile !== "a later Edit") assert.equal(sheetOf(s).hidden, true, `${say}: the form is gone at once, before the read ends`);
      await ticks();
      gate.release(); await ticks(5);
      if (meanwhile === "a later Edit") {
        assert.equal(sheetOf(s).hidden, false, say); assert.equal(form.elements.id.value, "plain", `${say}: the later Edit's form`);
        assert.equal(form.elements.backend.value, "", say); assert.equal(s.el.querySelector(".schedule-save").disabled, false, say);
        assert.deepEqual(options(form.elements.backend), outcome === "answers" ? ["", "tmux", "bb"] : ["", "tmux"], say);
      } else assert.equal(sheetOf(s).hidden, true, `${say}: no form`);
      assert.doesNotMatch(s.el.textContent, /cannot keep|Could not read the session backends|changed while it was being edited/, `${say}: nothing is said of the dropped Edit`);
      // Nothing of the old definition is sent: a submit of the dropped form reaches nothing.
      if (meanwhile !== "a later Edit") { submit(s); await ticks(); assert.equal(posts(s, "/api/schedules").filter(c => ["add", "update"].includes(JSON.parse(c.opts.body).operation)).length, 0, say); }
      if (meanwhile === "Turn off here") assert.deepEqual([acts, stored.enabled], [["disable"], false], `${say}: the switch stands`);
      if (meanwhile === "Turn on here") assert.deepEqual([acts, stored.enabled], [["enable"], true], say);
    } finally { setWorkspace("/team"); s.cleanup(); }
  }
});

// A list read in flight (spec C1b, 4, "a list read"): the rows on screen are from before it. An Edit pressed then
// would hold the old definition whichever lands first, the list or the form's own read of the soul's inspection
// (often the faster: the server holds it), so no Edit opens until the read ends.
test("no Edit opens while the list is being read, of a provider schedule or a tmux one, whichever answer would land first; after the read, Edit holds the new definition", async () => {
  for (const outcome of ["the read answers", "the read fails"]) for (const id of ["bb-review", "plain"]) {
    const say = `${outcome}, ${id}`, saved = []; let enabled = true, reads = 0, release, fail;
    const plain = { ...onBb, id: "plain", backend: "tmux" };
    const s = setup({ read: async () => {
      if (++reads === 2) await new Promise((resolve, reject) => { release = resolve; fail = () => reject(new Error("list failed")); });
      return { schedules: [{ ...onBb, enabled }, { ...plain, enabled }], scheduler };
    }, mutate: async (path, body) => (path.startsWith("/api/capabilities") ? listsBb : saver(saved)(body)) });
    try {
      await tick();
      s.el.querySelector('button[aria-label="Refresh schedules"]').click(); await tick();
      enabled = false; // what the read in flight will bring: switched off elsewhere
      assert.equal(s.rowAction(id, "edit").disabled, true, `${say}: Edit waits for the read`);
      // Every way in, not only the disabled button.
      s.rowAction(id, "edit").disabled = false; s.rowAction(id, "edit").click(); await ticks();
      assert.equal(sheetOf(s).hidden, true, `${say}: no form on the old row`); assert.equal(posts(s, "/api/capabilities").length, 0, `${say}: and nothing read for one`);
      // A New form holds no stored definition: it opens, and stays through the read's end.
      s.el.querySelector(".schedule-new").click(); await ticks(); assert.equal(sheetOf(s).hidden, false, say);
      s.el.querySelector(".schedule-cancel").click();
      if (outcome === "the read answers") release(); else fail();
      await ticks(5);
      if (outcome === "the read fails") { assert.equal(s.el.querySelector(".schedule-new").disabled, true, `${say}: a list that did not read changes nothing`); continue; }
      assert.equal(s.rowAction(id, "edit").disabled, false, say);
      s.rowAction(id, "edit").click(); await ticks();
      const form = s.el.querySelector("form");
      assert.equal(sheetOf(s).hidden, false, say); assert.equal(form.elements.enabled.checked, false, `${say}: the definition the read brought`);
      submit(s); await ticks();
      assert.deepEqual(saved.map(spec => spec.enabled), [false], `${say}: a save keeps what the list now says`);
    } finally { s.cleanup(); }
  }
});

test("two list reads that overlap, the earlier answering last: Edit is offered again once none is left", async () => {
  const release = []; let reads = 0;
  const s = setup({ read: async () => { if (++reads > 1) await new Promise(resolve => release.push(resolve)); return { schedules: [{ ...onBb, backend: "tmux" }], scheduler }; }, mutate: async () => ({}) });
  try {
    await tick();
    s.el.querySelector('button[aria-label="Refresh schedules"]').click(); await tick();
    s.rowAction("bb-review", "disable").click(); await ticks(); // an act, then its own re-read
    assert.equal(release.length, 2, "two reads in flight");
    release[1](); await ticks();
    assert.equal(s.rowAction("bb-review", "edit").disabled, true, "one read is still in flight");
    release[0](); await ticks(5);
    assert.equal(s.rowAction("bb-review", "edit").disabled, false, "none left: Edit no longer waits");
    s.rowAction("bb-review", "edit").click(); await ticks(); assert.equal(sheetOf(s).hidden, false);
  } finally { s.cleanup(); }
});

test("a change's own re-read holds Edit too: after a save, a Delete or a summary's save, no Edit opens on the rows from before it", async () => {
  for (const change of ["a form's save", "a summary's save"]) {
    let reads = 0, release;
    const s = setup({ cliFacts: { features: ["automation-descriptions"] }, read: async () => {
      if (++reads === 2) await new Promise(resolve => { release = resolve; });
      return { schedules: [onBb], scheduler };
    }, mutate: async path => (path.startsWith("/api/capabilities") ? listsBb : {}) });
    try {
      await tick();
      if (change === "a form's save") {
        s.el.querySelector(".schedule-new").click(); await ticks();
        const form = s.el.querySelector("form"); form.elements.id.value = "other"; form.elements.task.value = "Check work"; submit(s);
      } else {
        s.rowAction("bb-review", "describe").click();
        const describe = s.el.querySelector(".auto-describe"); describe.querySelector("input").value = "Nightly"; describe.dispatchEvent(new s.dom.window.Event("submit", { cancelable: true }));
      }
      await ticks();
      assert.equal(reads, 2, `${change}: its re-read is in flight`);
      const edit = s.rowAction("bb-review", "edit"); edit.disabled = false; edit.click(); await ticks();
      assert.equal(sheetOf(s).hidden, true, `${change}: no Edit on the old rows`);
      release(); await ticks(5);
      s.rowAction("bb-review", "edit").click(); await ticks();
      assert.equal(sheetOf(s).hidden, false, `${change}: and Edit opens once the list is read`);
    } finally { s.cleanup(); }
  }
});

test("the schedule view sees the page's own acts: while a switch runs no form opens and nothing is sent; after it, Edit reads the definition as it now is", async () => {
  let finish; const stored = { ...onBb }, saved = [];
  const s = setup({ read: async () => ({ schedules: [structuredClone(stored)], scheduler }), mutate: async (path, body) => {
    if (path.startsWith("/api/capabilities")) return listsBb;
    if (path.startsWith("/api/automations")) { await new Promise(resolve => { finish = resolve; }); stored.enabled = false; return {}; }
    return saver(saved)(body);
  } });
  try {
    await tick(); s.rowAction("bb-review", "disable").click(); await tick();
    assert.equal(s.el.querySelector(".schedule-new").disabled, true, "New waits");
    // Every way in is held, not only the disabled buttons: the row's Edit and Delete, and New.
    for (const enter of [() => s.rowAction("bb-review", "edit").click(), () => s.el.querySelector(".schedule-new").click(), () => s.rowAction("bb-review", "remove").click()]) {
      const control = enter; for (const b of s.el.querySelectorAll("button:disabled")) b.disabled = false; control(); await tick();
      assert.equal(sheetOf(s).hidden, true); assert.equal(s.el.querySelector(".schedule-delete-sheet").hidden, true);
    }
    assert.equal(posts(s, "/api/capabilities").length, 0, "and nothing is read for a form");
    finish(); await ticks(5);
    assert.equal(s.el.querySelector(".schedule-new").disabled, false);
    s.rowAction("bb-review", "edit").click(); await ticks();
    const form = s.el.querySelector("form");
    assert.equal(sheetOf(s).hidden, false); assert.equal(form.elements.enabled.checked, false, "the definition after the switch");
    submit(s); await ticks();
    assert.equal(saved.length, 1); assert.equal(saved[0].enabled, false, "a save keeps the switch");
  } finally { s.cleanup(); }
});

test("one of the page's acts that begins under an Edit already in use closes it and says why; a New form stays", async () => {
  const s = setup({ read: async () => ({ schedules: [onBb], scheduler }), mutate: async path => (path.startsWith("/api/capabilities") ? listsBb : {}) });
  try {
    await tick(); const edit = s.rowAction("bb-review", "edit"); edit.click(); await ticks();
    assert.equal(s.el.querySelector(".schedule-save").disabled, false, "in use");
    s.rowAction("bb-review", "disable").click();
    assert.equal(sheetOf(s).hidden, true, "closed at once");
    await ticks(5);
    assert.equal(s.el.querySelector(".auto-notice").textContent, "bb-review changed while it was being edited. Open Edit again.");
    submit(s); await ticks(); assert.equal(posts(s, "/api/schedules").length, 0);
    s.el.querySelector(".schedule-new").click(); await ticks();
    s.el.querySelector("form").elements.task.value = "Keep me";
    s.rowAction("bb-review", "disable").click(); await ticks(5);
    assert.equal(sheetOf(s).hidden, false, "a New form holds no stored definition"); assert.equal(s.el.querySelector("form").elements.task.value, "Keep me");
  } finally { s.cleanup(); }
});

test("the page rebuilt under one of its acts (the CLI's gate changes): the schedule view stays held until the act's request settles, then reads the list again before any Edit", async () => {
  // `then`: an act the rebuilt view begins before the first one lands (its buttons are free): its own re-read, if
  // it has one, is from before the first act landed too.
  for (let outcome of ["the act answers", "the act fails"]) for (const then of [null, "test", "run"]) {
    let finish, fail, enabled = true; const cliFacts = {}, saved = [], heard = [], rebuild = () => { for (const fn of heard) fn(); };
    const s = setup({ cliFacts, subscribeCli: fn => { heard.push(fn); return () => {}; }, read: async () => ({ schedules: [{ ...onBb, enabled }], scheduler }), mutate: async (path, body) => {
      if (path.startsWith("/api/capabilities")) return listsBb;
      if (path.startsWith("/api/automations")) {
        if (body.action === "disable") await new Promise((resolve, reject) => { finish = resolve; fail = () => reject(new Error("refused")); });
        return body.action === "test" ? { ok: true, problems: [], warnings: [] } : {};
      }
      return saver(saved)(body);
    } });
    outcome = `${outcome}${then ? `, then ${then}` : ""}`;
    try {
      await tick(); s.rowAction("bb-review", "disable").click(); await tick();
      // The gate changes: the page disposes its view and builds another, which reads the list before the act lands.
      cliFacts.features = ["automation-descriptions"]; rebuild(); await ticks(5);
      if (then) { assert.equal(s.rowAction("bb-review", then).disabled, false, `${outcome}: the new view's own acts are free`); s.rowAction("bb-review", then).click(); await ticks(5); }
      const reads = posts(s, "/api/automations").filter(c => JSON.parse(c.opts.body).action === "list").length;
      assert.equal(s.el.querySelector(".schedule-new").disabled, true, `${outcome}: still held, the act has not ended`);
      const edit = s.rowAction("bb-review", "edit"); edit.disabled = false; edit.click(); await ticks();
      assert.equal(sheetOf(s).hidden, true, `${outcome}: no Edit on a list read before the act landed`);
      const answers = outcome.startsWith("the act answers");
      if (answers) { enabled = false; finish(); } else fail();
      await ticks(5);
      assert.equal(posts(s, "/api/automations").filter(c => JSON.parse(c.opts.body).action === "list").length, reads + 1, `${outcome}: the list is read again`);
      assert.equal(s.el.querySelector(".schedule-new").disabled, false, outcome);
      s.rowAction("bb-review", "edit").click(); await ticks();
      assert.equal(sheetOf(s).hidden, false, outcome); assert.equal(s.el.querySelector("form").elements.enabled.checked, !answers, `${outcome}: the definition as it now is`);
      submit(s); await ticks();
      assert.deepEqual(saved.map(spec => spec.enabled), [!answers], `${outcome}: a save keeps it`);
    } finally { s.cleanup(); }
  }
});

// The Schedules view made again while an act is in flight: the stage disposes it and makes a new one each time
// the subtab is chosen (Triggers and back), and leaving Automations and coming back does the same. This way round
// predates the form's provider part (the old view's disabled buttons were the only hold, and the new view has none).
test("the Schedules view made again under one of the page's acts starts held, and reads the list again when the act ends, before any Edit", async () => {
  for (const act of ["Turn off here", "a summary's save"]) for (const outcome of ["the act answers", "the act fails"]) {
    const say = `${act}, ${outcome}`, saved = []; let finish, fail, stored = { ...onBb, description: "Nightly" };
    const s = setup({ cliFacts: { features: ["automation-descriptions"] }, read: async () => ({ schedules: [structuredClone(stored)], scheduler }), mutate: async (path, body) => {
      if (path.startsWith("/api/capabilities")) return listsBb;
      if (path.startsWith("/api/automations")) { await new Promise((resolve, reject) => { finish = resolve; fail = () => reject(new Error("refused")); }); return {}; }
      return saver(saved)(body);
    } });
    try {
      await tick();
      if (act === "Turn off here") s.rowAction("bb-review", "disable").click();
      else { s.rowAction("bb-review", "describe").click(); const sheet = s.el.querySelector(".auto-describe"); sheet.querySelector("input").value = "Weekly"; sheet.dispatchEvent(new s.dom.window.Event("submit", { cancelable: true })); }
      await tick();
      s.remount(); await ticks(5); // its list is read before the act lands
      const lists = () => posts(s, "/api/automations").filter(c => JSON.parse(c.opts.body).action === "list").length, reads = lists();
      assert.equal(s.el.querySelector(".schedule-new").disabled, true, `${say}: the new view starts held`);
      for (const verb of ["edit", "remove"]) { const control = s.rowAction("bb-review", verb); control.disabled = false; control.click(); await ticks(); }
      assert.equal(sheetOf(s).hidden, true, `${say}: no Edit on a list read before the act landed`); assert.equal(s.el.querySelector(".schedule-delete-sheet").hidden, true, say);
      const answers = outcome === "the act answers";
      if (answers) { stored = act === "Turn off here" ? { ...stored, enabled: false } : { ...stored, description: "Weekly" }; finish(); } else fail();
      await ticks(5);
      assert.equal(lists(), reads + 1, `${say}: the list is read again`);
      assert.equal(s.el.querySelector(".schedule-new").disabled, false, say);
      s.rowAction("bb-review", "edit").click(); await ticks();
      const form = s.el.querySelector("form");
      assert.equal(sheetOf(s).hidden, false, say);
      assert.deepEqual([form.elements.enabled.checked, form.elements.description.value], [stored.enabled, stored.description], `${say}: the definition as it now is`);
      submit(s); await ticks();
      assert.deepEqual(saved.map(spec => [spec.enabled, spec.description]), [[stored.enabled, stored.description]], `${say}: a save keeps it`);
    } finally { s.cleanup(); }
  }
});

test("an act in one workspace holds no Schedules view of another; it is counted against its own workspace wherever it ends, and the view back there reads the list again before any Edit", async () => {
  // `ends`: which workspace is shown when the act's request settles.
  for (const outcome of ["the act answers", "the act fails"]) for (const ends of ["back in its workspace", "while another is shown"]) {
    const say = `${outcome}, ${ends}`, saved = []; let finish, fail, enabled = true;
    const s = setup({ read: async () => ({ schedules: [{ ...onBb, enabled }], scheduler }), mutate: async (path, body) => {
      if (path.startsWith("/api/capabilities")) return listsBb;
      if (path.startsWith("/api/automations")) { await new Promise((resolve, reject) => { finish = resolve; fail = () => reject(new Error("refused")); }); return {}; }
      return saver(saved)(body);
    } });
    const lists = () => posts(s, "/api/automations").filter(c => JSON.parse(c.opts.body).action === "list" && new URL(c.path, "http://local").searchParams.get("ws") === "/team").length;
    const settle = () => { if (outcome === "the act answers") { enabled = false; finish(); } else fail(); };
    try {
      await tick(); s.rowAction("bb-review", "disable").click(); await tick();
      setWorkspace("/elsewhere"); await ticks(5);
      assert.equal(s.el.querySelector(".schedule-new").disabled, false, `${say}: another workspace is not held`);
      if (ends === "while another is shown") { settle(); await ticks(5); }
      setWorkspace("/team"); await ticks(5);
      if (ends === "back in its workspace") {
        assert.equal(s.el.querySelector(".schedule-new").disabled, true, `${say}: back in the act's workspace, held`);
        const edit = s.rowAction("bb-review", "edit"); edit.disabled = false; edit.click(); await ticks();
        assert.equal(sheetOf(s).hidden, true, `${say}: no Edit on a list read before the act landed`);
        const reads = lists(); settle(); await ticks(5);
        assert.equal(lists(), reads + 1, `${say}: the list is read again when the act ends`);
      }
      // Counted against its own workspace: nothing is left held there, wherever the end landed.
      assert.equal(s.el.querySelector(".schedule-new").disabled, false, `${say}: not held once the act has ended`);
      s.rowAction("bb-review", "edit").click(); await ticks();
      assert.equal(sheetOf(s).hidden, false, say); assert.equal(s.el.querySelector("form").elements.enabled.checked, enabled, `${say}: the definition as it now is`);
      submit(s); await ticks();
      assert.deepEqual(saved.map(spec => spec.enabled), [enabled], `${say}: a save keeps it`);
    } finally { setWorkspace("/team"); s.cleanup(); }
  }
});

test("the automations page tells its own acts, begin and end, in turn; one it is disposed under ends when its request settles; never the busy state set from outside", async () => {
  const dom = new JSDOM("<body><main></main></body>", { pretendToBeVisual: true }), host = dom.window.document.querySelector("main"), told = [];
  const list = { scheduleApi: 2, host: { name: "laptop" }, snapshot: null, scheduler, schedules: [{ ...onBb, name: "bb-review", qualifiedId: "local/bb-review", origin: { kind: "local", path: "local" }, runsHere: true, enabledHere: true, teams: [] }] };
  assert.equal(automationRows(list, "schedule").rows.length, 1);
  let finish, fail;
  const make = () => createAutomationsView(host, { kind: "schedule", read: async () => list, act: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }), describe: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }), onBusy: v => told.push(v) });
  const action = verb => host.querySelector(`.auto-row[data-id="local/bb-review"] .auto-menu button[data-verb=${verb}]`);
  try {
    let view = make(); await ticks();
    view.setBusy(true); view.setBusy(false); assert.deepEqual(told, [], "setBusy is the extending view's own");
    action("disable").click(); assert.deepEqual(told, [true]); finish({}); await ticks(); assert.deepEqual(told, [true, false], "an act that answers");
    action("run").click(); fail(new Error("refused")); await ticks(); assert.deepEqual(told, [true, false, true, false], "an act that fails");
    action("describe").click(); const form = host.querySelector(".auto-describe");
    form.querySelector("input").value = "Nightly"; form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); assert.deepEqual(told.slice(4), [true], "a summary's save");
    fail(new Error("refused")); await ticks(); assert.deepEqual(told.slice(4), [true, false]);
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); finish({}); await ticks(); assert.deepEqual(told.slice(6), [true, false]);
    // Disposed under an act: nothing is told at the disposal (the act may not have landed), and the end is told
    // when the request settles, on its answer and on its failure; under a summary's save, the same.
    for (const [begin, settle] of [[() => action("test").click(), () => finish({})], [() => action("run").click(), () => fail(new Error("refused"))],
      [() => { action("describe").click(); const sheet = host.querySelector(".auto-describe"); sheet.querySelector("input").value = "Weekly"; sheet.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); }, () => finish({})],
      [() => { action("describe").click(); const sheet = host.querySelector(".auto-describe"); sheet.querySelector("input").value = "Daily"; sheet.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); }, () => fail(new Error("refused"))]]) {
      const at = told.length;
      begin(); assert.deepEqual(told.slice(at), [true]);
      view.dispose(); assert.deepEqual(told.slice(at), [true], "nothing at the disposal");
      settle(); await ticks(); assert.deepEqual(told.slice(at), [true, false], "the end, when the request settles");
      view = make(); await ticks();
    }
    assert.deepEqual(told, told.map((_, i) => i % 2 === 0), "true and false in turn, never the same twice");
    view.dispose();
    // Two summaries' saves that overlap: the sheet is free again once the first save answered, while that save's
    // re-read is still in flight. The page stays busy until the second save has settled too.
    let reads = 0, releaseRead; const answers = [];
    told.length = 0;
    view = createAutomationsView(host, { kind: "schedule", read: async () => { if (++reads === 2) await new Promise(resolve => { releaseRead = resolve; }); return list; },
      describe: () => new Promise(resolve => answers.push(resolve)), onBusy: v => told.push(v) });
    await ticks();
    const save = text => { action("describe").click(); const sheet = host.querySelector(".auto-describe"); sheet.querySelector("input").value = text; sheet.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); };
    save("One"); answers[0]({}); await ticks(); assert.equal(reads, 2, "the first save's re-read is in flight");
    save("Two"); await ticks(); assert.equal(answers.length, 2, "and a second save is sent under it");
    releaseRead(); await ticks(); assert.deepEqual(told, [true], "the first save ended; the second is still in flight: busy");
    answers[1]({}); await ticks(5); assert.deepEqual(told, [true, false], "not busy once both have settled");
    view.dispose();
  } finally { dom.window.close(); }
});
