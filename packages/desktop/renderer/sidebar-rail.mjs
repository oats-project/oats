/* oats desktop — the collapsed sidebar: a narrow rail (the Desktop UI rework, slice 6a, tour step 44).
   The pinned destinations as icons, then one dot per agent in the roster's order, each with its needs-input mark,
   and at the foot the "N need you" mark. Every control is a native button: an agent's accessible name is its name
   and its state ("Rework lead, running, needs input"), its tooltip its name; Enter or a click opens it as its roster
   row does. The rail draws what the shell hands it (`update`); it reads nothing and decides no order of its own.
   Pure DOM, textContent only (names are the kernel's). */
import { iconElement } from "./shell-icons.mjs";

export const RAIL_WIDTH = 48;

export const railCSS = `
#sidebar-rail { display:none; flex:none; width:${RAIL_WIDTH}px; min-width:${RAIL_WIDTH}px; box-sizing:border-box; flex-direction:column;
  align-items:center; gap:4px; padding:8px 0; border-right:1px solid var(--border); background:var(--surface); overflow:hidden auto; }
#app.sidebar-rail #sidebar-rail { display:flex; }
#app.sidebar-rail #sidebar { display:none; }
#sidebar-rail .rail-group { display:flex; flex-direction:column; align-items:center; gap:4px; width:100%; }
#sidebar-rail .rail-line { width:24px; height:1px; margin:4px 0; background:var(--border); flex:none; }
#sidebar-rail button { display:flex; align-items:center; justify-content:center; width:32px; height:32px; flex:none; padding:0; border:0;
  border-radius:6px; background:transparent; color:var(--muted); cursor:pointer; position:relative; }
#sidebar-rail button:hover { background:var(--surface-2); color:var(--fg); }
#sidebar-rail button[aria-current="page"], #sidebar-rail button[aria-current="true"] { background:var(--sel); color:var(--fg); }
#sidebar-rail .rail-dot { width:9px; height:9px; border-radius:50%; box-sizing:border-box; border:1.5px solid var(--faint); }
#sidebar-rail .rail-dot.on { background:var(--live); border-color:var(--live); }
#sidebar-rail .rail-agents { flex:1 1 auto; min-height:0; }
#sidebar-rail .rail-need { margin-top:auto; flex-direction:column; height:auto; min-height:32px; gap:2px; font-size:11px; font-weight:650;
  color:var(--fg); font-family:var(--ui-font, system-ui); }
#sidebar-rail .rail-need[hidden] { display:none; }
`;

/** createSidebarRail(doc, { onPinned(name), onAgent(row), onNeedYou() }) -> { element, update(state) }
 *  state: { pinned: [{ name, label, icon, current }], agents: [{ row, id, name, state, waiting }], needYou: n,
 *           nouns } — agents in the roster's order, as the shell computed it. */
export function createSidebarRail(doc, { onPinned = () => {}, onAgent = () => {}, onNeedYou = () => {} } = {}) {
  const element = doc.createElement("nav");
  element.id = "sidebar-rail";
  element.setAttribute("aria-label", "Sidebar (collapsed)");
  const pinned = doc.createElement("div"); pinned.className = "rail-group rail-pinned";
  const line = doc.createElement("div"); line.className = "rail-line"; line.setAttribute("aria-hidden", "true");
  const agents = doc.createElement("div"); agents.className = "rail-group rail-agents"; agents.setAttribute("role", "group");
  const need = doc.createElement("button"); need.type = "button"; need.className = "rail-need"; need.hidden = true;
  need.addEventListener("click", () => onNeedYou());
  element.append(pinned, line, agents, need);
  let last = null;

  function update({ pinned: rows = [], agents: list = [], needYou = 0, nouns = { instance: "agent", instances: "agents" } } = {}) {
    // Focus is kept by identity across repaints: the control that had it gets it back.
    const had = element.contains(doc.activeElement) ? doc.activeElement.dataset.railKey : null;
    pinned.replaceChildren(...rows.map((p) => {
      const b = doc.createElement("button"); b.type = "button"; b.dataset.railKey = `pinned:${p.name}`;
      b.setAttribute("aria-label", p.label); b.title = p.label;
      if (p.current) b.setAttribute("aria-current", "page");
      b.append(iconElement(doc, p.icon, { size: 16 }));
      b.addEventListener("click", () => onPinned(p.name));
      return b;
    }));
    agents.setAttribute("aria-label", nouns.instances[0].toUpperCase() + nouns.instances.slice(1));
    agents.replaceChildren(...list.map((a) => {
      const b = doc.createElement("button"); b.type = "button"; b.dataset.railKey = `agent:${a.id}`;
      const state = a.state === "running" ? "running" : a.state === "stopped" ? "stopped" : "status unknown";
      b.setAttribute("aria-label", `${a.name}, ${state}${a.waiting ? ", needs input" : ""}`);
      b.title = a.name;
      if (a.current) b.setAttribute("aria-current", "true");
      const mark = a.waiting ? iconElement(doc, "attention", { size: 12, className: "shell-icon attn-mark" }) : doc.createElement("span");
      if (!a.waiting) mark.className = `rail-dot${state === "running" ? " on" : ""}`;
      mark.setAttribute("aria-hidden", "true");
      b.append(mark);
      b.addEventListener("click", () => onAgent(a.row));
      return b;
    }));
    need.hidden = !needYou;
    need.replaceChildren(iconElement(doc, "attention", { size: 12, className: "shell-icon attn-mark" }), doc.createTextNode(String(needYou)));
    need.setAttribute("aria-label", `${needYou} ${needYou === 1 ? `${nouns.instance} needs` : `${nouns.instances} need`} you. Open the first`);
    need.title = `${needYou} need you`;
    need.dataset.railKey = "need";
    if (had) [...element.querySelectorAll("button")].find((b) => b.dataset.railKey === had)?.focus();
    last = { rows, list, needYou };
  }
  return { element, update, get state() { return last; } };
}
