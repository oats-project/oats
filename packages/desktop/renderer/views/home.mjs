/* oats desktop — Home (the Desktop UI rework, slice 2): the operator's first two questions on one page, what needs
   me and what do I have. A stage view on the shell's mount(el, ctx) contract, so a later slice can put it in a tab.

   - The board: Needs you (each claim's message) and Running, each shown only when it has a row, from the roster
     the sidebar shows (ctx.homeRoster, its paints through ctx.subscribeHomeRoster), grouped by the shared
     packages/client/home-board.mjs. Idle and stopped agents aren't listed (D11). There is no working/idle fact
     (the activity contract isn't built) and none is inferred: a live row is "running". The "New" group (stopped or
     finished since you last looked) has no fact to read, so it isn't drawn. The board never reorders the roster.
   - The overview: Agents, Souls, Capabilities, Teams, Machines and Graph, each "You have N …" from reads the app
     makes already. Agents opens Home › Agents here; the others open the Workspace page on their tab
     (ctx.openWorkspaceTab), whose Esc comes back to Home (shell.mjs). The Machines canvas stands in for the Graph.
   - Home › Agents: every agent, running or stopped, flat: name, soul · machine, state, who started it. Esc or Back
     returns to the board.
   - First run (no agents): OATS in two lines, three keys, then the overview.
   Every row is a button: Enter (or a click) opens it as Enter does in the roster (ctx.openAgent). Each read carries
   a latest-intent token, checked on its answer and on its failure. Copy reads its nouns from DESKTOP_NOUNS. */
import { apiJson, postJson, wsQuery, workspaceGeneration } from "./common.mjs";
import { cliStatus } from "./cli-status.mjs";
import { DESKTOP_NOUNS, DESKTOP_TERMS } from "../desktop-terms.mjs";
import { homeBoard, homeAgents, startedBy } from "../../../client/home-board.mjs";
import { rosterRowFacts } from "../../../client/roster-row-facts.mjs";
import { waitingDetail, waitingLabel } from "../../../client/waiting-on-you.mjs";
import { runtimeState } from "../../../client/instance-presentation.mjs";
import { teamModelOf } from "../../../client/team-rows.mjs";
import { displayLine } from "../../../client/display-text.mjs";
import { teamsAnswer } from "../computer-teams.mjs";
import { iconElement } from "../shell-icons.mjs";

/** The overview's sections, in order: what each opens (`agents`: Home › Agents here; else a Workspace tab id, with
 * the Machines tab's view where it has one: its List for Machines, its Map, today's canvas, for the Graph until
 * slice 6; slice 3b's `preselectWorkspaceTab(tab, { machinesView })`, which an older page ignores). */
export const OVERVIEW = Object.freeze([
  { key: "agents", label: "Agents", opens: "agents" },
  { key: "souls", label: "Souls", opens: "souls" },
  { key: "capabilities", label: "Capabilities", opens: "capabilities" },
  { key: "teams", label: "Teams", opens: "teams" },
  { key: "machines", label: "Machines", opens: "machines", options: { machinesView: "list" } },
  { key: "graph", label: "Graph", opens: "machines", options: { machinesView: "map" } },
]);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** "You have N …" for a section, from its count (null: not known, "" for no line). */
export function overviewLine(key, counts, nouns = DESKTOP_NOUNS) {
  const n = counts[key];
  if (key === "graph") {
    const agents = counts.agents, machines = counts.machines;
    return Number.isInteger(agents) && Number.isInteger(machines) ? `${plural(agents, nouns.instance, nouns.instances)} on ${plural(machines, "machine", "machines")}` : "";
  }
  if (n === "loading") return "Counting…";
  if (n === "failed") return "Couldn't count them";
  if (!Number.isInteger(n)) return "";
  const words = { agents: [nouns.instance, nouns.instances], souls: ["soul", "souls"], capabilities: ["capability", "capabilities"],
    teams: ["team", "teams"], machines: ["machine", "machines"] }[key];
  return `You have ${plural(n, ...words)}`;
}

/** The first run's two lines and three keys. `chord(id)`: the bound key's text, or "". */
export function firstRunCopy(chord, nouns = DESKTOP_NOUNS) {
  const key = (id, fallback) => chord(id) || fallback;
  return {
    lines: [`OATS runs your ${nouns.instances}: each one is a soul at work on a machine of yours.`,
      `Start one, and Home shows what needs you and what you have.`],
    keys: [
      { label: `New ${nouns.instance}`, key: key("app.quickOpenSouls", "the sidebar's New " + nouns.instance) },
      { label: "Command palette", key: key("app.palette", "") },
      { label: "Home", key: key("stage.home", "View: Home in the palette") },
    ],
  };
}

