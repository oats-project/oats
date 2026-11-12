// Start… and Restart with… wait for the instance's row to be terminal-ready (#525). The row they pass
// is a roster row, whose `deployment` is an object (#482); the wait matches it by the deployment's id.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { waitForInstanceInPanel } from "../renderer/views/spawn.mjs";
import { createInstanceStarter } from "../renderer/start-instance.mjs";
import { setWorkspace } from "../renderer/views/common.mjs";

const D = { id: "/Users/me/Agents/oats", machine: "This Mac", path: "/Users/me/Agents/oats" };
const row = (extra = {}) => ({ instance: "probe", agent: "code-reviewer", home: `${D.id}/agents/code-reviewer/instances/probe`, agentsRoot: `${D.id}/agents`,
  deployment: D, runtime: "claude", ...extra });
const READY = { running: true, tmux: { session: "pi-agents", window: "probe" } };
const panelOf = (...instances) => ({ ctx: { api: async () => ({ ok: true, status: 200, json: async () => ({ instances }) }) } });
const fast = { tries: 3, delayMs: 0, sleep: async () => {} };

test("a roster row (its deployment an object) is matched by its deployment's id once it is running with a tmux session", async () => {
  assert.equal(await waitForInstanceInPanel(panelOf(row(READY)), row({ running: false }), () => true, fast), true);
  assert.equal(await waitForInstanceInPanel(panelOf(row(READY)), { ...row(), deployment: D.id }, () => true, fast), true, "an id ref still matches");
  const elsewhere = { ...D, id: "/Users/me/Agents/web" };
  assert.equal(await waitForInstanceInPanel(panelOf(row({ ...READY, deployment: elsewhere })), row(), () => true, fast), false,
    "another deployment's same-named row never matches");
  assert.equal(await waitForInstanceInPanel(panelOf(row({ running: true })), row(), () => true, fast), false, "no tmux session: not ready");
});

test("the Start dialog, with the real wait, closes and opens the terminal once the started row is ready", async () => {
  const dom = new JSDOM("<body><button id='opener'>Start</button></body>");
  setWorkspace(D.id);
  const instance = row({ running: false });
  let started = false;
  const opened = [];
  const ctx = {
    api: async (path) => {
      if (path === "/api/cli") return { ok: true, features: ["session-start"] };
      if (path.startsWith("/api/panel")) return { instances: [started ? row(READY) : instance] };
      if (path === "/api/models") return { models: [] };
      if (path.startsWith("/api/start/")) { started = true; return { instance: instance.instance, home: instance.home }; }
      throw new Error(path);
    },
    openTerminal: async (ref) => opened.push(ref),
  };
  try {
    const open = createInstanceStarter(dom.window.document, ctx, { waitForReady: (s, ref, owns) => waitForInstanceInPanel(s, ref, owns, fast) });
    const modal = open(instance);
    await new Promise((r) => setTimeout(r, 0));
    modal.querySelector("form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    for (let i = 0; i < 20 && !opened.length; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(modal.isConnected, false, "the dialog closed");
    assert.deepEqual(opened.map((r) => r.instance), ["probe"], "the terminal opened");
  } finally { setWorkspace("/finished"); dom.window.close(); }
});
