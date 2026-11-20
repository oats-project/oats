/* oats desktop — Details, an agent's static facts as a tab (the Desktop UI rework, slice 6a, tour step 18). For any
   agent, running or not, held included: what the roster knows about it, read from the roster model's current row
   for it (ctx.detailsRow, its changes through ctx.subscribeDetails), never a terminal.

   - The header: its name, its state in words, its soul.
   - Needs input, while a claim is live (the sidebar's one gate, waiting-on-you.mjs waitingClaim, with the roster's
     stale rule): its words, how long, and its message.
   - The facts: soul; harness · model; where it runs (machine, repository, branch; the pull request is on the
     Git section's card); started by (the attributed human, else the parent), created, started; same work as its
     parent (the sameWork flag, where the host reports it); its messaging address.
   - One row of buttons: Open terminal (a running agent), Start / Restart / Stop / Retire (today's dialogs, as
     desktop-acts.mjs offers them), Open pull request, Files (the soul's brain).
   - Folded: Git (the instance-git panel: changes, the worktree, the pull request), and Recent events (the
     instance-events view the Machines canvas's popup had).
   - One dim technical line: the kernel's instance name, its home, its address.
   The task is left out: the kernel reports none (no TASK.md is parsed). Every text goes in as textContent. */
import { DESKTOP_TERMS } from "../desktop-terms.mjs";
import { rowMachine } from "../../../client/roster-row-facts.mjs";
import { startedBy } from "../../../client/home-board.mjs";
import { instanceDisplayName } from "../../../client/instance-display-name.mjs";
import { runtimeState } from "../../../client/instance-presentation.mjs";
import { waitingClaim, waitingLabel, waitingDetail, waitedText } from "../../../client/waiting-on-you.mjs";
import { displayLine } from "../../../client/display-text.mjs";
import { harnessName } from "../identity-marks.mjs";
import { runtimeErrorLine } from "../speaker-line.mjs";
import { desktopActs } from "../desktop-acts.mjs";
import { iconElement } from "../shell-icons.mjs";
import { driftText, workRepo, workFolder, LINKED, remoteWorkNote } from "../context-panel.mjs";
import { needsInputReportingGap } from "../../../client/needs-input-reporting-gap.mjs";
import { servedIdentityText } from "../../../client/deployment-facts.mjs";

export const detailsCSS = `
.details { box-sizing:border-box; height:100%; overflow:auto; padding:24px 28px 32px; color:var(--fg); font-family:var(--ui-font, system-ui); }
.details-inner { max-width:760px; display:flex; flex-direction:column; gap:18px; }
.details-head { display:flex; flex-direction:column; gap:4px; }
.details-head h1 { margin:0; font-size:20px; font-weight:700; line-height:1.3; }
.details-sub { margin:0; font-size:12.5px; color:var(--muted); }
.details-waiting { display:flex; flex-direction:column; gap:4px; padding:10px 12px; border:1px solid var(--attn-border); border-radius:8px; background:var(--attn-bg); }
.details-waiting-head { display:flex; align-items:center; gap:6px; margin:0; font-size:12.5px; font-weight:650; color:var(--fg); }
.details-waiting-message { margin:0; font-size:13px; color:var(--fg); }
.details-facts { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:6px 16px; margin:0; font-size:13px; }
.details-facts dt { color:var(--muted); }
.details-facts dd { margin:0; min-width:0; overflow-wrap:anywhere; }
.details-note { margin:0; font-size:12.5px; color:var(--muted); }
.details-actions { display:flex; flex-wrap:wrap; gap:8px; }
.details-actions button { display:inline-flex; align-items:center; gap:6px; min-height:30px; padding:0 12px; border:1px solid var(--border);
  border-radius:7px; background:var(--surface); color:var(--fg); font:inherit; font-size:12.5px; font-weight:600; cursor:pointer; }
.details-actions button:hover:not(:disabled) { background:var(--surface-2); }
.details-actions button:disabled { color:var(--muted); cursor:default; }
.details-fold { border-top:1px solid var(--border); padding-top:8px; }
.details-fold > summary { cursor:pointer; font-size:12.5px; font-weight:650; color:var(--fg); padding:4px 0; }
.details-top { display:flex; flex-direction:column; gap:18px; }
/* D2: the chrome is sans; monospace is the terminal's. */
.details-tech { margin:0; font-size:11.5px; color:var(--muted); overflow-wrap:anywhere; }
`;

