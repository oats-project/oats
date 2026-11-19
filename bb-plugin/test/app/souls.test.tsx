// @vitest-environment jsdom
// A11: the Souls page (navPanel `souls`): Preview, Spawn in bb, and a soul that cannot be spawned.
import { afterEach, expect, test } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureAgents, fixtureThreads } from "../helpers/fixtures";
import { handlers, loadApp, resetApp, sidebarThreads } from "../helpers/render";
import type { Contract, Handlers } from "../helpers/render";
import type { Agent } from "../../model/types";

afterEach(resetApp);

async function souls(subPath: string, over: Partial<Handlers> = {}, agents?: Agent[], threads = fixtureThreads()) {
  const app = await loadApp();
  const panel = app.navPanels.find((candidate) => candidate.id === "souls")!;
  expect(panel.experimental_hideFromNavigation).toBe(true);
  return renderSlot<{ subPath: string }, Contract>(panel, { subPath }, { rpc: handlers(over, agents), sidebarThreads: { status: "ready", threads } });
}

function fill(slot: Awaited<ReturnType<typeof souls>>, name: string, task: string) {
  fireEvent.change(slot.getByTestId("oats-spawn-name"), { target: { value: name } });
  fireEvent.change(slot.getByTestId("oats-spawn-task"), { target: { value: task } });
}
const rpcOf = (slot: Awaited<ReturnType<typeof souls>>, method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method);

test("the list: each soul with the number of this deployment's agents; a click opens the soul", async () => {
  const slot = await souls("");
  const rows = await slot.findAllByTestId("oats-soul-row");
  await waitFor(() => expect(rows.map((row) => row.textContent)).toEqual(["oats-developer2 agents", "broken-soul0 agents"]));
  expect(slot.queryByTestId("oats-soul-detail")).toBeNull();
  fireEvent.click(rows[0]!);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "souls", options: { subPath: "oats-developer" } }]);
});

test("the picked soul: description, origin, capabilities, and its agents by where they are", async () => {
  const slot = await souls("oats-developer");
  const detail = await slot.findByTestId("oats-soul-detail");
  expect(detail.textContent).toContain("Builds and proves one spec.");
  expect(detail.textContent).toContain("from oats.framework 1.12.0");
  for (const id of ["oats.core", "oats.aweb", "oats.developer"]) expect(detail.textContent).toContain(id);
  // in the tree: a link to its thread
  const inTree = await slot.findByTestId("oats-soul-agent");
  expect(inTree.getAttribute("href")).toBe("/projects/proj_ci/threads/thr_ci");
  fireEvent.click(inTree);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_ci" }]);
  // on tmux: labelled with the backend
  expect(slot.getByTestId("oats-soul-agent-elsewhere").textContent).toBe("kernel-fix-developeron tmux");
});

test("Preview shows what oats spawn --preview would do, and spawns nothing", async () => {
  const slot = await souls("oats-developer", {
    spawnPreview: () => ({
      summary: {
        modules: ["oats.core 2.6.0", "oats.aweb 1.28.0"],
        teams: ["oats (default:oats.aweb.ai)"],
        launch: "claude-opus on bb",
        warnings: ["channel-dev-confirmation: OATS confirms the development-channel prompt"],
        problems: [],
      },
    }),
  });
  await slot.findByTestId("oats-spawn-form");
  fill(slot, "ranker-v4-probe", "Sweep the learning rate.");
  fireEvent.click(slot.getByTestId("oats-spawn-preview"));
  const preview = await slot.findByTestId("oats-preview");
  for (const text of ["oats.core 2.6.0", "oats (default:oats.aweb.ai)", "claude-opus on bb", "channel-dev-confirmation"]) {
    expect(preview.textContent).toContain(text);
  }
  expect(rpcOf(slot, "spawnPreview").map((call) => call.input)).toEqual([
    { soul: "oats-developer", name: "ranker-v4-probe", task: "Sweep the learning rate." },
  ]);
  expect(rpcOf(slot, "spawn")).toEqual([]);
  expect(slot.inspection.navigateCalls).toEqual([]);
});

test("Spawn calls spawn once with { soul, name, task, key } and, on ok, navigates to the returned thread", async () => {
  const slot = await souls("oats-developer", { spawn: () => ({ instance: "ranker-v4-probe", threadId: "thr_new" }) });
  await slot.findByTestId("oats-spawn-form");
  fill(slot, "ranker-v4-probe", "Sweep the learning rate.");
  fireEvent.click(slot.getByTestId("oats-spawn-submit"));
  await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_new" }]));
  const calls = rpcOf(slot, "spawn");
  expect(calls).toHaveLength(1);
  const input = calls[0]!.input as { soul: string; name: string; task: string; key: string };
  expect(Object.keys(input).sort()).toEqual(["key", "name", "soul", "task"]);
  expect(input).toMatchObject({ soul: "oats-developer", name: "ranker-v4-probe", task: "Sweep the learning rate." });
  expect(input.key).toMatch(/^[0-9a-f]{32}$/);
});

