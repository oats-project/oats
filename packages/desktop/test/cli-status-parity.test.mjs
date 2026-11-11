// Actual CLI status/card boundary: shell-parsed bodies versus Fetch Responses.
// All I/O is injected; no servers, CLI processes, native pickers or installs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { httpError } from "../renderer/views/common.mjs";
import * as cs from "../renderer/views/cli-status.mjs";
import { scopedRequest } from "../renderer/workspace-routes.mjs";

const source = readFileSync(new URL("../renderer/views/cli-status.mjs", import.meta.url), "utf8");
const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
// Exercise the shipped shell adapter without booting the shell or its services.
const apiSource = shell.match(/async function api\(pathname, opts\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(apiSource, "current-shell API seam is present");
// A window bound to its workspace (#481): the no-workspace guard lets every request through.
const shellApi = (desk) => new Function("desk", "httpError", "windowState", "scopedRequest", `${apiSource}; return api;`)(desk, httpError, () => "bound", scopedRequest);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const unavailable = (name = "old") => ({
  ok: false, bin: null, version: null,
  tried: [{ path: `/${name}/oats`, version: "0.21.6" }],
  required: { range: ">=0.22.0 <0.23.0", desktopApi: 7 },
  install: "npm install -g @awebai/oats@0.22.19",
});
const compatible = { ...unavailable(), ok: true, bin: "/current/oats", version: "0.22.19", tried: [], relations: true };
const reply = (body, status = 200) => ({ body, status });
function context(shape, read) {
  const bridge = async (...args) => {
    const r = await read(...args);
    return { ...r, ok: r.status >= 200 && r.status < 300 };
  };
  return { api: shape === "parsed" ? shellApi({ api: bridge }) : async (...args) => {
    const r = await bridge(...args);
    return new Response(r.raw ?? JSON.stringify(r.body), { status: r.status });
  } };
}
function card(mod, ctx) {
  const d = new JSDOM("<!doctype html><body></body>", { url: "http://127.0.0.1/" });
  const handle = mod.cliCard(d.window.document, ctx);
  d.window.document.body.append(handle.el);
  return { ...handle, close() { handle.dispose(); d.window.close(); } };
}
function assertFacts(mod, el, expected) {
  assert.deepEqual(mod.cliStatus(), expected, "domain diagnostics must survive parsing");
  assert.equal(mod.cliAvailable(), false);
  assert.equal(mod.cliRelationsAvailable(), false);
  assert.equal(mod.cliKnownUnavailable(), true);
  assert.ok(el.textContent.includes(expected.tried[0].path), "card keeps reported path");
  assert.ok(el.textContent.includes(expected.tried[0].version), "card keeps reported version");
  assert.ok(el.textContent.includes(`${expected.required.range} with desktop API ${expected.required.desktopApi}`), "card keeps reported requirement");
  assert.equal(el.querySelector(".cli-cmd").textContent, expected.install, "card keeps backend-pinned install command");
  assert.doesNotMatch(el.textContent, /no oats binary found/);
  assert.match(el.textContent, /Reads and\s+terminals keep working/);
}
async function domainParity(shape, method, mod = cs) {
  mod.resetCliStateForTests();
  const expected = unavailable();
  const calls = [], seen = [];
  const ctx = context(shape, async (...args) => { calls.push(args); return reply(expected); });
  const c = card(mod, ctx);
  const off = mod.onCliChange(s => seen.push(s));
  try {
    await mod[method](ctx, method === "reprobeCli" ? "/chosen/oats" : undefined);
    assertFacts(mod, c.el, expected);
    assert.deepEqual(seen, [expected]);
    assert.deepEqual(calls, method === "refreshCli" ? [["/api/cli", undefined]] : [["/api/cli/reprobe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bin: "/chosen/oats" }),
    }]], "rendering never installs or dispatches extra requests");
  } finally { off(); c.close(); mod.resetCliStateForTests(); }
}
for (const shape of ["parsed", "response"]) {
  for (const method of ["refreshCli", "reprobeCli"]) {
    test(`${method}: ${shape} domain ok:false retains facts in the actual card`, () => domainParity(shape, method));
    test(`${method}: ${shape} current HTTP/malformed/transport failures have distinct settling semantics`, async () => {
      const failures = [
        ["transport", async () => { throw new TypeError("fetch failed"); }],
        ["404", async () => reply(compatible, 404)], // HTTP ok wins even over a plausible domain body
        ["503", async () => reply(unavailable(), 503)],
        ["legacy", async () => reply({ legacy: true })],
        ["null", async () => reply(null)],
        ["array", async () => reply([])],
        ["invalid ok", async () => reply({ ok: "true" })],
        ["non-JSON", async () => ({ ...reply({ raw: "not JSON" }), raw: "not JSON" })],
      ];
      for (const initial of [null, unavailable(), compatible]) {
        for (const [kind, read] of failures) {
          cs.resetCliStateForTests();
          if (initial) await cs.refreshCli(context(shape, async () => reply(initial)));
          const ctx = context(shape, read), c = card(cs, ctx);
          try {
            await cs[method](ctx);
            assert.deepEqual(cs.cliStatus(), kind === "transport" ? initial : null, kind);
            assert.equal(cs.cliAvailable(), kind === "transport" && initial?.ok === true, kind);
            assert.equal(cs.cliKnownUnavailable(), kind === "transport" ? initial?.ok === false : true, kind);
            if (kind === "transport" && initial?.ok === false) assertFacts(cs, c.el, initial);
            if (kind !== "transport") {
              assert.match(c.el.textContent, /unknown — no CLI detection reported/);
              assert.equal(c.el.querySelector(".cli-cmd").textContent, cs.GENERIC_INSTALL_COMMAND);
              assert.doesNotMatch(c.el.textContent, /no oats binary found/);
            }
          } finally { c.close(); }
        }
      }
      cs.resetCliStateForTests();
    });
  }
}

for (const shape of ["parsed", "response"]) {
  test(`${shape} actual Choose/Retry keep facts on a current transport failure`, async () => {
    cs.resetCliStateForTests();
    const expected = unavailable(), calls = [];
    await cs.refreshCli(context(shape, async () => reply(expected)));
    const ctx = context(shape, async (...args) => { calls.push(args); throw new TypeError("fetch failed"); });
    ctx.chooseCliBinary = async () => ({ path: "/not-yet-verified/oats" });
    const c = card(cs, ctx);
    try {
      c.el.querySelector(".cli-choose").click(); await tick();
      assertFacts(cs, c.el, expected);
      assert.match(c.el.querySelector(".cli-status").textContent, /Could not verify/);
      assert.doesNotMatch(c.el.textContent, /Chosen binary is not a compatible/);
      c.el.querySelector(".cli-retry").click(); await tick();
      assertFacts(cs, c.el, expected);
      assert.deepEqual(calls.map(([path, opts]) => [path, JSON.parse(opts.body)]), [
        ["/api/cli/reprobe", { bin: "/not-yet-verified/oats" }], ["/api/cli/reprobe", {}],
      ]);
    } finally { c.close(); cs.resetCliStateForTests(); }
  });
}

// #1879: /api/cli gains aboveTested and testedThrough; both shapes keep them, and the notice takes the card's place.
const aboveTested = { ...compatible, version: "0.23.1", aboveTested: true, testedThrough: "0.22", required: { range: ">=0.22.0, tested through 0.22", desktopApi: 1 } };
for (const shape of ["parsed", "response"]) {
  for (const method of ["refreshCli", "reprobeCli"]) {
    test(`${method}: ${shape} an accepted CLI above the tested bound keeps aboveTested and testedThrough, and shows the notice, not the card`, async () => {
      cs.resetCliStateForTests();
      const ctx = context(shape, async () => reply(aboveTested));
      const d = new JSDOM("<!doctype html><body></body>", { url: "http://127.0.0.1/" });
      const notice = cs.aboveTestedCard(d.window.document, ctx);
      try {
        await cs[method](ctx, method === "reprobeCli" ? "/chosen/oats" : undefined);
        assert.deepEqual(cs.cliStatus(), aboveTested);
        assert.equal(cs.cliAvailable(), true);
        assert.equal(cs.cliKnownUnavailable(), false, "no card");
        assert.equal(notice.el.hidden, false);
        assert.match(notice.el.querySelector(".cli-notice").textContent, /tested with oats CLIs up to 0\.22; the installed CLI is 0\.23\.1\./);
      } finally { notice.dispose(); d.window.close(); cs.resetCliStateForTests(); }
    });
  }
}

test("actual card tolerates incomplete diagnostics without inventing binary absence", async () => {
  const c = card(cs, {});
  try {
    for (const tried of [undefined, null, {}, "garbage", [null, {}], [{ path: "/failed/oats" }]]) {
      // Each shape is judged as a first settled payload: `tried` is locator
      // diagnostics outside the change signature, so a repeat from a settled
      // state would (by design) not repaint.
      cs.resetCliStateForTests();
      await cs.refreshCli({ api: async () => ({ ok: false, tried }) });
      assert.equal(cs.cliKnownUnavailable(), true);
      assert.match(c.el.textContent, /unknown/);
      assert.doesNotMatch(c.el.textContent, /no oats binary found|undefined|\[object Object\]/);
      if (Array.isArray(tried) && tried[0]?.path) assert.match(c.el.textContent, /candidate: \/failed\/oats/);
    }
    await cs.refreshCli({ api: async () => compatible });
    assert.match(c.el.textContent, /\/current\/oats/);
    assert.equal(cs.cliAvailable(), true);
  } finally { c.close(); cs.resetCliStateForTests(); }
});

function complete(waiter, outcome) {
  if (outcome === "transport") waiter.reject(new TypeError("old transport failure"));
  else if (outcome === "http") waiter.resolve(reply(compatible, 404));
  else if (outcome === "malformed") waiter.resolve(reply({ legacy: true }));
  else waiter.resolve(reply(outcome === "compatible" ? compatible : unavailable("obsolete")));
}
async function overlap(shape, first, second, outcome, mod = cs, olderFirst = false) {
  mod.resetCliStateForTests();
  const a = deferred(), b = deferred(), seen = [];
  const winner = unavailable("latest");
  const c = card(mod, {}), off = mod.onCliChange(s => seen.push(s));
  try {
    const old = mod[first](context(shape, () => a.promise));
    const latest = mod[second](context(shape, () => b.promise));
    if (olderFirst) {
      complete(a, outcome); await old;
      assert.equal(mod.cliStatus(), null, "older completion cannot settle while latest is pending");
      assert.equal(mod.cliKnownUnavailable(), false);
      assert.equal(seen.length, 0, "older completion cannot emit while latest is pending");
    }
    b.resolve(reply(winner)); await latest;
    const html = c.el.innerHTML;
    if (!olderFirst) { complete(a, outcome); await old; }
    assertFacts(mod, c.el, winner);
    assert.deepEqual(seen, [winner], "stale completion must not emit/repaint");
    assert.equal(c.el.innerHTML, html, "stale completion must not repaint the card");
  } finally { off(); c.close(); mod.resetCliStateForTests(); }
}
for (const shape of ["parsed", "response"]) {
  for (const first of ["refreshCli", "reprobeCli"]) {
    for (const second of ["refreshCli", "reprobeCli"]) {
      for (const outcome of ["unavailable", "compatible", "http", "malformed", "transport"]) {
        test(`${shape} ${first} → ${second}: older ${outcome} cannot replace latest status/card`, () => overlap(shape, first, second, outcome));
      }
    }
  }
}
for (const outcome of ["compatible", "transport"]) {
  test(`older ${outcome} is ignored even while newest request is pending`, () => overlap("parsed", "refreshCli", "reprobeCli", outcome, cs, true));
}

for (const outcome of ["resolve", "reject"]) {
  test(`request ownership extends across deferred Response.json() ${outcome}`, async () => {
    cs.resetCliStateForTests();
    const body = deferred(), entered = deferred();
    const old = cs.refreshCli({ api: async () => ({ ok: true, status: 200, json: () => { entered.resolve(); return body.promise; } }) });
    await entered.promise;
    const winner = unavailable("latest");
    await cs.reprobeCli({ api: async () => winner });
    if (outcome === "resolve") body.resolve(compatible); else body.reject(new SyntaxError("invalid JSON"));
    await old;
    assert.deepEqual(cs.cliStatus(), winner);
    cs.resetCliStateForTests();
  });
}

async function resetRace(outcome, mod = cs) {
  mod.resetCliStateForTests();
  const waiter = deferred(), seen = [];
  const old = mod.refreshCli(context("parsed", () => waiter.promise));
  mod.resetCliStateForTests();
  const off = mod.onCliChange(s => seen.push(s));
  try {
    complete(waiter, outcome); await old;
    assert.equal(mod.cliStatus(), null, "reset invalidates pending request");
    assert.equal(mod.cliKnownUnavailable(), false);
    assert.equal(seen.length, 0, "reset invalidates pending notification");
  } finally { off(); mod.resetCliStateForTests(); }
}
for (const outcome of ["compatible", "http", "transport"]) {
  test(`reset invalidates pending ${outcome}`, () => resetRace(outcome));
}

async function cardRace(boundary, outcome, mod = cs) {
  mod.resetCliStateForTests();
  await mod.refreshCli({ api: async () => unavailable() });
  const a = deferred(), b = deferred();
  const ctx = context("parsed", () => a.promise);
  ctx.chooseCliBinary = async () => ({ path: "/chosen/oats" });
  const c = card(mod, ctx);
  try {
    c.el.querySelector(".cli-retry").click();
    let expected;
    if (boundary === "dispose") {
      c.dispose(); // leave connected: disposal, not DOM removal, must be authoritative
      expected = c.el.innerHTML;
    } else if (boundary === "reset") {
      mod.resetCliStateForTests(); expected = c.el.innerHTML;
    } else {
      ctx.api = context("parsed", () => b.promise).api;
      c.el.querySelector(".cli-choose").click(); await tick();
      b.resolve(reply(unavailable("chosen"))); await tick();
      assert.equal(c.el.querySelector(".cli-status").textContent, "Could not verify a compatible oats CLI for this choice.");
      expected = c.el.innerHTML;
    }
    complete(a, outcome); await tick();
    assert.equal(c.el.innerHTML, expected, "obsolete card completion must not paint");
    if (boundary === "dispose" && outcome === "unavailable") {
      assert.equal(mod.cliStatus()?.tried[0].path, "/obsolete/oats", "shared probe outlives one card");
    }
  } finally { c.close(); mod.resetCliStateForTests(); }
}
for (const boundary of ["newer action", "reset", "dispose"]) {
  for (const outcome of ["unavailable", "http", "transport"]) {
    test(`Retry ${outcome} respects card ${boundary}`, () => cardRace(boundary, outcome));
  }
}

async function pickerRace(boundary, outcome, mod = cs) {
  mod.resetCliStateForTests();
  const picked = deferred(), calls = [];
  const ctx = { api: async (...args) => { calls.push(args); return unavailable(); }, chooseCliBinary: () => picked.promise };
  const c = card(mod, ctx);
  try {
    c.el.querySelector(".cli-choose").click();
    if (boundary === "dispose") c.dispose();
    else if (boundary === "reset") mod.resetCliStateForTests();
    else if (boundary === "refresh") await mod.refreshCli({ api: async () => unavailable("fresh") });
    else { c.el.querySelector(".cli-retry").click(); await tick(); }
    const before = c.el.innerHTML, count = calls.length;
    if (outcome === "resolve") picked.resolve({ path: "/obsolete-choice/oats" });
    else picked.reject(new Error("old picker failure"));
    await tick();
    assert.equal(calls.length, count, "obsolete picker must not dispatch reprobe");
    assert.equal(c.el.innerHTML, before, "obsolete picker must not paint");
  } finally { c.close(); mod.resetCliStateForTests(); }
}
for (const boundary of ["dispose", "reset", "refresh", "retry"]) {
  for (const outcome of ["resolve", "reject"]) {
    test(`Choose ${outcome} respects ${boundary} invalidation`, () => pickerRace(boundary, outcome));
  }
}

// Subscribers hear CHANGES. Every subscriber treats an emit as "the CLI
// changed" (the Workspace view wipes its capabilities catalog), and a
// window-focus reprobe of the same binary differs only in probedAt/tried.
async function emitOnChange(shape, mod = cs) {
  mod.resetCliStateForTests();
  const seen = [];
  const off = mod.onCliChange(s => seen.push(s));
  const refresh = body => mod.refreshCli(context(shape, async () => reply(body)));
  try {
    const first = { ...compatible, probedAt: 1, tried: [] };
    await refresh(first);
    assert.deepEqual(seen, [first], "the first settled payload always emits");
    await refresh({ ...compatible, probedAt: 2, tried: [{ path: "/old/oats", reason: "probe failed: spawn ETIMEDOUT" }], source: "login-shell" });
    assert.equal(seen.length, 1, "identical probe with fresh diagnostics must not emit");
    assert.equal(mod.cliStatus().probedAt, 2, "but the latest payload IS retained");
    await refresh({ ...compatible, probedAt: 3, version: "0.22.20" });
    assert.equal(seen.length, 2, "a changed version emits");
    assert.equal(seen[1].version, "0.22.20");
    await refresh({ ...compatible, probedAt: 4, version: "0.22.20", features: ["observe-max-age"] });
    assert.equal(seen.length, 3, "a declared feature emits");
    await mod.refreshCli(context(shape, async () => { throw new TypeError("fetch failed"); }));
    assert.equal(seen.length, 3, "transport failure keeps state and stays silent");
    assert.equal(mod.cliAvailable(), true);
    await refresh(unavailable());
    assert.equal(seen.length, 4, "ok → unavailable emits");
    assert.equal(mod.cliKnownUnavailable(), true);
    await refresh({ legacy: true });
    assert.equal(seen.length, 5, "unavailable → settled-unknown emits once");
    assert.deepEqual(seen[4], null);
    await refresh({ other: "garbage" }); await refresh(null); await refresh([]);
    assert.equal(seen.length, 5, "repeated garbage stays silent");
    assert.equal(mod.cliKnownUnavailable(), true);
    await refresh(unavailable());
    assert.equal(seen.length, 6, "settled-unknown → unavailable emits");
    await refresh(unavailable("other"));
    assert.equal(seen.length, 7, "with no accepted CLI a different failing candidate repaints the card's Detected line");
    await refresh({ ...unavailable("other"), probedAt: 9 });
    assert.equal(seen.length, 7, "the same failing candidate probed again stays silent");
  } finally { off(); mod.resetCliStateForTests(); }
}
for (const shape of ["parsed", "response"]) {
  test(`${shape} subscribers are notified on change only`, () => emitOnChange(shape));
}
test("reset notifies unconditionally, even from probe-pending", () => {
  cs.resetCliStateForTests();
  const seen = [];
  const off = cs.onCliChange(s => seen.push(s));
  try { cs.resetCliStateForTests(); assert.deepEqual(seen, [null]); } finally { off(); }
});
// Pending and settled-unknown share `cli === null`: the flip itself is the change.
async function unknownFromPending(mod = cs) {
  mod.resetCliStateForTests();
  const seen = [];
  const off = mod.onCliChange(s => seen.push(s));
  try {
    await mod.refreshCli({ api: async () => ({ legacy: true }) });
    assert.deepEqual(seen, [null], "pending → settled-unknown emits once (the card must appear)");
    assert.equal(mod.cliKnownUnavailable(), true);
    await mod.refreshCli({ api: async () => ({ other: 1 }) });
    assert.deepEqual(seen, [null], "repeated garbage stays silent");
  } finally { off(); mod.resetCliStateForTests(); }
}
test("pending → settled-unknown notifies exactly once", () => unknownFromPending());

// Bounded mutations of the exact shipped module, loaded only in memory.
// Each mutant must fail one of the behavioral assertions above, not a source check.
async function mutant(from, to) {
  assert.equal(source.split(from).length, 2, "mutation targets exactly one boundary");
  const changed = source.replace(from, to).replace(/from "(\.[^"]+)"/g, (_all, path) => `from ${JSON.stringify(new URL(path, new URL("../renderer/views/cli-status.mjs", import.meta.url)).href)}`);
  return import(`data:text/javascript;base64,${Buffer.from(changed).toString("base64")}`);
}
test("mutation: interpreting parsed domain ok:false as HTTP failure is caught", async () => {
  const mod = await mutant('if (!r || typeof r.json !== "function") return { received: true, body: r };', 'if (!r || typeof r.json !== "function") return r?.ok === false ? { received: true, error: true } : { received: true, body: r };');
  await assert.rejects(domainParity("parsed", "refreshCli", mod), /domain diagnostics must survive parsing/);
});
// A stale TRANSPORT completion is silent by construction (nothing received,
// nothing emitted), so only a stale RECEIVED completion can prove ownership.
test("mutation: request ownership is essential on stale compatible", async () => {
  const mod = await mutant('if (request !== requestGeneration) return cli;', '/* mutation: completion always commits */');
  await assert.rejects(overlap("parsed", "refreshCli", "reprobeCli", "compatible", mod), /domain diagnostics must survive parsing/);
});
test("mutation: real Response HTTP status cannot be ignored", async () => {
  const mod = await mutant('if (!r.ok) return { received: true, error: true, status: r.status };', '/* mutation: ignore HTTP status */');
  await mod.refreshCli(context("response", async () => reply(compatible, 503)));
  assert.throws(() => assert.equal(mod.cliAvailable(), false, "HTTP failure cannot verify a CLI"), /HTTP failure cannot verify a CLI/);
  mod.resetCliStateForTests();
});
test("mutation: each request must mint fresh ownership", async () => {
  const mod = await mutant('const request = ++requestGeneration;', 'const request = requestGeneration;');
  await assert.rejects(overlap("parsed", "reprobeCli", "refreshCli", "compatible", mod), /domain diagnostics must survive parsing/);
});
test("mutation: reset must advance request ownership", async () => {
  const mod = await mutant('++requestGeneration; cli = null;', 'cli = null;');
  await assert.rejects(resetRace("compatible", mod), /reset invalidates pending request/);
});
test("mutation: latest card action must own its completion message", async () => {
  const mod = await mutant('if (owns() && !cliAvailable() && el.isConnected)', 'if (!cliAvailable() && el.isConnected)');
  await assert.rejects(cardRace("newer action", "transport", mod), /obsolete card completion must not paint/);
});
test("mutation: disposal must invalidate a pending picker", async () => {
  const mod = await mutant('dispose() { alive = false; off(); }', 'dispose() { off(); }');
  await assert.rejects(pickerRace("dispose", "resolve", mod), /obsolete picker must not dispatch reprobe/);
});
test("mutation: emitting per response instead of per change is caught", async () => {
  const mod = await mutant('if (probeChanged(previous, cli) || settledUnknown !== wasUnknown || triedChanged(previous, cli)) emit();', 'emit();');
  await assert.rejects(emitOnChange("parsed", mod), /identical probe with fresh diagnostics must not emit/);
});
test("mutation: comparing payloads by identity instead of signature is caught", async () => {
  const mod = await mutant('if (probeChanged(previous, cli) || settledUnknown !== wasUnknown || triedChanged(previous, cli)) emit();', 'if (previous !== cli || settledUnknown !== wasUnknown) emit();');
  await assert.rejects(emitOnChange("parsed", mod), /identical probe with fresh diagnostics must not emit/);
});
test("mutation: dropping the settled-unknown flip loses the pending → unknown emit", async () => {
  const mod = await mutant('if (probeChanged(previous, cli) || settledUnknown !== wasUnknown || triedChanged(previous, cli)) emit();', 'if (probeChanged(previous, cli) || triedChanged(previous, cli)) emit();');
  await assert.rejects(unknownFromPending(mod), /pending → settled-unknown emits once/);
});
