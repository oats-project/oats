// Quick Open for souls (Mod+P) — pure row logic, overlay picker chrome,
// keymap/terminal-policy pins, and the Spawn-view preselect handoff.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createOverlayPicker } from "../renderer/overlay-picker.mjs";
import { subsequenceScore } from "../../client/subsequence-score.mjs";
import { quickOpenRows } from "../renderer/quick-open.mjs";
import { paletteRows, createPalette } from "../renderer/palette.mjs";
import { DEFAULT_KEYMAP, DEFAULT_KEYMAPS, TERMINAL_ALLOWLIST } from "../renderer/keybindings.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(PKG, f), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── house fuzzy matcher (shared) ─────────────────────────────────────────

test("subsequenceScore: subsequence matches, prefix bonus, no-match null", () => {
  assert.equal(subsequenceScore("abc", "zzz"), null);
  assert.ok(subsequenceScore("oats-desktop-engineer", "ode") != null);
  assert.ok(subsequenceScore("reviewer", "rev") < subsequenceScore("harvester-rev", "rev"),
    "prefix match scores better (lower)");
  assert.ok(subsequenceScore("theme: toggle", "theme") < 0,
    "prefix scores go negative — the legacy sc<0 no-match filter dropped exact prefixes; null is the only no-match");
});

// ── quick-open rows (pure) ───────────────────────────────────────────────

const AGENTS = [
  { name: "oats-expert", repoName: "oats", description: "maintainer", work: "worktree", agentsRoot: "/r1" },
  { name: "reviewer", repoName: "oats", description: "post-commit review", work: "attached", agentsRoot: "/r1" },
  { name: "ux-designer", repoName: "oats", description: "design", work: "worktree", agentsRoot: "/r2" },
];

test("quickOpenRows: empty query lists all souls alphabetically", () => {
  const rows = quickOpenRows(AGENTS, "", { onPick: () => {} });
  assert.deepEqual(rows.map((r) => r.label), ["oats-expert", "reviewer", "ux-designer"]);
});

test("quickOpenRows: fuzzy filter narrows to matching souls; picking passes name + agentsRoot", () => {
  const picked = [];
  const rows = quickOpenRows(AGENTS, "uxd", { onPick: (s) => picked.push(s) });
  assert.deepEqual(rows.map((r) => r.label), ["ux-designer"]);
  rows[0].run();
  assert.deepEqual(picked, [{ name: "ux-designer", agentsRoot: "/r2" }]);
});

test("quickOpenRows: attached-mode souls are listed but marked attached only", () => {
  const rows = quickOpenRows(AGENTS, "reviewer", { onPick: () => {} });
  assert.equal(rows.length, 1);
  assert.match(rows[0].detail, /attached only/);
});

test("quickOpenRows: caps at 12 results", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `soul-${String(i).padStart(2, "0")}`, work: "worktree" }));
  assert.equal(quickOpenRows(many, "", { onPick: () => {} }).length, 12);
});

// ── overlay picker chrome (shared with the palette) ──────────────────────

function pickerDom() {
  const dom = new JSDOM("<!doctype html><body>", { url: "http://localhost" });
  return { dom, doc: dom.window.document };
}

test("overlay picker: opens, filters, Enter runs active row, Esc closes", async (t) => {
  const { dom, doc } = pickerDom();
  t.after(() => dom.window.close());
  const ran = [];
  const picker = createOverlayPicker({
    placeholder: "p", ariaLabel: "Quick open souls", doc,
    loadItems: async () => AGENTS,
    computeRows: (agents, q) => quickOpenRows(agents || [], q, { onPick: (s) => ran.push(s.name) }),
  });
  await picker.open();
  const input = doc.querySelector(".palette-input");
  assert.ok(input, "overlay input rendered");
  assert.equal(doc.querySelector(".palette").getAttribute("aria-label"), "Quick open souls");
  assert.equal(doc.querySelectorAll(".palette-item").length, 3);
  input.value = "uxd";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(doc.querySelectorAll(".palette-item").length, 1);
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  assert.deepEqual(ran, ["ux-designer"]);
  assert.equal(doc.querySelector(".palette-overlay"), null, "Enter closes the overlay");
  await picker.open();
  doc.querySelector(".palette-input")
    .dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  assert.equal(doc.querySelector(".palette-overlay"), null, "Esc closes");
});

