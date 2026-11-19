// CLI degradation card + Spawn-view disable behavior (desktop-dist contract:
// without a compatible oats CLI, reads work, mutation UI is consistently
// disabled behind ONE card with detected/required/Choose/Retry/docs/install).
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const cs = await import("../renderer/views/cli-status.mjs");
const sp = await import("../renderer/views/spawn.mjs");
// Launch now belongs to the selected-soul inspector, not every grid card.
function selectSoul(el, index = 0) {
  const card = el.querySelectorAll(".soul-card")[index];
  assert.ok(card, "read-only soul card renders");
  card.click();
  const launch = el.querySelector(".workspace-soul-page .spawn-act");
  assert.ok(launch, "selected-soul inspector exposes Launch");
  return launch;
}

function dom() {
  const d = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  return d.window.document;
}
const payload = (ok, extra = {}) => ({
  ok, bin: ok ? "/usr/local/bin/oats" : null, version: ok ? "0.22.0" : null,
  source: ok ? "path" : null, required: { desktopApi: 1, range: ">=0.22.0 <0.23.0" },
  install: "npm install -g @awebai/oats@0.22.0",
  probedAt: 1, tried: ok ? [] : [{ path: "/old/oats", source: "path", reason: "version 0.21.6 outside >=0.22.0 <0.23.0", version: "0.21.6" }],
  ...extra,
});
// Match the current shell: ctx.api resolves the already-parsed domain body.
// cli-status-parity.test.mjs checks this against the Response-shaped harness.
const jsonCtx = (state) => ({
  api: async (pathname, opts) => pathname === "/api/cli" ? state.get : (state.reprobes.push(opts?.body || null), state.post),
});

test("cli-status: a RECEIVED 404 (absent endpoint) settles as unavailable and cards; transport failure stays transient (review 6b90702)", async () => {
  // Older backend: /api/cli does not exist → the endpoint 404s. That is a
  // SETTLED absent-endpoint state and must card from pristine state.
  cs.resetCliStateForTests();
  const notFoundCtx = { api: async () => ({ ok: false, status: 404, json: async () => ({ error: "not found" }) }) };
  await cs.refreshCli(notFoundCtx);
  assert.equal(cs.cliAvailable(), false);
  assert.equal(cs.cliKnownUnavailable(), true, "404 settles → recovery card shows (absent endpoint case)");
  // shell-proxy shape: api() throws a status-tagged Error on non-2xx — same settling
  cs.resetCliStateForTests();
  const proxy404Ctx = { api: async () => { const e = new Error("HTTP 404 for /api/cli"); e.status = 404; throw e; } };
  await cs.refreshCli(proxy404Ctx);
  assert.equal(cs.cliKnownUnavailable(), true, "status-tagged proxy error settles too");
  // TRANSPORT failure (no status tag) from pristine state: stays pending —
  // no card, and mutations stay disabled (fail-closed).
  cs.resetCliStateForTests();
  const downCtx = { api: async () => { throw new Error("fetch failed: ECONNREFUSED"); } };
  await cs.refreshCli(downCtx);
  assert.equal(cs.cliStatus(), null);
  assert.equal(cs.cliKnownUnavailable(), false, "transport failure is transient — not carded");
  assert.equal(cs.cliAvailable(), false, "but mutations stay disabled (fail-closed)");
  // and a transport failure AFTER a settled state keeps that state (no flapping)
  const state = { get: payload(false), post: payload(false), reprobes: [] };
  await cs.refreshCli(jsonCtx(state));
  assert.equal(cs.cliKnownUnavailable(), true);
  await cs.refreshCli(downCtx);
  assert.equal(cs.cliKnownUnavailable(), true, "settled state survives a transient blip");
});

test("refreshCli/reprobeCli update shared state and notify subscribers", async () => {
  cs.resetCliStateForTests(); // subscribers hear CHANGES: start from probe-pending, not the previous test's state
  const state = { get: payload(false), post: payload(true), reprobes: [] };
  const ctx = jsonCtx(state);
  const seen = [];
  const off = cs.onCliChange((s) => seen.push(s?.ok));
  await cs.refreshCli(ctx);
  assert.equal(cs.cliAvailable(), false);
  await cs.reprobeCli(ctx);
  assert.equal(cs.cliAvailable(), true);
  assert.deepEqual(seen, [false, true]);
  // The same CLI probed again (fresh probedAt, as every /api/cli response
  // carries) is not a change: nobody is told, nothing is wiped.
  state.post = payload(true, { probedAt: 2 });
  await cs.reprobeCli(ctx);
  assert.equal(cs.cliAvailable(), true);
  assert.deepEqual(seen, [false, true], "identical reprobe must not notify");
  off();
});

