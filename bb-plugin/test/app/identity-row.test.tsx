// @vitest-environment jsdom
// A9: the IdentityRow (experimental_threadHeaderRow).
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalThreadHeaderRowProps } from "@get-bb/plugin-sdk/app";
import { fixtureAgents } from "../helpers/fixtures";
import { handlers, loadApp, resetApp, sidebarThreads } from "../helpers/render";
import type { Contract } from "../helpers/render";

afterEach(() => {
  resetApp();
  vi.unstubAllGlobals();
});

async function row(threadId: string, options: RenderSlotOptions<Contract> = {}) {
  const app = await loadApp();
  expect(app.threadHeaderRows.map((registration) => registration.id)).toEqual(["identity"]);
  const calls: string[] = [];
  const rpc = handlers();
  const slot = renderSlot<ExperimentalThreadHeaderRowProps, Contract>(
    app.threadHeaderRows[0]!,
    { threadId, projectId: "proj_x", environment: null },
    {
      rpc: { ...rpc, snapshot: (input) => (calls.push("snapshot"), rpc.snapshot(input)) },
      sidebarThreads: sidebarThreads(),
      ...options,
    },
  );
  // the row draws nothing until the snapshot is in: wait for the read, then one more turn
  await vi.waitFor(() => expect(calls).toEqual(["snapshot"]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return slot;
}

test("nothing for a thread that is no OATS agent", async () => {
  const slot = await row("thr_plain");
  expect(slot.container.innerHTML).toBe("");
});

test("nothing for a thread bb does not list", async () => {
  const slot = await row("thr_unknown");
  expect(slot.container.innerHTML).toBe("");
});

test("for a child agent: the soul, instance, alias, parent link, home and OATS chips", async () => {
  const slot = await row("thr_mockups", { experimental_panel: { openTab: () => true } });
  await slot.findByTestId("oats-identity-row");
  expect(slot.getByTestId("oats-chip-soul").textContent).toBe("oats-desktop-developer");
  expect(slot.getByTestId("oats-chip-instance").textContent).toBe("desktop-mockups-developer");
  expect(slot.getByTestId("oats-chip-alias").textContent).toBe("✓ desktop-mockups-developer");
  expect(slot.getByTestId("oats-chip-home").textContent).toBe("home · …/instances/desktop-mockups-developer");
  expect(slot.getByTestId("oats-chip-home").parentElement!.getAttribute("title")).toBe(
    "/abs/deployment/agents/oats-desktop-developer/instances/desktop-mockups-developer",
  );
  expect(slot.queryByTestId("oats-chip-children")).toBeNull();

  // the parent is in the tree: a link to its thread
  const parent = slot.getByTestId("oats-chip-parent");
  expect(parent.tagName).toBe("A");
  expect(parent.textContent).toBe("parent · redesign-ui-lead");
  expect(parent.getAttribute("href")).toBe("/projects/proj_redesign/threads/thr_redesign");
  fireEvent.click(parent);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_redesign" }]);

  // OATS opens the thread's fixed tab
  fireEvent.click(slot.getByTestId("oats-chip-oats"));
  expect(slot.inspection.experimental_panelCalls).toEqual([
    { method: "openTab", options: { tab: { id: "home", context: { kind: "thread" }, availability: "fixed" } } },
  ]);
  expect(slot.inspection.navigateCalls).toHaveLength(1);
});

test("for a root agent with children: parent · <human>, not a link, and the number of children", async () => {
  const slot = await row("thr_redesign");
  const parent = await slot.findByTestId("oats-chip-parent");
  expect(parent.tagName).toBe("SPAN");
  expect(parent.textContent).toBe("parent · joan");
  expect(slot.getByTestId("oats-chip-children").textContent).toBe("2 children");
});

test("the address is shown instead of the alias when the row carries one; no identity chip without either", async () => {
  const agents = fixtureAgents().map((agent) =>
    agent.instance === "redesign-ui-lead"
      ? { ...agent, address: "oats.aweb.ai/redesign-ui-lead" }
      : agent.instance === "flaky-ci-developer"
        ? { ...agent, alias: null, team: null, address: null }
        : agent,
  );
  const app = await loadApp();
  const render = (threadId: string) =>
    renderSlot<ExperimentalThreadHeaderRowProps, Contract>(
      app.threadHeaderRows[0]!,
      { threadId, projectId: "p", environment: null },
      { rpc: handlers({}, agents), sidebarThreads: sidebarThreads() },
    );
  const withAddress = render("thr_redesign");
  expect((await withAddress.findByTestId("oats-chip-alias")).textContent).toBe("✓ oats.aweb.ai/redesign-ui-lead");
  withAddress.unmount();
  const without = render("thr_ci");
  await without.findByTestId("oats-chip-soul");
  expect(without.queryByTestId("oats-chip-alias")).toBeNull();
});

test("a parent that is not in bb is named, without a link", async () => {
  const agents = fixtureAgents().map((agent) =>
    agent.instance === "ranker-v3-probe" ? { ...agent, parent: "kernel-fix-developer" } : agent,
  );
  const app = await loadApp();
  const slot = renderSlot<ExperimentalThreadHeaderRowProps, Contract>(
    app.threadHeaderRows[0]!,
    { threadId: "thr_research", projectId: "p", environment: null },
    { rpc: handlers({}, agents), sidebarThreads: sidebarThreads() },
  );
  const parent = await slot.findByTestId("oats-chip-parent");
  expect(parent.tagName).toBe("SPAN");
  expect(parent.textContent).toBe("parent · kernel-fix-developer");
});

test("where bb declines the tab, OATS opens the home page", async () => {
  const slot = await row("thr_mockups"); // no panel handler: every call declines
  fireEvent.click(await slot.findByTestId("oats-chip-oats"));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "home" }]);
});

test("on a compact viewport OATS navigates to the home page and never asks for the tab", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(max-width: 767px)" }));
  const slot = await row("thr_mockups", { experimental_panel: { openTab: () => true } });
  fireEvent.click(await slot.findByTestId("oats-chip-oats"));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "home" }]);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("the chips are one line that scrolls sideways and never wraps", async () => {
  const slot = await row("thr_mockups");
  const line = await slot.findByTestId("oats-identity-row");
  expect(line.className).toContain("overflow-x-auto");
  expect(line.className).toContain("whitespace-nowrap");
  expect(line.className).not.toContain("flex-wrap");
});