test("overlay picker: arrows move the active row", async (t) => {
  const { dom, doc } = pickerDom();
  t.after(() => dom.window.close());
  const ran = [];
  const picker = createOverlayPicker({
    placeholder: "p", ariaLabel: "x", doc,
    loadItems: async () => AGENTS,
    computeRows: (agents, q) => quickOpenRows(agents || [], q, { onPick: (s) => ran.push(s.name) }),
  });
  await picker.open();
  const input = doc.querySelector(".palette-input");
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  assert.deepEqual(ran, ["reviewer"], "second row after one ArrowDown");
});

test("overlay picker: a load resolving after close must not paint (generation guard)", async (t) => {
  const { dom, doc } = pickerDom();
  t.after(() => dom.window.close());
  let release;
  const picker = createOverlayPicker({
    placeholder: "p", ariaLabel: "x", doc,
    loadItems: () => new Promise((ok) => { release = ok; }),
    computeRows: (agents) => quickOpenRows(agents || [], "", { onPick: () => {} }),
  });
  const opening = picker.open();
  picker.close();
  release(AGENTS);
  await opening;
  assert.equal(doc.querySelector(".palette-overlay"), null, "stale load did not resurrect the overlay");
});

test("the palette's souls: a failing souls load leaves the souls group empty, not a crash (slice 4: Quick Open folded in)", async (t) => {
  const { dom, doc } = pickerDom();
  t.after(() => dom.window.close());
  const palette = createPalette({ loadInstances: async () => ({ instances: [], deployments: [] }), loadSouls: async () => { throw new Error("boom"); },
    onSoul: () => {}, openTerminal: () => {}, doc });
  await palette.open({ query: "+" });
  assert.equal(doc.querySelector(".palette-input").value, "+", "Alt+P opens the palette on its souls");
  assert.match(doc.querySelector(".palette-list").textContent, /No matches/);
});

test("the palette's souls: \"New agent: <soul>\" rows pick the soul for the New agent form", async (t) => {
  const { dom, doc } = pickerDom();
  t.after(() => dom.window.close());
  const picked = [];
  const palette = createPalette({ loadInstances: async () => ({ instances: [], deployments: [] }), loadSouls: async () => ({ agents: AGENTS }),
    onSoul: (soul) => picked.push(soul.name), openTerminal: () => {}, doc });
  await palette.open({ query: "+uxd" });
  assert.deepEqual([...doc.querySelectorAll(".palette-item .plabel")].map((el) => el.textContent), ["New agent: ux-designer"]);
  doc.querySelector(".palette-input").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  assert.deepEqual(picked, ["ux-designer"]);
});

// ── palette parity: paletteRows still behaves on the shared scorer ───────

test("paletteRows: '>' restricts to commands; live chord detail functions re-evaluate", () => {
  let chord = "⌘T";
  const rows = paletteRows(
    [{ instance: "inst-a", running: true }],
    [{ label: "Theme: toggle", detail: () => chord, run: () => {} }],
    ">theme",
  );
  assert.deepEqual(rows.map((r) => r.label), ["Theme: toggle"]);
  assert.equal(rows[0].detail, "⌘T");
});

// ── keymap + terminal policy pins ────────────────────────────────────────

test("app.quickOpenSouls defaults to ⌘P / Alt+P (Ctrl+Alt+P in that family) and is terminal-allowlisted", () => {
  assert.deepEqual(DEFAULT_KEYMAP["app.quickOpenSouls"], { mac: "Mod+P", other: "Alt+P" });
  assert.deepEqual(DEFAULT_KEYMAPS["ctrl+alt"]["app.quickOpenSouls"], { mac: "Mod+P", other: "Ctrl+Alt+P" });
  assert.ok(TERMINAL_ALLOWLIST.includes("app.quickOpenSouls"),
    "Alt+P fires from a focused terminal on Linux/Windows; plain Ctrl+P stays the shell's history");
});

// ── shell wiring pins (source-level, house style) ────────────────────────

