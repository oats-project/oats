/* oats desktop — Home (the Desktop UI rework, slices 2 and 2b): what needs me, and what do I have, on one screen. A
   stage view on the shell's mount(el, ctx) contract, so a later slice can put it in a tab.

   Top to bottom, in a centred column (slice 2b and its Amendment 1, Pepe, 2026-11-20: slice 2's board repeated the
   sidebar in full, and pushed the workspace off screen):
   - Needs you: each agent with a live claim (the roster's waitingClaim gate), dot, name, soul (· machine for another machine's agent) and its
     message, newest claim first, from the roster the sidebar shows (ctx.homeRoster, its paints through
     ctx.subscribeHomeRoster), grouped by the shared packages/client/home-board.mjs. NEEDS_YOU_SHOWN at most, then
     "Show all N", which expands in place. None: one quiet line.
   - One summary line: "24 agents · 21 running · 3 need you · 0 stopped", text, not a list. There is no working/idle
     fact (the activity contract isn't built) and none is inferred: a live row is "running".
   - The workspace, one row of compact tiles, each a button with its count: Agents (Home › Agents here), Souls,
     Capabilities, Teams, Machines (the Workspace page on its tab, ctx.openWorkspaceTab, whose Esc comes back to Home:
     shell.mjs) and Automations (its page, ctx.openPage), with the sidebar row's red mark while a run failed
     (ctx.automationsFailed, slice 1's reader). The Graph has no tile: it is frozen, and Machines keeps its List | Map.
   - Running, under the tiles: the live agents that don't need you, RUNNING_SHOWN in the roster's order, then "Show
     all N running" (and "Show fewer"). The heading says they run; no row repeats it.
   - Home › Agents: every agent, running or stopped, flat, in the roster's order (pins first where it shows them):
     name, soul (· machine for another machine's agent), state, who started it. Esc or Back returns.
   - First run (no agents): OATS in two lines, three keys, then the tiles.
   Every row is a button: Enter (or a click) opens it as Enter does in the roster (ctx.openAgent). Each read carries
   a latest-intent token, checked on its answer and on its failure. Copy reads its nouns from DESKTOP_NOUNS. */
import { apiJson, postJson, wsQuery, workspaceGeneration, onWorkspaceChange } from "./common.mjs";
import { cliStatus, onCliChange } from "./cli-status.mjs";
import { DESKTOP_NOUNS, DESKTOP_TERMS } from "../desktop-terms.mjs";
import { homeBoard, homeAgents, startedBy } from "../../../client/home-board.mjs";
import { instanceId } from "../../../client/instance-tree.mjs";
import { rosterRowFacts } from "../../../client/roster-row-facts.mjs";
import { waitingClaim, waitingDetail, waitingLabel } from "../../../client/waiting-on-you.mjs";
import { runtimeState } from "../../../client/instance-presentation.mjs";
import { teamModelOf } from "../../../client/team-rows.mjs";
import { displayLine } from "../../../client/display-text.mjs";
import { teamsAnswer } from "../computer-teams.mjs";
import { iconElement } from "../shell-icons.mjs";
import { automationRows } from "../automation-rows.mjs";
import { FAILED_RUN_TEXT } from "../automations-failure.mjs";
import { automationsSupported } from "./automations.mjs";

/** The workspace's tiles, in order: what each opens (`agents`: Home › Agents here; `page`: a page of its own, by its
 * stage name; else a Workspace tab id, with the Machines tab's view: its List; slice 3b's
 * `preselectWorkspaceTab(tab, { machinesView })`). No Graph: it is frozen (slice 2b), and Machines keeps List | Map. */
export const TILES = Object.freeze([
  { key: "agents", label: "Agents", opens: "agents" },
  { key: "souls", label: "Souls", opens: "souls" },
  { key: "capabilities", label: "Capabilities", opens: "capabilities" },
  { key: "teams", label: "Teams", opens: "teams" },
  { key: "machines", label: "Machines", opens: "machines", options: { machinesView: "list" } },
  { key: "automations", label: "Automations", page: "automations" },
]);