const STATE_WORDS = { running: "running", stopped: "stopped", unknown: "status unknown" };
// The work mode and where the model came from, in the instance panel's words (context-panel.mjs WORK_MODES and
// MODEL_FROM, which said the mode as a sentence).
const WORK_WORDS = { worktree: "its own worktree", checkout: "the shared checkout", attached: "its parent's tree", directory: "its own folder",
  workspace: "the whole workspace" };
const MODEL_FROM = { soul: "the soul's choice", spawn: "chosen at spawn", start: "chosen at start", "launch-config": "from the launch configuration",
  "harness-default": "the harness's default", local: "set for this soul on this computer", "local-default": "this computer's default for every soul" };
const ACT_LABELS = { start: "Start…", restart: "Restart with…", stop: "Stop…", retire: "Retire…" };

/** The facts Details shows for a row, in order: [id, label, value]; a fact the row doesn't report is absent. */
export function detailsFacts(row, { deployments = [], here = null } = {}) {
  const text = (v) => (typeof v === "string" && v.trim() ? displayLine(v) || v : null);
  const harness = text(row?.harness) ? harnessName(row.harness) : null;
  const model = text(row?.model);
  const parent = text(row?.parentInstance);
  const sameWork = row?.sameWorkKnown === true && row?.sameWork === true && parent ? `same work as ${instanceDisplayName(parent) || parent}` : null;
  const facts = [
    ["soul", "Soul", text(row?.agent)],
    ["harness", "Harness · model", harness ? [harness, model].filter(Boolean).join(" · ") : model],
    ["modelFrom", "Model from", model && MODEL_FROM[row?.modelFrom] ? MODEL_FROM[row.modelFrom] : null],
    ["work", "Work", WORK_WORDS[row?.work] ?? null],
    ["machine", "Machine", rowMachine(row, DESKTOP_TERMS, { deployments, here })],
    // A remote row's repoName is its server's label: its repository is its own repo path's tail (workRepo).
    ["repository", "Repository", text(workRepo(row))],
    ["branch", "Branch", text(row?.branch)],
    ["startedBy", "Started by", startedBy(row)],
    ["parent", "Parent", parent ? instanceDisplayName(parent) || parent : null],
    ["sameWork", "Same work", sameWork],
    ["sibling", "Sibling", text(row?.siblingInstance) ? instanceDisplayName(row.siblingInstance) || row.siblingInstance : null],
    ["session", "Session", text(row?.tmux?.session) ? `tmux · ${row.tmux.session}` : null],
    ["createdAt", "Created", text(row?.createdAt) ? new Date(row.createdAt).toLocaleString() : null],
    ["startedAt", row?.running === true ? "Started" : "Last started", text(row?.startedAt) ? new Date(row.startedAt).toLocaleString() : null],
    ["identity", "Messaging", text(row?.identityAddress) ?? text(servedIdentityText(row?.identity))],
    ["agentsRoot", "Agents root", text(row?.agentsRoot)],
    ["workFolder", "Folder", workFolder(row?.home) ? `${workFolder(row.home)}${LINKED.has(row?.work) ? " (shared: a link to a tree others share)" : ""}` : null],
  ];
  return facts.filter(([, , value]) => typeof value === "string" && value);
}

