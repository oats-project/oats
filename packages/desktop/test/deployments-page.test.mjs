// The Deployments view (UI spec, #482; it replaces the Active overview; the Workspace page's Machines tab since
// 2026-10-26, views/spawn.mjs mounts it there, workspace-v2-view.test.mjs pins that side): its tabs (All, then one per
// deployment), All as the overview canvas split into one section per deployment, and a deployment's tab
// showing only that deployment's tree, or why it has none. DOM and computed-token checks in jsdom; no
// Electron, HTTP or CLI. (The first tests moved here from workspace-views-ui.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import * as hierarchy from "../renderer/views/hierarchy.mjs";
import { currentWorkspace, setWorkspace } from "../renderer/views/common.mjs";
import { requestDeploymentTab, rememberDeploymentTab, rememberedDeploymentTab } from "../renderer/deployment-tabs.mjs";
import { createDeploymentTabBar, deploymentHead } from "../renderer/deployments-page.mjs";

const theme = readFileSync(new URL("../renderer/theme.css", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const later = () => new Promise((resolve) => setTimeout(resolve, 0));
const ORIGINAL = { window: globalThis.window, document: globalThis.document, setInterval: globalThis.setInterval, ws: currentWorkspace() };

const LOCAL = { id: "/Users/op/Agents/oats", machine: "This Mac", path: "/Users/op/Agents/oats", label: "~/Agents/oats", local: true,
  reachable: true, identityFrom: "reported", primary: true };
const DEVBOX = { id: "remote:devbox:5d1e0c9b8a7f", machine: "devbox", path: "/home/op/Agents/web", label: "~/Agents/web", local: false,
  reachable: false, identityFrom: "remembered", primary: false, reason: "devbox timed out; it is tried again on the next read.",
  short: "timed out", note: "devbox now reports workspace web." };
const LAPTOP = { id: "remote:laptop:9f2c1a7b3e4d", machine: "laptop", path: "/home/op/Agents/lab", label: "~/Agents/lab", local: false,
  reachable: false, identityFrom: null, primary: false, reason: "ssh to laptop asks for a password, and Desktop never answers a prompt.",
  short: "ssh needs a prompt", fix: ["Run `ssh laptop` once in a terminal and answer its prompt (a host key or a password).", "Desktop tries again on its next read."] };
const tag = (d) => ({ id: d.id, machine: d.machine, path: d.path });
const row = (name, d, fields = {}) => ({ instance: name, agent: "soul", agentsRoot: `${d.path}/agents`, home: `${d.path}/agents/soul/instances/${name}`,
  repoName: "repo", running: true, deployment: tag(d), ...(d.local ? {} : { server: d.machine, addressable: true }), ...fields });
const view = { id: "ws:view", name: "oats" };
const panel = (deployments, instances) => ({ instances, workspace: view, workspaces: [{ ...view, deployments: deployments.map((d) => d.id) }], deployments });
const THREE = () => panel([LOCAL, DEVBOX, LAPTOP], [row("lead", LOCAL), row("dev", LOCAL, { parentInstance: "lead" }), row("far", DEVBOX), row("near", LOCAL)]);

/* Mount the page on `data`; `before(window)` runs first (to seed the remembered tab). */
async function page(t, data, { before } = {}) {
  const dom = new JSDOM('<body><main id="host"></main></body>', { url: "http://localhost" });
  const doc = dom.window.document, host = doc.querySelector("main");
  const old = ORIGINAL; // several pages in one test: every one restores the globals the file started with
  globalThis.window = dom.window; globalThis.document = doc;
  const polls = []; globalThis.setInterval = (fn) => { polls.push(fn); return 0; };
  // A focused window (#481): the roster poll reads every tick (jsdom's document reports no focus).
  doc.hasFocus = () => true;
  setWorkspace("ws:view");
  const style = doc.createElement("style"); style.textContent = theme; doc.head.append(style);
  before?.(dom.window);
  let current = data;
  const dispose = hierarchy.mount(host, { hasWorkspaceSwitcher: true, api: async () => ({ ok: true, status: 200, json: async () => current }), openTerminal() {} });
  t.after(() => { dispose(); setWorkspace(old.ws); globalThis.window = old.window; globalThis.document = old.document; globalThis.setInterval = old.setInterval; dom.window.close(); });
  await tick(); await tick();
  const all = (s) => [...host.querySelectorAll(s)], one = (s) => host.querySelector(s);
  const tabs = () => all('[role="tab"]');
  const tab = (label) => tabs().find((b) => b.firstChild.textContent === label);
  const key = (el, k) => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const poll = async (next) => { current = next; polls[0](); await tick(); await tick(); };
  return { dom, doc, host, all, one, tabs, tab, key, poll, names: (el) => [...el.querySelectorAll(".hnode")].map((n) => n.dataset.name).sort() };
}

test("one deployment: only its own tab, no All, and its tree under its machine's heading (the Machines tab, 2026-10-26)", async (t) => {
  const rows = [row("lead", LOCAL), row("dev", LOCAL, { parentInstance: "lead" }), row("solo", LOCAL)];
  const u = await page(t, panel([LOCAL], rows));
  assert.deepEqual(u.tabs().map((b) => b.textContent), ["This Mac"]);
  assert.equal(u.tabs()[0].getAttribute("aria-selected"), "true");
  assert.equal(u.all(".hier-deployment").length, 1); assert.equal(u.all(".hier-dhead").length, 1);
  assert.deepEqual(u.all(".hier-dname").map((n) => n.textContent), ["This Mac · ~/Agents/oats"]);
  assert.deepEqual(u.all(".hier-dsub").map((n) => n.textContent), ["Instances on This Mac"]);
  assert.equal(u.one(".hier-dstate"), null, "live: no chip");
  assert.equal(u.all(".hier-cluster").length, 1); assert.equal(u.all(".hier-solo .hnode").length, 1);
  assert.deepEqual(u.names(u.one(".hier-deployment")).sort(), ["dev", "lead", "solo"], "the whole tree under the heading");
  assert.equal(hierarchy.layoutByDeployment(rows, [LOCAL]), null, "no All tab's sections");
  assert.match(u.one(".hier-sum").textContent, /^3 running · 0 stopped · 1 group · 1 independent$/);
});

test("one deployment that is not live: its tab carries the mark and the canvas keeps its heading, so the reason is never hidden", async (t) => {
  const u = await page(t, panel([LAPTOP], [row("lab", LAPTOP)]));
  assert.deepEqual(u.tabs().map((b) => b.firstChild.textContent), ["laptop"]);
  assert.equal(u.tabs()[0].querySelector(".deployment-mark").getAttribute("aria-label"), "not reached");
  assert.deepEqual(u.all(".hier-dname").map((n) => n.textContent), ["laptop · ~/Agents/lab"]);
  assert.equal(u.one(".hier-dstate").textContent, "not reached"); assert.equal(u.one(".hier-dfix > summary").textContent, "How to fix");
  assert.deepEqual(u.names(u.one(".hier-deployment")), ["lab"]);
});

test("no deployments reported (an older server): no tabs, the overview as before", async (t) => {
  const u = await page(t, { instances: [row("lead", LOCAL)], workspace: view, workspaces: [view] });
  assert.equal(u.one('[role="tablist"]').hidden, true); assert.equal(u.tabs().length, 0);
  assert.equal(u.one(".hier-panel").getAttribute("role"), null, "no tabpanel without tabs");
  assert.equal(u.all(".hier-solo .hnode").length, 1);
});

test("tabs: All then each deployment in served order, the Workspace tab pattern, roving tabindex and Arrow/Home/End", async (t) => {
  const u = await page(t, THREE());
  const list = u.one('[role="tablist"]');
  assert.ok(list.classList.contains("hier-tabs")); assert.equal(list.getAttribute("aria-label"), "Deployments"); assert.equal(list.hidden, false);
  assert.ok(u.one(".hier-bar").contains(list), "the tabs lead the page header");
  assert.deepEqual(u.tabs().map((b) => b.firstChild.textContent), ["All", "This Mac", "devbox", "laptop"]);
  const selected = () => u.tabs().filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.firstChild.textContent);
  const tabbable = () => u.tabs().filter((b) => b.tabIndex === 0).map((b) => b.firstChild.textContent);
  assert.deepEqual(selected(), ["All"]); assert.deepEqual(tabbable(), ["All"]);
  assert.ok(u.tabs().every((b) => b.type === "button" && b.getAttribute("aria-controls") === u.one(".hier-panel").id));
  assert.equal(u.one(".hier-panel").getAttribute("role"), "tabpanel");
  assert.equal(u.one(".hier-panel").getAttribute("aria-labelledby"), u.tab("All").id);
  // A deployment that is not live: the shared status mark, its state in words (never the mark alone).
  assert.equal(u.tab("This Mac").querySelector(".deployment-mark"), null);
  assert.equal(u.tab("devbox").querySelector(".deployment-mark").getAttribute("aria-label"), "remembered");
  assert.equal(u.tab("laptop").querySelector(".deployment-mark").getAttribute("aria-label"), "not reached");
  assert.equal(u.tab("laptop").title, "/home/op/Agents/lab — not reached", "the full path only as a tooltip");
  u.tab("All").focus();
  u.key(u.tab("All"), "ArrowRight");
  assert.deepEqual(selected(), ["This Mac"]); assert.deepEqual(tabbable(), ["This Mac"]); assert.equal(u.doc.activeElement, u.tab("This Mac"));
  assert.equal(u.one(".hier-panel").getAttribute("aria-labelledby"), u.tab("This Mac").id);
  u.key(u.tab("This Mac"), "End"); assert.deepEqual(selected(), ["laptop"]); assert.equal(u.doc.activeElement, u.tab("laptop"));
  u.key(u.tab("laptop"), "ArrowRight"); assert.deepEqual(selected(), ["All"], "ArrowRight wraps to the first");
  u.key(u.tab("All"), "ArrowLeft"); assert.deepEqual(selected(), ["laptop"], "ArrowLeft wraps to the last");
  u.key(u.tab("laptop"), "Home"); assert.deepEqual(selected(), ["All"]); assert.equal(u.doc.activeElement, u.tab("All"));
  u.tab("devbox").click(); assert.deepEqual(selected(), ["devbox"]);
});

test("All: one section per deployment, stacked, under the group-label heading with counts; no primary chip", async (t) => {
  const u = await page(t, THREE());
  const sections = u.all(".hier-deployment");
  assert.deepEqual(sections.map((s) => s.getAttribute("aria-label")), ["This Mac · ~/Agents/oats, 3 running",
    "devbox · ~/Agents/web, 1 running, remembered, timed out", "laptop · ~/Agents/lab, no instances, not reached, ssh needs a prompt"]);
  assert.deepEqual(sections.map((s) => s.getAttribute("role")), ["group", "group", "group"]);
  const heads = u.all(".hier-dhead");
  assert.deepEqual(heads.map((h) => h.querySelector(".hier-dname").textContent), ["This Mac · ~/Agents/oats", "devbox · ~/Agents/web", "laptop · ~/Agents/lab"]);
  assert.ok(heads.every((h) => h.querySelector(".hier-dmachine").classList.contains("cnm")), "the machine: the overview's group-label style");
  // A path is case-sensitive: never uppercased (or letter-spaced) with the machine label.
  const style = (el) => u.dom.window.getComputedStyle(el);
  assert.deepEqual(heads.map((h) => h.querySelector(".hier-dmachine").textContent), ["This Mac", "devbox", "laptop"]);
  assert.deepEqual(heads.map((h) => h.querySelector(".hier-dpath").textContent), ["· ~/Agents/oats", "· ~/Agents/web", "· ~/Agents/lab"]);
  for (const h of heads) {
    assert.equal(style(h.querySelector(".hier-dmachine")).textTransform, "uppercase");
    assert.equal(style(h.querySelector(".hier-dpath")).textTransform, "none", "the path keeps its case");
    assert.ok(h.querySelector(".hier-dpath").classList.contains("cct"), "in the muted secondary style, like the counts");
  }
  assert.deepEqual(heads.map((h) => h.querySelector(".hier-dname").title), [LOCAL.path, DEVBOX.path, LAPTOP.path], "the full path is the tooltip");
  assert.deepEqual(heads.map((h) => h.querySelector(".hier-dcount").textContent), ["3 running", "1 running", "no instances"]);
  assert.doesNotMatch(u.host.textContent, /primary/); assert.equal(u.all(".hier-dtag").length, 0);
  assert.ok(sections.every((s) => !/primary/.test(s.getAttribute("aria-label"))));
  // The live deployment's heading is its label and counts only.
  assert.equal(heads[0].querySelector(".chip"), null); assert.equal(heads[0].querySelector(".hier-dfix"), null);
  // Not live: the state chip, the short reason, and the How to fix disclosure (closed) under the heading.
  assert.equal(heads[1].querySelector(".hier-dstate").textContent, "remembered"); assert.ok(heads[1].querySelector(".hier-dstate").classList.contains("chip"));
  assert.equal(heads[1].querySelector(".hier-dshort").textContent, "timed out");
  assert.equal(heads[2].querySelector(".hier-dstate").textContent, "not reached");
  assert.equal(heads[2].querySelector(".hier-dshort").textContent, "ssh needs a prompt");
  const fix = heads[2].querySelector("details.hier-dfix");
  assert.equal(fix.open, false); assert.equal(fix.querySelector("summary").textContent, "How to fix");
  // With steps, the steps are the explanation: the full sentence would repeat step 1 (live check, #482).
  assert.equal(fix.querySelector(".hier-dfix-reason"), null);
  assert.deepEqual([...fix.querySelectorAll("ol.hier-dfix-steps > li")].map((li) => li.textContent), LAPTOP.fix.map((step) => step.replaceAll("`", "")));
  // A command the server quotes in backticks is set as code, never shown with its backticks.
  const code = fix.querySelector("ol.hier-dfix-steps code.hier-dfix-code");
  assert.ok(code, "the quoted command is code"); assert.doesNotMatch(fix.textContent, /`/);
  // Remembered without steps: the sentence and the note, under Details (no fix to follow).
  const details = heads[1].querySelector("details.hier-dfix");
  assert.equal(details.querySelector("summary").textContent, "Details");
  assert.equal(details.querySelector(".hier-dfix-reason").textContent, `Last report, not live now. ${DEVBOX.reason}`);
  assert.equal(details.querySelector(".hier-dfix-note").textContent, DEVBOX.note);
  assert.equal(heads[1].querySelector(".hier-dline").getAttribute("aria-hidden"), "true", "the group's name says the line");
  // Stacked in the panel's order, each with its own tree (relations never cross sections).
  assert.ok(parseFloat(heads[1].style.top) > parseFloat(heads[0].style.top)); assert.ok(parseFloat(heads[2].style.top) > parseFloat(heads[1].style.top));
  assert.deepEqual(u.names(sections[0]), ["dev", "lead", "near"]); assert.deepEqual(u.names(sections[1]), ["far"]); assert.deepEqual(u.names(sections[2]), []);
  assert.deepEqual(u.all(".hier-solo").map((g) => g.dataset.ws), [`Independent:${LOCAL.id}`, `Independent:${DEVBOX.id}`]);
  assert.equal(u.all(".hier-stage").length, 1, "one canvas: pan, zoom and fit work over every section");
  assert.match(u.one(".hier-sum").textContent, /^4 running · 0 stopped · 1 group · 2 independent$/);
  const layout = hierarchy.layoutByDeployment(THREE().instances, [LOCAL, DEVBOX, LAPTOP]);
  const [a, b] = layout.sections;
  assert.ok(b.y >= a.y + a.height, "the second section starts below the first");
  assert.ok(a.placed.every((p) => p.y >= a.y), "blocks are in stage coordinates under their heading");
});

test("a deployment's tab: its heading and only its rows; the count line counts that tab", async (t) => {
  const u = await page(t, panel([LOCAL, DEVBOX], [row("lead", LOCAL), row("dev", LOCAL, { parentInstance: "lead" }), row("far", DEVBOX, { running: false })]));
  u.tab("devbox").click();
  assert.deepEqual(u.all(".hnode").map((n) => n.dataset.name), ["far"]);
  assert.deepEqual(u.all(".hier-dname").map((n) => n.textContent), ["devbox · ~/Agents/web"]);
  assert.equal(u.one(".hier-dcount").textContent, "0 running · 1 stopped"); assert.equal(u.one(".hier-dstate").textContent, "remembered");
  assert.match(u.one(".hier-sum").textContent, /^0 running · 1 stopped · 0 groups · 1 independent$/);
  u.tab("This Mac").click();
  assert.deepEqual(u.all(".hnode").map((n) => n.dataset.name).sort(), ["dev", "lead"]);
  assert.deepEqual(u.all(".hier-dname").map((n) => n.textContent), ["This Mac · ~/Agents/oats"]);
  assert.match(u.one(".hier-sum").textContent, /^2 running · 0 stopped · 1 group$/);
});

test("a deployment that is not reached and has no rows: its tab shows why and how to fix it, never a silent empty", async (t) => {
  const u = await page(t, THREE());
  u.tab("laptop").click();
  assert.equal(u.all(".hnode").length, 0); assert.equal(u.one(".empty"), null, "not the 'no instances' message");
  const block = u.one(".hier-empty-wrap .hier-dreason");
  assert.ok(block); assert.equal(block.getAttribute("role"), "group");
  assert.equal(block.getAttribute("aria-label"), "laptop · ~/Agents/lab, no instances, not reached, ssh needs a prompt");
  assert.equal(block.querySelector(".hier-dstate.chip").textContent, "not reached");
  assert.equal(block.querySelector(".hier-dshort").textContent, "ssh needs a prompt");
  assert.equal(block.querySelector(".hier-dfix > summary").textContent, "How to fix");
  assert.deepEqual([...block.querySelectorAll(".hier-dfix-steps li")].map((li) => li.textContent), LAPTOP.fix.map((step) => step.replaceAll("`", "")));
  assert.match(u.one(".hier-sum").textContent, /^0 running · 0 stopped · 0 groups$/);
  // A live deployment with no rows keeps the overview's empty message.
  const v = await page(t, panel([LOCAL, LAPTOP], [row("far", LAPTOP)]));
  v.tab("This Mac").click();
  assert.ok(v.one(".empty")); assert.equal(v.one(".hier-dreason"), null);
});

test("the selected tab is remembered per view and is where the page starts", async (t) => {
  const u = await page(t, THREE());
  u.tab("devbox").click();
  assert.equal(rememberedDeploymentTab("ws:view", u.dom.window.localStorage), DEVBOX.id);
  const v = await page(t, THREE(), { before: (win) => rememberDeploymentTab("ws:view", LAPTOP.id, win.localStorage) });
  assert.equal(v.tab("laptop").getAttribute("aria-selected"), "true", "starts from the view's remembered tab");
  const w = await page(t, THREE(), { before: (win) => rememberDeploymentTab("ws:other", LAPTOP.id, win.localStorage) });
  assert.equal(w.tab("All").getAttribute("aria-selected"), "true", "another view's choice does not apply");
  const gone = await page(t, panel([LOCAL, DEVBOX], [row("lead", LOCAL)]), { before: (win) => rememberDeploymentTab("ws:view", LAPTOP.id, win.localStorage) });
  assert.equal(gone.tab("All").getAttribute("aria-selected"), "true", "a remembered deployment the view no longer has falls back to the first tab");
});

test("another surface's tab request switches the shown view's tab; a request for another view does not", async (t) => {
  const u = await page(t, THREE());
  requestDeploymentTab("ws:other", DEVBOX.id, u.dom.window.localStorage);
  assert.equal(u.tab("All").getAttribute("aria-selected"), "true");
  requestDeploymentTab("ws:view", LAPTOP.id, u.dom.window.localStorage);
  assert.equal(u.tab("laptop").getAttribute("aria-selected"), "true"); assert.ok(u.one(".hier-dreason"));
  requestDeploymentTab("ws:view", "remote:nowhere:000000000000", u.dom.window.localStorage);
  assert.equal(u.tab("laptop").getAttribute("aria-selected"), "true", "a tab the view does not have changes nothing");
});

test("How to fix: an open disclosure pushes the sections below it down, and stays open across a refresh", async (t) => {
  const u = await page(t, panel([LAPTOP, LOCAL], [row("lab", LAPTOP), row("lead", LOCAL)]));
  // jsdom lays nothing out: a heading measures 40px closed and 160px with its disclosure open.
  Object.defineProperty(u.dom.window.HTMLElement.prototype, "offsetHeight", { configurable: true,
    get() { return this.classList?.contains("hier-dhead") ? (this.querySelector("details[open]") ? 160 : 40) : 0; } });
  const tops = () => u.all(".hier-group").map((g) => parseFloat(g.style.top));
  const headTop = () => parseFloat(u.all(".hier-dhead")[1].style.top);
  const before = tops(), head = headTop();
  const fix = u.one(".hier-dfix"); fix.open = true; await later(); // jsdom fires toggle on a timer
  const after = tops();
  assert.ok(after.every((top, i) => top > before[i]), `clusters moved down: ${before} → ${after}`);
  assert.ok(headTop() > head, "the next heading moved down too");
  await u.poll(panel([LAPTOP, LOCAL], [row("lab", LAPTOP), row("lead", LOCAL), row("new", LOCAL)]));
  assert.equal(u.one(".hier-dfix").open, true, "open across a repaint");
  assert.ok(u.all(".hnode").some((n) => n.dataset.name === "new"));
});

test("no raw deployment id or view id in any text, tooltip or accessible name", async (t) => {
  const u = await page(t, THREE());
  const shown = (u) => [u.host.textContent, ...u.all("[title]").map((e) => e.title), ...u.all("[aria-label]").map((e) => e.getAttribute("aria-label"))].join("\n");
  for (const label of ["All", "This Mac", "devbox", "laptop"]) {
    u.tab(label).click();
    assert.doesNotMatch(shown(u), /remote:|5d1e0c9b8a7f|9f2c1a7b3e4d|ws:view/, `${label} tab`);
  }
});

/* ── contrast: every new text on its computed surface, in every theme ── */
function channels(hex) { assert.match(hex, /^#[0-9a-f]{6}$/i, hex); return hex.slice(1).match(/../g).map((v) => parseInt(v, 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); }
const luminance = (hex) => { const c = channels(hex); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; };
const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const painted = (win, el) => { for (let p = el; p; p = p.parentElement) { const bg = win.getComputedStyle(p).background; if (/^var\(--/.test(bg)) return bg.slice(6, -1); } return null; };

for (const name of ["light", "solarized", "dark"]) test(`${name}: the tabs, deployment headings, chips and How to fix meet computed AA`, async (t) => {
  const u = await page(t, THREE());
  u.doc.documentElement.dataset.theme = name;
  for (const fix of u.all(".hier-dfix")) fix.open = true;
  const empty = await page(t, THREE(), { before: (win) => rememberDeploymentTab("ws:view", LAPTOP.id, win.localStorage) });
  empty.doc.documentElement.dataset.theme = name;
  const checks = [
    [u, '.hier-tabs [aria-selected="true"]', "fg"], [u, '.hier-tabs [aria-selected="false"]', "nav-fg"],
    [u, ".hier-dmachine", "muted"], [u, ".hier-dpath", "muted"], [u, ".hier-dcount", "muted"], [u, ".hier-dshort", "muted"], [u, ".hier-dstate", "chip-fg"],
    [u, ".hier-dfix > summary", "fg"], [u, ".hier-dfix-body", "fg"], [u, ".hier-dfix-note", "muted"], [u, ".hier-dfix-code", "fg"],
    [empty, ".hier-dreason .hier-dmachine", "muted"], [empty, ".hier-dreason .hier-dpath", "muted"], [empty, ".hier-dreason .hier-dshort", "muted"], [empty, ".hier-dreason .hier-dstate", "chip-fg"],
    [empty, ".hier-dreason .hier-dfix > summary", "fg"],
  ];
  for (const [p, selector, fg] of checks) {
    const win = p.dom.window, el = p.one(selector); assert.ok(el, selector);
    assert.equal(win.getComputedStyle(el).color, `var(--${fg})`, selector);
    const bg = painted(win, el); assert.ok(bg, `${selector} sits on a painted token surface`);
    const root = win.getComputedStyle(p.doc.documentElement);
    const r = ratio(root.getPropertyValue(`--${fg}`).trim(), root.getPropertyValue(`--${bg}`).trim());
    assert.ok(r >= 4.5, `${selector}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
    for (let e = el; e; e = e.parentElement) assert.equal(win.getComputedStyle(e).opacity, "1", `${selector}: no opacity over text`);
  }
});

test("a reached deployment that is not matched says why on its tab (the switcher's Not matched entries open here)", async (t) => {
  const BUILD = { id: "remote:build:cccccccccccc", machine: "build", path: "/srv/fixture", label: "/srv/fixture", local: false, reachable: true,
    identityFrom: null, primary: true, reason: "build's OATS is too old to report its workspace; update OATS there.",
    short: "OATS too old to report its workspace", fix: ["Update OATS on build."] };
  const u = await page(t, panel([BUILD], []));
  assert.deepEqual(u.all(".hier-tabs [role=tab]").map((b) => b.textContent), ["build"]);
  assert.equal(u.all(".hier-tabs [role=tab] .deployment-mark").length, 1, "its tab carries the mark");
  assert.equal(u.one(".empty"), null, "never the plain 'no instances' message");
  const block = u.one(".hier-empty-wrap .hier-dreason");
  assert.ok(block);
  assert.equal(block.querySelector(".hier-dstate.chip").textContent, "not matched");
  assert.equal(block.querySelector(".hier-dshort").textContent, "OATS too old to report its workspace");
  assert.equal(block.querySelector(".hier-dfix > summary").textContent, "How to fix");
  assert.deepEqual([...block.querySelectorAll(".hier-dfix-steps li")].map((li) => li.textContent), ["Update OATS on build."]);
  // A reached, matched deployment alone is headed with its machine and no chip (the Machines tab, 2026-10-26).
  const quiet = await page(t, panel([LOCAL], [row("lead", LOCAL)]));
  assert.equal(quiet.all(".hier-dhead").length, 1); assert.equal(quiet.one(".hier-dstate"), null);
});

test("a live deployment's note (information, not a failure) is said under Details, with no chip and no mark, even when it is alone", async (t) => {
  const MOVED = { ...DEVBOX, reachable: true, identityFrom: "reported", reason: undefined, short: undefined, primary: true };
  const u = await page(t, panel([MOVED], [row("far", MOVED)]));
  assert.equal(u.all(".hier-tabs [role=tab] .deployment-mark").length, 0, "no mark: it is live");
  assert.deepEqual(u.all(".hier-dname").map((n) => n.textContent), ["devbox · ~/Agents/web"], "alone, it keeps its heading for the note");
  assert.equal(u.one(".hier-dstate"), null, "no chip: a matched live deployment is never 'not matched'");
  assert.equal(u.one(".hier-dfix > summary").textContent, "Details");
  assert.equal(u.one(".hier-dfix-note").textContent, "devbox now reports workspace web.");
  assert.deepEqual(u.names(u.one(".hier-deployment")), ["far"]);
  // A standalone host with no rows: the note heads its empty tab, above the usual message.
  const STANDALONE = { ...LOCAL, note: "Teams are local only on this host (standalone)." };
  const empty = await page(t, panel([STANDALONE], []));
  assert.ok(empty.one(".hier-empty-wrap .hier-dreason + .empty"), "the note, then the usual empty message");
  assert.equal(empty.one(".hier-dfix-note").textContent, "Teams are local only on this host (standalone).");
  assert.equal(empty.one(".hier-dstate"), null);
  // All, every deployment live and none with rows: the notes still head the empty state.
  const bare = await page(t, panel([LOCAL, { ...MOVED, primary: false }], []));
  assert.equal(bare.tabs().find((b) => b.getAttribute("aria-selected") === "true").firstChild.textContent, "All");
  assert.deepEqual(bare.all(".hier-empty-wrap .hier-dfix-note").map((n) => n.textContent), ["devbox now reports workspace web."]);
  assert.ok(bare.one(".hier-empty-wrap > .empty"), "then the usual empty message");
  // In All, beside other deployments: the same Details line on its section.
  const all = await page(t, panel([LOCAL, { ...MOVED, primary: false }], [row("lead", LOCAL), row("far", MOVED)]));
  const section = all.all(".hier-deployment").find((s) => s.querySelector(".hier-dname").textContent.startsWith("devbox"));
  assert.equal(section.querySelector(".hier-dstate"), null);
  assert.equal(section.querySelector(".hier-dfix-note").textContent, "devbox now reports workspace web.");
});

test("a stale local deployment (its last re-read failed): a 'stale' chip with the kernel's message, and its held rows wait for a current read", async (t) => {
  const OTHER = { id: "/Users/op/example/oats-qa", machine: "This Mac", path: "/Users/op/example/oats-qa", label: "~/example/oats-qa", local: true,
    reachable: true, identityFrom: "reported", primary: false, stale: true, short: "Last read failed",
    reason: "This deployment's last read failed: the cache is locked. It shows what was last observed." };
  const u = await page(t, panel([LOCAL, OTHER], [row("lead", LOCAL), row("held", OTHER)]));
  const section = u.all(".hier-deployment").find((s) => s.querySelector(".hier-dname").textContent.endsWith("oats-qa"));
  assert.equal(section.querySelector(".hier-dstate").textContent, "stale");
  assert.equal(section.querySelector(".hier-dshort").textContent, "Last read failed");
  assert.equal(section.querySelector(".hier-dfix-reason").textContent, OTHER.reason);
  assert.equal(u.tabs().find((b) => b.firstChild.textContent.endsWith("oats-qa")).querySelector(".deployment-mark").getAttribute("aria-label"), "stale");
  const click = (name) => u.one(`.hnode[data-name="${name}"]`).dispatchEvent(new u.dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
  click("held");
  assert.equal(u.one(".pterm").disabled, true, "a held row's actions wait");
  assert.match(u.one(".pstate").textContent, /\(last observation\)$/);
  click("lead");
  assert.equal(u.one(".pterm").disabled, false, "the live deployment's rows act as before");
});

test("header: the counts sit at the right, never against the tabs, and no Spawn button (Spec E); the tab strip shrinks and scrolls", async (t) => {
  const u = await page(t, THREE());
  const bar = u.one(".hier-bar"), kids = [...bar.children];
  const at = (sel) => kids.findIndex((k) => k.matches(sel));
  assert.ok(at(".hier-tabs") < at('[style*="flex:1"]') && at('[style*="flex:1"]') < at(".hier-sum"),
    kids.map((k) => k.className || k.getAttribute("style")).join(" | "));
  assert.deepEqual(u.all(".spawnbtn, .hier button").filter((b) => /spawn/i.test(b.textContent)), [], "Spec E: no Spawn button on the page (the S key and every other way stay)");
  const win = u.dom.window;
  assert.equal(win.getComputedStyle(u.one(".hier-tabs")).overflowX, "auto");
  assert.equal(win.getComputedStyle(u.one(".hier-sum")).whiteSpace, "nowrap");
});

/* ── What a machine is, in plain words (the Workspace page's Machines tab, the product owner, 2026-10-26): one
   sentence under the bar, and under each machine's heading what the tree under it is. The round "i" and its
   "What is a deployment?" dialog are gone. ── */
const INTRO = "Each machine runs this workspace in a folder of its own. The instances under a machine run on that machine.";

test('the intro: one plain sentence right under the bar, on every tab and with no tabs; no "i" and no About dialog', async (t) => {
  const u = await page(t, THREE());
  const intro = u.all(".hier-intro");
  assert.equal(intro.length, 1, "one sentence");
  assert.equal(intro[0].tagName, "P"); assert.equal(intro[0].textContent, INTRO);
  assert.equal(intro[0].previousElementSibling, u.one(".hier-status"), "right under the bar, after only its visually hidden status line");
  assert.equal(u.one(".hier-status").previousElementSibling, u.one(".hier-bar"));
  assert.equal(intro[0].nextElementSibling, u.one(".hier-notice"), "above the notice and the canvas");
  assert.equal(intro[0].querySelector("code, a, button"), null, "plain words: no code, no link, nothing to press");
  assert.doesNotMatch(intro[0].textContent, /oats-local|\.yaml|`|deployment/, "plain words: no file names, no code, not the word deployment");
  // No "i": no info button anywhere, nothing after the tabs, no About dialog to open.
  assert.equal(u.doc.querySelector(".ws-info-button, [aria-haspopup=dialog]"), null, "no info button");
  assert.equal(u.one(".hier-tabs").nextElementSibling?.classList.contains("ws-info-button") ?? false, false);
  assert.deepEqual(u.all(".hier-bar button:not([role=tab])"), [], "the bar holds the tabs only");
  assert.doesNotMatch(hierarchy.hierarchyCSS, /ws-info-button|about-dialog/, "no rule left for the \"i\" or its dialog");
  for (const label of ["This Mac", "devbox", "laptop", "All"]) {
    u.tab(label).click();
    assert.deepEqual(u.all(".hier-intro").map((p) => p.textContent), [INTRO], `${label}: the same sentence`);
  }
  assert.equal(u.doc.querySelector(".palette-overlay, .about-dialog"), null, "no dialog opened along the way");
  // With no tabs (an older server reports no deployments) the sentence stays under the bar.
  const old = await page(t, { instances: [row("lead", LOCAL)], workspace: view, workspaces: [view] });
  assert.equal(old.one(".hier-tabs").hidden, true);
  assert.equal(old.one(".hier-intro").previousElementSibling, old.one(".hier-status")); assert.equal(old.one(".hier-intro").textContent, INTRO);
  assert.equal(old.doc.querySelector(".ws-info-button"), null);
});

test('each machine\'s heading says the tree under it: "Instances on <machine>", or "Instances on this machine" when it names none', async (t) => {
  const u = await page(t, THREE());
  const subs = () => u.all(".hier-dhead").map((h) => h.querySelector(".hier-dsub")?.textContent ?? null);
  assert.deepEqual(subs(), ["Instances on This Mac", "Instances on devbox", "Instances on laptop"], "one line per heading, the machine named");
  for (const head of u.all(".hier-dhead")) {
    assert.equal(head.querySelectorAll(".hier-dsub").length, 1);
    assert.equal(head.querySelector(".hier-dsub").previousElementSibling, head.querySelector(".hier-dline"), "right under the machine's name and counts");
    assert.equal(head.querySelector(".hier-dline").contains(head.querySelector(".hier-dsub")), false, "its own line, not the aria-hidden one");
  }
  // A deployment's tab: its own heading's line; an empty, not reached one says it in its reason block.
  u.tab("devbox").click(); assert.deepEqual(subs(), ["Instances on devbox"]);
  u.tab("laptop").click(); assert.equal(u.one(".hier-dreason .hier-dsub").textContent, "Instances on laptop");
  // A deployment that names no machine: "this machine", never an id or a path (deploymentHead, deployments-page.mjs).
  const HERE = { id: "/Users/op/Agents/here", path: "/Users/op/Agents/here", label: "~/Agents/here", local: true, reachable: true, identityFrom: "reported", primary: true };
  for (const machine of [undefined, ""]) {
    const head = deploymentHead(u.doc, { deployment: { ...HERE, ...(machine === undefined ? {} : { machine }) }, rows: [] }).element;
    assert.equal(head.querySelector(".hier-dsub").textContent, "Instances on this machine", `machine ${JSON.stringify(machine)}`);
    assert.equal(head.querySelector(".hier-dmachine").textContent, "This Mac", "the heading keeps this machine's word");
  }
  assert.equal(deploymentHead(u.doc, { deployment: LAPTOP, rows: [] }).element.querySelector(".hier-dsub").textContent, "Instances on laptop");
  // Through the page, a local deployment the panel names no machine for is this machine's word (view-deployments.mjs).
  const v = await page(t, panel([HERE, DEVBOX], [row("near", HERE), row("far", DEVBOX)]));
  assert.deepEqual(v.all(".hier-dhead .hier-dsub").map((d) => d.textContent), ["Instances on This Mac", "Instances on devbox"]);
  // One deployment is headed too, with its line.
  const one = await page(t, panel([LOCAL], [row("lead", LOCAL)]));
  assert.deepEqual(one.all(".hier-dhead .hier-dsub").map((d) => d.textContent), ["Instances on This Mac"]);
  // Computed type: the heading's muted 11px secondary line.
  const style = u.dom.window.getComputedStyle(u.one(".hier-dsub"));
  assert.equal(style.color, "var(--muted)"); assert.equal(style.fontSize, "11px");
});

for (const name of ["light", "solarized", "dark"]) test(`${name}: the intro sentence and each heading's "Instances on …" line meet computed AA`, async (t) => {
  const u = await page(t, THREE());
  u.doc.documentElement.dataset.theme = name;
  const empty = await page(t, THREE(), { before: (win) => rememberDeploymentTab("ws:view", LAPTOP.id, win.localStorage) });
  empty.doc.documentElement.dataset.theme = name;
  for (const [p, selector, fg] of [[u, ".hier-intro", "muted"], [u, ".hier-dhead .hier-dsub", "muted"], [empty, ".hier-dreason .hier-dsub", "muted"]]) {
    const win = p.dom.window, el = p.one(selector); assert.ok(el, selector);
    assert.equal(win.getComputedStyle(el).color, `var(--${fg})`, selector);
    const bg = painted(win, el); assert.ok(bg, `${selector} sits on a painted token surface`);
    const root = win.getComputedStyle(p.doc.documentElement);
    const r = ratio(root.getPropertyValue(`--${fg}`).trim(), root.getPropertyValue(`--${bg}`).trim());
    assert.ok(r >= 4.5, `${selector}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
    for (let e = el; e; e = e.parentElement) assert.equal(win.getComputedStyle(e).opacity, "1", `${selector}: no opacity over text`);
  }
  assert.equal(painted(u.dom.window, u.one(".hier-intro")), "surface", "the intro paints its own surface");
});

test("tab strip overflow: a newly selected or focused tab is scrolled into the strip, and only the strip scrolls", () => {
  const win = new JSDOM("<body></body>").window, doc = win.document;
  const bar = createDeploymentTabBar(doc, { idPrefix: "t", onSelect() {} });
  doc.body.append(bar.element);
  // A 200px strip at x=100 holding five 120px tabs, laid out as a browser would (jsdom has no layout).
  Object.defineProperty(bar.element, "clientWidth", { value: 200 });
  bar.element.getBoundingClientRect = () => ({ left: 100, right: 300, width: 200 });
  win.HTMLButtonElement.prototype.getBoundingClientRect = function () {
    const left = 100 + [...this.parentElement.children].indexOf(this) * 120 - bar.element.scrollLeft;
    return { left, right: left + 120, width: 120 };
  };
  const tabs = ["all", "a", "b", "c", "d"].map((id) => ({ id, label: id }));
  bar.paint(tabs, "all");
  assert.equal(bar.element.scrollLeft, 0, "the first tab is in view: nothing scrolls");
  bar.paint(tabs, "d"); // the selection moved (a remembered tab, a switcher request): reveal it
  assert.equal(bar.element.scrollLeft, 400, "the last tab's right edge meets the strip's");
  bar.paint(tabs, "d");
  assert.equal(bar.element.scrollLeft, 400, "a repaint of the same selection leaves the scroll alone");
  bar.element.children[0].dispatchEvent(new win.FocusEvent("focus"));
  assert.equal(bar.element.scrollLeft, 0, "a focused tab is revealed too");
  win.close();
});

test("tab strip overflow: a selection painted while the stage is hidden is revealed once the strip has a width (a repaint or a resize)", () => {
  const win = new JSDOM("<body></body>").window, doc = win.document;
  const observers = [];
  win.ResizeObserver = class { constructor(fn) { this.fn = fn; this.on = false; observers.push(this); } observe() { this.on = true; } disconnect() { this.on = false; } };
  const tabs = ["all", "a", "b", "c", "d"].map((id) => ({ id, label: id }));
  const strip = (bar) => {
    let width = 0; // the stage is hidden (a terminal in front of it): no layout
    Object.defineProperty(bar.element, "clientWidth", { get: () => width });
    bar.element.getBoundingClientRect = () => ({ left: 100, right: 100 + width, width });
    return (w) => { width = w; };
  };
  win.HTMLButtonElement.prototype.getBoundingClientRect = function () {
    const left = 100 + [...this.parentElement.children].indexOf(this) * 120 - this.parentElement.scrollLeft;
    return { left, right: left + 120, width: 120 };
  };
  // A repaint after the stage shows again.
  const one = createDeploymentTabBar(doc, { idPrefix: "h1", onSelect() {} }); doc.body.append(one.element);
  const show1 = strip(one);
  one.paint(tabs, "d");
  assert.equal(one.element.scrollLeft, 0, "hidden: nothing to measure, nothing scrolled");
  show1(200); one.paint(tabs, "d");
  assert.equal(one.element.scrollLeft, 400, "the next paint reveals it");
  one.element.scrollLeft = 120; one.paint(tabs, "d");
  assert.equal(one.element.scrollLeft, 120, "once revealed, a repaint leaves the operator's scrolling alone");
  // No repaint: the strip's resize (hidden to shown) reveals it.
  const two = createDeploymentTabBar(doc, { idPrefix: "h2", onSelect() {} }); doc.body.append(two.element);
  const show2 = strip(two);
  two.paint(tabs, "d");
  const observer = observers.at(-1);
  assert.equal(observer.on, true, "the strip is observed");
  show2(200); observer.fn([]);
  assert.equal(two.element.scrollLeft, 400, "revealed when the strip gets its width");
  two.dispose();
  assert.equal(observer.on, false, "disposed with the page");
  win.close();
});