test("shell wires the souls: action registered, palette command present, spawn handoff", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /id: "app\.quickOpenSouls"/, "action registered");
  assert.match(src, /New \$\{DESKTOP_NOUNS\.instance\}: choose a soul…/, "palette discoverability entry");
  assert.match(src, /void palette\.open\(\{ query: "\+" \}\)/, "Alt+P opens the palette on its souls");
  assert.match(src, /onSoul: \(soul\) => openNewAgent\(soul\)/, "a soul row opens the New agent form");
  assert.match(src, /mod\.preselectSpawn\(/, "selection opens the soul's spawn dialog in Workspace");
  assert.match(src, /showStage\("spawn"\)/, "selection routes to the Spawn stage");
});

test("the palette uses the overlay-picker machinery, and the souls' rows are quick-open.mjs's (no duplicated chrome)", () => {
  const palette = read("renderer/palette.mjs");
  const qo = read("renderer/quick-open.mjs");
  assert.match(palette, /from "\.\/overlay-picker\.mjs"/);
  assert.match(palette, /import \{ quickOpenRows \} from "\.\/quick-open\.mjs"/);
  for (const src of [palette, qo]) assert.ok(!/palette-overlay/.test(src), "overlay DOM lives only in overlay-picker.mjs");
  assert.ok(!/createOverlayPicker/.test(qo), "Quick Open has no overlay of its own");
});

// ── Spawn view preselect handoff (jsdom) ─────────────────────────────────

const CLI_OK = { ok: true, bin: "/seed/oats", version: "0.18.0", source: "path", required: { desktopApi: 1, range: ">=0.18.0 <0.21.0" }, probedAt: 1, tried: [] };

async function mountSpawn(t, { cliOk = true, agents = AGENTS } = {}) {
  const dom = new JSDOM("<!doctype html><body><div id=host></div>", { url: "http://localhost" });
  const oldDoc = globalThis.document, oldWin = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const cliStatus = await import("../renderer/views/cli-status.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  await cliStatus.refreshCli({
    api: async () => ({ ok: cliOk, status: cliOk ? 200 : 503, json: async () => (cliOk ? CLI_OK : { ok: false, error: "cli-unavailable", tried: [] }) }),
  });
  const ctx = {
    api: async (pathname) => {
      if (pathname.startsWith("/api/cli")) return { ok: cliOk, status: cliOk ? 200 : 503, json: async () => (cliOk ? CLI_OK : { ok: false, error: "cli-unavailable", tried: [] }) };
      if (pathname.startsWith("/api/agents")) return { ok: true, status: 200, json: async () => ({ agents }) };
      if (pathname.startsWith("/api/panel")) return { ok: true, status: 200, json: async () => ({ instances: [], workspace: { id: "" }, workspaces: [] }) };
      throw new Error(`unexpected ${pathname}`);
    },
    openTerminal: () => {},
  };
  spawn.mount(dom.window.document.getElementById("host"), ctx);
  await tick(); await tick();
  t.after(() => {
    spawn.unmount();
    globalThis.document = oldDoc;
    globalThis.window = oldWin;
    dom.window.close();
  });
  return { dom, doc: dom.window.document, spawn };
}

// F7: a soul opens as a page in the Workspace view; focus moves into it (its back
// control), and going back focuses the soul's card.
const onPage = (doc, name) => {
  const page = doc.querySelector(".workspace-soul-page");
  assert.equal(page.hidden, false, "the soul's page is open");
  assert.equal(page.querySelector(".inspector-head h2").textContent, name);
  assert.ok(doc.activeElement?.classList.contains("inspector-back"), "focus is on the page's back control");
  return page;
};
test("preselectSoul opens the soul's page; launching is explicit", async (t) => {
  const { doc, spawn } = await mountSpawn(t);
  spawn.preselectSoul({ name: "ux-designer", agentsRoot: "/r2" });
  const inspector = onPage(doc, "ux-designer");
  assert.equal(inspector.hidden, false);
  assert.match(inspector.textContent, /ux-designer/);
  assert.equal(doc.querySelector(".spawn-dialog"), null);
});

