/** Schedules (§2.3a, human 2026-09-26): the workspace's schedules and this computer's own,
 * grouped by where they run (views/automations.mjs, on the kernel's `oats schedule list`).
 * This module adds what only local schedules have: the New / Edit form, Delete, the run
 * state check, and enabling the host scheduler — through the local `/api/schedules` verbs.
 *
 * Session providers (spec C1b): a spawn schedule's Session backend offers tmux and each session provider its soul's
 * capabilities supply (the soul's inspection, `sessionProviders`), read by the form itself once it is open. The
 * form is modal from the press on, so nothing else is pressed while it reads; and every read carries a
 * latest-intent ticket, so an answer or a failure that lands after anything moved on changes nothing. */
import { isShown } from "../focus-regions.mjs";
import { apiJson, postJson, workspaceGeneration, wsQuery, onWorkspaceChange, currentWorkspace } from "./common.mjs";
import { wakeScheduleFields } from "../wake-schedule-fields.mjs";
import { scheduleDraft, descriptionValid, DESCRIPTION_MAX } from "../schedule-read-data.mjs";
import { localScheduleDefinition, runState, fullModeRefusal } from "../automation-rows.mjs";
import { sessionBackendNames, sessionProviderNames, listedBackends, fullModeOnly } from "../../../client/session-backends.mjs";
import { sessionProvider, sessionProviderName } from "../../../client/instance-presentation.mjs";
import { mountAutomationsPage, automationDescriptionsSupported } from "./automations.mjs";
import { cliStatus, onCliChange, cliHeldBack } from "./cli-status.mjs";

// The automations page's own acts in flight (a switch, a run, a test, a summary's save: its onBusy), per workspace,
// kept here and not in a view: an act outlives the view it began under. The page rebuilds its view when the CLI's
// gate changes, and the stage makes a new Schedules view each time its subtab is chosen, while the act's request
// is still on its way. `builds`: the page views the acts in flight began under (one token each).
// This closes every lifetime of a view inside one window. It knows nothing of another window, nor of a change made
// with the CLI: a check at save is what covers those (see the docs).
const actsInFlight = new Map(); // workspace -> { count, builds }
const actWatchers = new Set();
/** An act of `build` began, or ended, in `workspace`: every live Schedules view hears it; the last end carries the
 * builds the acts began under. */
function noteAct(workspace, build, began) {
  let entry = actsInFlight.get(workspace);
  if (!entry) { if (!began) return; actsInFlight.set(workspace, entry = { count: 0, builds: new Set() }); }
  entry.count += began ? 1 : -1; if (began) entry.builds.add(build);
  const over = entry.count <= 0; if (over) actsInFlight.delete(workspace);
  for (const watcher of [...actWatchers]) watcher(workspace, began, over ? entry.builds : null);
}

// Mounted as the Automations stage's Schedules subtab (views/automations.mjs).
let preselection;
export function preselectSchedule(soul) { preselection = { soul, generation: workspaceGeneration() }; }