export function createDetails(el, ctx, { doc = el.ownerDocument, now = () => Date.now() } = {}) {
  const style = doc.createElement("style"); style.dataset.details = ""; style.textContent = detailsCSS;
  const root = doc.createElement("div"); root.className = "details";
  const inner = doc.createElement("div"); inner.className = "details-inner";
  root.append(style, inner);
  el.replaceChildren(root);
  const node = (tag, className, textValue) => {
    const n = doc.createElement(tag);
    if (className) n.className = className;
    if (textValue != null) n.textContent = textValue;
    return n;
  };
  // The folds are built once and kept across repaints: the person's open state, and the Git panel's and the
  // events view's own reads, live in them.
  const git = node("details", "details-fold"); git.dataset.detailsSection = "git";
  git.append(node("summary", null, "Git"));
  const gitHost = node("div"); git.append(gitHost);
  const gitPanel = typeof ctx.createGitPanel === "function" ? ctx.createGitPanel(gitHost) : null;
  const teams = node("details", "details-fold"); teams.dataset.detailsSection = "teams";
  teams.append(node("summary", null, "Messaging & teams"));
  const teamsHost = node("div"); teams.append(teamsHost);
  const teamsSection = typeof ctx.createTeamsSection === "function" ? ctx.createTeamsSection(teamsHost) : null;
  const soul = node("details", "details-fold"); soul.dataset.detailsSection = "soul";
  soul.append(node("summary", null, "Soul as spawned"));
  const soulHost = node("div"); soul.append(soulHost);
  const soulSection = typeof ctx.createSoulSection === "function" ? ctx.createSoulSection(soulHost) : null;
  const events = node("details", "details-fold"); events.dataset.detailsSection = "events";
  events.append(node("summary", null, "Recent events"));
  const eventsHost = node("div"); events.append(eventsHost);
  // The page: a part repainted with each roster change (its header, Needs input, facts, notes, actions), then the
  // folds and the technical line, which stay in place: focus inside them, and their own reads, survive a repaint.
  const top = node("div", "details-top"), tech = node("p", "details-tech");
  inner.replaceChildren(top, soul, teams, git, events, tech);
  // Built once its host is in the document (the view is mounted connected): the events view watches its own
  // ancestors' visibility from there, and syncs on each paint and on its fold's toggle.
  const eventsView = typeof ctx.createEventsView === "function" ? ctx.createEventsView(eventsHost, () => ctx.detailsRow?.()) : null;
  let alive = true;

  function button(label, onClick, { disabled = false, title = "" } = {}) {
    const b = node("button", null, label); b.type = "button"; b.disabled = disabled;
    if (title) b.title = title;
    b.addEventListener("click", () => { if (!b.disabled) onClick(); });
    return b;
  }

  function paint() {
    if (!alive) return;
    const row = ctx.detailsRow?.() ?? null;
    const focusedKey = top.contains(doc.activeElement) ? doc.activeElement.dataset.detailsKey ?? null : null;
    if (!row) { top.replaceChildren(node("p", "details-note", "This agent is no longer in the roster.")); return; }
    const state = runtimeState(row);
    const parts = [];
    const head = node("div", "details-head");
    head.append(node("h1", null, instanceDisplayName(row.instance) || row.instance),
      node("p", "details-sub", [STATE_WORDS[state], typeof row.agent === "string" && row.agent ? `instance of ${row.agent}` : null].filter(Boolean).join(" · ")));
    parts.push(head);
    const claim = waitingClaim(row, { stale: ctx.detailsStale?.(row) === true });
    if (claim) {
      const box = node("section", "details-waiting"); box.dataset.detailsSection = "waiting";
      const line = node("p", "details-waiting-head");
      line.append(iconElement(doc, "attention", { size: 12, className: "shell-icon attn-mark" }),
        node("span", null, `Needs input · ${waitingLabel(claim)} · ${waitedText(claim.since, now())}`));
      box.append(line);
      const message = waitingDetail(claim);
      if (message) box.append(node("p", "details-waiting-message", message));
      parts.push(box);
    }
    const dl = node("dl", "details-facts");
    for (const [id, label, value] of detailsFacts(row, ctx.detailsScope?.() ?? {})) {
      const dt = node("dt", null, label), dd = node("dd", null, value); dd.dataset.detailsFact = id;
      dl.append(dt, dd);
    }
    parts.push(dl);
    const error = typeof row.runtimeError === "string" && row.runtimeError ? runtimeErrorLine(row) : null;
    if (error) parts.push(node("p", "details-note", error));
    // A remote row that doesn't report its work and build says why, and which computer to update (context-panel).
    const remote = remoteWorkNote(row);
    if (remote) parts.push(node("p", "details-note", remote));
    const drift = driftText(row);
    if (drift) parts.push(node("p", "details-note", drift));
    const gap = needsInputReportingGap(row);
    if (gap) parts.push(node("p", "details-note", `This agent's Claude questions and permission requests don't show as needs input: its oats.core (oats.framework ${gap}) is older than 2.4.0. Upgrade or respawn it to report them.`));
    // The row of buttons: what the agent can do, as the row's own menu offers it (desktop-acts.mjs).
    const acts = ctx.detailsActs ?? {};
    const actions = node("div", "details-actions"); actions.setAttribute("role", "group"); actions.setAttribute("aria-label", "Actions");
    const add = (key, b) => { b.dataset.detailsKey = key; actions.append(b); };
    if (row.running === true) add("terminal", button("Open terminal", () => acts.openTerminal?.(row)));
    const offer = desktopActs(row);
    for (const { verb, reason } of offer.blocked ? [] : offer.acts) {
      if (!ACT_LABELS[verb]) continue;
      add(verb, button(ACT_LABELS[verb], () => acts.lifecycle?.(verb, row), { disabled: !!reason, title: typeof reason?.sentence === "string" ? reason.sentence : "" }));
    }
    add("pr", button("Open pull request…", () => acts.openPullRequest?.(row), { disabled: !!(row.server || row.remote), title: row.server || row.remote ? "Remote PR inspection is unavailable here." : "" }));
    if (typeof row.agent === "string" && row.agent) add("files", button("Files", () => acts.openFiles?.(row)));
    parts.push(actions);
    top.replaceChildren(...parts);
    tech.textContent = [row.instance, typeof row.home === "string" ? row.home : null, typeof row.identityAddress === "string" ? row.identityAddress : null].filter(Boolean).join(" · ");
    gitPanel?.update?.({ active: git.open, workspace: ctx.detailsWorkspace?.(row) ?? null, instance: row, key: null });
    teamsSection?.update?.({ active: teams.open, workspace: ctx.detailsWorkspace?.(row) ?? null, instance: row });
    soulSection?.update?.({ active: soul.open, workspace: ctx.detailsWorkspace?.(row) ?? null, instance: row });
    eventsView?.sync?.(); // connected now, and its row may have changed: Load activity follows (instance-events-view.mjs)
    if (focusedKey) [...actions.querySelectorAll("button")].find((b) => b.dataset.detailsKey === focusedKey)?.focus();
  }
  git.addEventListener("toggle", () => paint());
  teams.addEventListener("toggle", () => paint());
  soul.addEventListener("toggle", () => paint());
  events.addEventListener("toggle", () => eventsView?.sync?.());
  const unsubscribe = typeof ctx.subscribeDetails === "function" ? ctx.subscribeDetails(() => paint()) : () => {};
  paint();
  return {
    refresh: paint,
    dispose() { alive = false; unsubscribe(); gitPanel?.dispose?.(); teamsSection?.dispose?.(); soulSection?.dispose?.(); eventsView?.dispose?.(); },
  };
}

const mounted = new Set();
export function mount(el, ctx) {
  const details = createDetails(el, ctx); mounted.add(details);
  return () => { mounted.delete(details); details.dispose(); };
}
export function unmount() { for (const details of mounted) details.dispose(); mounted.clear(); }
