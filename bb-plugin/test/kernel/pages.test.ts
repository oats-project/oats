// The four read verbs behind the pages, against the recorded answers.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Oats, Processes } from "../../kernel/index.js";
import { withSoulCounts } from "../../kernel/pages.js";
import { installFakeOats, type FakeOats } from "../support/fake-oats.js";

let fake: FakeOats;
let processes: Processes;
let oats: Oats;

beforeEach(async () => {
  fake = await installFakeOats();
  processes = new Processes();
  oats = new Oats({ bin: fake.bin, cwd: fake.deployment, processes });
});
afterEach(async () => {
  await processes.killAll();
  await fake.remove();
});

describe("the pages' verbs", () => {
  it("souls: the key to spawn by, the capabilities' names, and the kernel's problem", async () => {
    const answer = await oats.souls();
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.souls.map((soul) => soul.name)).toEqual([
      "code-reviewer",
      "oats.okf/knowledge-harvester",
      "oats.okf/knowledge-maintainer",
      "oats-desktop-developer",
      "oats-developer",
      "oats-expert",
      "oats-maintainer",
      "oats-product-expert",
      "research-expert",
    ]);
    const developer = answer.value.souls.find((soul) => soul.name === "oats-developer");
    expect(developer).toMatchObject({ origin: "member github.com/awebai/oats @ e5b6c5ac", spawnable: true, problem: null });
    expect(developer?.capabilities).toContain("oats.developer");
    expect(developer?.description.startsWith("OATS developer")).toBe(true);
    const broken = answer.value.souls.find((soul) => soul.name === "oats.okf/knowledge-maintainer");
    expect(broken).toMatchObject({ spawnable: false, capabilities: [] });
    expect(broken?.problem).toBe('E_TEAM_UNKNOWN: team "reviewers" is not declared (oats-local.yaml#/defaultTeam): declare it with `oats teams add reviewers --team <id>`');
    expect((await fake.calls()).map((call) => call.argv)).toEqual([["souls", "--json"]]);
  });

  it("capabilities: id, description, origin; the count of souls comes from the souls", async () => {
    const [capabilities, souls] = [await oats.capabilities(), await oats.souls()];
    expect(capabilities.ok && souls.ok).toBe(true);
    if (!capabilities.ok || !souls.ok) return;
    const rows = withSoulCounts(capabilities.value.capabilities, souls.value.souls);
    const core = rows.find((row) => row.id === "oats.core");
    expect(core?.origin).toMatch(/^package oats\.framework v/);
    expect(core?.souls).toBe(souls.value.souls.filter((soul) => soul.capabilities.includes("oats.core")).length);
    expect(core?.souls).toBeGreaterThan(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["description", "id", "origin", "souls"]);
  });

  it("teams: label, id and default; an unmapped team has no id", async () => {
    const answer = await oats.teams();
    expect(answer).toEqual({
      ok: true,
      value: { teams: [{ label: "oats", team: "default:oats.aweb.ai", isDefault: true }, { label: "docs", team: null, isDefault: false }] },
    });
  });

  it("machines: the registered servers as the kernel last recorded them", async () => {
    const answer = await oats.servers();
    expect(answer).toEqual({
      ok: true,
      value: {
        machines: [
          { id: "devbox-oats", route: "devbox", isThisMachine: false, note: "devbox · workspace /srv/oats · 2 saved instance routes" },
          { id: "build", route: "build.internal", isThisMachine: false, note: "workspace /home/ci/oats · 0 saved instance routes" },
        ],
      },
    });
    expect((await fake.calls()).map((call) => call.argv)).toEqual([["server", "list", "--json"]]);
  });
});