/** How many needs-you rows Home shows before "Show all N". */
export const NEEDS_YOU_SHOWN = 8;
/** How many running agents Home shows before "Show all N running" (Amendment 1, B). */
export const RUNNING_SHOWN = 5;

/** A tile's count as it reads: the number, "Counting…" while it is read (or pending), "Couldn't count" when that
 * failed, and "" when there is nothing to count (Teams without a team model, an OATS without automations). */
export function tileCount(key, counts) {
  const n = counts[key];
  if (n === "loading") return "Counting…";
  if (n === "failed") return "Couldn't count";
  return Number.isInteger(n) ? String(n) : "";
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** The summary line, from homeBoard's counts: "24 agents · 21 running · 3 need you · 0 stopped", and the agents whose
 * state isn't known, only when there are some. "need you" as the sidebar's foot says it (sidebar-foot.mjs). */
export function summaryLine(counts, nouns = DESKTOP_NOUNS) {
  return [plural(counts.agents, nouns.instance, nouns.instances), `${counts.running} running`, `${counts.needYou} need you`, `${counts.stopped} stopped`,
    ...(counts.unknown ? [`${counts.unknown} status unknown`] : [])].join(" · ");
}

/** The first run's two lines and three keys. `chord(id)`: the bound key's text, or "". */
export function firstRunCopy(chord, nouns = DESKTOP_NOUNS) {
  const key = (id, fallback) => (chord(id) ? { key: chord(id) } : { hint: fallback });
  return {
    lines: [`OATS runs your ${nouns.instances}: each one is a soul at work on a machine of yours.`,
      `Start one, and Home shows what needs you and what you have.`],
    keys: [
      { label: `New ${nouns.instance}`, ...key("app.quickOpenSouls", `the sidebar's New ${nouns.instance}`) },
      { label: "Command palette", ...key("app.palette", "not bound") },
      { label: "Home", ...key("stage.home", "Home in the palette") },
    ],
  };
}

const machineCount = (deployments) => new Set((Array.isArray(deployments) ? deployments : []).map((d) => d?.machine ?? d?.id).filter(Boolean)).size;

/** Home's vertical budget (slice 2b: the tiles in the first viewport at 1280×800 with NEEDS_YOU_SHOWN rows above
 * them), in px: the numbers homeCSS is built from, so the DOM test (which has no layout) sums the same ones. */
export const HOME_LAYOUT = Object.freeze({ padTop: 24, title: 30, titleGap: 16, heading: 20, headingGap: 8, needRow: 44, rowGap: 2,
  more: 28, summaryGap: 14, summary: 18, tile: 56 });
const L = HOME_LAYOUT;

export const homeCSS = `
.home { box-sizing:border-box; height:100%; overflow:auto; padding:${L.padTop}px 32px 32px; color:var(--fg); font-family:var(--ui-font, system-ui); }
.home-inner { max-width:880px; margin:0 auto; } /* a centred, readable column (Amendment 1, A: Pepe, 2026-11-20) */
.home h1 { margin:0 0 ${L.titleGap}px; font-size:24px; font-weight:700; line-height:${L.title}px; }
/* The Workspace page's head (views/spawn.mjs .workspace-title) is this one's, so the two pages read alike. */
.home h2 { margin:0 0 var(--title-gap); font-size:15px; font-weight:650; line-height:1.3; }
.home-section { margin:0 0 var(--section-gap); }
.home-section.home-needs { margin:0; } /* the summary line's own margins space it */
.home-section.home-running { margin:var(--section-gap) 0 0; }
.home h2.home-group-title { margin:0 0 ${L.headingGap}px; font-size:15px; line-height:${L.heading}px; }
.home h2.home-needs-title { margin:0 0 ${L.headingGap}px; line-height:${L.heading}px; }
.home-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:${L.rowGap}px; }
.home-row { display:flex; align-items:center; gap:10px; width:100%; min-height:44px; padding:6px 10px; border:0; border-radius:6px;
  background:transparent; color:var(--fg); font:inherit; font-size:13px; text-align:left; cursor:pointer; }
.home-row:hover { background:var(--surface-2); }
.home-row:focus-visible { background:var(--sel); }
.home-row:disabled { cursor:default; }
.home-row-copy { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
.home-row-name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.home-row-meta { font-size:12px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.home-row-side { flex:none; font-size:12px; color:var(--muted); }
/* Needs you: two lines a row, name and soul (· machine for another machine's agent) on the first, the message on the second. */
.home-needs .home-row { height:${L.needRow}px; min-height:${L.needRow}px; padding:4px 10px; box-sizing:border-box; }
.home-row-line { display:flex; align-items:baseline; gap:8px; min-width:0; }
.home-row-line .home-row-name { flex:none; max-width:60%; }
.home-row-line .home-row-meta { min-width:0; }
.home-row-message { font-size:12.5px; color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.home button.home-more { height:${L.more}px; margin:${L.rowGap}px 0 0; padding:0 10px; border:0; border-radius:6px; background:transparent; color:var(--accent);
  font:inherit; font-size:12.5px; font-weight:600; cursor:pointer; }
.home button.home-more:hover { background:var(--surface-2); }
.home-summary { margin:${L.summaryGap}px 0; font-size:13px; line-height:${L.summary}px; color:var(--muted); }
/* The workspace: one row of compact tiles, each a button with its count. */
.home-tiles { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(${TILES.length}, minmax(0, 1fr)); gap:8px; }
.home-tile { position:relative; box-sizing:border-box; width:100%; height:${L.tile}px; display:flex; flex-direction:column; justify-content:center; gap:2px;
  padding:6px 12px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--fg); font:inherit; text-align:left; cursor:pointer; }
.home-tile:hover { background:var(--surface-2); }
.home-tile:focus-visible { background:var(--sel); }
.home-tile-name { font-size:12px; font-weight:600; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.home-tile-count { font-size:16px; font-weight:650; line-height:20px; color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.home-tile-count.pending { font-size:12.5px; font-weight:500; color:var(--muted); }
/* Automations' failure mark: a --danger dot at the tile's corner (the sidebar's row says "N failed" since slice 3d). */
.home-tile-failed { position:absolute; top:9px; right:10px; width:8px; height:8px; border-radius:50%; background:var(--danger); }
.home-dot { flex:none; width:8px; height:8px; border-radius:50%; background:var(--faint); }
.home-dot.on { background:var(--live); }
.home-mark { width:10px; height:10px; margin:0 -1px; }
.home-quiet, .home-status { margin:0; font-size:13px; color:var(--muted); }
.home-failed { display:flex; align-items:center; gap:12px; margin:0; font-size:13px; color:var(--fg); }
.home-first p { margin:0 0 4px; font-size:14px; }
.home-keys { list-style:none; margin:12px 0 0; padding:0; display:flex; flex-direction:column; gap:4px; font-size:13px; }
.home-keys kbd { font:inherit; font-weight:600; color:var(--fg); } /* D2: the chrome is sans; monospace is the terminal's */
/* The back control, as the capability page's "‹ Capabilities" (capability-page.mjs .page-back): a quiet bordered
   button with its chevron; the shell's focus ring shows on it. */
.home button.home-back { display:inline-flex; align-items:center; gap:6px; height:30px; min-height:30px; margin:0 0 12px; padding:0 10px 0 8px;
  border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--fg); font-weight:600; font-size:12.5px;
  line-height:normal; font-family:var(--ui-font,system-ui); cursor:pointer; }
.home button.home-back:hover { background:var(--surface-2); }
`;

let returnTo = null; // the tile Home last opened, focused again when Home mounts (per workspace generation)

export function createHome(el, ctx, { doc = el.ownerDocument, cli = cliStatus, subscribeCli = onCliChange, subscribeWorkspace = onWorkspaceChange,
  generation = workspaceGeneration, setTimeout: schedule = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: cancel = (id) => globalThis.clearTimeout(id) } = {}) {
  const nouns = DESKTOP_NOUNS;
  const style = doc.createElement("style"); style.dataset.home = ""; style.textContent = homeCSS;
  const root = doc.createElement("div"); root.className = "home";
  const inner = doc.createElement("div"); inner.className = "home-inner";
  root.append(style, inner);
  el.replaceChildren(root);
  // expanded / runningExpanded: "Show all N" and "Show all N running" were chosen (until a workspace switch)
  let view = "board", alive = true, expanded = false, runningExpanded = false;
  const counts = { souls: "loading", capabilities: "loading", teams: "loading", automations: "loading" };
  let gen = generation();
  const chord = (id) => (typeof ctx.chordText === "function" ? ctx.chordText(id) : "") || "";

  const roster = () => (typeof ctx.homeRoster === "function" ? ctx.homeRoster() : { rows: [], deployments: [], phase: "loading", stale: () => false, here: null });

  function node(tag, className, text) {
    const n = doc.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  /** One agent's row: its dot, name, soul (· machine for another machine's agent), and a side note (the state, who started it). A needs-you row
   * (`claim`) is two lines: name and soul (· machine for another machine's agent), then the claim's message. */
  function agentRow(row, { claim = null, side = null, state = runtimeState(row), deployments, here }) {
    const facts = rosterRowFacts(row, DESKTOP_TERMS, { deployments, here });
    const b = node("button", "home-row"); b.type = "button"; b.dataset.homeAgent = instanceId(row); // identity, never the bare name: names repeat across roots and hosts
    // The needs-input mark is the roster's (.attn-mark): yellow means needs input only, never a dot's fill.
    const dot = claim ? iconElement(doc, "attention", { size: 10, className: "shell-icon attn-mark home-mark" })
      : node("span", `home-dot ${state === "running" ? "on" : ""}`.trim());
    dot.setAttribute("aria-hidden", "true");
    const copy = node("span", "home-row-copy");
    if (claim && !side) {
      const line = node("span", "home-row-line");
      line.append(node("span", "home-row-name", facts.name), node("span", "home-row-meta", facts.detail));
      copy.append(line, node("span", "home-row-message", displayLine(waitingDetail(claim) ?? waitingLabel(claim)) || waitingLabel(claim)));
    } else {
      copy.append(node("span", "home-row-name", facts.name), node("span", "home-row-meta", facts.detail));
      // Home › Agents: a waiting row keeps its message under its meta line (as merged in slice 2).
      if (claim) copy.append(node("span", "home-row-meta", displayLine(waitingDetail(claim) ?? waitingLabel(claim)) || waitingLabel(claim)));
    }
    b.append(dot, copy);
    if (side) b.append(node("span", "home-row-side", side));
    b.addEventListener("click", () => { ctx.openAgent?.(row); });
    return b;
  }

  /** The counts each tile shows, the roster's two included (a workspace served with no deployment list is this
   * machine's alone: one machine). */
  function tileCounts(data) {
    const rosterCount = (n) => (data.phase === "ready" ? n : data.phase === "loading" ? "loading" : "failed");
    return { ...counts, agents: rosterCount(data.rows.length), machines: rosterCount(machineCount(data.deployments) || 1) };
  }

  function tilesSection(data) {
    const s = node("section", "home-section home-workspace"); s.dataset.homeSection = "workspace";
    const ul = node("ul", "home-tiles"); ul.setAttribute("aria-label", "Workspace");
    const all = tileCounts(data), failed = ctx.automationsFailed?.() === true;
    for (const entry of TILES) {
      const label = entry.key === "agents" ? cap(nouns.instances) : entry.label;
      const said = tileCount(entry.key, all), mark = entry.key === "automations" && failed;
      const b = node("button", "home-tile"); b.type = "button"; b.dataset.homeOpen = entry.key;
      // Its name, read as "Souls, 26" (and "Automations, 4, a run failed"): the count is its own line on screen.
      b.setAttribute("aria-label", [label, said].filter(Boolean).join(", ") + (mark ? FAILED_RUN_TEXT : ""));
      b.append(node("span", "home-tile-name", label));
      if (said) b.append(node("span", `home-tile-count${Number.isInteger(all[entry.key]) ? "" : " pending"}`, said));
      if (mark) { const dot = node("span", "home-tile-failed"); dot.setAttribute("aria-hidden", "true"); b.append(dot); }
      b.addEventListener("click", () => openSection(entry));
      const li = node("li"); li.append(b); ul.append(li);
    }
    s.append(ul);
    return s;
  }

  function openSection(entry) {
    returnTo = { key: entry.key, gen };
    if (entry.opens === "agents") { view = "agents"; paint({ focus: "first" }); return; }
    if (entry.page) { void ctx.openPage?.(entry.page); return; }
    void ctx.openWorkspaceTab?.(entry.opens, entry.options);
  }

  /** Needs you, then the summary line (none until the roster is read). */
  function needsSection(data) {
    const s = node("section", "home-section home-needs"); s.dataset.homeSection = "needs-you";
    const h = node("h2", "home-needs-title", "Needs you"); h.id = "home-needs-title"; s.append(h);
    if (data.phase === "loading") { s.append(statusLine(`Reading your ${nouns.instances}…`)); return [s]; }
    if (data.phase === "failed" || data.phase === "unavailable") {
      // Unavailable: the kernel could not observe the deployment (its refusal, or a feature missing), said in the
      // sidebar's own words: no first run, no empty board, no zero.
      const p = node("p", "home-failed", `Couldn't read your ${nouns.instances}.`);
      const retry = node("button", null, "Retry"); retry.type = "button"; retry.addEventListener("click", () => data.retry?.());
      p.append(retry); s.append(p);
      if (data.phase === "unavailable" && data.note) s.append(node("p", "home-quiet", data.note));
      return [s];
    }
    const { needsYou, counts: tally } = homeBoard(data.rows, { stale: data.stale, pins: data.pins === true });
    const opts = { deployments: data.deployments, here: data.here };
    if (!needsYou.length) s.append(node("p", "home-quiet", "Nothing needs you."));
    else {
      const shown = expanded ? needsYou : needsYou.slice(0, NEEDS_YOU_SHOWN);
      const ul = node("ul", "home-list"); ul.setAttribute("aria-labelledby", h.id);
      for (const { row, claim } of shown) { const li = node("li"); li.append(agentRow(row, { claim, ...opts })); ul.append(li); }
      s.append(ul);
      if (shown.length < needsYou.length) {
        const more = node("button", "home-more", `Show all ${needsYou.length}`); more.type = "button"; more.dataset.homeMore = "needs";
        // Expands in place; the focus goes to the first row it showed, so the keyboard carries on down the list.
        more.addEventListener("click", () => { expanded = true; paint({ focus: { agent: instanceId(needsYou[NEEDS_YOU_SHOWN].row) } }); });
        s.append(more);
      }
    }
    return [s, node("p", "home-summary", summaryLine(tally, nouns))];
  }

  /** Running (Amendment 1, B: Pepe, 2026-11-20): under the tiles, the live agents that don't need you, in the roster's
   * order, RUNNING_SHOWN at most until "Show all N running" (expands in place, and "Show fewer" folds it back). The
   * heading says they run: no row says "running". None running: no group. */
  function runningSection(data) {
    const { running } = homeBoard(data.rows, { stale: data.stale, pins: data.pins === true });
    if (!running.length) return null;
    const s = node("section", "home-section home-running"); s.dataset.homeSection = "running";
    const h = node("h2", "home-group-title", "Running"); h.id = "home-running-title"; s.append(h);
    const opts = { deployments: data.deployments, here: data.here };
    const shown = runningExpanded ? running : running.slice(0, RUNNING_SHOWN);
    const ul = node("ul", "home-list"); ul.setAttribute("aria-labelledby", h.id);
    for (const row of shown) { const li = node("li"); li.append(agentRow(row, opts)); ul.append(li); }
    s.append(ul);
    if (running.length > RUNNING_SHOWN) {
      const more = node("button", "home-more", runningExpanded ? "Show fewer" : `Show all ${running.length} running`); more.type = "button";
      more.dataset.homeMore = "running";
      more.addEventListener("click", () => {
        runningExpanded = !runningExpanded;
        // Expanding focuses the first row it showed; folding keeps the focus on the toggle.
        paint({ focus: runningExpanded ? { agent: instanceId(running[RUNNING_SHOWN]) } : { more: "running" } });
      });
      s.append(more);
    }
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
      li.append(k.key ? node("kbd", null, k.key) : k.hint);
      keys.append(li);
    }
    s.append(keys);
    return s;
  }

  function agentsView(data) {
    const s = node("section", "home-section"); s.dataset.homeSection = "agents";
    const back = node("button", "home-back"); back.type = "button";
    back.append(iconElement(doc, "chevronLeft", { size: 15 }), node("span", null, "Home"));
    back.setAttribute("aria-label", "Back to Home"); back.title = "Back to Home (Esc)";
    back.addEventListener("click", () => backToBoard());
    s.append(back);
    if (data.phase === "loading") { s.append(statusLine(`Reading your ${nouns.instances}…`)); return s; }
    if (data.phase === "failed" || data.phase === "unavailable") {
      s.append(node("p", "home-failed", `Couldn't read your ${nouns.instances}.`));
      if (data.phase === "unavailable" && data.note) s.append(node("p", "home-quiet", data.note));
      return s;
    }
    const rows = homeAgents(data.rows, { pins: data.pins === true });
    if (!rows.length) { s.append(node("p", "home-quiet", `No ${nouns.instances} yet.`)); return s; }
    const opts = { deployments: data.deployments, here: data.here };
    const ul = node("ul", "home-list"); ul.setAttribute("aria-label", `Every ${nouns.instance}`);
    for (const row of rows) {
      // The roster's and the board's dot grammar: a row that waits on you wears the needs-input mark and says so first.
      const state = runtimeState(row), claim = waitingClaim(row, { stale: data.stale?.(row) === true });
      const by = startedBy(row);
      const said = claim ? "needs you" : state === "running" ? "running" : state === "stopped" ? "stopped" : "status unknown";
      const side = [said, by ? `started by ${by}` : null].filter(Boolean).join(" · ");
      const li = node("li"); li.append(agentRow(row, { ...opts, claim, state, side })); ul.append(li);
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
    const hadKey = had?.dataset?.homeOpen ? ["open", had.dataset.homeOpen] : had?.dataset?.homeAgent ? ["agent", had.dataset.homeAgent]
      : had?.dataset?.homeMore ? ["more", had.dataset.homeMore] : null;
    const data = roster();
    const title = node("h1", null, view === "agents" ? `Home › ${cap(nouns.instances)}` : "Home");
    const parts = [title];
    if (view === "agents") parts.push(agentsView(data));
    else {
      if (data.phase === "ready" && !data.rows.length) parts.push(firstRun());
      else parts.push(...needsSection(data));
      parts.push(tilesSection(data));
      if (data.phase === "ready" && data.rows.length) { const running = runningSection(data); if (running) parts.push(running); }
    }
    inner.replaceChildren(...parts);
    const target = focus === "first" ? inner.querySelector(".home-back")
      : focus === "agents" ? inner.querySelector('[data-home-open="agents"]')
      : focus?.agent ? find("homeAgent", focus.agent)
      : focus?.more ? find("homeMore", focus.more)
      : hadKey?.[0] === "more" ? find("homeMore", hadKey[1])
      : hadKey ? find(hadKey[0] === "open" ? "homeOpen" : "homeAgent", hadKey[1])
      : null;
    if (target) target.focus();
    else if (had && !root.contains(doc.activeElement)) inner.querySelector("button")?.focus();
  }

  /** Teams has a count only where the CLI has a team model: unknown while its probe is pending ("loading"), none
   * (null) where it has none. */
  const teamsState = () => { const status = cli(); return status == null ? "loading" : teamModelOf(status.features) ? "read" : null; };
  // Each count is its own read, owned by the workspace generation it was asked in and by its own latest intent (a
  // serial per count): a late answer, or a failure, for a workspace since left, or for a read a newer one or a gate
  // (the CLI no longer serving Teams or Automations: revoke) superseded, is dropped. A read never rejects: a refused
  // or malformed answer is that count's "failed".
  const own = (asked) => alive && asked === gen && generation() === asked;
  const serials = new Map(); // key -> the serial of its latest read
  function revoke(key) {
    serials.set(key, (serials.get(key) ?? 0) + 1);
    if (retries.has(key)) { cancel(retries.get(key)); retries.delete(key); }
  }
  // A read may answer PENDING: the server has no settled observation yet (the souls catalog still reading). The count
  // stays "Counting…" and is asked again PENDING_RETRY_MS later, on a timer this Home owns (cleared on a workspace
  // switch and on disposal; one read in flight per count), for as long as it is pending: a still-reading catalog
  // never becomes a count. (Not on the roster's paints: an unchanged roster read paints nothing.)
  const PENDING = Symbol("pending"), PENDING_RETRY_MS = 3000;
  const retries = new Map(); // key -> its retry timer, while pending
  function readCount(key, read) {
    const asked = gen;
    revoke(key);
    const serial = serials.get(key), owns = () => own(asked) && serials.get(key) === serial;
    counts[key] = "loading";
    // `owns` goes to the read too, so a read of several answers stops between them once superseded.
    Promise.resolve().then(() => read(owns)).catch(() => "failed").then((value) => {
      if (!owns()) return;
      if (value === PENDING) { retries.set(key, schedule(() => { retries.delete(key); if (owns()) readCount(key, read); }, PENDING_RETRY_MS)); return; }
      counts[key] = value; paint();
    });
  }
  function clearRetries() { for (const id of retries.values()) cancel(id); retries.clear(); }
  /** The souls catalog's answer as a count (the Workspace page's rules, views/spawn.mjs settleGridState): a
   * `catalog.reason` is a failed read; an empty list while the catalog is still reading (`refreshing`), or with no
   * catalog observed yet, is pending, not "0 souls"; else the number listed. A remote view's answer (its workspace
   * names a `server`) carries no catalog of its own: its list is the count. */
  function soulsCount(d) {
    if (!d || !Array.isArray(d.agents)) return "failed";
    if (d.catalog?.reason) return "failed";
    if (!d.agents.length && (d.refreshing === true || (!d.catalog && !d.workspace?.server))) return PENDING;
    return d.agents.length;
  }
  let teamsReadIn = null; // the generation a Teams read was asked in: a CLI answer then asks no second one
  function readTeams() {
    const state = teamsState();
    if (state !== "read") { revoke("teams"); counts.teams = state; teamsReadIn = null; return; }
    if (teamsReadIn === gen) return;
    teamsReadIn = gen;
    readCount("teams", async () => {
      const doc = teamsAnswer(await postJson(ctx, `/api/workspace-teams${wsQuery()}`, { action: "list" }), "teams", "");
      return Array.isArray(doc.teams) ? doc.teams.length : "failed";
    });
  }
  /** Automations' count: the schedules and the triggers the kernel lists (the Automations page's read, POST
   * /api/automations { kind, action: "list" }), where this OATS serves automations (views/automations.mjs
   * automationsSupported): unknown while the CLI's probe is pending, none (null) where it serves none. */
  let automationsReadIn = null;
  function readAutomations() {
    const status = cli();
    const gated = status == null ? "loading" : automationsSupported(status) ? null : "none";
    if (gated) { revoke("automations"); counts.automations = gated === "loading" ? "loading" : null; automationsReadIn = null; return; }
    if (automationsReadIn === gen) return;
    automationsReadIn = gen;
    readCount("automations", async (owns) => {
      let total = 0;
      for (const kind of ["schedule", "trigger"]) {
        if (!owns()) return "failed"; // superseded: the answer is dropped anyway, so ask nothing more
        const r = await postJson(ctx, `/api/automations${wsQuery()}`, { kind, action: "list" });
        const rows = r?.status === "ok" ? automationRows(r.result, kind)?.rows : null;
        if (!Array.isArray(rows)) return "failed";
        total += rows.length;
      }
      return total;
    });
  }
  function readCounts() {
    readCount("souls", async () => soulsCount(await apiJson(ctx, `/api/agents${wsQuery()}`)));
    readCount("capabilities", async () => {
      const r = await postJson(ctx, `/api/workspace-sync${wsQuery()}`, { action: "read" });
      return r?.status === "ok" && Array.isArray(r.capabilities?.capabilities) ? r.capabilities.capabilities.length : "failed";
    });
    readTeams();
    readAutomations();
    paint();
  }
  /** Another workspace: Home shows its board again and counts that workspace's (the stage stays mounted across a
   * switch, so Home follows it itself). */
  function workspaceChanged() {
    if (!alive || generation() === gen) return;
    gen = generation(); view = "board"; expanded = false; runningExpanded = false; returnTo = null; clearRetries();
    readCounts();
  }

  const unsubscribe = typeof ctx.subscribeHomeRoster === "function" ? ctx.subscribeHomeRoster(() => paint()) : () => {};
  const unsubscribeWorkspace = subscribeWorkspace(() => workspaceChanged());
  // The CLI's probe answering (or its features changing) settles whether Teams and Automations have a count.
  const unsubscribeCli = subscribeCli(() => { if (!alive) return; readTeams(); readAutomations(); paint(); });
  // The sidebar's Automations mark changing (slice 1's reader) marks the tile too.
  const unsubscribeFailed = typeof ctx.subscribeAutomationsFailed === "function" ? ctx.subscribeAutomationsFailed(() => paint()) : () => {};
  const onKey = (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || view !== "agents") return;
    e.preventDefault(); backToBoard();
  };
  root.addEventListener("keydown", onKey);
  paint();
  if (returnTo && returnTo.gen === gen) find("homeOpen", returnTo.key)?.focus();
  returnTo = null;
  readCounts();

  return {
    get view() { return view; },
    refresh: () => paint(),
    /** Home as a destination (its sidebar row, the palette, a trail's Home) while it is already the stage: the board,
     * whatever view it showed (review r3: the Home row always returns to Home). */
    toBoard() { if (!alive || view === "board") return; view = "board"; paint(); },
    dispose() { alive = false; clearRetries(); unsubscribe(); unsubscribeWorkspace(); unsubscribeCli(); unsubscribeFailed(); root.removeEventListener("keydown", onKey); },
  };
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/** The stage contract: mount returns its disposer, so each mount cleans up only itself (view-lifecycle.mjs); the
 * module-wide unmount, a legacy host's fallback, disposes every Home still mounted. */
const mounted = new Set();
/** The shell's arrival on Home while Home is already its stage (shell.mjs showStage): each mounted Home shows its board. */
export function arrive() { for (const home of mounted) home.toBoard(); }
export function mount(el, ctx) {
  const home = createHome(el, ctx); mounted.add(home);
  return () => { mounted.delete(home); home.dispose(); };
}
export function unmount() { for (const home of mounted) home.dispose(); mounted.clear(); }