const machineCount = (deployments) => new Set((Array.isArray(deployments) ? deployments : []).map((d) => d?.machine ?? d?.id).filter(Boolean)).size;

export const homeCSS = `
.home { box-sizing:border-box; height:100%; overflow:auto; padding:28px 32px 40px; color:var(--fg); font-family:var(--ui-font, system-ui); }
.home-inner { max-width:760px; }
.home h1 { margin:0 0 var(--section-gap); font-size:24px; font-weight:700; line-height:1.25; }
.home h2 { margin:0 0 var(--title-gap); font-size:15px; font-weight:650; line-height:1.3; }
.home h3 { margin:0 0 6px; font-size:12px; font-weight:600; color:var(--muted); line-height:1.3; }
.home-section { margin:0 0 var(--section-gap); }
.home-group { margin:0 0 14px; }
.home-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px; }
.home-row { display:flex; align-items:center; gap:10px; width:100%; min-height:44px; padding:6px 10px; border:0; border-radius:6px;
  background:transparent; color:var(--fg); font:inherit; font-size:13px; text-align:left; cursor:pointer; }
.home-row:hover { background:var(--surface-2); }
.home-row:focus-visible { background:var(--sel); }
.home-row:disabled { cursor:default; }
.home-row-copy { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
.home-row-name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.home-row-meta { font-size:12px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.home-row-side { flex:none; font-size:12px; color:var(--muted); }
.home-dot { flex:none; width:8px; height:8px; border-radius:50%; background:var(--faint); }
.home-dot.on { background:var(--live); }
.home-mark { width:10px; height:10px; margin:0 -1px; }
.home-quiet, .home-status { margin:0; font-size:13px; color:var(--muted); }
.home-failed { display:flex; align-items:center; gap:12px; margin:0; font-size:13px; color:var(--fg); }
.home-first p { margin:0 0 4px; font-size:14px; }
.home-keys { list-style:none; margin:12px 0 0; padding:0; display:flex; flex-direction:column; gap:4px; font-size:13px; }
.home-keys kbd { font-family:var(--mono); font-size:12px; color:var(--fg); }
.home-back { margin:0 0 12px; }
`;

let returnTo = null; // the overview key Home last opened, focused again when Home mounts (per workspace generation)