test("reprobeCli posts {} and names no binary, whatever it is given", async () => {
  const state = { get: payload(false), post: payload(true), reprobes: [] };
  await cs.reprobeCli(jsonCtx(state), "/chosen/oats");
  assert.deepEqual(state.reprobes, ["{}"]);
});

test("cliCard renders the full contract surface: detected, required, Choose, Retry, docs, copyable install", async () => {
  const doc = dom();
  const state = { get: payload(false), post: payload(false), reprobes: [] };
  await cs.refreshCli(jsonCtx(state));
  let chosen = 0, opened = null;
  const order = [];
  const ctx = {
    api: async (pathname, opts) => { if (pathname === "/api/cli/reprobe") order.push(["reprobe", opts?.body]); return jsonCtx(state).api(pathname, opts); },
    chooseCliBinary: async () => { chosen++; await new Promise((r) => setTimeout(r, 1)); order.push("picked"); return { path: "/picked/oats" }; },
    openExternal: (url) => { opened = url; },
  };
  const { el, dispose } = cs.cliCard(doc, ctx);
  doc.body.append(el);
  // detected path + version from diagnostics
  assert.ok(el.textContent.includes("/old/oats"), "detected path shown");
  assert.ok(el.textContent.includes("0.21.6"), "detected version shown");
  // required range + api
  assert.ok(el.textContent.includes(">=0.22.0 <0.23.0"), "required range shown");
  // copyable install command — the BACKEND's derived, version-pinned one
  assert.ok(el.querySelector(".cli-cmd").textContent.includes("npm install -g @awebai/oats@0.22.0"));
  assert.ok(el.querySelector(".cli-copy"), "copy affordance present");
  // actions
  const choose = el.querySelector(".cli-choose");
  const retry = el.querySelector(".cli-retry");
  assert.ok(choose && !choose.disabled, "Choose oats… enabled when the picker hook exists");
  assert.ok(retry, "Retry present");
  // docs link opens externally, never navigates the shell
  el.querySelector(".cli-docs").dispatchEvent(new doc.defaultView.Event("click", { bubbles: true, cancelable: true }));
  assert.equal(opened, cs.DOCS_URL);
  // choose runs the picker (main writes the choice file) and, once it resolved, reprobes with {}: the path is never sent
  choose.dispatchEvent(new doc.defaultView.Event("click"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(chosen, 1);
  assert.deepEqual(order, ["picked", ["reprobe", "{}"]], "the reprobe follows the picker and names no binary");
  assert.ok(!state.reprobes.some((b) => String(b).includes("/picked/oats")), "the picked path is never posted");
  dispose();
});

test("cliCard without a picker hook disables Choose but keeps Retry/docs usable", async () => {
  const doc = dom();
  const state = { get: payload(false), post: payload(false), reprobes: [] };
  await cs.refreshCli(jsonCtx(state));
  const { el, dispose } = cs.cliCard(doc, jsonCtx(state));
  assert.equal(el.querySelector(".cli-choose").disabled, true);
  assert.ok(!el.querySelector(".cli-retry").disabled);
  dispose();
});

// The card must never RESTATE an enforced value. A renderer-side copy of the
// band or of a pinned version drifts silently — that is how the card came to
// advertise @0.18.2 while requiring 0.18.6 for relations (review bbfec1a).
test("cliCard states the requirement from the payload and never invents one when the payload is absent", async () => {
  const doc = dom();
  // SETTLED-UNKNOWN: a legacy/garbage payload arrived — nothing to read.
  await cs.refreshCli({ api: async () => ({ ok: true, status: 200, json: async () => ({ some: "legacy-shape" }) }) });
  assert.equal(cs.cliStatus(), null, "precondition: settled unknown");
  const { el, dispose } = cs.cliCard(doc, { api: async () => ({ ok: true, status: 200, json: async () => ({ some: "legacy-shape" }) }) });
  assert.match(el.textContent, /unknown/, "an unreadable requirement says so");
  assert.doesNotMatch(el.textContent, /no oats binary found/, "unreadable diagnostics cannot establish absence");
  assert.ok(!/>=\d+\.\d+\.\d+/.test(el.textContent), "no band is fabricated for a state that never received one");
  assert.equal(el.querySelector(".cli-cmd").textContent.trim(), cs.GENERIC_INSTALL_COMMAND);
  assert.ok(!/@\d+\.\d+\.\d+/.test(el.querySelector(".cli-cmd").textContent), "no version is fabricated either");
  dispose();
});

/* ── A Desktop older than the CLI it found (#1107): since #1879 only a newer desktop API (desktopApi > 1). A CLI
   of a later minor is accepted, with the notice instead (above-tested-notice.test.mjs). ── */

const RANGE = ">=0.26.0, tested through 0.69", INSTALL = "npm install -g @awebai/oats@0.55.1";
const refused = (entries, extra = {}) => ({ ok: false, bin: null, version: null, source: null, required: { desktopApi: 1, range: RANGE }, install: INSTALL, probedAt: 1, tried: entries, ...extra });
const NEWER = { path: "/new/oats", source: "path", reason: "desktopApi 2 (need 1)", version: "0.70.2", newerApi: true };
const words = (node) => node.textContent.replace(/\s+/g, " ").trim();
async function card(payloadToShow) {
  const doc = dom();
  const state = { get: payloadToShow, post: payloadToShow, reprobes: [] };
  await cs.refreshCli(jsonCtx(state));
  const mounted = cs.cliCard(doc, { ...jsonCtx(state), chooseCliBinary: async () => null, openExternal: () => {} });
  doc.body.append(mounted.el);
  // The shared status goes back to probe-pending with the card: later tests read it as they found it.
  return { doc, el: mounted.el, dispose() { mounted.dispose(); cs.resetCliStateForTests(); } };
}
/** The card's controls in Tab order (no tabindex is set: document order). */
const tabOrder = (el) => [...el.querySelectorAll("button:not([disabled]), a[href], [tabindex]")].map((n) => n.className);

test("cliCard, a CLI of a newer desktop API: the Desktop is the older, with no install command and no Copy, and Tab goes from Detected to Choose", async () => {
  const { el, dispose } = await card(refused([NEWER]));
  try {
    assert.equal(words(el.querySelector(".cli-head")), "This Desktop is older than the installed oats CLI");
    assert.equal(el.querySelector(".cli-head code").textContent, "oats");
    assert.equal(words(el.querySelector(".cli-explanation")), "The installed oats CLI is 0.70.2, which speaks a newer desktop API than this Desktop's (1). Install OATS Desktop 0.70.2 to use it; reads and terminals keep working meanwhile.");
    // Detected and Required as today.
    assert.ok(words(el.querySelector(".cli-kv")).includes("Detected /new/oats (0.70.2)"));
    assert.ok(words(el.querySelector(".cli-kv")).includes(`Required ${RANGE} with desktop API 1`));
    // No command to downgrade the CLI, and nothing to copy.
    assert.equal(el.querySelector(".cli-install"), null); assert.equal(el.querySelector(".cli-cmd"), null); assert.equal(el.querySelector(".cli-copy"), null);
    assert.ok(!el.textContent.includes("npm install"), "no npm command anywhere on the card");
    // Choose, Retry and the docs link stay, and are the card's controls in Tab order.
    assert.deepEqual(tabOrder(el), ["act cli-choose", "act cli-retry", "cli-docs"]);
  } finally { dispose(); }
});

test("cliCard: every other state keeps today's heading, explanation, install command and Copy, in today's Tab order", async () => {
  const entry = (version, reason) => ({ path: "/x/oats", source: "path", reason, ...(version === undefined ? {} : { version }) });
  const STATES = [
    ["below the floor", refused([entry("0.25.9", `version 0.25.9 outside ${RANGE}`)])],
    ["unparsable", refused([entry("0.56", 'unparsable version "0.56"')])],
    ["a prerelease above", refused([entry("0.70.0-rc.1", `prerelease version 0.70.0-rc.1 not accepted (need a released ${RANGE})`)])],
    ["a desktop API that is missing, not newer", refused([entry("0.70.0", "desktopApi missing (need 1)")])],
    ["not the oats CLI", refused([entry("0.70.0", "not the oats CLI (name: @other/pkg, not @awebai/oats or @oats-project/oats)")])],
    ["no CLI found", refused([])],
    ["a probe that failed", refused([entry(undefined, "probe failed: timeout")])],
    // The band's old flag (a backend before #1879) is no newer API; nor is a newer API on a candidate not shown.
    ["the old flag of a CLI above the band", refused([{ ...entry("0.70.2", "version 0.70.2 outside >=0.26.0 <0.70.0"), above: true }])],
    ["a newer API, but an earlier candidate is the one shown", refused([entry("0.21.5", `version 0.21.5 outside ${RANGE}`), NEWER])],
  ];
  for (const [name, shown] of STATES) {
    const { el, dispose } = await card(shown);
    try {
      assert.equal(words(el.querySelector(".cli-head")), "Compatible oats CLI required", name);
      assert.equal(words(el.querySelector(".cli-explanation")), "Spawn, Start and other changes run through the installed oats CLI. Reads and terminals keep working without it.", name);
      assert.equal(el.querySelector(".cli-cmd")?.textContent, INSTALL, name);
      assert.ok(el.querySelector(".cli-copy"), name);
      assert.deepEqual(tabOrder(el), ["act cli-copy", "act cli-choose", "act cli-retry", "cli-docs"], name);
    } finally { dispose(); }
  }
});

test("cliCard, a CLI of a newer desktop API: the version enters the sentence through the display filter, as text", async () => {
  const { el, dispose } = await card(refused([{ ...NEWER, version: "<b>0.70.2</b>\nmore" }]));
  try {
    assert.equal(el.querySelector(".cli-explanation b"), null, "markup stays text");
    assert.ok(words(el.querySelector(".cli-explanation")).startsWith("The installed oats CLI is <b>0.70.2</b> more, which"), "one display line");
  } finally { dispose(); }
});

test("cli-status: install/requirement helpers prefer the backend payload, fall back version-lessly", () => {
  const withPayload = { required: { desktopApi: 1, range: ">=0.22.0 <0.23.0" }, install: "npm install -g @awebai/oats@0.22.0" };
  assert.equal(cs.cliInstallCommand(withPayload), "npm install -g @awebai/oats@0.22.0");
  assert.equal(cs.cliRequirementText(withPayload), ">=0.22.0 <0.23.0 with desktop API 1");
  for (const absent of [null, undefined, {}, { install: "" }, { required: {} }]) {
    assert.equal(cs.cliInstallCommand(absent), cs.GENERIC_INSTALL_COMMAND);
    assert.match(cs.cliRequirementText(absent), /unknown/);
  }
});

test("cli-status: a cached unavailable state transitions to UNKNOWN on an invalid/legacy payload (review d7becaf)", async () => {
  // unavailable → legacy/garbage response → unknown → mutation UI stays disabled
  const state = { get: payload(false), post: payload(false), reprobes: [] };
  await cs.refreshCli(jsonCtx(state));
  assert.equal(cs.cliAvailable(), false);
  assert.ok(cs.cliStatus(), "unavailable state cached");
  state.get = { some: "legacy-shape" };            // older server: no boolean ok
  await cs.refreshCli(jsonCtx(state));
  assert.equal(cs.cliStatus(), null, "invalid payload transitions to unknown — stale unavailable NOT kept");
  assert.equal(cs.cliAvailable(), false, "unknown is not 'available' — it is uncommitted");
});

test("spawn view: PENDING probe disables card-less; SETTLED unknown/unavailable always shows the recovery card (binding UX)", async () => {
  const doc = dom();
  globalThis.document = doc;
  try {
    const agents = [{ name: "dev", description: "d", kind: "persistent", work: "worktree", runtime: "pi", repo: "/r", repoName: "r", agentsRoot: "/ws/agents", workspace: "/ws" }];
    // /api/cli HANGS first (probe pending), then answers legacy garbage
    // (settled unknown), then unavailable, then compatible.
    const state = { mode: "pending", posts: [], cliWaiters: [] };
    const ctx = {
      api: (pathname, opts) => {
        if (pathname === "/api/cli" && state.mode === "pending") {
          return new Promise((ok) => state.cliWaiters.push(ok)); // never settles while pending
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => {
            if (pathname.startsWith("/api/agents")) return { workspace: { id: "/ws", name: "ws" }, agents };
            if (pathname.startsWith("/api/panel")) return { workspace: { id: "/ws", name: "ws" }, workspaces: [{ id: "/ws", name: "ws" }], instances: [] };
            if (pathname === "/api/cli") return state.mode === "legacy" ? { legacy: true } : state.mode === "bad" ? payload(false) : payload(true);
            if (pathname === "/api/spawn") { state.posts.push(opts); return { spawned: true, instance: "dev-x" }; }
            return {};
          },
        });
      },
      openTerminal: () => {}, openBrain: () => {},
    };
    // reset shared state to truly-pending: a hanging refresh keeps cli null
    cs.resetCliStateForTests();
    const el = doc.createElement("div"); doc.body.append(el);
    sp.mount(el, ctx);
    await new Promise((r) => setTimeout(r, 20));
    // TRANSIENT probe-pending: disabled, card-less is acceptable
    const spawnBtn = selectSoul(el);
    assert.ok(spawnBtn, "spawn button renders");
    assert.equal(spawnBtn.disabled, true, "pending probe disables spawn (mutations need a VERIFIED CLI)");
    spawnBtn.dispatchEvent(new doc.defaultView.Event("click"));
    assert.equal(el.querySelector(".spawn-form"), null, "no form opens while pending");
    // SETTLED unknown (legacy/malformed payload) → card MUST appear
    state.mode = "legacy";
    await cs.refreshCli(ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(el.querySelectorAll(".cli-card").length, 1, "settled unknown shows the recovery card (binding UX)");
    assert.ok([...el.querySelectorAll(".spawn-act")].every((b) => b.disabled), "spawn stays disabled");
    // SETTLED unavailable → card stays, still disabled
    state.mode = "bad";
    await cs.refreshCli(ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(el.querySelectorAll(".cli-card").length, 1, "known-unavailable keeps the card");
    assert.equal(state.posts.length, 0, "no spawn was ever dispatched");
    // recovery: a compatible probe re-enables and opens forms again
    state.mode = "good";
    await cs.refreshCli(ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(el.querySelectorAll(".cli-card").length, 0, "card clears on recovery");
    const btn2 = el.querySelector(".spawn-act");
    assert.ok(btn2 && !btn2.disabled, "verified CLI re-enables spawn");
    btn2.dispatchEvent(new doc.defaultView.Event("click"));
    assert.ok(el.querySelector(".spawn-form"), "form opens once the CLI is verified");
    sp.unmount();
    state.cliWaiters.forEach((ok) => ok({ ok: false, status: 599, json: async () => ({}) })); // release hangs
  } finally {
    sp.unmount(); doc.defaultView.close();
    delete globalThis.document;
  }
});


test("doSpawn gate isolation: selection still set + CLI unavailable → no dispatch (review 0b83988)", async () => {
  // The realistic race the render-time bypass cannot cover: the CLI flips
  // unavailable but the view listener has not yet repainted (or a stale
  // closure retains the old state object with selAgent SET). Only the
  // doSpawn submit-time gate blocks the POST here — deleting the gate
  // makes this test dispatch.
  const doc = dom();
  globalThis.document = doc;
  try {
    const posts = [];
    const ctx = {
      api: async (pathname, opts) => ({
        ok: true, status: 200,
        json: async () => {
          if (pathname === "/api/spawn") { posts.push(opts); return { spawned: true, instance: "dev-x" }; }
          if (pathname === "/api/cli") return payload(false);           // KNOWN unavailable
          if (pathname.startsWith("/api/panel")) return { workspace: { id: "/ws" }, workspaces: [], instances: [] };
          return {};
        },
      }),
      openTerminal: () => {},
    };
    cs.resetCliStateForTests();
    await cs.refreshCli(ctx);                                           // settled unavailable
    assert.equal(cs.cliAvailable(), false);
    // fabricated state exactly as a stale closure would hold it: selection SET
    const grid = doc.createElement("div"); grid.className = "souls-grid"; doc.body.append(grid);
    const s = {
      ctx, alive: true, spawnOp: 0, sel: "dev", filterText: "",
      selAgent: { name: "dev", agentsRoot: "/ws/agents" },
      souls: { agents: [] },
      q: () => grid,
      waitOpts: { tries: 1, delayMs: 1, sleep: async () => {} },
    };
    const btn = doc.createElement("button");
    const status = doc.createElement("span");
    await sp.doSpawn(s, { server: "host", task: "t", status: () => {} });
    assert.equal(posts.length, 0, "submit-time gate blocked the dispatch despite a live selection");
    assert.equal(s.sel, null, "gate invalidates the stale selection");
    // control: same fabricated state dispatches once the CLI is verified
    s.sel = "dev"; s.selAgent = { name: "dev", agentsRoot: "/ws/agents" };
    const okCtx = { ...ctx, api: async (pathname, opts) => ({ ok: true, status: 200, json: async () => {
      if (pathname === "/api/spawn") { posts.push(opts); return { spawned: true, instance: "dev-x" }; }
      if (pathname === "/api/cli") return { ...payload(true), remote: ["spawn"] };
      if (pathname.startsWith("/api/panel")) return { workspace: { id: "/ws" }, workspaces: [], instances: [{ instance: "dev-x" }] };
      return {};
    } }) };
    s.ctx = okCtx;
    await cs.refreshCli(okCtx);
    await sp.doSpawn(s, { server: "host", task: "t", status: () => {} });
    assert.equal(posts.length, 1, "control: gate open under a verified CLI — the gate was the blocker");
  } finally {
    sp.unmount(); doc.defaultView.close();
    delete globalThis.document;
  }
});

test("spawn view: an UNSETTLED probe explains itself (no dead button pointing at a missing card) and the poll keeps retrying /api/cli until it settles", async () => {
  const doc = dom();
  globalThis.document = doc;
  // Capture the view's poll tick so the retry runs without real 8s waits.
  const realSetInterval = globalThis.setInterval;
  const ticks = [];
  globalThis.setInterval = (fn) => { ticks.push(fn); return realSetInterval(() => {}, 1 << 30); };
  try {
    const agents = [{ name: "dev", description: "d", kind: "persistent", work: "worktree", runtime: "pi", repo: "/r", repoName: "r", agentsRoot: "/ws/agents", workspace: "/ws" }];
    // /api/cli fails at TRANSPORT level first (backend booting — e.g. the
    // request raced server startup), then recovers. The probe stays
    // UNSETTLED (null, card-less) until a response arrives.
    const state = { cliDown: true, cliFetches: 0 };
    const ctx = {
      api: async (pathname) => {
        if (pathname === "/api/cli") {
          state.cliFetches++;
          if (state.cliDown) throw new Error("fetch failed: ECONNREFUSED"); // no .status → transport
          return { ok: true, status: 200, json: async () => payload(true) };
        }
        return {
          ok: true, status: 200,
          json: async () => {
            if (pathname.startsWith("/api/agents")) return { workspace: { id: "/ws", name: "ws" }, agents };
            if (pathname.startsWith("/api/panel")) return { workspace: { id: "/ws", name: "ws" }, workspaces: [{ id: "/ws", name: "ws" }], instances: [] };
            return {};
          },
        };
      },
      openTerminal: () => {}, openBrain: () => {},
    };
    cs.resetCliStateForTests();
    const el = doc.createElement("div"); doc.body.append(el);
    sp.mount(el, ctx);
    await new Promise((r) => setTimeout(r, 20));
    // Unsettled: disabled + card-less — the tooltip must NOT reference a
    // card that is not there; it says the probe is still checking.
    const btn = selectSoul(el);
    assert.ok(btn, "spawn button renders");
    assert.equal(btn.disabled, true, "unsettled probe disables spawn (fail-closed)");
    assert.equal(el.querySelector(".cli-card"), null, "pending is card-less by design");
    assert.match(btn.title, /[Cc]hecking/, "tooltip explains the probe is pending");
    assert.doesNotMatch(btn.title, /card above/, "tooltip must not point at a missing card");
    // The poll retries the CLI probe while unsettled…
    const before = state.cliFetches;
    for (const t of ticks) t();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(state.cliFetches > before, "poll re-fetches /api/cli while the probe is unsettled");
    // …and once the backend answers, spawn enables without any user action.
    state.cliDown = false;
    for (const t of ticks) t();
    await new Promise((r) => setTimeout(r, 20));
    const btn2 = el.querySelector(".spawn-act");
    assert.ok(btn2 && !btn2.disabled, "spawn enables once the probe settles ok");
    assert.match(btn2.textContent, /^Spawn$/, "explicit launch affordance (the soul page's Spawn, human 2026-09-26) remains available");
    // settled state: the retry stops (no more /api/cli fetches from the tick)
    const settled = state.cliFetches;
    for (const t of ticks) t();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(state.cliFetches, settled, "no further CLI re-probes once settled");
    sp.unmount();
  } finally {
    sp.unmount(); doc.defaultView.close();
    globalThis.setInterval = realSetInterval;
    delete globalThis.document;
  }
});

test("spawn view: no compatible CLI disables every spawn button and shows ONE card; reads stay rendered", async () => {
  const doc = dom();
  globalThis.document = doc; // spawn.mjs builds DOM via the global document
  try {
    const state = { get: payload(false), post: payload(false), reprobes: [] };
    const agents = [
      { name: "dev", description: "a dev", kind: "persistent", work: "worktree", runtime: "pi", repo: "/r", repoName: "r", agentsRoot: "/ws/agents", workspace: "/ws" },
      { name: "helper", description: "cap", kind: "capability", work: "checkout", runtime: "pi", repo: null, repoName: "ws", agentsRoot: "/ws/agents", workspace: "/ws" },
    ];
    const ctx = {
      api: async (pathname) => {
        if (pathname.startsWith("/api/agents")) return { workspace: { id: "/ws", name: "ws" }, agents };
        if (pathname.startsWith("/api/panel")) return { workspace: { id: "/ws", name: "ws" }, workspaces: [{ id: "/ws", name: "ws" }], instances: [] };
        if (pathname === "/api/cli") return state.get;
        if (pathname === "/api/cli/reprobe") return state.post;
        return {};
      },
      openTerminal: () => {}, openBrain: () => {},
    };
    const el = doc.createElement("div"); doc.body.append(el);
    sp.mount(el, ctx);
    await new Promise((r) => setTimeout(r, 20));
    // one consistent card, above a STILL-RENDERED roster (reads keep working)
    assert.equal(el.querySelectorAll(".cli-card").length, 1, "exactly one degradation card");
    const cliCard = el.querySelector(".cli-card");
    assert.match(cliCard.textContent, /\/old\/oats/, "parsed diagnostics survive into the actual Spawn card");
    assert.match(cliCard.textContent, /0\.21\.6/);
    assert.equal(cliCard.querySelector(".cli-cmd").textContent, state.get.install);
    assert.doesNotMatch(cliCard.textContent, /no oats binary found/);
    const cards = [...el.querySelectorAll(".soul-card")];
    assert.equal(cards.length, 2, "soul cards (reads) still render");
    for (let i = 0; i < cards.length; i++) {
      const launch = selectSoul(el, i);
      assert.equal(launch.disabled, true, "each selected soul's Launch is disabled");
      assert.match(launch.title, /OATS CLI/i, "tooltip explains the CLI requirement");
      launch.dispatchEvent(new doc.defaultView.Event("click"));
      assert.equal(el.querySelector(".soul-form"), null, "no spawn form opens without a CLI");
      const files = el.querySelector(".workspace-soul-page .brain-act");
      assert.ok(files && !files.disabled, "read-only Files remains usable");
    }
    // CLI becomes available → card disappears, buttons enable (same subscribe path)
    state.get = payload(true);
    await cs.refreshCli(ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(el.querySelectorAll(".cli-card").length, 0, "card removed once compatible");
    assert.equal(selectSoul(el).disabled, false, "Launch re-enabled");
    sp.unmount();
  } finally {
    sp.unmount(); doc.defaultView.close();
    delete globalThis.document;
  }
});
