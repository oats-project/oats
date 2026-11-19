import test from "node:test";
import assert from "node:assert/strict";
import {
  terminalTabsForWorkspace, tabVisibleInContext, canActivateTab,
  fallbackTabForContext, terminalOpenOwnsWorkspace, restoreTerminalTab,
} from "../renderer/workspace-tabs.mjs";

test("terminal tabs: same-named A/B instances remain workspace-scoped", () => {
  const tabs = new Map([
    [1, { kind: "terminal", workspace: "wsA", key: "term:wsA:dev-1" }],
    [2, { kind: "terminal", workspace: "wsB", key: "term:wsB:dev-1" }],
    [3, { kind: "brain", workspace: "wsB", key: "brain:wsB" }],
  ]);
  assert.deepEqual(terminalTabsForWorkspace(tabs, "wsA").map(([id]) => id), [1]);
  assert.deepEqual(terminalTabsForWorkspace(tabs, "wsB").map(([id]) => id), [2]);
  assert.equal(tabVisibleInContext(tabs.get(1), "instances", "wsB"), false,
    "workspace A terminal must be hidden beside workspace B roster");
  assert.equal(tabVisibleInContext(tabs.get(2), "instances", "wsB"), true);
  // Slice 6a: every tab of the workspace shows in its strip, whatever the sidebar's mode (pages beside terminals).
  assert.equal(tabVisibleInContext(tabs.get(3), "instances", "wsB"), true);
  assert.equal(tabVisibleInContext(tabs.get(3), "souls", "wsB"), true);
  assert.equal(tabVisibleInContext(tabs.get(3), "souls", "wsA"), false, "never another workspace's");
});

test("every artifact kind requires the exact workspace for visibility and activation", () => {
  for (const kind of ["terminal", "brain", "file", "artifact"]) {
    const tab = { kind, workspace: "wsA" };
    assert.equal(canActivateTab(tab, "wsA"), true);
    assert.equal(canActivateTab(tab, "wsB"), false);
    assert.equal(tabVisibleInContext(tab, "souls", "wsB"), false);
    assert.equal(tabVisibleInContext(tab, "instances", "wsB"), false);
  }
  assert.equal(canActivateTab({ kind: "file", workspace: null }, "wsA"), false);
});

test("shell fallback: closing B terminal never activates hidden A terminal", () => {
  const tabsAfterClose = new Map([
    [1, { kind: "terminal", workspace: "wsA", key: "term:wsA:dev-1" }],
    [3, { kind: "brain", workspace: null, key: "view:brain" }],
  ]);
  assert.equal(canActivateTab(tabsAfterClose.get(1), "wsB"), false,
    "activation boundary rejects hidden workspace-A pane");
  assert.equal(fallbackTabForContext(tabsAfterClose, "instances", "wsB"), null,
    "Instances/B has no fallback after its last terminal closes");
});

test("shell deferred open: A completion loses ownership after switch to B", () => {
  assert.equal(terminalOpenOwnsWorkspace("wsA", "wsA"), true);
  assert.equal(terminalOpenOwnsWorkspace("wsA", "wsB"), false,
    "late A /api/panel completion must be discarded before addTab auto-activation");
});

test("workspace switch-back restores the remembered active terminal", () => {
  const tabs = new Map([
    [1, { kind: "terminal", workspace: "wsA", key: "term:wsA:dev-1" }],
    [2, { kind: "terminal", workspace: "wsA", key: "term:wsA:dev-2" }],
    [3, { kind: "terminal", workspace: "wsB", key: "term:wsB:dev-1" }],
  ]);
  // dev-1 was active in wsA even though dev-2 was opened later
  const [id] = restoreTerminalTab(tabs, "wsA", "term:wsA:dev-1");
  assert.equal(id, 1, "remembered wsA active tab wins over most-recent");
});

test("restore falls back to most recent when memory is stale or foreign", () => {
  const tabs = new Map([
    [1, { kind: "terminal", workspace: "wsA", key: "term:wsA:dev-1" }],
    [2, { kind: "terminal", workspace: "wsA", key: "term:wsA:dev-2" }],
    [3, { kind: "terminal", workspace: "wsB", key: "term:wsB:dev-1" }],
  ]);
  // remembered tab was closed → most recently opened wsA terminal
  assert.equal(restoreTerminalTab(tabs, "wsA", "term:wsA:closed")[0], 2);
  // no memory at all → most recent
  assert.equal(restoreTerminalTab(tabs, "wsA", undefined)[0], 2);
  // a wsB key must never restore into wsA (same-named instances hazard):
  // candidates are workspace-filtered, so the foreign key falls back
  assert.equal(restoreTerminalTab(tabs, "wsA", "term:wsB:dev-1")[0], 2);
  // workspace with no terminals → null (caller falls back to the stage)
  assert.equal(restoreTerminalTab(tabs, "wsC", "term:wsC:dev-1"), null);
});
