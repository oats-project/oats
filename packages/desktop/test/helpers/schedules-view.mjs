import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createSchedulesView } from "../../renderer/views/schedules.mjs";
import { setWorkspace } from "../../renderer/views/common.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const cli = { ok: true, bin: "/installed/oats", scheduleApi: 1, features: ["schedule"], remote: ["schedule"] };
const workspace = { id: "/team", scope: "/team" };
const home = "/team/agents/reviewer/instances/reviewer-seat";
const spec = { kind: "wake", enabled: true, cron: "*/15 * * * *", tz: "America/Toronto", home, message: "Check pending work.\nKeep existing work safe." };
const job = { ...spec, id: "review", nextRun: "2026-09-07T12:00:00Z", lastRun: { outcome: "delivered", startedAt: "2026-09-07T11:45:00Z" } };


// The page reads `oats schedule list` through /api/automations (§2.3a) and keeps the local
// verbs (add/update/remove/reconcile/host-install) on /api/schedules.
const localRow = s => ({ ...s, name: s.id, qualifiedId: `local/${s.id}`, origin: { kind: "local", path: "local" }, owner: null, runsOn: null,
  runsHere: true, reason: null, enabledHere: s.enabled !== false, soul: null, teams: [], nextDue: s.nextRun || null });
const reviewer = { name: "reviewer", repo: "src", repoName: "src", agentsRoot: "/team/src/agents", work: "worktree" };
function setup({ mutate, read, instances = [{ home, instance: "reviewer-seat" }], agents = [reviewer], cliFacts = {}, subscribeCli = () => () => {}, host = { installed: true, active: true, registered: true, lastTick: "2026-09-07T11:59:00Z", maxConcurrent: 1 } } = {}) {
  const dom = new JSDOM("<body><main></main></body>", { pretendToBeVisual: true }); const el = dom.window.document.querySelector("main");
  const calls = []; setWorkspace("/team");
  const ctx = { api: async (path, opts) => {
    calls.push({ path, opts });
    if (path.startsWith("/api/automations")) {
      const input = JSON.parse(opts.body); assert.equal(input.kind, "schedule");
      if (input.action !== "list") return { automationsViewApi: 1, status: "ok", kind: "schedule", action: input.action, reason: null, result: await mutate(path, input) };
      const raw = read ? await read(path) : { schedules: [job], scheduler: host };
      return { automationsViewApi: 1, status: "ok", kind: "schedule", action: "list", reason: null,
        result: { scheduleApi: 2, host: { name: "laptop" }, snapshot: null, scheduler: raw.scheduler, schedules: raw.schedules.map(localRow) } };
    }
    if (opts?.method === "POST") return mutate ? mutate(path, JSON.parse(opts.body)) : { schedule: job };
    if (path.startsWith("/api/agents")) return { agents };
    if (path.startsWith("/api/panel")) return { instances };
    assert.fail(path);
  } };
  const create = () => createSchedulesView(el, ctx, { cli: () => ({ ...cli, ...cliFacts, scheduleApi: 2, automationsApi: 1, features: ["schedule", "automations", ...(cliFacts.features || [])] }), subscribeCli });
  let view = create();
  const rowAction = (id, verb) => el.querySelector(`.auto-row[data-id="local/${id}"] .auto-menu button[data-verb=${verb}]`);
  // remount(): the view is disposed and made again on the same element and backend, as the Automations stage does
  // each time the Schedules subtab is chosen.
  return { dom, el, calls, get view() { return view; }, remount() { view.dispose(); view = create(); }, rowAction, cleanup() { view.dispose(); dom.window.close(); } };
}
const posts = (s, prefix) => s.calls.filter(c => c.path.startsWith(prefix) && c.opts?.method === "POST");


export { tick, cli, workspace, home, spec, job, setup, posts };
