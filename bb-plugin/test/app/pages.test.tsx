// @vitest-environment jsdom
// The Capabilities, Teams and Machines pages: what the kernel answers, listed; nothing acts.
import { afterEach, expect, test } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { handlers, loadApp, resetApp, sidebarThreads } from "../helpers/render";
import type { Contract, Handlers } from "../helpers/render";

afterEach(resetApp);

async function page(id: string, over: Partial<Handlers> = {}) {
  const app = await loadApp();
  const panel = app.navPanels.find((candidate) => candidate.id === id)!;
  expect(panel.path).toBe(id);
  expect(panel.experimental_hideFromNavigation).toBe(true); // opened from our thread list only
  return renderSlot<{ subPath: string }, Contract>(panel, { subPath: "" }, { rpc: handlers(over), sidebarThreads: sidebarThreads() });
}

test("the plugin registers the home and the four pages, in that order", async () => {
  const app = await loadApp();
  expect(app.navPanels.map((panel) => panel.path)).toEqual(["home", "souls", "capabilities", "teams", "machines"]);
});

test("Capabilities: id, description, origin and the number of souls", async () => {
  const slot = await page("capabilities", {
    capabilities: () => ({
      capabilities: [
        { id: "oats.core", description: "Day-to-day operation.", origin: "oats.framework 1.12.0", souls: 9 },
        { id: "oats.aweb", description: "", origin: "oats-aweb 1.28.0", souls: 1 },
      ],
    }),
  });
  const rows = await slot.findAllByTestId("oats-capability-row");
  expect(rows.map((row) => row.textContent)).toEqual([
    "oats.coreused by 9 soulsDay-to-day operation.from oats.framework 1.12.0",
    "oats.awebused by 1 soulfrom oats-aweb 1.28.0",
  ]);
  expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["capabilities"]);
});

test("Teams: label, team id, default or not, and this deployment's agents in each", async () => {
  const slot = await page("teams", {
    teams: () => ({
      teams: [
        { label: "oats", team: "default:oats.aweb.ai", isDefault: true },
        { label: "wider", team: "wider:oats.aweb.ai", isDefault: false },
        { label: "shared", team: null, isDefault: false },
      ],
    }),
  });
  const rows = await slot.findAllByTestId("oats-team-row");
  await slot.findByText("8 agents");
  expect(rows.map((row) => row.textContent)).toEqual(["oatsdefault8 agentsdefault:oats.aweb.ai", "wider0 agentswider:oats.aweb.ai", "sharednot mapped"]);
});

test("Machines: this machine with its agents in bb and elsewhere, then what the kernel recorded; no check is run", async () => {
  const slot = await page("machines", {
    machines: () => ({
      machines: [
        { id: "falcon", route: null, isThisMachine: true, note: null },
        { id: "kestrel", route: "ssh://kestrel.tailnet", isThisMachine: false, note: "last checked 2026-11-18: reachable, oats 0.69.20" },
      ],
    }),
  });
  const rows = await slot.findAllByTestId("oats-machine-row");
  expect(rows.map((row) => row.textContent)).toEqual([
    "falconthis machine",
    "kestrelssh://kestrel.tailnetlast checked 2026-11-18: reachable, oats 0.69.20",
  ]);
  await slot.findByText("7 agents in bb · 1 agent elsewhere");
  expect(slot.getByTestId("oats-this-machine").textContent).toContain("falcon");
  expect(slot.inspection.rpcCalls.map((call) => call.method).sort()).toEqual(["machines", "snapshot", "souls"]);
});

test("an empty answer says so in one line", async () => {
  const slot = await page("capabilities", { capabilities: () => ({ capabilities: [] }) });
  expect((await slot.findByText("This deployment has no capabilities.")).tagName).toBe("P");
});

test("a failed read shows the message unchanged, and Retry rereads", async () => {
  let failing = true;
  const slot = await page("teams", {
    teams: () => {
      if (failing) throw new Error("E_OATS_NOT_JSON: oats teams printed something that is not JSON");
      return handlers().teams(null);
    },
  });
  expect((await slot.findByRole("alert")).textContent).toBe("E_OATS_NOT_JSON: oats teams printed something that is not JSONRetry");
  failing = false;
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  expect(await slot.findAllByTestId("oats-team-row")).toHaveLength(1);
});