export function scheduleOutcome(run) {
  if (!run) return "Not run yet";
  const labels = { launched: "Agent launched", active: "Agent active", running: "Agent active", ended: "Run ended", stopped: "Agent stopped — needs attention", unknown: "Launch state unknown — needs attention", "launch-failed": "Launch failed", skipped: "Skipped", delivered: "Wake message delivered" };
  return [labels[run.outcome] || run.outcome || "Attempt recorded", run.error?.message || run.error, run.reason].filter(Boolean).join(" · ");
}
const CSS = `
.schedules-page { position:relative; height:100%; display:block; }
.schedule-sheet { position:fixed; z-index:90; inset:0; display:grid; place-items:center; padding:24px; background:var(--scrim); }
.schedule-sheet[hidden] { display:none; }
.schedule-form { grid-template-columns:minmax(0, 1fr); width:min(680px, 100%); max-height:calc(100vh - 48px); overflow:auto; box-sizing:border-box; display:grid; gap:12px; padding:18px 20px; border:1px solid var(--border); border-radius:12px; background:var(--surface); color:var(--fg); box-shadow:var(--shadow-popover); }
.schedule-form [hidden] { display:none; }
.schedule-form h3 { margin:0; font-size:15px; }
.schedule-form label { display:grid; grid-template-columns:minmax(0, 1fr); gap:5px; min-width:0; font-size:12.5px; }
.schedule-form .field { width:100%; min-width:0; }
.schedule-form .schedule-check { display:flex; align-items:center; gap:8px; }
.schedule-form .schedule-pair { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; }
.schedule-form fieldset { border:1px solid var(--border); border-radius:8px; margin:12px 0 0; padding:12px; }
.schedule-form textarea { resize:vertical; min-height:90px; }
.schedule-form .schedule-hint { color:var(--muted); font-size:12px; margin:0; }
.schedule-form .schedule-error { color:var(--danger); margin:0; font-size:12.5px; }
.schedule-form .schedule-note { margin-top:var(--space-2); }
.schedule-form .schedule-warn { color:var(--warn); }
.schedule-actions { display:flex; flex-wrap:wrap; gap:8px; }
.schedule-confirm { width:min(420px, 100%); box-sizing:border-box; display:grid; gap:14px; padding:18px 20px; border:1px solid var(--border); border-radius:12px; background:var(--surface); color:var(--fg); box-shadow:var(--shadow-popover); font-size:12.5px; }
.schedule-confirm h3 { margin:0; font-size:15px; }
.schedule-confirm p { margin:0; color:var(--muted); line-height:1.5; }
@media(max-width:650px) { .schedule-form .schedule-pair { grid-template-columns:minmax(0, 1fr); } }
`;
const FORM = `
  <form class="schedule-form" role="dialog" aria-modal="true" aria-labelledby="schedule-form-title">
    <h3 class="schedule-form-title" id="schedule-form-title">New schedule</h3>
    <label>Name<input class="field" name="id" required pattern="[a-z0-9][a-z0-9\\-]{0,99}" placeholder="daily-review"></label>
    <label class="schedule-summary-field" hidden>Summary (optional)<input class="field" name="description" autocomplete="off" aria-describedby="schedule-summary-hint"><span class="schedule-hint" id="schedule-summary-hint">One line of up to ${DESCRIPTION_MAX} characters, shown in the list. Without one, the list shows the first line of the message or task.</span></label>
    <label>Action<select class="field" name="kind"><option value="wake">Wake an existing agent</option><option value="spawn">Launch a new agent</option><option value="operation">Run a provider operation</option></select></label>
    <label class="schedule-agent-field">Soul<select class="field" name="agent"></select></label>
    <label class="schedule-home-field">Agent home<select class="field" name="home" aria-describedby="schedule-home-note"></select><span class="schedule-home-note schedule-hint" id="schedule-home-note" hidden></span></label>
    <label class="schedule-provider-field" hidden>Provider operation<select class="field" name="providerOperation"></select><span class="schedule-provider-note schedule-hint"></span></label>
    <label class="schedule-task-field"><span class="schedule-task-label">Wake message</span><textarea class="field" name="task" placeholder="What should the agent do each time?"></textarea></label>
    <div class="schedule-spawn-options">
      <label>Purpose (optional instance name prefix)<input class="field" name="purpose"></label>
      <div class="schedule-pair">
        <label>Harness<select class="field" name="harness"><option value="">Soul default</option><option>pi</option><option>claude</option><option>codex</option></select></label>
        <label>Model<input class="field" name="model" placeholder="Soul default"></label>
      </div>
      <div class="schedule-pair">
        <label>Session backend<select class="field" name="backend" aria-describedby="schedule-yolo-note"><option value="">Soul default</option><option value="tmux">tmux</option></select></label>
        <label>Permissions<select class="field" name="yolo" aria-describedby="schedule-yolo-note"><option value="">Soul / scope setting</option><option value="true">YOLO — skip permission prompts</option><option value="false">Native permission policy</option></select></label>
      </div>
      <p class="schedule-backend-note schedule-hint schedule-note" role="status" hidden></p>
      <p class="schedule-yolo-note schedule-hint schedule-note" id="schedule-yolo-note" hidden></p>
    </div>
    <label>Repeat<select class="field" name="repeat"><option value="*/15 * * * *">Every 15 minutes</option><option value="*/5 * * * *">Every 5 minutes</option><option value="*/30 * * * *">Every 30 minutes</option><option value="0 * * * *">Every hour</option><option value="0 9 * * *">Daily at 09:00</option><option value="0 9 * * 1-5">Weekdays at 09:00</option><option value="custom">Custom cron</option></select></label>
    <div class="schedule-pair">
      <label>Cron expression<input class="field" name="cron" required value="*/15 * * * *" aria-describedby="schedule-cron-hint"></label>
      <label>Time zone<input class="field" name="tz" required placeholder="America/Toronto"></label>
    </div>
    <p class="schedule-hint" id="schedule-cron-hint">Minute, hour, day of month, month, day of week. Missed times are skipped. Wake messages use the agent’s terminal; no interrupts are sent.</p>
    <label class="schedule-check"><input type="checkbox" name="enabled" checked>Enabled</label>
    <div class="schedule-actions"><button class="act primary schedule-save" type="submit">Save schedule</button><button class="act schedule-cancel" type="button">Cancel</button></div>
    <p class="schedule-form-error schedule-error" role="alert"></p>
  </form>`;

/** The kernel feature of a wake that starts a provider home OATS stopped (docs/desktop-cli-api.md, Features). */
const WAKE_STARTS_PROVIDER_HOME = "wake-starts-provider-home";

