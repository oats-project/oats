import { iconElement } from "./shell-icons.mjs";
import { cliHeldBack, onCliChange } from "./views/cli-status.mjs";
import { revealInScrollport } from "./reveal-in-scrollport.mjs";
import { workspaceStep } from "../../client/workspace-step.mjs";
import { requestDeploymentTab } from "./deployment-tabs.mjs";
import { whenRightButtonReleased } from "./context-menu-release.mjs";
// For a view no workspace matched, the deployment its pick opens is the shared home's (workspaceChoiceRows); the
// row's name (rowNames), the needs-input words, the new-window hint and adding a folder are this module's.
import { isLocalPath, workspaceChoiceRows } from "../../client/workspace-choices.mjs";

/* The workspace list (docs/desktop.md, "Workspaces"): always shown at the top of the sidebar, one row per
   workspace this window can show, whatever machine it is on: the served views, remote-only ones included, then
   the views no workspace identity matched, in the same flat list. A row is one line, the instance roster's circle
   and the workspace's name: no machine, no state. The current row is `aria-current` and marked by style alone (its
   circle filled, its name bold); picking a row (a
   click, Enter or a move) shows it in this window, taking it over from another window that shows it (#481 as
   changed: never focus the other window). A row with an instance that needs input carries the needs-input mark (.attn-mark) at its far right
   (and the words, for assistive tech and in its tooltip), from the served views' roll-up alone.

   A list of buttons, not a listbox (the sidebar's plain keys stay live on it): one tab stop (the current row,
   else the row last focused), Up/Down/Home/End move, Enter opens. ⌘Enter / Ctrl+Enter opens a row in a new
   window, and so does its context menu (a right-click, Shift+F10 or the Menu key): no button is drawn for it.
   `step(±1)` (the leader's ↑/↓) selects the previous / next row, as a click does, wrapping at the ends.

   This computer's deployments not opened are not rows: Add local workspace… offers them, each one a button that
   adds it and opens it here (#518), and after them the rows of this computer's list that can't be opened, each
   with its state in a word and its Remove (#1390). */

/** Below the list while rows are cut off below its bounded height (a sighted cue: every row is in the list). */
export const moreBelowText = (count) => `${count} more below`;
/** "Show only the current workspace" (2026-10-23, the product owner: "for people that prefer working like we used to
 * work"): the toggle's name and the key it is remembered under. Nothing stands for the rows it hides. */
export const CURRENT_ONLY_LABEL = "Show only the current workspace";
export const CURRENT_ONLY_KEY = "oats-desktop-workspaces-current-only";
/** A workspace with an instance that needs input: the mark's words, in the row's name and as its tooltip. */
export const WAITING_NAME = ", needs input";
export const WAITING_TITLE = "An instance here needs input";
/** The row's context-menu item (#481). */
export const OPEN_IN_NEW_WINDOW = "Open in new window";
/** A row of this computer's deployments list that can't be opened, in words (#1390): the kernel's state. */
export const LISTED_STATE_TEXT = Object.freeze({
  missing: "Missing: the folder is gone, or its volume isn't mounted",
  "not-a-deployment": "Not a deployment any more: no oats-local.yaml",
  unreadable: "Can't be checked: OATS couldn't read this folder",
});
/** The same states in a word or two, the row's visible line (the sentence is its tooltip and is said). */
export const LISTED_STATE_WORD = Object.freeze({ missing: "Missing", "not-a-deployment": "Not a deployment", unreadable: "Can't be checked" });
/** What the dialog adds when this computer's list could not be read: its CLI has no list, or the read failed. */
export const LIST_UNSUPPORTED_TEXT = "This oats can't list this computer's deployments. Update oats.";
export const listFailedText = (message) => `Couldn't read this computer's deployments: ${message}`;
/** The Add dialog's count (its status line): what can be added, never the rows that can't be opened. */
export const addableText = (count) => (count ? `${count} workspace${count === 1 ? "" : "s"} to add` : "No OATS workspaces to add.");
/** The heading over this computer's list's rows that can't be opened, in the Add dialog after those to add. */
export const STALE_HEADING = "Can't be opened";
/** The keyboard route to a row's Remove, said once for every removable row. */
export const REMOVE_HINT = "Press Right Arrow, then Enter, to remove it from this computer's list.";

const text = (value) => String(value || "");
const candidateId = (candidate) => text(candidate?.id || candidate?.path);
const candidateName = (candidate) => candidate?.name
  || candidateId(candidate).split("/").filter(Boolean).at(-1)
  || "Workspace";

/** Each row's name, in order: the workspace's name, else a local folder's last segment, else "Workspace". Two
 * of one name are told apart by what names the workspace, its team and its key ("tsm — github.com/a/tsm"),
 * never by where it is: no folder, no machine (the shared workspaceChoiceLabels falls back to those, for the
 * TUI's switcher). Twins with nothing of the kind keep the same name. */
export function rowNames(choices) {
  const short = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 ? value : "";
  const base = choices.map((choice) => choice.name
    || (isLocalPath(choice.id) ? String(choice.id).split("/").filter(Boolean).at(-1) : "")
    || "Workspace");
  const counts = new Map();
  for (const name of base) counts.set(name, (counts.get(name) || 0) + 1);
  return choices.map((choice, index) => {
    if (counts.get(base[index]) === 1) return base[index];
    const suffix = [short(choice.team?.name), short(choice.key)].filter(Boolean).join(" · ");
    return suffix ? `${base[index]} — ${suffix}` : base[index];
  });
}

/** The keyboard route to a workspace's Open in new window (#481), said once for every row. */
export function openInNewWindowHint(mac) {
  return `Press ${mac ? "⌘Enter" : "Ctrl+Enter"} to open this workspace in a new window.`;
}