export function createHome(el, ctx, { doc = el.ownerDocument, now = () => Date.now() } = {}) {
  const nouns = DESKTOP_NOUNS;
  const style = doc.createElement("style"); style.dataset.home = ""; style.textContent = homeCSS;
  const root = doc.createElement("div"); root.className = "home";
  const inner = doc.createElement("div"); inner.className = "home-inner";
  root.append(style, inner);
  el.replaceChildren(root);
  let view = "board", alive = true, serial = 0;
  const counts = { souls: "loading", capabilities: "loading", teams: null };
  const gen = workspaceGeneration();
  const chord = (id) => (typeof ctx.chordText === "function" ? ctx.chordText(id) : "") || "";

  const roster = () => (typeof ctx.homeRoster === "function" ? ctx.homeRoster() : { rows: [], deployments: [], phase: "loading", stale: () => false, here: null });

  function node(tag, className, text) {
    const n = doc.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  /** One agent's row: its dot, name, soul · machine, and a side note (the claim, the state, who started it). */
  function agentRow(row, { claim = null, side = null, state = runtimeState(row), deployments, here }) {
    const facts = rosterRowFacts(row, DESKTOP_TERMS, { deployments, here });
    const b = node("button", "home-row"); b.type = "button"; b.dataset.homeAgent = row.instance;
    // The needs-input mark is the roster's (.attn-mark): yellow means needs input only, never a dot's fill.
    const dot = claim ? iconElement(doc, "attention", { size: 10, className: "shell-icon attn-mark home-mark" })
      : node("span", `home-dot ${state === "running" ? "on" : ""}`.trim());
    dot.setAttribute("aria-hidden", "true");
    const copy = node("span", "home-row-copy");
    copy.append(node("span", "home-row-name", facts.name), node("span", "home-row-meta", facts.detail));
    if (claim) copy.append(node("span", "home-row-meta", displayLine(waitingDetail(claim) ?? waitingLabel(claim)) || waitingLabel(claim)));
    b.append(dot, copy);
    if (side) b.append(node("span", "home-row-side", side));
    b.addEventListener("click", () => { ctx.openAgent?.(row); });
    return b;
  }

  function group(title, items) {
    const g = node("section", "home-group");
    const h = node("h3", null, title); h.id = `home-group-${title.toLowerCase().replace(/\W+/g, "-")}`;
    const ul = node("ul", "home-list"); ul.setAttribute("aria-labelledby", h.id);
    for (const item of items) { const li = node("li"); li.append(item); ul.append(li); }
    g.append(h, ul);
    return g;
  }

  function overviewSection(data) {
    const s = node("section", "home-section"); s.dataset.homeSection = "overview";
    const h = node("h2", null, "Workspace overview"); h.id = "home-overview-title";
    const ul = node("ul", "home-list"); ul.setAttribute("aria-labelledby", h.id);
    const all = { ...counts, agents: data.phase === "ready" ? data.rows.length : data.phase === "failed" ? "failed" : "loading", machines: machineCount(data.deployments) || (data.phase === "ready" ? 1 : data.phase === "failed" ? "failed" : "loading") };
    // A workspace served with no deployment list is this machine's alone: one machine.
    for (const entry of OVERVIEW) {
      const b = node("button", "home-row"); b.type = "button"; b.dataset.homeOpen = entry.key;
      const copy = node("span", "home-row-copy");
      copy.append(node("span", "home-row-name", entry.key === "agents" ? cap(nouns.instances) : entry.label));
      const line = overviewLine(entry.key, all, nouns);
      if (line) copy.append(node("span", "home-row-meta", line));
      b.append(copy);
      b.addEventListener("click", () => openSection(entry));
      const li = node("li"); li.append(b); ul.append(li);
    }
    s.append(h, ul);
    return s;
  }

  function openSection(entry) {
    returnTo = { key: entry.key, gen };
    if (entry.opens === "agents") { view = "agents"; paint({ focus: "first" }); return; }
    void ctx.openWorkspaceTab?.(entry.opens, entry.options);
  }

  function boardSection(data) {
    const s = node("section", "home-section"); s.dataset.homeSection = "board";
    const h = node("h2", null, cap(nouns.instances)); s.append(h);
    if (data.phase === "loading") { s.append(statusLine(`Reading your ${nouns.instances}…`)); return s; }
    if (data.phase === "failed") {
      const p = node("p", "home-failed", `Couldn't read your ${nouns.instances}.`);
      const retry = node("button", null, "Retry"); retry.type = "button"; retry.addEventListener("click", () => data.retry?.());
      p.append(retry); s.append(p); return s;
    }
    const { needsYou, running } = homeBoard(data.rows, { stale: data.stale });
    const opts = { deployments: data.deployments, here: data.here };
    if (needsYou.length) s.append(group("Needs you", needsYou.map(({ row, claim }) => agentRow(row, { claim, ...opts }))));
    if (running.length) s.append(group("Running", running.map((row) => agentRow(row, { ...opts, side: "running" }))));
    if (!needsYou.length && !running.length) s.append(node("p", "home-quiet", `Nothing needs you, and no ${nouns.instance} is running.`));
    return s;
  }

  function statusLine(text) { const p = node("p", "home-status", text); p.setAttribute("role", "status"); return p; }

  function firstRun() {
    const s = node("section", "home-section home-first"); s.dataset.homeSection = "first-run";
    const copy = firstRunCopy(chord, nouns);
    for (const line of copy.lines) s.append(node("p", null, line));
    const keys = node("ul", "home-keys");
    for (const k of copy.keys) {
      const li = node("li"); li.append(`${k.label}: `);
      if (k.key) li.append(node("kbd", null, k.key));
      keys.append(li);
    }
    s.append(keys);
    return s;
  }

  function agentsView(data) {
    const s = node("section", "home-section"); s.dataset.homeSection = "agents";
    const back = node("button", "home-back", "Back to Home"); back.type = "button";
    back.addEventListener("click", () => backToBoard());
    s.append(back);
    if (data.phase === "loading") { s.append(statusLine(`Reading your ${nouns.instances}…`)); return s; }
    if (data.phase === "failed") { s.append(node("p", "home-failed", `Couldn't read your ${nouns.instances}.`)); return s; }
    const rows = homeAgents(data.rows);
    if (!rows.length) { s.append(node("p", "home-quiet", `No ${nouns.instances} yet.`)); return s; }
    const opts = { deployments: data.deployments, here: data.here };
    const ul = node("ul", "home-list"); ul.setAttribute("aria-label", `Every ${nouns.instance}`);
    for (const row of rows) {
      const state = runtimeState(row);
      const by = startedBy(row);
      const side = [state === "running" ? "running" : state === "stopped" ? "stopped" : "status unknown", by ? `started by ${by}` : null].filter(Boolean).join(" · ");
      const li = node("li"); li.append(agentRow(row, { ...opts, state, side })); ul.append(li);
    }
    s.append(ul);
    return s;
  }

  /** The button whose data key (homeOpen, homeAgent) holds that value: no selector built from a name. */
  function find(key, value) { return [...inner.querySelectorAll("button")].find((b) => b.dataset[key] === value) ?? null; }

  function backToBoard() { view = "board"; paint({ focus: "agents" }); }

  function paint({ focus = null } = {}) {
    if (!alive) return;
    const had = root.contains(doc.activeElement) ? doc.activeElement : null;
    const hadKey = had?.dataset?.homeOpen ? ["open", had.dataset.homeOpen] : had?.dataset?.homeAgent ? ["agent", had.dataset.homeAgent] : null;
    const data = roster();
    const title = node("h1", null, view === "agents" ? `Home › ${cap(nouns.instances)}` : "Home");
    const parts = [title];
    if (view === "agents") parts.push(agentsView(data));
    else {
      if (data.phase === "ready" && !data.rows.length) parts.push(firstRun());
      else parts.push(boardSection(data));
      parts.push(overviewSection(data));
    }
    inner.replaceChildren(...parts);
    const target = focus === "first" ? inner.querySelector(".home-back")
      : focus === "agents" ? inner.querySelector('[data-home-open="agents"]')
      : hadKey ? find(hadKey[0] === "open" ? "homeOpen" : "homeAgent", hadKey[1])
      : null;
    if (target) target.focus();
    else if (had && !root.contains(doc.activeElement)) inner.querySelector("button")?.focus();
  }

  async function readCounts() {
    const mine = ++serial;
    const owns = () => alive && mine === serial && workspaceGeneration() === gen;
    const soulsRead = apiJson(ctx, `/api/agents${wsQuery()}`).then((d) => (Array.isArray(d?.agents) ? d.agents.length : "failed"), () => "failed");
    const capsRead = postJson(ctx, `/api/workspace-sync${wsQuery()}`, { action: "read" })
      .then((r) => (r?.status === "ok" && Array.isArray(r.capabilities?.capabilities) ? r.capabilities.capabilities.length : "failed"), () => "failed");
    const teamsOn = !!teamModelOf(cliStatus()?.features);
    if (teamsOn) counts.teams = "loading";
    const teamsRead = teamsOn ? postJson(ctx, `/api/workspace-teams${wsQuery()}`, { action: "list" })
      .then((a) => { const doc = teamsAnswer(a, "teams", ""); return Array.isArray(doc.teams) ? doc.teams.length : "failed"; }, () => "failed") : Promise.resolve(null);
    if (owns()) paint();
    const [souls, capabilities, teams] = await Promise.all([soulsRead, capsRead, teamsRead]);
    if (!owns()) return;
    Object.assign(counts, { souls, capabilities, teams });
    paint();
  }

  const unsubscribe = typeof ctx.subscribeHomeRoster === "function" ? ctx.subscribeHomeRoster(() => paint()) : () => {};
  const onKey = (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || view !== "agents") return;
    e.preventDefault(); backToBoard();
  };
  root.addEventListener("keydown", onKey);
  paint();
  if (returnTo && returnTo.gen === gen) find("homeOpen", returnTo.key)?.focus();
  returnTo = null;
  void readCounts();

  return {
    get view() { return view; },
    refresh: () => paint(),
    dispose() { alive = false; serial++; unsubscribe(); root.removeEventListener("keydown", onKey); },
  };
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/** The stage contract: mount returns its disposer, so each mount cleans up only itself (view-lifecycle.mjs); the
 * module-wide unmount, a legacy host's fallback, disposes every Home still mounted. */
const mounted = new Set();
export function mount(el, ctx) {
  const home = createHome(el, ctx); mounted.add(home);
  return () => { mounted.delete(home); home.dispose(); };
}
export function unmount() { for (const home of mounted) home.dispose(); mounted.clear(); }