export function createSchedulesView(el, ctx, { cli = cliStatus, subscribeCli = onCliChange, frame = null } = {}) {
  const doc = el.ownerDocument;
  el.innerHTML = `<style>${CSS}</style><div class="oats-view schedules-page"><div class="schedule-sheet" hidden>${FORM}</div><div class="schedule-sheet schedule-delete-sheet" hidden><div class="schedule-confirm" role="alertdialog" aria-modal="true" aria-labelledby="schedule-delete-title" aria-describedby="schedule-delete-text"><h3 id="schedule-delete-title">Delete schedule</h3><p id="schedule-delete-text"></p><div class="schedule-actions"><button class="act danger schedule-delete-confirm" type="button">Delete schedule</button><button class="act schedule-delete-cancel" type="button">Cancel</button></div></div></div><div class="schedule-stage" style="height:100%"></div></div>`;
  const q = selector => el.querySelector(selector);
  const sheet = q(".schedule-sheet:not(.schedule-delete-sheet)"), deleteSheet = q(".schedule-delete-sheet"), form = q("form"), field = name => form.elements.namedItem(name);
  const nestedWake = wakeScheduleFields(doc);
  q(".schedule-spawn-options").append(nestedWake.el);
  let alive = true, busy = false, readOk = false, editing = null, formReady = false, opener = null;
  let agents = [], instances = [], original = null, baseline = {}, originalWake = null;
  let operationRequest = 0, formOperation = 0, mutationOperation = 0, backendRequest = 0;
  // The automations page's own acts in this workspace (`actsInFlight`, above). While one runs this view opens no
  // form and sends no change, as while its own `busy`; a view made while one runs starts held.
  const pageBusy = () => actsInFlight.has(currentWorkspace());
  // The page view this Schedules view shows now: a token made each time the page builds one.
  let build = null;
  // The list reads in flight. While one runs no Edit opens: the rows on screen are from before it, and a form
  // opened on one would hold, and save back, a definition the read is about to replace (whichever of the list's
  // answer and the form's own reads lands first). A New form holds no stored definition and opens.
  let reading = 0;
  // An Edit of a schedule on a session provider, until its soul's inspection says the kernel lists that backend:
  // `{ definition, name }`, the stored definition and the row's name. The form is open and not yet usable.
  let pendingEdit = null;
  // The Permissions choice held aside while a backend that launches only in full mode locks it to YOLO; null: not locked.
  let yoloFree = null;
  // The soul whose session providers the Session backend's options hold (its name and agents root); null: none read.
  let providersOf = null;
  // The local verbs need the schedule contract (0.28) on a compatible CLI, and a list that read:
  // nothing changes what the page could not show.
  // The Summary field needs an OATS that writes summaries (feature automation-descriptions, 0.43).
  const summaries = () => automationDescriptionsSupported(cli());
  // Above the tested bound (#1879) every schedule write is held back (packages/client/above-tested.mjs).
  const canMutate = () => { const c = cli(); return alive && readOk && c?.ok === true && [1, 2].includes(c.scheduleApi) && !!c.features?.includes("schedule")
    && cliHeldBack("POST /api/schedules", c) === null; };
  const owns = (token, gen) => alive && token === formOperation && gen === workspaceGeneration();
  const preserve = (name, key = name) => original && original.kind === field("kind").value && Object.hasOwn(original, key) && field(name).value === baseline[name] ? original[key] : field(name).value;
  const view = () => page?.view;
  const notice = text => view()?.setNotice(text);
  const fill = (select, rows, label, value) => {
    select.replaceChildren();
    for (const row of rows) { const o = doc.createElement("option"); o.value = value(row); o.textContent = label(row); select.append(o); }
  };
  function syncKind(preferred) {
    const kind = field("kind").value;
    q(".schedule-agent-field").hidden = kind !== "spawn";
    q(".schedule-home-field").hidden = kind === "spawn";
    q(".schedule-spawn-options").hidden = kind !== "spawn";
    q(".schedule-task-field").hidden = kind === "operation";
    q(".schedule-task-label").textContent = kind === "wake" ? "Wake message" : "Task";
    field("task").required = kind !== "operation";
    field("agent").required = kind === "spawn";
    field("home").required = kind !== "spawn";
    q(".schedule-provider-field").hidden = kind !== "operation";
    field("providerOperation").required = kind === "operation";
    void loadOperations(typeof preferred === "string" ? preferred : undefined);
    syncHome(); void loadBackends();
  }
  const setNote = (selector, text, warn = false) => { const note = q(selector); note.textContent = text; note.hidden = !text; note.classList.toggle("schedule-warn", !!text && warn); };
  /** A wake to a home on a session provider is a wake as any other; what differs is said: it goes to the session
   * as input, and what it does with a stopped home is the kernel's rule (lib/schedule.mjs performWake). A kernel
   * that lists the feature `wake-starts-provider-home` starts a home OATS stopped at the due minute, in a fresh
   * conversation, as it starts a tmux home, and leaves one stopped with the host to its resume. A kernel without
   * the feature never starts a stopped home there: the note says which of the two this kernel does. */
  function syncHome() {
    const row = field("kind").value === "wake" ? instances.find(i => i.home === field("home").value) : null, provider = row ? sessionProvider(row) : null;
    const stopped = cli()?.features?.includes(WAKE_STARTS_PROVIDER_HOME)
      ? "A home OATS stopped is started at the wake's due minute, in a fresh conversation, and gets the message once it runs; one stopped with the host waits until it is resumed."
      : "A wake never starts a stopped home there: it waits, and is delivered once the home runs again.";
    setNote(".schedule-home-note", provider ? `This home runs on ${sessionProviderName(provider) ? provider : "a session provider"}, not in a terminal: the wake is sent as its session's input. ${stopped}` : "");
  }
  /** The Session backend's provider options: `names`, after "Soul default" and "tmux". A choice that is no longer
   * offered falls back to the soul's default. */
  function setProviders(names) {
    const select = field("backend"), keep = select.value;
    for (const option of [...select.options]) if (option.dataset.provider) option.remove();
    for (const name of names) { const option = doc.createElement("option"); option.value = option.textContent = name; option.dataset.provider = "1"; select.append(option); }
    select.value = [...select.options].some(option => option.value === keep) ? keep : "";
  }
  /** A backend that launches only in full mode (packages/client/session-backends.mjs `fullModeOnly`) takes
   * Permissions: the form sets YOLO, keeps it set while that backend is chosen, and says why. A schedule stored
   * without it says what that means for its runs (automation-rows.mjs `fullModeRefusal`, its reason). Leaving the backend
   * gives the earlier choice back. */
  function syncYolo() {
    const backend = field("backend").value, locked = field("kind").value === "spawn" && fullModeOnly(backend);
    if (locked && yoloFree === null) { yoloFree = field("yolo").value; field("yolo").value = "true"; }
    else if (!locked && yoloFree !== null) { field("yolo").value = yoloFree; yoloFree = null; }
    const stored = locked && original?.kind === "spawn" && original.backend === backend ? fullModeRefusal({ backend, yolo: original.yolo }) : null;
    setNote(".schedule-yolo-note", !locked ? "" : stored ? `As saved: ${stored.reason} Saving it here sets YOLO (permission prompts are skipped).`
      : `${backend} launches only in full mode, so this schedule is saved with YOLO (permission prompts are skipped). Without it every run is refused.`, !!stored);
    render();
  }
  /** The session providers of the chosen soul, read from its inspection into the Session backend's options: one
   * read per soul chosen, under its own ticket and the form's (a later choice, a closed or replaced form, another
   * workspace: the answer or the failure changes nothing). A read that fails offers tmux alone and says so.
   * For an Edit still pending (`pendingEdit`) the soul is the stored definition's, and the answer decides it:
   * `scheduleDraft` with the backends the kernel lists for that soul. Listed, the form becomes usable; not listed,
   * or not read, the form closes and says the editor cannot keep the schedule, as before. */
  async function loadBackends() {
    const token = ++backendRequest, formToken = formOperation, gen = workspaceGeneration(), pending = pendingEdit;
    const chosen = () => { const [soul, , agentsRoot] = JSON.parse(field("agent").value || "[]"); return typeof soul === "string" && soul && typeof agentsRoot === "string" && agentsRoot ? { soul, agentsRoot } : null; };
    const target = pending ? { soul: pending.definition.agent, agentsRoot: pending.definition.agentsRoot } : field("kind").value === "spawn" ? chosen() : null;
    const key = target ? JSON.stringify([target.soul, target.agentsRoot]) : null;
    // Another action than a launch keeps the options as they are, unseen: coming back to the same soul finds its
    // choice again, without a second read.
    if (!target || (!pending && key === providersOf)) { setNote(".schedule-backend-note", ""); syncYolo(); return; }
    // Another soul's providers go at once (a choice among them falls back to the soul's default): nothing can be
    // saved for this soul that was read for the last one. A pending Edit's own option stays until its answer.
    providersOf = null; if (!pending) setProviders([]);
    setNote(".schedule-backend-note", `Reading the session backends of ${target.soul}…`); syncYolo();
    let inspection = null, failed = false;
    try { inspection = await postJson(ctx, `/api/capabilities${deploymentQuery()}`, { action: "inspect", selector: target }); }
    catch { failed = true; }
    if (token !== backendRequest || !owns(formToken, gen) || sheet.hidden) return;
    if (pending) {
      if (failed || !scheduleDraft(pending.definition, { backends: sessionBackendNames(cli(), inspection) })) {
        closeForm();
        notice(failed ? `Could not read the session backends of ${target.soul}, so this editor cannot tell whether it keeps ${pending.name}. Try Edit again; if it fails again, edit it with the CLI.`
          : `${pending.name} carries settings this editor cannot keep; edit it with the CLI.`);
        return;
      }
      pendingEdit = null;
    }
    setProviders(sessionProviderNames(inspection)); providersOf = failed ? null : key;
    setNote(".schedule-backend-note", failed ? `Could not read the session providers of ${target.soul}: only tmux is offered.` : ""); syncYolo();
  }
  /** A pending Edit holds a definition read before whatever happens next: a Delete asked, a list read begun, a
   * change sent, one of the page's own acts. It is dropped, and nothing is said of it. */
  function dropPendingEdit() { if (pendingEdit && !sheet.hidden) closeForm(); }
  async function loadOperations(preferred = field("providerOperation").value) {
    const token = ++operationRequest, formToken = formOperation, gen = workspaceGeneration();
    if (field("kind").value !== "operation") return;
    field("providerOperation").replaceChildren();
    q(".schedule-provider-note").textContent = "Loading operations for this home…";
    try {
      const inspection = await postJson(ctx, `/api/capabilities${deploymentQuery()}`, { action: "inspect", selector: { home: field("home").value } });
      if (token !== operationRequest || !owns(formToken, gen) || sheet.hidden) return;
      const operations = (inspection.capabilities || []).filter(cap => cap.layer).flatMap(cap =>
        (cap.operations || []).filter(op => op.kind === "action" && op.available && !op.args?.some(arg => arg.required)).map(op => ({ address: `${cap.layer}:${op.name}`, label: `${cap.layer}: ${op.name} — ${op.description || cap.id}` })));
      fill(field("providerOperation"), operations, op => op.label, op => op.address);
      if (operations.some(op => op.address === preferred)) field("providerOperation").value = preferred;
      q(".schedule-provider-note").textContent = operations.length ? "Resolved through this home's active provider at each run." : "No available provider actions for this home.";
    } catch (error) {
      if (token === operationRequest && owns(formToken, gen) && !sheet.hidden) q(".schedule-provider-note").textContent = error.message;
    }
  }
  field("home").addEventListener("change", () => { syncHome(); void loadOperations(); });
  field("agent").addEventListener("change", () => void loadBackends());
  field("backend").addEventListener("change", syncYolo);
  function closeForm() {
    ++formOperation; ++operationRequest; ++backendRequest; pendingEdit = null; sheet.hidden = true; formReady = false; formDeployment = null;
    const back = opener; opener = null; if (back?.isConnected) back.focus();
  }
  // The deployment the OPEN form's homes belong to (the view's primary, #482): the form's own requests
  // that name a home (add, update, the home's operations) are addressed to it, never to the view. It
  // belongs to one form: reset when a form opens or closes, and never used by list-level actions.
  let formDeployment = null;
  const deploymentQuery = () => formDeployment ? `?ws=${encodeURIComponent(formDeployment)}` : wsQuery();
  /** Where a mutation goes: the open form's add/update to the form's deployment; anything from the list
   * (remove, reconcile, install…) to the view on screen, which the server reads as its primary. */
  const mutationQuery = (operation) => (operation === "add" || operation === "update") && !sheet.hidden ? deploymentQuery() : wsQuery();
  /** `pending`: an Edit whose backend is a session provider's, admitted for now (editRow); loadBackends decides it. */
  async function openForm(job, soul, pending = null) {
    if (!canMutate() || busy || pageBusy() || (job && reading)) return;
    const token = ++formOperation, gen = workspaceGeneration(); ++operationRequest; ++backendRequest;
    pendingEdit = pending; yoloFree = null;
    formDeployment = null; // this form's deployment is read below; never a previous form's
    opener = doc.activeElement;
    editing = job?.id || null; original = job ? structuredClone(job) : null; formReady = false; form.reset();
    q(".schedule-form-error").textContent = "";
    q(".schedule-form-title").textContent = editing ? `Edit ${editing}` : "New schedule";
    field("agent").replaceChildren(); field("home").replaceChildren();
    field("id").disabled = !!editing; field("id").value = editing || "";
    field("tz").value = job?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    field("cron").value = job?.cron || "*/15 * * * *";
    field("repeat").value = [...field("repeat").options].some(o => o.value === field("cron").value) ? field("cron").value : "custom";
    field("enabled").checked = job?.enabled ?? true;
    q(".schedule-summary-field").hidden = !summaries(); field("description").value = job?.description || "";
    field("kind").value = job?.kind || (soul ? "spawn" : "wake");
    field("task").value = job?.message || job?.task || "";
    field("purpose").value = job?.purpose || "";
    nestedWake.set(job?.wake);
    // The backend's choices start from the soul's default and tmux, and a pending Edit's own provider, so the
    // stored value shows from the start; the soul's providers join them once read (loadBackends).
    setProviders(pending ? [job.backend] : []); providersOf = null;
    setNote(".schedule-backend-note", ""); setNote(".schedule-home-note", "");
    for (const name of ["harness", "model", "backend"]) field(name).value = job?.[name] || "";
    field("yolo").value = job?.yolo === undefined ? "" : String(job.yolo);
    baseline = Object.fromEntries([...form.elements].filter(f => f.name).map(f => [f.name, f.value]));
    originalWake = job?.wake ? { ...nestedWake.read() } : null;
    syncYolo(); // after the baseline: the lock is the form's, not the stored definition's
    sheet.hidden = false; field(editing ? "cron" : "id").focus(); render();
    try {
      const suffix = wsQuery();
      const [roster, panel] = await Promise.all([apiJson(ctx, `/api/agents${suffix}`), apiJson(ctx, `/api/panel${suffix}`)]);
      if (!owns(token, gen) || sheet.hidden) return;
      // Schedules belong to the view's primary deployment (#482): its souls (/api/agents reads it) and its homes only.
      formDeployment = panel.workspace?.primary || null;
      agents = roster.agents || [];
      instances = (panel.instances || []).filter(i => !formDeployment || !i.deployment || i.deployment.id === formDeployment);
      fill(field("agent"), agents.filter(a => a.work !== "attached"), a => `${a.name} · ${a.agentsRoot}`, a => JSON.stringify([a.name, a.repo || null, a.agentsRoot]));
      fill(field("home"), instances, i => `${i.instance} · ${i.home}`, i => i.home);
      if (job?.agent || soul) {
        const want = [job?.agent || soul.name, job?.repo || soul?.repo || null, job?.agentsRoot || soul?.agentsRoot];
        field("agent").value = JSON.stringify(want);
        // A definition stored without its repository (one made with the CLI): its soul is the one of that name
        // under that agents root, when there is exactly one, as the server reads it (server/schedules.mjs).
        if (field("agent").selectedIndex < 0 && want[1] === null) {
          const same = [...field("agent").options].filter(option => { const [name, , root] = JSON.parse(option.value); return name === want[0] && root === want[2]; });
          if (same.length === 1) field("agent").value = same[0].value;
        }
      }
      if (job?.home) field("home").value = job.home;
      baseline.agent = field("agent").value; baseline.home = field("home").value;
      formReady = true; syncKind(job?.operation); render();
    } catch {
      if (owns(token, gen)) { q(".schedule-form-error").textContent = "Could not read targets for this form. Reopen it to retry."; render(); }
    }
  }
  /** Edit a local schedule from its list row: the stored definition, if this editor can preserve it.
   * A spawn whose `backend` is a session provider's name is admitted for now and opens the form at once, not yet
   * usable (`pendingEdit`): the form reads the soul's inspection and keeps the schedule only when the kernel
   * lists that backend for the soul (loadBackends). No press reaches the list while that read runs (the form is
   * modal), and whatever else moves on drops it (dropPendingEdit, the form's ticket). No Edit, of any schedule,
   * opens while the list is being read (`reading`). */
  function editRow(row) {
    if (busy || pageBusy() || reading) return;
    const definition = localScheduleDefinition(row);
    const provider = definition?.kind === "spawn" && sessionProviderName(definition.backend) && listedBackends([definition.backend]).length ? definition.backend : null;
    const draft = scheduleDraft(definition, provider ? { backends: ["tmux", provider] } : undefined);
    if (!draft) { notice(`${row.name} carries settings this editor cannot keep; edit it with the CLI.`); return; }
    void openForm(draft, null, provider ? { definition, name: row.name } : null);
  }
  let automations = null; // the page's POST /api/automations call
  async function mutate(operation, id, spec, send = body => postJson(ctx, `/api/schedules${mutationQuery(operation)}`, body)) {
    if (busy || pageBusy() || !canMutate()) return;
    dropPendingEdit(); // a change from the list, begun under a form still reading
    const op = ++mutationOperation, formToken = formOperation, gen = workspaceGeneration();
    const current = () => alive && op === mutationOperation && gen === workspaceGeneration();
    busy = true; view()?.setBusy(true); notice(""); render();
    try {
      const result = await send({ operation, id, ...(spec ? { spec } : {}) });
      if (!current()) return;
      if ((operation === "add" || operation === "update") && formToken === formOperation) closeForm();
      if (operation === "reconcile") notice([result.reconciled === "unknown" ? "Run state is still unknown." : `Run state: ${result.reconciled || "checked"}.`, result.remedy].filter(Boolean).join(" "));
      busy = false; view()?.setBusy(false);
      await view()?.refresh();
    } catch (e) {
      if (current()) { if (!sheet.hidden && formToken === formOperation) q(".schedule-form-error").textContent = e.message; else notice(e.message); }
    } finally {
      if (current()) { busy = false; view()?.setBusy(false); render(); }
    }
  }
  function render() {
    newButton.disabled = busy || pageBusy() || !canMutate();
    newButton.title = cliHeldBack("POST /api/schedules", cli()) ?? "";
    q(".schedule-save").disabled = busy || pageBusy() || !canMutate() || !formReady || !!pendingEdit;
    // A pending Edit's action, soul, backend and permissions wait for its answer; a locked Permissions stays YOLO.
    for (const control of form.querySelectorAll("input, select, textarea")) control.disabled = busy || (control.name === "id" && !!editing)
      || (!formReady && ["agent", "home", "providerOperation"].includes(control.name))
      || (!!pendingEdit && ["kind", "agent", "backend", "yolo"].includes(control.name)) || (control.name === "yolo" && yoloFree !== null);
  }
  field("kind").addEventListener("change", syncKind);
  field("repeat").addEventListener("change", () => { if (field("repeat").value !== "custom") field("cron").value = field("repeat").value; });
  field("cron").addEventListener("input", () => { field("repeat").value = "custom"; });
  form.addEventListener("submit", event => {
    event.preventDefault(); if (busy || pageBusy() || !formReady || pendingEdit || !canMutate() || sheet.hidden) return;
    const kind = field("kind").value;
    const spec = { kind, cron: preserve("cron"), tz: preserve("tz"), enabled: field("enabled").checked };
    if (summaries()) {
      // The Summary field, sent as typed: empty leaves the replacement without one (which removes it).
      // Its length is the rule's (code points), checked here: the input has no UTF-16 maxlength.
      const description = field("description").value;
      if (description && !descriptionValid(description)) { q(".schedule-form-error").textContent = `Summary: one line of up to ${DESCRIPTION_MAX} characters, without control characters`; field("description").focus(); return; }
      if (description) spec.description = description;
    // An OATS without summaries: the form does not edit this label, but a replacement definition must retain it.
    } else if (original && Object.hasOwn(original, "description")) spec.description = original.description;
    if (kind === "spawn") {
      const [agent, repo, agentsRoot] = JSON.parse(field("agent").value || "[]"); Object.assign(spec, { agent, repo, agentsRoot, task: preserve("task", "task") });
      if (field("purpose").value) spec.purpose = preserve("purpose");
      try {
        const wake = nestedWake.read();
        if (wake) spec.wake = Object.fromEntries(["cron", "tz", "message"].map(key => [key,
          original?.wake && original.kind === kind && wake[key] === originalWake?.[key] ? original.wake[key] : wake[key]]));
      } catch (e) { q(".schedule-form-error").textContent = e.message; return; }
      for (const name of ["harness", "model", "backend"]) if (field(name).value || original && Object.hasOwn(original, name)) spec[name] = preserve(name);
      if (field("yolo").value) spec.yolo = field("yolo").value === "true";
    } else {
      spec.home = field("home").value;
      if (kind === "wake") spec.message = preserve("task", "message");
      if (kind === "operation") {
        if (!field("providerOperation").value) { q(".schedule-form-error").textContent = "Select an available provider operation"; return; }
        spec.operation = field("providerOperation").value;
      }
    }
    void mutate(editing ? "update" : "add", field("id").value.trim(), spec);
  });
  q(".schedule-cancel").addEventListener("click", closeForm);
  sheet.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeForm(); return; }
    // A modal sheet: Tab and Shift+Tab stay inside it (spec F audit).
    if (e.key !== "Tab") return;
    const stops = [...form.querySelectorAll("button, input, select, textarea, summary, [tabindex]")]
      .filter(f => !f.disabled && f.tabIndex >= 0 && isShown(f));
    if (!stops.length) return;
    const first = stops[0], last = stops.at(-1);
    if (e.shiftKey ? doc.activeElement === first : doc.activeElement === last) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  });
  sheet.addEventListener("mousedown", e => { if (e.target === sheet && !busy) closeForm(); });

  // Delete asks first, in the app (a native confirm would block the renderer).
  let deleting = null, deleteOpener = null;
  function askDelete(row) {
    if (busy || pageBusy() || !canMutate()) return;
    dropPendingEdit(); // an Edit still reading opens nothing over this, or after it
    deleting = row.name; deleteOpener = doc.activeElement;
    q("#schedule-delete-text").textContent = `${row.name} is removed from this computer and stops running here.`;
    deleteSheet.hidden = false; q(".schedule-delete-cancel").focus();
  }
  function closeDelete() {
    deleting = null; deleteSheet.hidden = true;
    const back = deleteOpener; deleteOpener = null; if (back?.isConnected) back.focus();
  }
  q(".schedule-delete-cancel").addEventListener("click", closeDelete);
  q(".schedule-delete-confirm").addEventListener("click", () => { const id = deleting; closeDelete(); if (id) void mutate("remove", id); });
  deleteSheet.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDelete(); }
    if (e.key === "Tab") { // two buttons: keep focus inside the dialog
      const [first, last] = [q(".schedule-delete-confirm"), q(".schedule-delete-cancel")];
      if (e.shiftKey ? doc.activeElement === first : doc.activeElement === last) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    }
  });
  deleteSheet.addEventListener("mousedown", e => { if (e.target === deleteSheet) closeDelete(); });

  const newButton = doc.createElement("button"); newButton.type = "button"; newButton.className = "act primary schedule-new"; newButton.textContent = "New schedule";
  newButton.addEventListener("click", () => openForm());
  // Edit and Delete are for local rows only: a workspace schedule is edited in its repository.
  // An unknown last run is checked through the kernel's reconcile, wherever the schedule comes from.
  const rowActions = row => {
    if (!canMutate()) return [];
    const actions = row.origin.kind === "local" ? [{ label: "Edit", verb: "edit", enabled: !reading, run: () => editRow(row) }] : [];
    if (row.runsHere && runState(row)?.unknown) actions.push({ label: "Check run state", verb: "reconcile",
      run: () => mutate("reconcile", row.key, null, () => automations({ kind: "schedule", action: "reconcile", key: row.key })) });
    if (row.origin.kind === "local") actions.push({ label: "Delete…", verb: "remove", run: () => askDelete(row) });
    return actions;
  };
  const page = mountAutomationsPage(q(".schedule-stage"), ctx, "schedule", call => { automations = call; const built = build = {}, workspace = currentWorkspace(); return {
    read: async () => {
      // A read of the list that begins: a pending Edit holds a definition from before it, and until the read
      // ends no Edit opens (`reading`: a mutation's and a summary's re-read begin here too, before they yield).
      dropPendingEdit(); reading++;
      // The page painted its rows before it asked for this read: paint them once more, so Edit shows that it waits.
      queueMicrotask(() => { if (alive && reading) view()?.repaint(); });
      try { const list = await call({ kind: "schedule", action: "list" }); readOk = true; return list; }
      catch (error) { readOk = false; throw error; }
      // The last read to end may not be the one the page paints for (it paints for the latest asked): paint once
      // more when none is left, so no Edit is left showing that it waits.
      finally { reading--; render(); if (!reading) queueMicrotask(() => { if (alive && !reading) view()?.repaint(); }); }
    },
    // The page's own acts (Turn off here, Turn on here, Run now, Test, a summary's save), told for the page view
    // and the workspace they began in, whatever becomes of this view meanwhile (watchActs, below, is what acts).
    onBusy: acting => noteAct(workspace, built, acting),
    headerActions: () => [newButton], rowActions,
    onEnableScheduler: () => mutate("host-install"),
    onResult: (verb, row, result) => { if (verb === "run" && result?.run) notice(`${row.id}: ${scheduleOutcome(result.run)}`); },
  }; }, { cli, subscribeCli, frame });
  // The page's acts in this workspace, begun under any view. While one runs, no form opens and nothing is sent
  // from here (pageBusy). One that begins under an open Edit closes it: the form holds the definition as it was
  // before the act (its Enabled, for one), and saving it would undo the act. A pending Edit goes without a word;
  // one already in use says why it closed. When the last one ends and any of them began under another page view
  // than the one on screen (the page was rebuilt, or this whole view was made, meanwhile), that view re-read
  // nothing here after its act, and the list on screen may be from before the act landed, whatever was read for an
  // act of this view's own: read it again, which holds Edit until it answers.
  const watchActs = (workspace, began, builds) => {
    if (!alive || workspace !== currentWorkspace()) return;
    if (began && editing && !sheet.hidden) { const id = editing, silent = !!pendingEdit; closeForm(); if (!silent) notice(`${id} changed while it was being edited. Open Edit again.`); }
    if (builds && [...builds].some(other => other !== build)) void view()?.refresh();
    render();
  };
  actWatchers.add(watchActs);
  // A workspace switch closes the form: its targets belong to the old workspace.
  const offWorkspace = onWorkspaceChange(() => { ++mutationOperation; busy = false; readOk = false; closeForm(); if (!deleteSheet.hidden) closeDelete(); render(); });
  const offCli = subscribeCli(() => render());
  render();
  if (preselection) {
    const selected = preselection; preselection = null;
    if (selected.generation === workspaceGeneration()) void openForm(null, selected.soul);
  }
  return {
    refresh: () => page.refresh(),
    dispose() { alive = false; ++formOperation; ++operationRequest; ++backendRequest; ++mutationOperation; pendingEdit = null; actWatchers.delete(watchActs); offWorkspace(); offCli?.(); page.dispose(); el.replaceChildren(); },
  };
}