test("a refusal's message is shown unchanged, nothing is navigated, and a retry of the same form reuses the key", async () => {
  const refusal = "E_INSTANCE_EXISTS: an instance named ranker-v4-probe already exists\n  retire it first: oats retire ranker-v4-probe";
  let refuse = true;
  const slot = await souls("oats-developer", {
    spawn: () => {
      if (refuse) throw new Error(refusal);
      return { instance: "ranker-v4-probe", threadId: "thr_new" };
    },
  });
  await slot.findByTestId("oats-spawn-form");
  fill(slot, "ranker-v4-probe", "Sweep.");
  fireEvent.click(slot.getByTestId("oats-spawn-submit"));
  expect((await slot.findByRole("alert")).textContent).toBe(refusal);
  expect(slot.inspection.navigateCalls).toEqual([]);

  refuse = false;
  fireEvent.click(slot.getByTestId("oats-spawn-submit"));
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
  const keys = rpcOf(slot, "spawn").map((call) => (call.input as { key: string }).key);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test("a changed form is a new intent: it gets a new key", async () => {
  const slot = await souls("oats-developer", {
    spawn: () => {
      throw new Error("E_SPAWN_REFUSED: no");
    },
  });
  await slot.findByTestId("oats-spawn-form");
  fill(slot, "one", "Task.");
  fireEvent.click(slot.getByTestId("oats-spawn-submit"));
  await slot.findByRole("alert");
  fill(slot, "two", "Task.");
  fireEvent.click(slot.getByTestId("oats-spawn-submit"));
  await waitFor(() => expect(rpcOf(slot, "spawn")).toHaveLength(2));
  const keys = rpcOf(slot, "spawn").map((call) => (call.input as { key: string }).key);
  expect(keys[0]).not.toBe(keys[1]);
});

test("a name the kernel would refuse never leaves the form", async () => {
  const slot = await souls("oats-developer");
  await slot.findByTestId("oats-spawn-form");
  for (const bad of ["Has Space", "with/slash", "Upper", "-leading-dash", "a".repeat(64)]) {
    fill(slot, bad, "Task.");
    expect((slot.getByTestId("oats-spawn-submit") as HTMLButtonElement).disabled).toBe(true);
    expect((slot.getByTestId("oats-spawn-preview") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(slot.getByTestId("oats-spawn-form"));
  }
  fill(slot, "good-name", "   ");
  expect((slot.getByTestId("oats-spawn-submit") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(slot.getByTestId("oats-spawn-form"));
  expect(rpcOf(slot, "spawn")).toEqual([]);
  expect(rpcOf(slot, "spawnPreview")).toEqual([]);
});

test("spawnable: false shows the problem and no form", async () => {
  const slot = await souls("broken-soul");
  expect((await slot.findByTestId("oats-soul-problem")).textContent).toBe(
    "E_SOUL_INVALID: soul.yaml names a capability that is not installed: oats.missing",
  );
  expect(slot.queryByTestId("oats-spawn-form")).toBeNull();
  expect(slot.queryByTestId("oats-spawn-submit")).toBeNull();
});

test("an agent whose thread is archived shows as thread missing, with Start and Retire", async () => {
  const threads = fixtureThreads().map((thread) => (thread.id === "thr_ci" ? { ...thread, isArchived: true } : thread));
  const slot = await souls("oats-developer", { start: () => ({ threadId: "thr_restarted" }) }, fixtureAgents(), threads);
  const missing = await slot.findByTestId("oats-soul-agent-detached");
  expect(missing.textContent).toBe("flaky-ci-developerthread missingStartRetire");
  expect(slot.queryByTestId("oats-soul-agent")).toBeNull();
  fireEvent.click(slot.getByTestId("oats-detached-start"));
  await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_restarted" }]));
  expect(rpcOf(slot, "start").map((call) => call.input)).toEqual([{ instance: "flaky-ci-developer" }]);
});

test("a soul name in the URL that the deployment does not have says so", async () => {
  const slot = await souls("no%20such%20soul");
  expect((await slot.findByText("This deployment has no soul named no such soul.")).tagName).toBe("P");
});

test("when souls cannot be read: the kernel's message and Retry", async () => {
  let failing = true;
  const slot = await souls("", {
    souls: () => {
      if (failing) throw new Error("E_OATS_TIMEOUT: oats souls did not answer in 20 s");
      return handlers().souls(null);
    },
  });
  expect((await slot.findByRole("alert")).textContent).toBe("E_OATS_TIMEOUT: oats souls did not answer in 20 sRetry");
  failing = false;
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  expect(await slot.findAllByTestId("oats-soul-row")).toHaveLength(2);
});

test("a package soul's agents are matched by its roster agent name, not by its key", async () => {
  // bb hands the key back as it took it: `/`-separated segments, each percent-encoded
  const slot = await souls("oats.okf/knowledge-harvester", {
    souls: () => ({
      souls: [{ name: "oats.okf/knowledge-harvester", agent: "knowledge-harvester", description: "Harvests.", origin: "oats.okf 2.1.0", capabilities: [], spawnable: true, problem: null }],
    }),
  });
  expect((await slot.findByTestId("oats-soul-agent")).getAttribute("href")).toBe("/projects/proj_harvest/threads/thr_harvest");
  expect(slot.getByTestId("oats-soul-row").textContent).toBe("oats.okf/knowledge-harvester1 agent");
  expect(slot.getByTestId("oats-spawn-form")).toBeTruthy();
  // and the row opens it with the key as bb's unencoded segments
  fireEvent.click(slot.getByTestId("oats-soul-row"));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "souls", options: { subPath: "oats.okf/knowledge-harvester" } }]);
});

test("a soul key with characters bb percent-encodes is decoded segment by segment", async () => {
  const slot = await souls("my%20pkg/soul%2Fx", {
    souls: () => ({ souls: [{ name: "my pkg/soul/x", agent: "x", description: "", origin: "o", capabilities: [], spawnable: true, problem: null }] }),
  });
  expect((await slot.findByTestId("oats-soul-detail")).textContent).toContain("my pkg/soul/x");
});