test("preselectSoul on an attached-only soul opens its page (which explains itself), never a modal; back focuses its card", async (t) => {
  const { doc, spawn } = await mountSpawn(t);
  spawn.preselectSoul({ name: "reviewer", agentsRoot: "/r1" });
  assert.equal(doc.querySelector(".spawn-dialog"), null, "no modal for attached souls");
  onPage(doc, "reviewer").querySelector(".inspector-back").click();
  assert.equal(doc.activeElement?.dataset?.agent, "reviewer", "back returns to its card");
});

test("preselectSoul with the CLI unavailable opens the page, not a modal (degradation respected)", async (t) => {
  const { doc, spawn } = await mountSpawn(t, { cliOk: false });
  spawn.preselectSoul({ name: "ux-designer" });
  assert.equal(doc.querySelector(".spawn-dialog"), null, "no modal without a verified CLI");
  onPage(doc, "ux-designer").querySelector(".inspector-back").click();
  assert.equal(doc.activeElement?.dataset?.agent, "ux-designer");
});

test("preselect is consumed once: closing inspection keeps it closed", async (t) => {
  const { doc, spawn } = await mountSpawn(t);
  spawn.preselectSoul({ name: "ux-designer" });
  assert.equal(doc.querySelector(".workspace-soul-page").hidden, false);
  doc.querySelector(".workspace-soul-page .inspector-back").click();
  assert.equal(doc.querySelector(".workspace-soul-page").hidden, true);
  assert.equal(doc.querySelector(".spawn-dialog"), null);
  // a later roster paint (poll) must not resurrect the consumed preselect
  await tick(); await tick();
  assert.equal(doc.querySelector(".spawn-dialog"), null, "modal stays closed");
});

const KEYED_PKG = { name: "dev", key: "oats.okf/dev", agentsRoot: "/r1", work: "worktree", description: "package dev", soulSource: { repoKey: "github.com/awebai/oats-okf" } };
const KEYED_MEMBER = { name: "dev", key: "dev", agentsRoot: "/r2", work: "worktree", description: "member dev", soulSource: { repoKey: "github.com/acme/agents" } };

test("preselectSoul with a key and a repoKey opens only that exact soul", async (t) => {
  const { doc, spawn } = await mountSpawn(t, { agents: [KEYED_PKG, KEYED_MEMBER] });
  const misses = [];
  const miss = (count, detail) => misses.push([count, detail ?? null]);
  spawn.preselectSoul({ name: "dev", agentsRoot: "/r1", key: "dev", onMiss: miss });
  assert.deepEqual(misses, [[0, null]], "the root's dev is not the soul of that key");
  spawn.preselectSoul({ name: "dev", agentsRoot: "/r1", key: "oats.okf/dev", repoKey: "github.com/acme/agents", onMiss: miss });
  assert.deepEqual(misses, [[0, null], [0, null]], "the key's soul from another source is not it");
  assert.equal(doc.querySelector(".workspace-soul-page").hidden, true);
  spawn.preselectSoul({ name: "dev", agentsRoot: "/r1", key: "oats.okf/dev", repoKey: "github.com/awebai/oats-okf", onMiss: miss });
  assert.equal(misses.length, 2);
  const page = onPage(doc, "dev");
  assert.match(page.textContent, /package dev/); assert.doesNotMatch(page.textContent, /member dev/);
});

test("preselectSoul: a keyed soul whose name another soul of its root shares is not opened (its page is read by name and root)", async (t) => {
  const { doc, spawn } = await mountSpawn(t, { agents: [KEYED_PKG, { ...KEYED_MEMBER, agentsRoot: "/r1" }] });
  const misses = [];
  const miss = (count, detail) => misses.push([count, detail ?? null]);
  spawn.preselectSoul({ name: "dev", agentsRoot: "/r1", onMiss: miss });
  assert.deepEqual(misses, [[2, null]], "today's callers, by name: two souls named dev, none opened");
  spawn.preselectSoul({ name: "dev", agentsRoot: "/r1", key: "oats.okf/dev", repoKey: "github.com/awebai/oats-okf", onMiss: miss });
  assert.deepEqual(misses, [[2, null], [1, { sharedName: "dev" }]]);
  assert.equal(doc.querySelector(".workspace-soul-page").hidden, true);
});

