// @vitest-environment jsdom
// A8: the Sidebar (experimental_threadList) with the pinned fixtures.
import { afterEach, expect, test } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { fixtureAgents, fixtureSnapshot, fixtureThreads } from "../helpers/fixtures";
import { handlers, loadApp, resetApp, sidebarThreads } from "../helpers/render";
import type { Contract, Handlers } from "../helpers/render";

afterEach(resetApp);

async function sidebar(over: Partial<Handlers> = {}, activeThreadId: string | null = null) {
  const app = await loadApp();
  expect(app.threadLists.map((list) => list.id)).toEqual(["agents"]);
  let navigated = 0;
  const slot = renderSlot<PluginThreadListProps, Contract>(
    app.threadLists[0]!,
    { activeThreadId, activeProjectId: null, isCompactViewport: false, onNavigate: () => void navigated++, searchQuery: "" },
    { rpc: handlers(over), sidebarThreads: sidebarThreads() },
  );
  return { slot, navigated: () => navigated };
}

const ids = (rows: HTMLElement[]) => rows.map((row) => row.getAttribute("data-sidebar-thread-id"));

test("the tree: every bb agent has a row with both data-sidebar-thread-* attributes and its href", async () => {
  const { slot } = await sidebar();
  const rows = await slot.findAllByTestId("oats-agent-row");
  // needs-you first (newest first), then working with its children under it, then the rest
  expect(ids(rows)).toEqual(["thr_release", "thr_ci", "thr_research", "thr_redesign", "thr_mockups", "thr_harvest", "thr_digest"]);
  for (const row of rows) {
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("data-sidebar-thread-shortcut-target")).toBe("");
    const id = row.getAttribute("data-sidebar-thread-id")!;
    expect(row.getAttribute("href")).toBe(fixtureThreads().find((thread) => thread.id === id)!.href);
  }
});

test("a row shows the title, the soul, its state as the dot's label, and ? or new at the end", async () => {
  const { slot } = await sidebar();
  const rows = await slot.findAllByTestId("oats-agent-row");
  const row = (id: string) => rows.find((candidate) => candidate.getAttribute("data-sidebar-thread-id") === id)!;
  const dot = (id: string) => row(id).querySelector("[role=img]")!.getAttribute("aria-label");

  expect(row("thr_release").textContent).toContain("Release 0.70");
  expect(row("thr_release").textContent).toContain("oats-maintainer");
  expect(row("thr_release").textContent!.endsWith("?")).toBe(true);
  expect(dot("thr_release")).toBe("needs you");
  expect(dot("thr_ci")).toBe("needs you"); // a claim, and a bb pending interaction
  expect(dot("thr_redesign")).toBe("working");
  expect(dot("thr_harvest")).toBe("idle");
  expect(row("thr_harvest").textContent!.endsWith("new")).toBe(true); // unread
  expect(dot("thr_digest")).toBe("stopped");
  expect(row("thr_digest").textContent).toContain("oats-expert · stopped");
});

test("children are indented one step under their parent", async () => {
  const { slot } = await sidebar();
  const rows = await slot.findAllByTestId("oats-agent-row");
  const cls = (id: string) => rows.find((row) => row.getAttribute("data-sidebar-thread-id") === id)!.className;
  expect(cls("thr_redesign")).toContain("pl-2");
  expect(cls("thr_mockups")).toContain("pl-6");
  expect(cls("thr_harvest")).toContain("pl-6");
});

test("a click on a row records navigate.toThread(id) and calls onNavigate", async () => {
  const { slot, navigated } = await sidebar();
  const rows = await slot.findAllByTestId("oats-agent-row");
  fireEvent.click(rows.find((row) => row.getAttribute("data-sidebar-thread-id") === "thr_mockups")!);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_mockups" }]);
  expect(navigated()).toBe(1);
});

