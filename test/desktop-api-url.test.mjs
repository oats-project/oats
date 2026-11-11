// Regression coverage for the desktop app's privileged API proxy URL shaping
// (packages/desktop/api-url.mjs) — findings from review de5141c:
//   1. protocol-relative / backslash pathnames must not steer the privileged
//      fetch off the backend origin;
//   2. a caller-supplied ?ws= must not override the verified workspace on a
//      shared server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl, apiInit } from "../packages/desktop/api-url.mjs";

// apiUrl resolves request paths on a fixed origin; main sends their path and search over its socket.
const BASE = "http://oats-backend.invalid";

test("normal API paths stay on the server origin", () => {
  assert.equal(apiUrl("/api/panel").href, `${BASE}/api/panel`);
  assert.equal(apiUrl("/api/start/foo?home=%2Fh").href, `${BASE}/api/start/foo?home=%2Fh`);
});

test("rejects non-string and non-absolute pathnames", () => {
  for (const bad of [undefined, null, 42, "api/panel", "http://evil/x", ""]) {
    assert.throws(() => apiUrl(bad), /pathname/);
  }
});

test("rejects off-origin resolution: protocol-relative and backslash forms", () => {
  for (const bad of ["//attacker.example/x", "/\\attacker.example/x", "//127.0.0.1:9999/x", "/\\\\attacker.example/x"]) {
    assert.throws(() => apiUrl(bad), /off-origin/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("pins the verified workspace on scoped endpoints, overwriting unknown ws", () => {
  const ws = "/Users/me/oats";
  assert.equal(apiUrl("/api/panel", ws).searchParams.get("ws"), ws);
  // caller-supplied ws NOT advertised by the server must be overwritten
  assert.equal(apiUrl("/api/panel?ws=/Users/me/other", ws).searchParams.get("ws"), ws);
  assert.equal(apiUrl("/api/agents?ws=/Users/me/other", ws).searchParams.get("ws"), ws);
  // ...even with an allowed set that does not contain it
  assert.equal(apiUrl("/api/panel?ws=/Users/me/other", ws, new Set([ws])).searchParams.get("ws"), ws);
});

test("allows switching to a workspace the server advertises", () => {
  const ws = "/Users/me/oats", other = "/Users/me/lfx";
  const allowed = new Set([ws, other]);
  assert.equal(apiUrl(`/api/panel?ws=${other}`, ws, allowed).searchParams.get("ws"), other);
  assert.equal(apiUrl(`/api/agents?ws=${other}`, ws, allowed).searchParams.get("ws"), other);
  // no caller ws → verified id still pinned
  assert.equal(apiUrl("/api/panel", ws, allowed).searchParams.get("ws"), ws);
});

test("pins ws on /api/brain/* like the other scoped endpoints", () => {
  const ws = "/Users/me/oats", other = "/Users/me/lfx";
  // no caller ws → verified id pinned
  assert.equal(apiUrl("/api/brain/tui-dev", ws).searchParams.get("ws"), ws);
  // unknown/stale caller ws → overwritten
  assert.equal(apiUrl("/api/brain/tui-dev?ws=/stale/id", ws, new Set([ws, other])).searchParams.get("ws"), ws);
  assert.equal(apiUrl("/api/brain/tui-dev?ws=/stale/id", ws).searchParams.get("ws"), ws);
  // server-advertised caller ws → kept (workspace switching)
  assert.equal(apiUrl(`/api/brain/tui-dev?ws=${other}`, ws, new Set([ws, other])).searchParams.get("ws"), other);
});

test("pins ws on the path-addressed brain route; the removed chat route is no longer pinned (#627)", () => {
  const ws = "/Users/me/oats", other = "/Users/me/lfx";
  assert.equal(apiUrl("/api/chat/inst-a", ws).searchParams.get("ws"), null, "chat: no route, nothing pinned");
  assert.equal(apiUrl("/api/chat/inst-a?ws=/stale", ws, new Set([ws, other])).searchParams.get("ws"), "/stale", "chat: nothing overwritten");
  // omitted ws → fails safe to the verified workspace
  assert.equal(apiUrl("/api/brain/inst-a", ws).searchParams.get("ws"), ws, "brain: pin on omission");
  // stale/unknown caller ws → overwritten
  assert.equal(apiUrl("/api/brain/inst-a?ws=/stale", ws, new Set([ws, other])).searchParams.get("ws"), ws, "brain: stale overwritten");
  // server-advertised caller ws → kept (workspace switching)
  assert.equal(apiUrl(`/api/brain/inst-a?ws=${other}`, ws, new Set([ws, other])).searchParams.get("ws"), other, "brain: advertised kept");
});

test("pins ws on the path-addressed start and restart like brain (#818)", () => {
  const ws = "/Users/me/oats", other = "/Users/me/lfx", remote = "remote:altair:3f2a00000000";
  const allowed = new Set([ws, other, remote]);
  for (const ep of ["start", "restart"]) {
    // omitted ws → fails safe to the verified workspace; the row's qualifiers ride along untouched
    const pinned = apiUrl(`/api/${ep}/inst-a?home=%2Fh`, ws);
    assert.equal(pinned.searchParams.get("ws"), ws, `${ep}: pin on omission`);
    assert.equal(pinned.searchParams.get("home"), "/h", `${ep}: home kept`);
    // stale/unknown caller ws → overwritten, with or without an advertised set
    assert.equal(apiUrl(`/api/${ep}/inst-a?ws=/stale`, ws, allowed).searchParams.get("ws"), ws, `${ep}: stale overwritten`);
    assert.equal(apiUrl(`/api/${ep}/inst-a?ws=/stale`, ws).searchParams.get("ws"), ws, `${ep}: stale overwritten, nothing advertised`);
    // server-advertised caller ws → kept (a row's own deployment, a remote one included)
    assert.equal(apiUrl(`/api/${ep}/inst-a?ws=${other}`, ws, allowed).searchParams.get("ws"), other, `${ep}: advertised kept`);
    const routed = apiUrl(`/api/${ep}/inst-a?home=%2Fh&server=altair&ws=${encodeURIComponent(remote)}`, ws, allowed);
    assert.deepEqual([routed.searchParams.get("ws"), routed.searchParams.get("server"), routed.searchParams.get("home")], [remote, "altair", "/h"], `${ep}: remote kept`);
  }
});

test("does not pin ws on unscoped endpoints and without a verified id", () => {
  assert.equal(apiUrl("/api/file?path=/x", "/Users/me/oats").searchParams.get("ws"), null);
  assert.equal(apiUrl("/api/panel", null).searchParams.get("ws"), null);
});

// apiInit: the IPC proxy must serialize exactly once. Views (common.mjs
// postJson) follow the Fetch contract and pass a pre-serialized string body
// + content-type header; double-serializing broke every POST /api/spawn.
test("apiInit forwards pre-serialized string bodies unchanged", () => {
  const body = JSON.stringify({ agent: "a", agentsRoot: "/r" });
  const init = apiInit({ method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(init.method, "POST");
  assert.equal(init.body, body); // NOT re-serialized
  assert.deepEqual(JSON.parse(init.body), { agent: "a", agentsRoot: "/r" });
  assert.equal(init.headers["content-type"], "application/json");
});

test("apiInit serializes object bodies exactly once and preserves headers", () => {
  const init = apiInit({ method: "POST", body: { data: "x" }, headers: { "x-extra": "1" } });
  assert.deepEqual(JSON.parse(init.body), { data: "x" });
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers["x-extra"], "1");
});

test("apiInit defaults: GET without body or headers", () => {
  const init = apiInit(undefined);
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
});
