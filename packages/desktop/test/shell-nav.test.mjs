// Shell navigation reachability + Instances-stage ABSENCE pins.
//
// History: PR #29 shipped a first-class "Instances" nav stage
// (views/instances.mjs). The human rejected that surface as scope overreach
// — the instances context is the shell's PERMANENT sidebar roster, not a
// rail destination. This suite pins both directions:
//   - every remaining NAV entry resolves to a real mount-exporting module
//     (the manifest lesson from the original reachability regression), and
//   - the Instances stage stays gone (inventory-style absence pin, so a
//     stray revert/cherry-pick cannot silently reship it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { NAV, NAV_TABS, PINNED, pinnedRowFor, navTab, stageSidebarMode, loadStageView } from "../renderer/shell-nav.mjs";
import { shellIcon } from "../renderer/shell-icons.mjs";
import { workspaceTabs } from "../renderer/workspace-discovery.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const shellSource = () => readFileSync(join(PKG, "renderer", "shell.mjs"), "utf8");

// The sidebar's pages (the Desktop UI rework, slice 2; before it, the product owner, 2026-10-26): Home, the
// Workspace page (Workspace overview, no row of its own: Home opens it) and Automations (Schedules | Triggers);
// Deployments became the Workspace page's Machines tab. The pinned rows: Home, then Automations.
test("NAV is exactly Home, Workspace overview and Automations, in that order; Home and Automations are pinned", () => {
  assert.deepEqual(NAV.map((v) => v.name), ["home", "spawn", "automations"],
    "page destinations are Home, Workspace and Automations; Machines (formerly Deployments, formerly Active overview) is a tab of Workspace");
  assert.deepEqual(NAV.map((v) => v.label), ["Home", "Workspace overview", "Automations"],
    "Knowledge/Tasks remain deferred; Workspace keeps the internal spawn route");
  for (const v of NAV) {
    assert.ok(v.label && v.icon && v.title, `${v.name} entry carries full rail chrome`);
  }
  assert.deepEqual(NAV.map((v) => v.title), ["Home", "Workspace overview", "Automations"]);
  assert.deepEqual(PINNED.map((v) => v.name), ["home", "automations"]);
  assert.equal(pinnedRowFor("spawn"), "home");
});

// A destination that is a tab of a page keeps its name (stage.hierarchy, ⌘1 / Ctrl+1) and says which page and tab
// it opens: "View: Workspace › Machines" in the palette and the shortcuts editor.
test("NAV_TABS maps hierarchy to the Workspace page's Machines tab; navTab() finds it, and nothing else", () => {
  assert.deepEqual(NAV_TABS, [{ name: "hierarchy", label: "Workspace › Machines", page: "spawn", tab: "machines" }]);
  assert.equal(navTab("hierarchy"), NAV_TABS[0]);
  for (const name of ["automations", "spawn", "machines", "souls", "capabilities", undefined, null, ""]) assert.equal(navTab(name), null, String(name));
  for (const entry of NAV_TABS) {
    assert.ok(NAV.some((v) => v.name === entry.page), `${entry.name}: its page is a NAV page`);
    assert.ok(!NAV.some((v) => v.name === entry.name), `${entry.name}: not a page of its own as well`);
    assert.ok(workspaceTabs.includes(entry.tab), `${entry.name}: a tab the Workspace page has`);
    // Its label names its page, by the page's own name: "Workspace › Machines" for the nav's "Workspace overview".
    const [page, tab] = entry.label.split(" › ");
    assert.ok(tab && NAV.find((v) => v.name === entry.page).label.startsWith(page), `${entry.name}: its label names its page`);
  }
  assert.deepEqual(workspaceTabs, ["souls", "capabilities", "teams", "machines", "sources"], "Souls, Capabilities, Teams, Machines, Setup: no Automations tab");
  assert.equal(workspaceTabs.indexOf("machines"), 3, "Machines before Setup; the page opens on Souls, its first tab");
});

test("every NAV destination loads a real mount-exporting view module", async () => {
  for (const v of NAV) {
    const mod = await loadStageView(v.name);
    assert.equal(typeof mod.mount, "function", `${v.name} view exports mount`);
    assert.equal(typeof mod.unmount, "function", `${v.name} view exports unmount`);
  }
});

test("stage sidebar pairing: spawn shows souls, others keep the overview tree", () => {
  assert.equal(stageSidebarMode("spawn"), "souls");
  assert.equal(stageSidebarMode("hierarchy"), "overview");
  assert.equal(stageSidebarMode("automations"), "overview");
  assert.equal(stageSidebarMode(undefined), "overview", "no-stage fallback stays overview");
});

test("shell.mjs consumes the manifest: rail built from shell-nav NAV, openView routes to showStage", () => {
  const src = shellSource();
  assert.match(src, /import\s*\{[^}]*\bNAV\b[^}]*\}\s*from\s*"\.\/shell-nav\.mjs"/,
    "shell imports NAV from shell-nav.mjs");
  assert.ok(!/const NAV\s*=/.test(src), "no shadowing local NAV manifest");
  assert.match(src, /openView:\s*\(name\)\s*=>\s*showStage\(name\)/,
    "openView routes every named view through the stage host");
});