test("a modified click is left to the anchor: nothing is navigated by the plugin", async () => {
  const { slot, navigated } = await sidebar();
  const rows = await slot.findAllByTestId("oats-agent-row");
  // jsdom cannot follow a link: note whether the plugin left the click alone, then stop it
  const leftAlone: boolean[] = [];
  slot.container.addEventListener("click", (event) => {
    leftAlone.push(!event.defaultPrevented);
    event.preventDefault();
  });
  fireEvent.click(rows[0]!, { ctrlKey: true });
  fireEvent.click(rows[0]!, { metaKey: true });
  expect(leftAlone).toEqual([true, true]);
  expect(slot.inspection.navigateCalls).toEqual([]);
  expect(navigated()).toBe(0);
});

test('"Other threads" lists the thread that is no OATS agent, and it opens like any other', async () => {
  const { slot, navigated } = await sidebar();
  await slot.findByTestId("oats-tree");
  const others = slot.getAllByTestId("oats-other-row");
  expect(ids(others)).toEqual(["thr_plain"]);
  expect(others[0]!.getAttribute("data-sidebar-thread-shortcut-target")).toBe("");
  expect(slot.getByText("Other threads")).toBeTruthy();
  fireEvent.click(others[0]!);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_plain" }]);
  expect(navigated()).toBe(1);
});

test("the workspace line, the needs line and + New agent", async () => {
  const { slot, navigated } = await sidebar();
  expect((await slot.findByTestId("oats-workspace-line")).textContent).toBe("oats · falcon · 8 agents");
  const needs = slot.getByTestId("oats-needs-line");
  expect(needs.textContent).toBe("3 need you");
  fireEvent.click(needs);
  fireEvent.click(slot.getByTestId("oats-new-agent"));
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "home" },
    { method: "toPluginPanel", path: "souls" },
  ]);
  expect(navigated()).toBe(2);
});

test("the four page rows call toPluginPanel, then onNavigate", async () => {
  const { slot, navigated } = await sidebar();
  await slot.findByTestId("oats-workspace-line");
  for (const path of ["souls", "capabilities", "teams", "machines"]) fireEvent.click(slot.getByTestId(`oats-page-link-${path}`));
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "souls" },
    { method: "toPluginPanel", path: "capabilities" },
    { method: "toPluginPanel", path: "teams" },
    { method: "toPluginPanel", path: "machines" },
  ]);
  expect(navigated()).toBe(4);
});

test("the active thread's row is marked", async () => {
  const { slot } = await sidebar({}, "thr_ci");
  const rows = await slot.findAllByTestId("oats-agent-row");
  expect(rows.filter((row) => row.getAttribute("aria-current") === "page").map((row) => row.getAttribute("data-sidebar-thread-id"))).toEqual(["thr_ci"]);
});

test("while no snapshot has loaded: one line, and every thread is listed", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const { slot } = await sidebar({ snapshot: async () => (await held, handlers().snapshot(null)) });
  expect(slot.getByTestId("oats-status-line").textContent).toBe("Reading OATS…");
  expect(ids(slot.getAllByTestId("oats-other-row"))).toEqual(fixtureThreads().map((thread) => thread.id));
  expect(slot.queryByText("Other threads")).toBeNull();
  expect(slot.queryByTestId("oats-workspace-line")).toBeNull();
  release();
  await slot.findByTestId("oats-tree");
});

test("with a failed snapshot: every thread is listed, the error's first line shows, and Retry rereads", async () => {
  let failing = true;
  const { slot, navigated } = await sidebar({
    snapshot: () =>
      failing
        ? { ok: false, at: "2026-11-19T12:30:00.000Z", code: "NO_DEPLOYMENT", message: "No OATS deployment found.\nSet one in the plugin's settings." }
        : handlers().snapshot(null),
  });
  await waitFor(() => expect(slot.getByTestId("oats-status-line").textContent).toContain("No OATS deployment found."));
  expect(slot.getByTestId("oats-status-line").textContent).not.toContain("Set one in");
  expect(ids(slot.getAllByTestId("oats-other-row"))).toEqual(fixtureThreads().map((thread) => thread.id));
  expect(slot.queryByTestId("oats-tree")).toBeNull();

  // bb stays usable: a thread opens
  fireEvent.click(slot.getAllByTestId("oats-other-row")[0]!);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_release" }]);
  expect(navigated()).toBe(1);

  failing = false;
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await slot.findByTestId("oats-tree");
  expect(slot.inspection.rpcCalls.map((call) => call.method).filter((method) => method !== "souls")).toEqual(["snapshot", "refresh", "snapshot"]);
});