test("preselectSoul for a soul not in this workspace's roster is a silent no-op", async (t) => {
  const { doc, spawn } = await mountSpawn(t);
  spawn.preselectSoul({ name: "not-here" });
  assert.equal(doc.querySelector(".spawn-dialog"), null);
});

test("preselect during a workspace switch is not consumed against the stale roster (review 6d5e183)", async (t) => {
  const dom = new JSDOM("<!doctype html><body><div id=host></div>", { url: "http://localhost" });
  const oldDoc = globalThis.document, oldWin = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const common = await import("../renderer/views/common.mjs");
  const cliStatus = await import("../renderer/views/cli-status.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  await cliStatus.refreshCli({ api: async () => ({ ok: true, status: 200, json: async () => CLI_OK }) });
  let releaseB; // workspace B's agents fetch hangs until released
  const ctx = {
    api: async (pathname) => {
      if (pathname.startsWith("/api/cli")) return { ok: true, status: 200, json: async () => CLI_OK };
      const ws = pathname.includes("ws=wsB") ? "wsB" : "wsA";
      if (pathname.startsWith("/api/agents")) {
        if (ws === "wsB") return { ok: true, status: 200, json: () => new Promise((ok) => { releaseB = () => ok({ agents: [{ name: "b-soul", work: "worktree", agentsRoot: "/b" }] }); }) };
        return { ok: true, status: 200, json: async () => ({ agents: [{ name: "a-soul", work: "worktree", agentsRoot: "/a" }, { name: "b-soul", work: "attached", agentsRoot: "/a" }] }) };
      }
      if (pathname.startsWith("/api/panel")) return { ok: true, status: 200, json: async () => ({ instances: [], workspace: { id: ws }, workspaces: [{ id: "wsA", name: "A" }, { id: "wsB", name: "B" }] }) };
      throw new Error(`unexpected ${pathname}`);
    },
    openTerminal: () => {},
  };
  const prevWs = common.currentWorkspace();
  t.after(() => {
    spawn.unmount();
    common.setWorkspace(prevWs || "");
    globalThis.document = oldDoc; globalThis.window = oldWin;
    dom.window.close();
  });
  common.setWorkspace("wsA");
  spawn.mount(dom.window.document.getElementById("host"), ctx);
  await tick(); await tick();
  assert.match(dom.window.document.body.textContent, /a-soul/, "wsA roster painted");
  // switch to B; B's roster fetch hangs — s.souls still holds wsA's agents
  common.setWorkspace("wsB");
  await tick(); // let the switch's refresh reach the hanging wsB agents fetch
  assert.ok(releaseB, "wsB roster fetch is hanging");
  // Quick Open (in wsB) picks b-soul — same NAME exists in wsA's stale
  // roster as an attached soul: consuming against the stale roster would
  // focus the WRONG (wsA) card and lose the preselect for wsB's spawnable one
  spawn.preselectSoul({ name: "b-soul", agentsRoot: "/b" });
  assert.equal(dom.window.document.querySelector(".spawn-dialog"), null, "not consumed against the stale roster");
  releaseB();
  await tick(); await tick();
  const inspector = dom.window.document.querySelector(".workspace-soul-page");
  assert.equal(inspector.hidden, false, "preselect consumed by wsB's own roster paint");
  assert.match(inspector.textContent, /b-soul/);
});

test("a deferred preselect dies with the view: defer → unmount → remount opens no modal (review 04584f9)", async (t) => {
  const dom = new JSDOM("<!doctype html><body><div id=host></div>", { url: "http://localhost" });
  const oldDoc = globalThis.document, oldWin = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const common = await import("../renderer/views/common.mjs");
  const cliStatus = await import("../renderer/views/cli-status.mjs");
  const spawn = await import("../renderer/views/spawn.mjs");
  await cliStatus.refreshCli({ api: async () => ({ ok: true, status: 200, json: async () => CLI_OK }) });
  let hangAgents = false;
  let releaseHung;
  const ctx = {
    api: async (pathname) => {
      if (pathname.startsWith("/api/cli")) return { ok: true, status: 200, json: async () => CLI_OK };
      if (pathname.startsWith("/api/agents")) {
        if (hangAgents) return { ok: true, status: 200, json: () => new Promise((ok) => { releaseHung = () => ok({ agents: [{ name: "b-soul", work: "worktree", agentsRoot: "/b" }] }); }) };
        return { ok: true, status: 200, json: async () => ({ agents: [{ name: "b-soul", work: "worktree", agentsRoot: "/b" }] }) };
      }
      if (pathname.startsWith("/api/panel")) return { ok: true, status: 200, json: async () => ({ instances: [], workspace: { id: "wsB" }, workspaces: [] }) };
      throw new Error(`unexpected ${pathname}`);
    },
    openTerminal: () => {},
  };
  const prevWs = common.currentWorkspace();
  t.after(() => {
    spawn.unmount();
    common.setWorkspace(prevWs || "");
    globalThis.document = oldDoc; globalThis.window = oldWin;
    dom.window.close();
  });
  common.setWorkspace("wsB");
  hangAgents = true; // the mount's roster fetch hangs — preselect must DEFER
  spawn.mount(dom.window.document.getElementById("host"), ctx);
  await tick();
  spawn.preselectSoul({ name: "b-soul", agentsRoot: "/b" });
  assert.equal(dom.window.document.querySelector(".spawn-dialog"), null, "deferred while the roster hangs");
  // navigate away before the roster resolves — the deferred intent must die
  spawn.unmount();
  releaseHung?.();
  await tick(); await tick();
  // return to Spawn in the SAME workspace generation
  hangAgents = false;
  spawn.mount(dom.window.document.getElementById("host"), ctx);
  await tick(); await tick();
  assert.match(dom.window.document.body.textContent, /b-soul/, "remounted roster painted");
  assert.equal(dom.window.document.querySelector(".spawn-dialog"), null,
    "a preselect deferred before unmount must never pop a modal on remount");
});

test("preselect of an attached soul hidden by an active filter clears the filter, so back focuses the revealed card", async (t) => {
  const { dom, doc, spawn } = await mountSpawn(t);
  const filter = doc.querySelector(".filter");
  filter.value = "ux"; // excludes "reviewer"
  filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal([...doc.querySelectorAll(".soul-card")].some((c) => c.dataset.agent === "reviewer"), false, "filter hides the card");
  spawn.preselectSoul({ name: "reviewer", agentsRoot: "/r1" });
  assert.equal(doc.querySelector(".spawn-dialog"), null, "attached soul never opens a modal");
  assert.equal(filter.value, "", "filter cleared to reveal the card");
  onPage(doc, "reviewer").querySelector(".inspector-back").click();
  assert.equal(doc.activeElement?.dataset?.agent, "reviewer", "revealed card focused");
});

test("preselect with the CLI unavailable and a hiding filter reveals the card; back focuses it", async (t) => {
  const { dom, doc, spawn } = await mountSpawn(t, { cliOk: false });
  const filter = doc.querySelector(".filter");
  filter.value = "reviewer"; // excludes "ux-designer"
  filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  spawn.preselectSoul({ name: "ux-designer" });
  assert.equal(doc.querySelector(".spawn-dialog"), null, "no modal without a verified CLI");
  assert.equal(filter.value, "", "filter cleared");
  onPage(doc, "ux-designer").querySelector(".inspector-back").click();
  assert.equal(doc.activeElement?.dataset?.agent, "ux-designer");
});

test("palette remote terminal actions preserve server and home, and label unknown state", () => {
  const opened = [];
  const rows = paletteRows([
    { instance: "dev", server: "one", home: "/same", running: true },
    { instance: "dev", server: "two", home: "/same", running: null },
  ], [], "dev", { openTerminal: (ref) => opened.push(ref) });
  for (const row of rows) row.run();
  assert.deepEqual(opened.map((r) => r.server).sort(), ["one", "two"]);
  assert.ok(opened.every((r) => r.home === "/same"));
  const unknown = rows.find((r) => r.detail.includes("two"));
  assert.match(unknown.detail, /unknown/);
  assert.equal(unknown.state, "unknown", "drawn as the sidebar's unknown dot (#1383), never a command's chevron");
});