/** The switcher's controls whose operation main holds back above the tested bound: selector → operation. */
const HELD_WRITES = Object.freeze({ ".ws-remove-listed": "main deployments remove", ".ws-pick-setup": "main workspace onboard" });

export function createWorkspaceSwitcher({
  document, selectWorkspace, discoverSuggestions, addWorkspace, pickWorkspace, onboardWorkspace = null, onboarded = null,
  // Remove a row of this computer's deployments list that can't be opened (#1390). Absent, no Remove.
  removeListed = null,
  // One window per workspace (#481): opens (or focuses) a workspace's own window. Absent, no action.
  openInNewWindow = null, mac = false,
  // Where "Show only the current workspace" is remembered (a Storage: localStorage), else not at all.
  storage = null,
  // The shell's guard for a focus it restores (selection-ownership.mjs applyFocus): a repaint keeping the focus on
  // the row that had it is no new intent of the operator's.
  applyFocus = (fn) => fn(),
}) {
  const q = (id) => document.getElementById(id);
  const section = q("ws-list"), options = q("ws-options"), addOpen = q("ws-add-open");
  addOpen.replaceChildren(iconElement(document, 'plus', { size: 14 }));
  addOpen.setAttribute('aria-label', 'Add local workspace…'); addOpen.title = 'Add local workspace…';
  const empty = document.createElement('p'); empty.className = 'ws-menu-empty'; empty.setAttribute('role', 'status'); empty.hidden = true;
  options.after(empty);
  const more = document.createElement('p'); more.className = 'ws-more'; more.setAttribute('aria-hidden', 'true'); more.hidden = true;
  options.after(more);
  // Show only the current workspace: a toggle at the heading, before Add (index.html #ws-current-only). Its state is
  // aria-pressed; the rows it hides leave the list and its keys, and no line stands for them.
  const currentOnlyButton = q("ws-current-only");
  let currentOnly = (() => { try { return storage?.getItem(CURRENT_ONLY_KEY) === "1"; } catch { return false; } })();
  if (currentOnlyButton) {
    currentOnlyButton.replaceChildren(iconElement(document, "collapse", { size: 14 }));
    currentOnlyButton.setAttribute("aria-label", CURRENT_ONLY_LABEL); currentOnlyButton.title = CURRENT_ONLY_LABEL;
    currentOnlyButton.setAttribute("aria-pressed", String(currentOnly));
  }
  // The rows' description: how to reach Open in new window from the keyboard (one hidden element).
  const hint = document.createElement('p'); hint.id = 'ws-open-window-hint'; hint.hidden = true; hint.textContent = openInNewWindowHint(mac);
  if (openInNewWindow) empty.after(hint);
  // A row's context menu (#481): one item, Open in new window. The page's own menu: the native one main
  // draws (Copy, Paste) never shows for a row.
  const rowMenu = document.createElement("div"); rowMenu.className = "ctx-instance-menu ws-row-menu"; rowMenu.tabIndex = -1;
  rowMenu.setAttribute("popover", "auto"); rowMenu.setAttribute("role", "menu");
  const openItem = document.createElement("button"); openItem.type = "button"; openItem.setAttribute("role", "menuitem");
  openItem.dataset.action = "open-in-new-window";
  const openLabel = document.createElement("span"); openLabel.textContent = OPEN_IN_NEW_WINDOW;
  const openKeys = document.createElement("kbd"); openKeys.textContent = mac ? "⌘Enter" : "Ctrl+Enter";
  openItem.append(openLabel, openKeys);
  rowMenu.append(openItem);
  if (openInNewWindow) section.append(rowMenu);
  let menuFor = ""; // the row the open context menu is for, else ""
  const modal = q("ws-modal"), dialog = modal.querySelector(".ws-dialog");
  const modalSearch = q("ws-suggestion-search"), suggestionsEl = q("ws-suggestions");
  const status = q("ws-dialog-status"), confirm = q("ws-confirm"), browse = q("ws-browse");
  const cancel = q("ws-cancel"), closeButton = q("ws-dialog-close");
  const title = q("ws-dialog-title"), intro = modal.querySelector(".ws-dialog-intro");
  const defaults = { title: title.textContent, intro: intro.textContent };
  const removeHint = document.createElement('p'); removeHint.id = 'ws-remove-hint'; removeHint.hidden = true; removeHint.textContent = REMOVE_HINT;
  if (removeListed) suggestionsEl.after(removeHint);
  // Onboarding (workspace model v2): a picked folder without oats-local.yaml.
  // The folder is the one main offered; the renderer supplies only the ref.
  const onboardEl = document.createElement("div"); onboardEl.className = "ws-onboard"; onboardEl.hidden = true;
  const onboardPath = document.createElement("p"); onboardPath.className = "ws-onboard-path";
  const refLabel = document.createElement("label"); refLabel.className = "ws-onboard-field";
  const refText = document.createElement("span"); refText.textContent = "Workspace repository";
  const refInput = document.createElement("input"); refInput.id = "ws-onboard-ref"; refInput.className = "field";
  refInput.type = "text"; refInput.autocomplete = "off"; refInput.spellcheck = false; refInput.placeholder = "github.com/org/agents";
  refLabel.append(refText, refInput);
  const onboardNote = document.createElement("p"); onboardNote.className = "ws-onboard-note";
  onboardNote.textContent = "Runs oats onboard in this folder: it writes oats-local.yaml and agents/, reads the workspace over Git and writes the lock. It installs nothing and spawns nothing.";
  onboardEl.append(onboardPath, refLabel, onboardNote);
  status.before(onboardEl);
  let onboarding = null; // { token, path } — the current single-use offer
  // A picked folder that is not a deployment (#461): refused before anything changes. Main says
  // where the deployment is when it can (one level down, or the deployment the folder is inside);
  // each choice goes through the normal add. With none, onboarding is the secondary action.
  const pickEl = document.createElement("div"); pickEl.className = "ws-pick"; pickEl.hidden = true;
  status.after(pickEl);
  let pickOffer = null; // the refused pick's onboarding offer, entered only on request
  let generation = 0, modalGeneration = 0, discoveryGeneration = 0;
  // `suggestions`: the found deployments that can be opened; `stale`: this computer's list's rows that can't.
  let activeId = "", workspaces = [], suggestions = [], stale = [], choosing = false, answered = false;
  let adding = false, discoveryState = { message: "", error: false };
  // `stopKey`: the row that is the list's tab stop (the row last focused), else the current one. `suggestionStop`:
  // the Add dialog's found deployment last focused, its tab stop.
  let stopKey = "", suggestionStop = "";
  // Where focus goes back when the Add dialog closes: what opened it.
  let returnTo = null;
  // The workspace last picked here while its switch is still on its way (main may be taking it over from another
  // window), else "": the moves go on from it, and a pick of the current row supersedes it.
  let pickedId = "";

  const setStatus = (message = "", error = false) => {
    status.textContent = message;
    status.classList.toggle("error", error);
  };
  const rowKey = (button) => button?.dataset?.workspaceId || "";
  const menuItems = () => [...options.querySelectorAll(".ws-option:not([hidden])")];
  const rowOf = (key) => menuItems().find((button) => rowKey(button) === key) || null;
  /** Where focus goes in the list: its tab stop, else the current row, else the first row. */
  const focusTarget = () => rowOf(stopKey) || rowOf(activeId) || menuItems()[0] || addOpen;
  const openInWindow = (id) => { openInNewWindow(id); };
  /** Pick `id` (selectWorkspace: the shell's switch, which may answer `{ ok }`; `how` goes to it as it is).
   * It is the pending pick until the switch lands here (reset) or is refused. */
  let pickToken = 0;
  const pick = (id, how) => {
    // Each pick owns its own answer: a refused or superseded older pick never clears a newer one, even of the same id.
    const mine = ++pickToken;
    pickedId = id;
    const done = () => { if (pickToken === mine) pickedId = ""; };
    let answer;
    try { answer = selectWorkspace(id, how); } catch { answer = { ok: false }; }
    Promise.resolve(answer).then((r) => { if (r?.ok === false) done(); }, done);
  };
  /** The rows as drawn, for the moves: `{ key, openable, open() }`, in order. Every row can be opened (a row
   * another window shows is taken over). */
  let drawn = [];
  const renderOptions = () => {
    const said = workspaceChoiceRows(workspaces), names = rowNames(workspaces);
    const focused = options.contains(document.activeElement) ? document.activeElement : null;
    const focusedKey = focused?.classList?.contains("ws-option") ? rowKey(focused) : "";
    // Focus in a row's open context menu (outside the list): the row it is for, should that row go.
    const menuFocusKey = menuFor && rowMenu.contains(document.activeElement) ? menuFor : "";
    options.replaceChildren();
    drawn = [];
    const list = document.createElement("ul"); list.className = "ws-group"; list.setAttribute("aria-label", "Workspaces");
    // The views a workspace identity matched, then those none matched: one flat list, no heading.
    const order = [...said.keys()].filter((i) => !said[i].unattached).concat([...said.keys()].filter((i) => said[i].unattached));
    for (const index of order) {
      const workspace = workspaces[index], row = said[index], label = names[index];
      const button = document.createElement("button");
      button.type = "button"; button.className = "ws-option"; button.tabIndex = -1;
      if (workspace.id === activeId) button.setAttribute("aria-current", "true");
      button.dataset.workspaceId = workspace.id;
      // The instance roster's circle, its own rule (shell.css .ctx-dot): filled like a running instance's on the current
      // workspace, a ring like a stopped one's on the others. Decorative: aria-current says which row is current.
      const mark = document.createElement("span"); mark.className = workspace.id === activeId ? "ctx-dot on" : "ctx-dot off";
      mark.setAttribute("aria-hidden", "true");
      const name = document.createElement("span"); name.className = "ws-option-name"; name.textContent = label;
      button.append(mark, name);
      // The mark (the view's `waiting === true`): at the row's far right, and in the row's name and tooltip. Unknown is none.
      let tooltip = label;
      if (workspace.waiting === true) {
        const words = document.createElement("span"); words.className = "sr-only"; words.textContent = WAITING_NAME;
        button.append(words, iconElement(document, "attention", { size: 14, className: "ws-waiting attn-mark" }));
        tooltip = `${tooltip}\n${WAITING_TITLE}`;
      }
      // The whole name, for a name cut off: never a path or a machine.
      button.title = tooltip;
      if (openInNewWindow) button.setAttribute("aria-describedby", hint.id);
      const choose = (how) => {
        // Picked unless it is already what this window shows or is about to show: the current row while another
        // pick is on its way supersedes that pick (the latest pick wins).
        if (workspace.id !== (pickedId || activeId)) pick(workspace.id, how);
        // A deployment no workspace matched: the Deployments page opens on its tab, where the full
        // reason and its fix are.
        if (row.deployment) requestDeploymentTab(workspace.id, row.deployment);
      };
      button.addEventListener("click", () => { if (button.isConnected && options.contains(button)) choose(); });
      const item = document.createElement("li"); item.className = "ws-option-row";
      // Only the current workspace: the others are hidden (never with no current row: then every row shows).
      if (currentOnly && workspace.id !== activeId && workspaces.some((w) => w.id === activeId)) { button.hidden = true; item.hidden = true; }
      item.append(button);
      list.append(item);
      drawn.push({ key: workspace.id, openable: true, open: choose });
    }
    if (list.childElementCount) options.append(list);
    empty.hidden = !!menuItems().length || !answered;
    empty.textContent = empty.hidden ? '' : 'No workspace choices reported.';
    // The tab stop: the row last focused while it is still drawn, else the current row, else the first.
    if (!rowOf(stopKey)) stopKey = "";
    const stop = focusTarget();
    if (stop?.classList?.contains("ws-option")) stop.tabIndex = 0;
    if (focused) applyFocus(() => (focusedKey ? rowOf(focusedKey) || focusTarget() : focusTarget()).focus());
    // A context menu whose row is gone closes; focus that was in it goes to the list's stop (the current row), never
    // <body> (review: Show only the current workspace's chord from another row's menu).
    if (menuFor && !rowOf(menuFor)) { closeRowMenu(false); if (menuFocusKey) focusTarget().focus(); }
    revealInScrollport(options, rowOf(activeId));
    noteMore();
  };
  /** "N more below" while rows are cut off by the list's bounded height, at any scroll; none otherwise. */
  const noteMore = () => {
    more.setAttribute("aria-hidden", "true");
    // Only the current workspace: the others are not shown at all, not even as a line (the product owner); the
    // pressed toggle says the list is narrowed.
    if (options.querySelector(".ws-option[hidden]")) { more.hidden = true; more.replaceChildren(); return; }
    const bottom = options.getBoundingClientRect().bottom;
    const below = menuItems().filter((button) => button.getBoundingClientRect().bottom > bottom + 0.5);
    more.hidden = !below.length;
    more.replaceChildren(below.length ? moreBelowText(below.length) : "");
    // A row cut off below waits on you: the line carries the rows' mark, as the TUI's "+N ●" (the rows keep their words).
    if (below.some((button) => button.querySelector(".ws-waiting"))) {
      more.append(iconElement(document, "attention", { size: 14, className: "ws-waiting attn-mark" }));
    }
  };

  const menuOpen = () => { try { return rowMenu.matches(":popover-open"); } catch { return false; } };
  function closeRowMenu(restore) {
    const key = menuFor;
    if (!key) return;
    menuFor = "";
    try { rowMenu.hidePopover?.(); } catch { /* already closed */ }
    if (restore) (rowOf(key) || focusTarget()).focus();
  }
  /** Open `button`'s context menu: at the pointer when the pointer opened it on the row, else (a key) below the row. */
  const openRowMenu = (button, event) => {
    if (typeof rowMenu.showPopover !== "function") return;
    menuFor = rowKey(button);
    rowMenu.setAttribute("aria-label", button.querySelector(".ws-option-name")?.textContent || "Workspace");
    if (!menuOpen()) rowMenu.showPopover();
    const win = document.defaultView, row = button.getBoundingClientRect(), size = rowMenu.getBoundingClientRect();
    const atPointer = event.clientX >= row.left && event.clientX <= row.right && event.clientY >= row.top && event.clientY <= row.bottom
      && (event.clientX || event.clientY);
    const x = atPointer ? event.clientX : row.left + 8, y = atPointer ? event.clientY : row.bottom;
    rowMenu.style.left = `${Math.max(8, Math.min(x, win.innerWidth - size.width - 8))}px`;
    rowMenu.style.top = `${Math.max(8, y + size.height + 8 <= win.innerHeight ? y : y - size.height - (atPointer ? 0 : row.height))}px`;
    openItem.focus();
  };

  // The Add dialog's found deployments (#518): each one a button that adds it and opens it here, on a click or
  // Enter. After them, this computer's list's rows that can't be opened (#1390): each says its state in a word
  // (the sentence is its tooltip and is said), opens nothing, and has Remove beside it, reached with Right Arrow.
  // One tab stop among them all (the one last focused, else the first); Up/Down move between them.
  const matches = (query) => (candidate) => !query
    || `${candidateName(candidate)} ${candidateId(candidate)} ${candidate.team?.name || ""} ${candidate.reason || ""}`.toLocaleLowerCase().includes(query);
  // Above the tested bound (#1879) the writes main would refuse are held back here too, with the notice as their
  // title (packages/client/above-tested.mjs): removing a row of this computer's deployments list, and setting up a
  // new deployment. Applied after every paint and busy change, and again when the CLI changes.
  const applyHolds = () => {
    for (const [selector, operation] of Object.entries(HELD_WRITES)) {
      const held = cliHeldBack(operation);
      for (const button of [suggestionsEl, pickEl].flatMap((el) => [...el.querySelectorAll(selector)])) { button.disabled = adding || !!held; button.title = held ?? button.dataset.title ?? ""; }
    }
  };
  const offCli = onCliChange(applyHolds);
  const renderSuggestions = (focusId = "") => {
    const query = modalSearch.value.trim().toLocaleLowerCase();
    suggestionsEl.replaceChildren();
    const visible = suggestions.filter(matches(query)), staleVisible = stale.filter(matches(query));
    const all = [...visible, ...staleVisible];
    if (!all.some((candidate) => candidateId(candidate) === suggestionStop)) suggestionStop = candidateId(all[0]);
    const entry = (candidate) => {
      const id = candidateId(candidate), name = candidateName(candidate);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ws-suggestion";
      button.dataset.workspaceId = id;
      button.tabIndex = id === suggestionStop ? 0 : -1;
      button.disabled = adding;
      button.title = id;
      const copy = document.createElement("span");
      copy.className = "ws-suggestion-copy";
      const title = document.createElement("span");
      title.className = "ws-suggestion-title";
      title.textContent = name;
      const meta = document.createElement("span");
      meta.className = "ws-suggestion-meta";
      meta.textContent = `${candidate.team?.name ? `${candidate.team.name} · ` : ""}${id}`;
      copy.append(title, meta);
      button.append(copy);
      return { id, name, button, copy };
    };
    for (const candidate of visible) {
      const { id, name, button, copy } = entry(candidate);
      if (candidate.reason) {
        const reason = document.createElement("span");
        reason.className = "ws-suggestion-reason";
        reason.textContent = candidate.reason;
        copy.append(reason);
      }
      button.addEventListener("click", () => { if (!adding) void runAdd(id, name, button); });
      suggestionsEl.append(button);
    }
    // Under their own heading, as their own group: they are not workspaces to add, and the count says so.
    let staleGroup = null;
    if (staleVisible.length) {
      const heading = document.createElement("h3"); heading.className = "ws-suggestions-heading"; heading.id = "ws-stale-heading";
      heading.textContent = STALE_HEADING;
      staleGroup = document.createElement("div"); staleGroup.className = "ws-stale-group";
      staleGroup.setAttribute("role", "group"); staleGroup.setAttribute("aria-labelledby", heading.id);
      suggestionsEl.append(heading, staleGroup);
    }
    for (const candidate of staleVisible) {
      const { id, name, button, copy } = entry(candidate);
      const sentence = LISTED_STATE_TEXT[candidate.state];
      button.classList.add("ws-suggestion-stale");
      button.dataset.listedState = candidate.state;
      button.setAttribute("aria-disabled", "true");
      button.title = `${id}\n${sentence}`;
      const word = document.createElement("span");
      word.className = "ws-suggestion-reason ws-listed-state"; word.setAttribute("aria-hidden", "true");
      word.textContent = LISTED_STATE_WORD[candidate.state];
      const said = document.createElement("span"); said.className = "sr-only"; said.textContent = `, ${sentence}`;
      copy.append(word, said);
      const row = document.createElement("div"); row.className = "ws-suggestion-row";
      row.append(button);
      if (removeListed && candidate.removable) {
        button.setAttribute("aria-describedby", removeHint.id);
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "ws-remove-listed"; remove.tabIndex = -1;
        remove.dataset.workspacePath = id; remove.textContent = "Remove"; remove.disabled = adding;
        remove.setAttribute("aria-label", `Remove ${name} from this computer's list`);
        remove.dataset.title = `Remove ${name} from this computer's list. Nothing on disk changes.`;
        remove.title = remove.dataset.title;
        remove.addEventListener("click", () => { if (!adding && !cliHeldBack(HELD_WRITES[".ws-remove-listed"])) void runRemove(id, name); });
        row.append(remove);
      }
      staleGroup.append(row);
    }
    if (focusId) {
      [...suggestionsEl.querySelectorAll(".ws-suggestion")]
        .find((button) => button.dataset.workspaceId === focusId)?.focus();
    }
    if (!all.length && !status.textContent) setStatus("No matching OATS workspaces found.");
    applyHolds();
  };

  const paintDiscoveryState = () => {
    setStatus(discoveryState.message, discoveryState.error);
    renderSuggestions();
  };

  const clearPick = () => { pickOffer = null; pickEl.hidden = true; pickEl.replaceChildren(); };
  const renderPick = (result) => {
    pickEl.replaceChildren();
    pickOffer = result?.onboard?.token ? { token: result.onboard.token, path: result.onboard.path } : null;
    if (typeof result?.path === "string" && result.path) {
      const picked = document.createElement("p"); picked.className = "ws-pick-path"; picked.textContent = `Chosen: ${result.path}`;
      pickEl.append(picked);
    }
    const choices = Array.isArray(result?.choices) ? result.choices.filter((c) => typeof c?.path === "string" && c.path) : [];
    if (choices.length) {
      const list = document.createElement("div"); list.className = "ws-pick-choices";
      list.setAttribute("role", "group"); list.setAttribute("aria-label", "OATS deployments to add instead");
      for (const choice of choices) {
        const button = document.createElement("button"); button.type = "button"; button.className = "ws-pick-choice secondary";
        button.dataset.workspacePath = choice.path; button.disabled = adding; button.title = choice.path;
        if (choice.kind === "ancestor") button.textContent = `Add ${choice.path} (the deployment this folder is inside)`;
        else {
          const name = document.createElement("span"); name.className = "ws-pick-name"; name.textContent = `Add ${choice.name || choice.path}`;
          const path = document.createElement("span"); path.className = "ws-pick-meta"; path.textContent = choice.path;
          button.append(name, path);
        }
        button.addEventListener("click", () => { void runAdd(choice.path, choice.name || choice.path, button); });
        list.append(button);
      }
      pickEl.append(list);
    }
    const notes = [];
    if (result?.more > 0) notes.push(`and ${result.more} more`);
    if (result?.limited) notes.push(Number.isInteger(result.scanLimit) ? `Only the first ${result.scanLimit} entries of this folder were checked` : "Only the first entries of this folder were checked");
    if (notes.length) { const more = document.createElement("p"); more.className = "ws-pick-more"; more.textContent = `${notes.join(". ")}.`; pickEl.append(more); }
    if (pickOffer && typeof onboardWorkspace === "function") {
      const setup = document.createElement("button"); setup.type = "button"; setup.className = "ws-pick-setup secondary";
      setup.textContent = "Set up a new deployment here…"; setup.disabled = adding; setup.dataset.title = "";
      setup.addEventListener("click", () => {
        if (adding || !pickOffer || cliHeldBack(HELD_WRITES[".ws-pick-setup"])) return;
        const offer = pickOffer; clearPick(); setStatus(""); enterOnboarding(offer);
      });
      pickEl.append(setup);
    }
    pickEl.hidden = !pickEl.childElementCount;
    applyHolds();
  };
  const setAdding = (value) => {
    adding = value;
    dialog.setAttribute("aria-busy", String(value));
    browse.disabled = value;
    cancel.disabled = value;
    closeButton.disabled = value;
    modalSearch.disabled = value;
    refInput.disabled = value;
    for (const button of suggestionsEl.querySelectorAll("button")) button.disabled = value;
    for (const button of pickEl.querySelectorAll("button")) button.disabled = value;
    applyHolds();
    confirm.disabled = value || !refInput.value.trim();
    if (value) status.focus();
  };
  // The dialog's confirm is Onboard's alone: a found deployment adds on its own click.
  const enterOnboarding = (offer) => {
    onboarding = { token: offer.token, path: offer.path };
    title.textContent = "Onboard workspace";
    intro.textContent = "This folder has no oats-local.yaml yet. Name the workspace repository to realize here.";
    onboardPath.textContent = offer.path;
    modalSearch.hidden = true; suggestionsEl.hidden = true; onboardEl.hidden = false;
    confirm.hidden = false;
    confirm.disabled = !refInput.value.trim();
    refInput.focus();
  };
  const leaveOnboarding = () => {
    onboarding = null;
    title.textContent = defaults.title; intro.textContent = defaults.intro;
    modalSearch.hidden = false; suggestionsEl.hidden = false; onboardEl.hidden = true;
    confirm.hidden = true;
    refInput.value = "";
  };
  const closeModal = (restore = true) => {
    if (adding) return false;
    leaveOnboarding(); clearPick();
    modalGeneration++;
    discoveryGeneration++;
    modal.hidden = true;
    confirm.disabled = true;
    const back = returnTo;
    returnTo = null;
    if (restore) (back?.isConnected ? back : addOpen.isConnected ? addOpen : focusTarget())?.focus();
    return true;
  };
  /** Open the Add dialog; `opener` (the header's button, the chooser's) gets focus back when it closes. */
  const openModal = async (opener = null) => {
    if (adding) return;
    returnTo = opener && typeof opener.focus === "function" ? opener : addOpen;
    modalGeneration++;
    const discoveryToken = ++discoveryGeneration;
    modal.hidden = false;
    modalSearch.value = "";
    leaveOnboarding(); clearPick();
    suggestions = []; stale = [];
    suggestionStop = "";
    discoveryState = { message: "Finding OATS workspaces…", error: false };
    setAdding(false);
    paintDiscoveryState();
    modalSearch.focus();
    try {
      const result = await discoverSuggestions();
      if (discoveryToken !== discoveryGeneration || modal.hidden) return;
      if (result?.stale) {
        discoveryState = { message: "No current workspace suggestions.", error: false };
      } else {
        const found = Array.isArray(result) ? result : (result?.suggestions || []);
        // A deployment a view already holds is not offered (#482): views name their deployments.
        const added = new Set(workspaces.flatMap((workspace) => [workspace.id, ...(Array.isArray(workspace.deployments) ? workspace.deployments : [])]));
        // What can be opened is offered; a row of this computer's list that is missing, not a deployment any more
        // or unreadable is listed after them, to remove (#1390). Any other state is neither.
        const offered = found.filter((candidate) => candidateId(candidate) && !added.has(candidateId(candidate)));
        suggestions = offered.filter((candidate) => candidate.state === undefined || candidate.state === "ok");
        stale = offered.filter((candidate) => Object.hasOwn(LISTED_STATE_TEXT, candidate.state));
        // Without the list (an older oats, a refused read) what is found is the saved deployments alone: said so.
        const note = result?.list?.state === "unsupported" ? LIST_UNSUPPORTED_TEXT
          : result?.list?.state === "failed" ? listFailedText(result.list.message || "the installed OATS CLI could not read it.") : "";
        const foundText = addableText(suggestions.length);
        discoveryState = { message: note ? `${foundText.replace(/\.?$/, ".")} ${note}` : foundText, error: false };
      }
      if (!adding) paintDiscoveryState();
    } catch (error) {
      if (discoveryToken !== discoveryGeneration || modal.hidden) return;
      discoveryState = { message: error?.message || "Could not discover OATS workspaces.", error: true };
      if (!adding) paintDiscoveryState();
    }
  };

  const reconcileAddedWorkspace = (workspace) => {
    const list = [...workspaces.filter((candidate) => candidate.id !== workspace.id), workspace];
    render(workspace, list);
    closeModal(false);
    pick(candidateId(workspace));
    // Focus on the added workspace's row, which becomes the list's tab stop, whatever row was it before.
    stopKey = candidateId(workspace);
    focusTarget()?.focus();
  };
  const resolvedMutation = (result) => {
    if (result?.ok && result.workspace) { reconcileAddedWorkspace(result.workspace); return true; }
    if (result?.code === "superseded") { setStatus(""); return true; }
    return false;
  };
  const mutationFailureMessage = (result, fallback) => result?.code === "not-suggested"
    ? `${result.reason || "That workspace is no longer suggested."} Use Browse… to choose it explicitly.`
    : result?.reason || fallback;
  const onBrowse = async () => {
    if (adding) return;
    const token = ++modalGeneration;
    clearPick();
    setAdding(true);
    setStatus("Choose an OATS workspace folder…");
    try {
      const result = await pickWorkspace();
      if (token !== modalGeneration) return;
      setAdding(false);
      if (result?.code === "cancelled") { paintDiscoveryState(); browse.focus(); return; }
      if (resolvedMutation(result)) return;
      discoveryGeneration++;
      setStatus(mutationFailureMessage(result, "Could not use that folder."), true);
      // Nothing changed: the refusal says what was expected and, below it, where the deployment is.
      if (result?.code === "not-a-workspace") renderPick(result);
      (pickEl.querySelector("button") || browse).focus();
    } catch (error) {
      if (token !== modalGeneration) return;
      setAdding(false);
      discoveryGeneration++;
      setStatus(error?.message || "Could not use that folder.", true);
      browse.focus();
    }
  };
  const onOnboard = async () => {
    const ref = refInput.value.trim();
    if (!onboarding || adding || !ref) return;
    const token = ++modalGeneration, offer = onboarding;
    setAdding(true);
    setStatus(`Onboarding ${offer.path}… reading the workspace over Git.`);
    try {
      const result = await onboardWorkspace(offer.token, ref);
      if (token !== modalGeneration) return;
      setAdding(false);
      if (result?.ok) {
        const added = result.added;
        if (added?.ok && added.workspace) { reconcileAddedWorkspace(added.workspace); onboarded?.(result); return; }
        // The deployment exists now; only its registration failed.
        onboarding = null;
        setStatus(`Onboarded ${offer.path}, but it could not be added: ${added?.reason || "unknown error"}. Use Browse… to add it.`, true);
        leaveOnboarding(); browse.focus(); return;
      }
      if (result?.retry) onboarding = { token: result.retry, path: offer.path };
      else if (result?.code !== "bad-ref" && result?.code !== "busy") onboarding = null;
      const note = result?.rolledBack ? " Nothing was left in the folder." : "";
      setStatus(`${result?.code ? `${result.code}: ` : ""}${result?.reason || "Could not onboard that folder."}${note}`, true);
      if (onboarding) refInput.focus(); else { leaveOnboarding(); browse.focus(); }
    } catch (error) {
      if (token !== modalGeneration) return;
      setAdding(false);
      onboarding = null; leaveOnboarding();
      setStatus(error?.message || "Could not onboard that folder.", true);
      browse.focus();
    }
  };
  // Every add from the dialog (a suggestion, a deployment offered beside a refused pick) is the
  // same main-validated add; `returnFocus` gets focus back when it fails.
  const runAdd = async (path, name, returnFocus) => {
    if (adding) return;
    const token = ++modalGeneration;
    setAdding(true);
    setStatus(`Adding ${name}…`);
    const failed = (message) => {
      setAdding(false);
      setStatus(message, true);
      (returnFocus?.isConnected ? returnFocus : [...suggestionsEl.querySelectorAll(".ws-suggestion")].find((button) => button.dataset.workspaceId === path) || browse).focus();
    };
    try {
      const result = await addWorkspace(path);
      if (token !== modalGeneration) return;
      setAdding(false);
      if (resolvedMutation(result)) return;
      failed(mutationFailureMessage(result, "Could not add that workspace."));
    } catch (error) {
      if (token !== modalGeneration) return;
      failed(error?.message || "Could not add that workspace.");
    }
  };

  /** Remove one row of this computer's list (#1390). It touches nothing on disk, so it asks nothing; the dialog
   * says what happened. Focus goes to the next row's place, else the first, else the filter; a failure keeps
   * it on that Remove. */
  const runRemove = async (path, name) => {
    if (adding) return;
    const token = ++modalGeneration;
    const rows = [...suggestionsEl.querySelectorAll(".ws-suggestion")];
    const at = rows.findIndex((button) => button.dataset.workspaceId === path);
    const after = rows[at + 1]?.dataset.workspaceId || rows[at - 1]?.dataset.workspaceId || "";
    setAdding(true);
    setStatus(`Removing ${name}…`);
    let result;
    try { result = await removeListed(path); }
    catch (error) { result = { ok: false, reason: error?.message || "Could not remove it from this computer's list." }; }
    if (token !== modalGeneration) return;
    setAdding(false);
    if (result?.ok) {
      stale = stale.filter((candidate) => candidateId(candidate) !== path);
      setStatus(`Removed ${name} from this computer's list.`);
      suggestionStop = after;
      renderSuggestions(after);
      if (!suggestionsEl.contains(document.activeElement)) modalSearch.focus();
      return;
    }
    setStatus(result?.reason || "Could not remove it from this computer's list.", true);
    renderSuggestions();
    ([...suggestionsEl.querySelectorAll(".ws-remove-listed")].find((button) => button.dataset.workspacePath === path) || modalSearch).focus();
  };

  const render = (workspace, list = []) => {
    activeId = workspace?.id || "";
    if (activeId && activeId === pickedId) pickedId = ""; // the pick has landed
    if (workspace) choosing = false; // a window showing a workspace is not choosing one
    workspaces = Array.isArray(list) ? [...list] : [];
    if (workspace && !workspaces.some((candidate) => candidate.id === activeId)) workspaces.unshift(workspace);
    const labels = rowNames(workspaces);
    const activeIndex = workspaces.findIndex((candidate) => candidate.id === activeId);
    // A window with no workspace (#481) asks for one; otherwise, before the first answer, it is resolving.
    const current = workspace ? (labels[activeIndex] || candidateName(workspace)) : choosing ? "none chosen yet" : "resolving";
    section.setAttribute("aria-description", `Current workspace: ${current}`);
    renderOptions();
  };

  const onListKey = (event) => {
    const focusedOption = event.target?.classList?.contains("ws-option") ? event.target : null;
    // Open in new window (#481): ⌘Enter (macOS) / Ctrl+Enter on a row.
    if (openInNewWindow && focusedOption?.dataset.workspaceId && event.key === "Enter" && !event.shiftKey && !event.altKey
      && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) {
      event.preventDefault(); openInWindow(focusedOption.dataset.workspaceId); return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = menuItems();
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
    items[next].focus();
  };
  const onRowMenuKey = (event) => {
    if (event.key === "Tab") { closeRowMenu(true); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRowMenu(true); return; }
    // One item: the arrows stay on it, and never reach the list behind the menu.
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); openItem.focus(); }
  };
  const onSuggestionKey = (event) => {
    if (adding) return;
    // A row's Remove (#1390): Right Arrow from the row reaches it; Left Arrow or Esc go back to the row.
    const remove = event.target.closest?.(".ws-remove-listed");
    const rowOfRemove = remove?.parentElement?.querySelector(":scope > .ws-suggestion");
    if (remove && ["ArrowLeft", "Escape"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); rowOfRemove?.focus(); return; }
    if (event.key === "ArrowRight" && event.target.classList?.contains("ws-suggestion")) {
      const beside = event.target.parentElement.querySelector(":scope > .ws-remove-listed");
      if (beside) { event.preventDefault(); beside.focus(); }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const target = remove ? rowOfRemove : event.target.closest?.(".ws-suggestion");
    if (!target) return;
    event.preventDefault();
    const items = [...suggestionsEl.querySelectorAll(".ws-suggestion")];
    const index = items.indexOf(target);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length;
    items[next].focus();
  };
  const onDialogKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeModal(); return; }
    if (adding && event.key === "Tab") { event.preventDefault(); status.focus(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled])")]
      .filter((element) => !element.hidden && element.tabIndex >= 0);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  options.addEventListener("keydown", onListKey);
  options.addEventListener("scroll", () => noteMore());
  // A row's context menu (a right-click, Shift+F10, the Menu key): the page's own, never the native one.
  options.addEventListener("contextmenu", (event) => {
    const button = event.target?.closest?.(".ws-option");
    if (!openInNewWindow || !button || !options.contains(button)) return;
    event.preventDefault();
    const at = { clientX: event.clientX, clientY: event.clientY };
    whenRightButtonReleased(event, () => { if (button.isConnected) openRowMenu(button, at); });
  });
  rowMenu.addEventListener("keydown", onRowMenuKey);
  // A light dismiss (a click outside, the window losing focus) closes it too: no row is its own any more.
  rowMenu.addEventListener("toggle", (event) => { if (event.newState === "closed") menuFor = ""; });
  openItem.addEventListener("click", () => {
    const key = menuFor;
    closeRowMenu(true);
    if (key && rowOf(key)) openInWindow(key);
  });
  // The list's height changes with the window and the sidebar: what is cut off is measured again.
  const resized = typeof (document.defaultView ?? globalThis).ResizeObserver === "function"
    ? new (document.defaultView ?? globalThis).ResizeObserver(() => noteMore()) : null;
  resized?.observe(options);
  // The tab stop follows the row last focused (the roster's roving pattern).
  options.addEventListener("focusin", (event) => {
    const button = event.target?.closest?.(".ws-option");
    if (!button || !options.contains(button)) return;
    stopKey = rowKey(button);
    for (const each of menuItems()) each.tabIndex = each === button ? 0 : -1;
  });
  suggestionsEl.addEventListener("focusin", (event) => {
    const button = event.target?.closest?.(".ws-suggestion");
    if (!button) return;
    suggestionStop = button.dataset.workspaceId;
    for (const each of suggestionsEl.querySelectorAll(".ws-suggestion")) each.tabIndex = each === button ? 0 : -1;
  });
  addOpen.addEventListener("click", () => { void openModal(addOpen); });
  modalSearch.addEventListener("input", () => renderSuggestions());
  refInput.addEventListener("input", () => { if (!adding) confirm.disabled = !refInput.value.trim(); });
  refInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void onOnboard(); } });
  suggestionsEl.addEventListener("keydown", onSuggestionKey);
  browse.addEventListener("click", onBrowse);
  confirm.addEventListener("click", () => { void onOnboard(); });
  cancel.addEventListener("click", () => closeModal());
  closeButton.addEventListener("click", () => closeModal());
  modal.addEventListener("mousedown", (event) => { if (event.target === modal) closeModal(); });
  dialog.addEventListener("keydown", onDialogKey);

  confirm.hidden = true;
  render(null);
  /** Show only the current workspace, or every one; remembered on this computer. Focus on a row that goes moves to
   * the current row. */
  const setCurrentOnly = (on) => {
    currentOnly = !!on;
    try { if (currentOnly) storage?.setItem(CURRENT_ONLY_KEY, "1"); else storage?.removeItem(CURRENT_ONLY_KEY); } catch { /* not remembered */ }
    currentOnlyButton?.setAttribute("aria-pressed", String(currentOnly));
    renderOptions();
  };
  currentOnlyButton?.addEventListener("click", () => setCurrentOnly(!currentOnly));

  return {
    /** The "Show only the current workspace" toggle (workspaces.currentOnly). */
    toggleCurrentOnly() { setCurrentOnly(!currentOnly); },
    get currentOnly() { return currentOnly; },
    begin() {
      const token = ++generation;
      return (workspace, list) => {
        if (token !== generation) return false;
        answered = true;
        render(workspace, list);
        return true;
      };
    },
    /** A switch landed here (shell.mjs restoreWorkspaceTabs): an older roster answer may not paint any more, and
     * `current` (the workspace now selected) is marked current at once. The rows stay: the list never empties
     * while the new workspace's roster is read, or when that read fails. */
    reset(current = "") {
      generation++;
      choosing = false;
      if (pickedId === current) pickedId = "";
      const known = workspaces.find((candidate) => candidate.id === current) ?? null;
      render(known, workspaces);
      if (!known && current) { activeId = current; renderOptions(); }
    },
    /** This window has no workspace (#481): the served choices main gave it, none current. Called again
     * as main serves more (#521), it repaints the list in place. */
    choose(list) { generation++; choosing = true; answered = true; render(null, list); },
    /** Focus the list's current row, else its tab stop (the `w` key, the leader's `o`, app.workspaces). */
    focusList() { const target = rowOf(activeId) || focusTarget(); target?.focus(); revealInScrollport(options, target); noteMore(); return !!target; },
    /** The leader's ↑/↓ (`step` -1 / 1): select the previous / next row, as a click does (a row another window
     * shows is taken over), going on from the other end past the last / first; `how` goes to selectWorkspace.
     * False when no other row can be shown. */
    step(delta, how) {
      // From the pick still on its way, else the current row: presses faster than a switch make as many moves.
      const from = pickedId || activeId || null;
      const key = workspaceStep(drawn.map(({ key, openable }) => ({ key, openable })), from, delta, { wrap: true });
      const row = key === null || key === from ? null : drawn.find((entry) => entry.key === key);
      if (!row) return false;
      row.open(how);
      return true;
    },
    /** Open the Add dialog (the chooser's button, a window with nothing to show); `opener` gets focus back. */
    openModal,
    dispose() {
      offCli();
      resized?.disconnect();
      closeRowMenu(false);
    },
  };
}