test("palette view commands derive from NAV and NAV_TABS — no hard-coded destination list to drift", () => {
  const src = shellSource();
  assert.match(src, /\.\.\.\[\.\.\.NAV, \.\.\.NAV_TABS\]\.map\(\(v\) => \(\{ label: `View: \$\{v\.label\}`,.*run: \(\) => showStageFocused\(v\.name\) \}\)\)/,
    "palette view commands (View: Workspace › Machines among them) are generated from the manifests");
  assert.ok(!/label:\s*"View: /.test(src), "no hard-coded View: palette entries remain");
});

// The stage actions too: stage.hierarchy (⌘1 / Ctrl+1) still exists, from NAV_TABS, and stage.automations (⌘3 / Ctrl+3) from NAV.
test("shell.mjs registers stage.<name> for every NAV page and NAV_TABS entry, each running showStageFocused", () => {
  assert.match(shellSource(), /\[\.\.\.NAV, \.\.\.NAV_TABS\]\.forEach\(\(v\) => registerAction\(\{\n  id: `stage\.\$\{v\.name\}`, label: `View: \$\{v\.label\}`, context: "global",\n  run: \(\) => showStageFocused\(v\.name\),\n\}\)\);/);
});

// showStage is where every open of a name goes (the actions, the palette, ctx.openView): a NAV_TABS name
// opens its page on its tab (openWorkspaceSouls) before anything of a page switch runs.
// test/navigation-projection.test.mjs runs the shipped showStage / showStageFocused for it.
test("showStage routes a NAV_TABS name to openWorkspaceSouls(tab); showStageFocused compares against the page", () => {
  const src = shellSource();
  assert.match(src, /import \{ NAV, NAV_TABS, PINNED, pinnedRowFor, navTab, stageSidebarMode, loadStageView \} from "\.\/shell-nav\.mjs";/);
  const showStage = src.match(/async function showStage\(name\) \{[^]*?\n\}/)[0];
  const route = showStage.indexOf("const asTab = navTab(name);\n  if (asTab) return openWorkspaceSouls(asTab.tab);");
  assert.ok(route > 0, "showStage asks navTab first");
  assert.ok(route < showStage.indexOf("const v = NAV.find") && route > showStage.indexOf('windowState() === "choosing"'),
    "after the no-workspace guard, before a page tab opens (slice 6a: pages are tabs)");
  const focused = src.match(/async function showStageFocused\(name\) \{[^]*?\n\}/)[0];
  assert.match(focused, /page = navTab\(name\)\?\.page \?\? name;/);
  assert.match(focused, /if \(currentPage\(\) !== page\) return;/, "it compares the shown page tab with the page");
  // openWorkspaceSouls names each tab it can open (its failure notice) and awaits the page.
  const open = src.match(/async function openWorkspaceSouls\(tab = "souls", options = undefined\) \{[^]*?\n\}/)[0];
  // Home's Machines and Graph rows name the Machines tab's view (slice 3b's option; an older page ignores it).
  assert.match(open, /mod\.preselectWorkspaceTab\(tab, options\);\n  await showStage\("spawn"\);/);
  // Quick Open's return (surface-return.mjs) knows the Workspace tab it left and goes back to it, through the
  // mounted view's own module: never a tab the page can't show (its control only once it shows).
  // (Slice 6a: the Workspace page is a page tab: its module is the tab's, pageModule("spawn").)
  assert.match(src, /workspaceTab: currentPage\(\) === "spawn" \? pageModule\("spawn"\)\?\.currentWorkspaceTab\?\.\(\) \?\? null : null/);
  assert.match(src, /selectWorkspaceTab: name => currentPage\(\) === "spawn" && pageModule\("spawn"\)\?\.preselectWorkspaceTab\?\.\(name\)\s*&& pageModule\("spawn"\)\.currentWorkspaceTab\?\.\(\) === name \? document\.getElementById\(`workspace-tab-\$\{name\}`\) : null/);
  assert.match(src, /record\.page = name; record\.mod = mod;/, "a page tab keeps its page and module");
  assert.match(src, /const WORKSPACE_TAB_NAMES = \{ machines: "Machines", souls: "Souls", capabilities: "Capabilities" \};/);
});

// The nav sits under the list of workspaces, outside the foot; the foot's bar's controls (New agent and ?, slice 1;
// "N need you" is sidebar-foot.mjs's) are wired by one loop over the foot's [data-action], which never reaches the nav,
// so a nav button runs its action once (its own listener), not twice. The shipped nav build and that wiring, run on
// the shipped index.html.
test("a nav button runs its stage action once; New agent and ? run their own once; the nav is under the list", () => {
  const src = shellSource();
  const block = src.slice(src.indexOf('const navEl = document.getElementById("nav");'), src.indexOf("// This is a chooser entry"));
  assert.match(block, /for \(const button of document\.querySelectorAll\("#nav-foot \[data-action\]"\)\) \{\n  button\.addEventListener\("click", \(\) => runAction\(button\.dataset\.action\)\);\n\}/);
  assert.doesNotMatch(src, /createSettingsMenu|sidebar-settings/, "the settings cog is gone (slice 1)");
  assert.ok(!src.includes("#sidebar-tools"), "the tools row is gone");
  const dom = new JSDOM(readFileSync(join(PKG, "renderer", "index.html"), "utf8"));
  const document = dom.window.document, ran = [];
  runInNewContext(block, { document, NAV, PINNED, shellIcon, runAction: (id) => ran.push(id),
    getBinding: () => null, formatChord: String, isMac: false });
  const nav = document.getElementById("nav");
  assert.equal(nav.parentElement.id, "sidebar", "the nav is the sidebar's own child");
  assert.equal(nav.previousElementSibling, document.getElementById("ws-list"), "the nav sits under the list of workspaces");
  assert.equal(nav.nextElementSibling, document.getElementById("instance-roster"), "then the instances");
  assert.equal(document.getElementById("nav-foot").contains(nav), false, "not in the foot");
  const buttons = [...nav.querySelectorAll("button")];
  assert.deepEqual(buttons.map((b) => [b.dataset.view, b.dataset.action, b.querySelector(".label").textContent, b.title]),
    [["home", "stage.home", "Home", "Home"], ["automations", "stage.automations", "Automations", "Automations"]]);
  for (const b of buttons) {
    ran.length = 0; b.click();
    assert.deepEqual(ran, [b.dataset.action], `${b.dataset.view}: one run per click`);
  }
  // The foot's actions, in the bar's order (slice 1): New agent (Quick Open), then ? (Keyboard shortcuts).
  const foot = [...document.querySelectorAll("#nav-foot [data-action]")];
  assert.deepEqual(foot.map((b) => [b.id, b.dataset.action]), [["sidebar-spawn", "app.quickOpenSouls"], ["sidebar-help", "app.shortcuts"]]);
  for (const b of foot) {
    for (let click = 1; click <= 2; click++) {
      ran.length = 0; b.click();
      assert.deepEqual(ran, [b.dataset.action], `${b.id}, click ${click}: one run`);
    }
  }
  dom.window.close();
});

test("inventory: the Instances stage view is gone and nothing references it", () => {
  assert.ok(!existsSync(join(PKG, "renderer", "views", "instances.mjs")),
    "views/instances.mjs must not ship");
  for (const f of ["renderer/shell.mjs", "renderer/shell-nav.mjs", "renderer/harness.html"]) {
    const src = readFileSync(join(PKG, f), "utf8");
    assert.ok(!/views\/instances\.mjs/.test(src), `${f}: imports the deleted Instances view`);
    assert.ok(!/data-view="instances"/.test(src), `${f}: dormant Instances tab entry`);
  }
});

// The landing surface (the Desktop UI rework, slice 2; before it, the Workspace page, 2026-10-23): Home, when no
// instance is open: at start, after choosing a workspace, and as the nav's fallback when the last terminal closes or
// a workspace switch restores no stage.
test("the landing surface is Home: at start, after a choice, and as the nav's fallback", async () => {
  const src = shellSource();
  const topLevel = src.match(/^showStage\("[a-z]+"\);$/gm);
  assert.deepEqual(topLevel, ['showStage("home");'], "the shell's one start-up stage is Home");
  assert.ok(src.lastIndexOf('showStage("home");') > src.indexOf("// The landing surface:"), "under its comment");
  assert.doesNotMatch(src, /showStage\("hierarchy"\)/, "Machines is never shown as a page of its own");
  // Slice 6a: no stage behind the tabs. The last terminal closing with no other tab shows the empty state (Open Home),
  // and a workspace switch that restores no tab reopens its page tabs, or lands on Home.
  const terminal = src.match(/function showTerminalContext\(\) \{[^]*?\n\}/)[0];
  assert.match(terminal, /if \(typeof showEmptyState === "function"\) showEmptyState\(\);/, "the last tab closing: the empty state, its Open Home");
  assert.match(src, /if \(!pages\?\.length\) \{\n    if \(still\(\) && !\[\.\.\.tabs\.values\(\)\]\.some\(\(t\) => canActivateTab\(t, ws\)\)\) await showStage\("home"\);/,
    "a workspace with no tab lands on Home");
  // After a choice (or an adoption) the window leaves the chooser for the home surface: run the shipped handler.
  const handler = src.match(/^onWindowState\(\(state\) => \{[^]*?\n\}\);$/m)?.[0];
  assert.ok(handler, "exercise the shipped onWindowState handler");
  const shown = [], roster = { hidden: true };
  let callback;
  runInNewContext(handler, { onWindowState: (fn) => { callback = fn; }, contextRosterEl: roster,
    showChooser: async () => shown.push("chooser"), showStage: async (name) => shown.push(name) });
  callback("choosing");
  assert.deepEqual(shown, ["chooser"]);
  roster.hidden = true; callback("bound");
  assert.deepEqual(shown, ["chooser", "home"], "bound again: Home");
  assert.equal(roster.hidden, false, "and the roster comes back");
  callback("bound");
  assert.deepEqual(shown, ["chooser", "home"], "already bound: the shown stage is kept");
});