test("when the plugin's server does not answer at all, the threads are listed with the error and Retry", async () => {
  const { slot } = await sidebar({
    snapshot: () => {
      throw new Error("plugin oats is not running");
    },
  });
  // the message as it is: no code before it, since nothing here is the kernel's word
  await waitFor(() => expect(slot.getByTestId("oats-status-line").textContent).toBe("plugin oats is not runningRetry"));
  expect(slot.getAllByTestId("oats-other-row")).toHaveLength(8);
  expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("an oats/changed event rereads the snapshot once, and the tree follows", async () => {
  let agents = fixtureAgents();
  const { slot } = await sidebar({ snapshot: () => fixtureSnapshot(agents) });
  await slot.findByTestId("oats-tree");
  agents = agents.filter((agent) => agent.instance !== "weekly-digest-helper");
  await slot.behavior.emitRealtime("oats/changed", { at: "2026-11-19T12:40:00.000Z" });
  await waitFor(() => expect(ids(slot.getAllByTestId("oats-other-row"))).toEqual(["thr_digest", "thr_plain"]));
  // the souls are read once, for their names: a status change does not reread them
  expect(slot.inspection.rpcCalls.map((call) => call.method).sort()).toEqual(["snapshot", "snapshot", "souls"]);
});

test("a title with markup is drawn as text", async () => {
  const threads = fixtureThreads().map((thread) =>
    thread.id === "thr_plain" ? { ...thread, title: "<img src=x onerror=alert(1)>", displayTitle: "<img src=x onerror=alert(1)>" } : thread,
  );
  const app = await loadApp();
  const slot = renderSlot<PluginThreadListProps, Contract>(
    app.threadLists[0]!,
    { activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: () => {}, searchQuery: "" },
    { rpc: handlers(), sidebarThreads: { status: "ready", threads } },
  );
  const other = await slot.findByTestId("oats-other-row");
  expect(other.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(other.querySelector("img")).toBeNull();
});

test("a row's soul is the matching soul's key once the souls are read, else the roster's name", async () => {
  const { slot } = await sidebar({
    souls: () => ({
      souls: [{ name: "oats.okf/knowledge-harvester", agent: "knowledge-harvester", description: "", origin: "oats.okf 2.1.0", capabilities: [], spawnable: true, problem: null }],
    }),
  });
  const rows = await slot.findAllByTestId("oats-agent-row");
  const row = (id: string) => rows.find((candidate) => candidate.getAttribute("data-sidebar-thread-id") === id)!;
  await waitFor(() => expect(row("thr_harvest").textContent).toContain("oats.okf/knowledge-harvester"));
  expect(row("thr_release").textContent).toContain("oats-maintainer");
});

test("several machines and none chosen: the line links to the plugin's settings", async () => {
  const { slot } = await sidebar({
    snapshot: () => ({ ok: false, at: "t", code: "CHOOSE_HOST", message: "This bb server has 2 machines: choose the one that holds the OATS homes." }),
  });
  const link = await slot.findByRole("link", { name: "Choose a machine" });
  expect(link.getAttribute("href")).toBe("/settings/plugins/test-plugin");
});

test("a kernel refusal of oats status shows the kernel's code and the first line of its message", async () => {
  const { slot } = await sidebar({
    snapshot: () => ({ ok: false, at: "t", code: "E_WORKSPACE_INVALID", message: "oats-workspace.yaml: unknown key `foo`\nsee docs/workspace.md" }),
  });
  await waitFor(() => expect(slot.getByTestId("oats-status-line").textContent).toBe("E_WORKSPACE_INVALID: oats-workspace.yaml: unknown key `foo`Retry"));
});
