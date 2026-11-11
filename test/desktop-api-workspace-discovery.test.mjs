import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { apiUrl, apiInit, classifyApiRoute, requestPath, servedSelectors } from "../packages/desktop/api-url.mjs";
import * as forge from '../packages/desktop/forge-proxy.mjs';
import { forgeFailure } from '../packages/desktop/renderer/forge-contract.mjs';
import { frameWorkspace } from '../packages/desktop/renderer/window-binding.mjs';
import { windowRefusal } from '../packages/desktop/api-url.mjs';
import { scopedRequest } from '../packages/desktop/renderer/workspace-routes.mjs';
import { workspaceNotServed } from '../packages/desktop/renderer/deployment-header.mjs';

const source = readFileSync(new URL("../packages/desktop/main.mjs", import.meta.url), "utf8");
const apiStart = source.indexOf('ipcMain.handle("api",');
const apiEnd = source.indexOf("// ---- IPC: workstation forge auth", apiStart);
const invalidation = source.match(/onInvalidate: \(\) => \{([^}]+)\}/)?.[1];
assert.ok(apiStart >= 0 && apiEnd > apiStart && invalidation);

// Exercise the production IPC handler and backend-invalidation callback,
// without Electron. SSH discovery may complete after the startup allowlist.
function bridge() {
  let handler;
  let advertised = ["/"];
  let panelFails = false;
  let heldResponse = null;
  let inTransition = false, forgeInvalidations = 0, terminalInvalidations = 0;
  const requests = [];
  // Main's backendFetch: it takes the request's path (and search), which main sends over its socket.
  const backendFetch = async (input) => {
    assert.ok(typeof input === "string" && input.startsWith("/api/"), `backendFetch takes a path: ${input}`);
    const url = new URL(input, "http://oats-backend.invalid");
    requests.push(url);
    const ok = !(panelFails && url.pathname === "/api/panel");
    const asked = url.searchParams.get("ws");
    const body = {
      workspace: { id: advertised.includes(asked) ? asked : "/" },
      workspaces: advertised.map((id) => ({ id })),
    };
    const hold = heldResponse;
    heldResponse = null;
    if (hold) await hold;
    return { ok, status: ok ? 200 : 503, text: async () => JSON.stringify(body) };
  };
  const setup = 'const wsId = "/"; let allowedWs = new Set(["/"]); let advertisedBefore = new Set(); let serverEpoch = 0;\n'
    + 'const unservedRefusal = () => null; // the unserved-deployment refusal is covered by packages/desktop/test/unserved-deployment.test.mjs\n'
    + 'const { forgeProxyOptions, trustedForgeFrame, FORGE_EPOCH_HEADER } = forge; const currentForgeEpoch = () => "fixture:0"; const RENDERER_URL = "file:///fixture/index.html";\n'
    // One window per workspace (#481): these requests come from no bound window (no sender frame), as main's.
    + 'const { frameWorkspace, windowRefusal, scopedRequest, workspaceNotServed } = windowGlobals; const advertisedNow = () => (allowedWs.size ? allowedWs : advertisedBefore); const noteServed = () => {};\n'
    + 'const choosers = new Set(); const BrowserWindow = { fromWebContents: () => null }; // no window here has chosen to have no workspace\n'
    + source.slice(apiStart, apiEnd) + '\nreturn () => {' + invalidation + '};';
  const invalidate = new Function("backendFetch", "apiUrl", "apiInit", "classifyApiRoute", "requestPath", "servedSelectors", "ipcMain", "guard", "serverHost", "forge", "forgeFailure", "invalidateForgeReads", "invalidateTerminalPreparations", "windowGlobals", setup)(
    backendFetch, apiUrl, apiInit, classifyApiRoute, requestPath, servedSelectors, { handle: (name, fn) => { assert.equal(name, "api"); handler = fn; } }, () => {},
    { inTransition: () => inTransition }, forge, forgeFailure, () => { forgeInvalidations++; }, () => { terminalInvalidations++; },
    { frameWorkspace, windowRefusal, scopedRequest, workspaceNotServed },
  );
  return {
    call: (path, opts) => handler({}, path, opts),
    advertise: (ids) => { advertised = ids; },
    failPanel: () => { panelFails = true; },
    holdNext: () => { let release; heldResponse = new Promise((resolve) => { release = resolve; }); return release; },
    invalidate, requests, forgeInvalidations: () => forgeInvalidations, terminalInvalidations: () => terminalInvalidations,
    beginTransition: () => { inTransition = true; invalidate(); },
    endTransition: () => { inTransition = false; },
  };
}

const remote = "remote:aweb-agents:late-discovery";

test("a remote workspace advertised after startup can actually be selected", async () => {
  const b = bridge();
  b.advertise(["/", remote]);
  const menu = await b.call("/api/panel");
  assert.ok(menu.body.workspaces.some((w) => w.id === remote));
  const selected = await b.call("/api/panel?ws=" + encodeURIComponent(remote));
  assert.equal(selected.body.workspace.id, remote);
  await b.call("/api/agents?ws=" + encodeURIComponent(remote));
  assert.equal(b.requests.at(-1).searchParams.get("ws"), remote);
  assert.equal(b.requests.length, 3, "menu and two requests require no additional discovery fetch");
});

test("unknown selections stay pinned without extra polling; only panel responses authorize choices", async () => {
  const b = bridge();
  b.advertise(["/", remote]);
  for (let i = 0; i < 3; i++) {
    await b.call("/api/instance-git?ws=" + encodeURIComponent(remote), { method: "POST", body: "{}" });
    assert.equal(b.requests.at(-1).searchParams.get("ws"), "/");
  }
  assert.equal(b.requests.length, 3);
  await assert.rejects(b.call("//attacker.example/api/panel?ws=/unadvertised"), /off-origin/);
  assert.equal(b.requests.length, 3, "off-origin rejection happens before any network call");
});

test("failed panel response does not authorize advertised choices", async () => {
  const b = bridge();
  b.advertise(["/", remote]);
  b.failPanel();
  assert.equal((await b.call("/api/panel")).status, 503);
  const result = await b.call("/api/agents?ws=" + encodeURIComponent(remote));
  assert.equal(result.body.workspace.id, "/");
});

test("an outgoing backend response cannot restore its invalidated choices", async () => {
  const b = bridge();
  b.advertise(["/", remote]);
  const release = b.holdNext();
  const pending = b.call("/api/panel");
  b.invalidate();
  assert.equal(b.forgeInvalidations(), 1, 'server replacement also revokes forge read generations');
  assert.equal(b.terminalInvalidations(), 1, 'server replacement also revokes pending terminal preparations');
  release();
  await pending;
  const result = await b.call("/api/agents?ws=" + encodeURIComponent(remote));
  assert.equal(result.body.workspace.id, "/");
});

test("a poll started during replacement cannot teach outgoing choices after replacement finishes", async () => {
  const b = bridge();
  b.advertise(["/", remote]);
  b.beginTransition();
  assert.equal(b.forgeInvalidations(), 1, 'transition start immediately revokes forge reads');
  assert.equal(b.terminalInvalidations(), 1, 'transition start immediately revokes pending terminal preparations');
  const release = b.holdNext();
  const pending = b.call("/api/panel");
  b.advertise(["/"]);
  b.endTransition();
  release();
  await pending;
  await b.call("/api/agents?ws=" + encodeURIComponent(remote));
  assert.equal(b.requests.at(-1).searchParams.get("ws"), "/");
});
