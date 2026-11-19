// A4: `status()` returns a typed error for non-JSON, for a row with no `instance` and for a
// timeout; it accepts unknown extra fields.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codes, Oats, Processes } from "../../kernel/index.js";
import { FIXTURES, gone, installFakeOats, type FakeOats } from "../support/fake-oats.js";

let fake: FakeOats;
let processes: Processes;
const oats = (timeouts = {}) => new Oats({ bin: fake.bin, cwd: fake.deployment, processes, timeouts });

beforeEach(async () => {
  fake = await installFakeOats();
  processes = new Processes();
});
afterEach(async () => {
  await processes.killAll();
  await fake.remove();
});

describe("A4 status()", () => {
  it("reads the roster into the plugin's agents, in the kernel's order", async () => {
    const status = await oats().status();
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.root).toBe("/abs/deployment");
    expect(status.value.workspace).toBe("github.com/awebai/oats");
    expect(status.value.agents.map((agent) => agent.instance)).toEqual([
      "release-070-maintainer",
      "redesign-ui-lead",
      "desktop-mockups-developer",
      "harvest-knowledge-helper",
      "flaky-ci-developer",
      "kernel-fix-developer",
      "ranker-v3-probe",
      "weekly-digest-helper",
    ]);
    expect(status.value.agents[0]).toEqual({
      instance: "release-070-maintainer",
      soul: "oats-maintainer",
      home: "/abs/deployment/agents/oats-maintainer/instances/release-070-maintainer",
      parent: null,
      human: "joan",
      alias: "release-070-maintainer",
      team: "default:oats.aweb.ai",
      address: null,
      backend: "bb",
      server: "http://127.0.0.1:38886",
      projectId: "proj_release",
      threadId: "thr_release",
      running: null,
      runtimeState: "unknown",
      runtimeError: null,
      waiting: { reason: "attention", message: "Green light at 9f2e1c? Second reader done.", since: "2026-11-19T12:22:00.000Z" },
    });
    const tmux = status.value.agents.find((agent) => agent.instance === "kernel-fix-developer");
    expect(tmux).toMatchObject({ backend: "tmux", server: null, projectId: null, threadId: null, running: true });
    const child = status.value.agents.find((agent) => agent.instance === "desktop-mockups-developer");
    expect(child).toMatchObject({ parent: "redesign-ui-lead", soul: "oats-desktop-developer", waiting: null });
    expect((await fake.calls()).map((call) => call.argv)).toEqual([["status", "--json"]]);
    expect((await fake.calls())[0]?.cwd).toBe(fake.deployment);
  });

  it("answers a typed error for output that is not JSON", async () => {
    await fake.behave({ status: { stdout: "oats: something else entirely\n" } });
    const status = await oats().status();
    expect(status).toEqual({ ok: false, error: { code: codes.notJson, message: "`oats` did not answer JSON: oats: something else entirely" } });
  });

  it("answers a typed error for a row with no instance", async () => {
    const roster = JSON.parse(await readFile(join(FIXTURES, "status.json"), "utf8"));
    delete roster.agents[1].instances[0].instance;
    await fake.behave({ status: { stdout: JSON.stringify(roster) } });
    const status = await oats().status();
    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.error.code).toBe(codes.badAnswer);
    expect(status.error.message).toContain("agents.1.instances.0.instance");
  });

  it("answers a typed error for a timeout, and the process is gone", async () => {
    await fake.behave({ status: { sleepMs: 60_000 } });
    const status = await oats({ read: 300 }).status();
    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.error.code).toBe(codes.timeout);
    const [call] = await fake.calls();
    expect(call).toBeDefined();
    await gone([call!.pid]);
    expect(processes.size).toBe(0);
  });

  it("accepts unknown extra fields, at every level", async () => {
    const roster = JSON.parse(await readFile(join(FIXTURES, "status.json"), "utf8"));
    roster.somethingNew = { nested: [1, 2, 3] };
    roster.agents[0].laterField = true;
    for (const group of roster.agents) {
      for (const instance of group.instances) {
        instance.futureFact = { a: 1 };
        if (instance.session) instance.session.endpoint.region = "eu";
        if (instance.waitingOnYou) instance.waitingOnYou.urgency = "high";
      }
    }
    roster.agents[0].instances[0].runtimeState = "hibernating"; // a state word of a newer kernel
    await fake.behave({ status: { stdout: JSON.stringify(roster) } });
    const status = await oats().status();
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.agents).toHaveLength(8);
    expect(status.value.agents[0]?.runtimeState).toBe("hibernating");
    expect(Object.keys(status.value.agents[0]!).sort()).toEqual(
      ["address", "alias", "backend", "home", "human", "instance", "parent", "projectId", "running", "runtimeError", "runtimeState", "server", "soul", "team", "threadId", "waiting"],
    );
  });

  it("reads a row of today's kernel, which names no backend and no session, as a tmux agent", async () => {
    const roster = {
      root: "/w/agents",
      agents: [
        {
          name: "dev",
          instances: [
            {
              agent: "dev",
              instance: "dev-1",
              home: "/w/agents/dev/instances/dev-1",
              parentInstance: "lead-1",
              identity: { mode: "local", alias: "dev-1", team: "eng:nw.aweb.ai", address: null },
              identityAddress: "dev-1",
              tmux: { session: "oats-agents", window: "dev-1" },
              running: true,
              waitingOnYou: null,
            },
            { instance: "broken", home: "/w/agents/dev/instances/broken", running: null, runtimeState: "unreachable", runtimeError: "E_UNIDENTIFIED_INSTANCE_HOME: cannot be read", waitingOnYou: null },
          ],
        },
      ],
    };
    await fake.behave({ status: { stdout: JSON.stringify(roster) } });
    const status = await oats().status();
    expect(status.ok && status.value.workspace).toBe(null);
    expect(status.ok && status.value.agents).toEqual([
      {
        instance: "dev-1", soul: "dev", home: "/w/agents/dev/instances/dev-1", parent: "lead-1", human: null, alias: "dev-1", team: "eng:nw.aweb.ai",
        address: "dev-1", backend: "tmux", server: null, projectId: null, threadId: null, running: true, runtimeState: null, runtimeError: null, waiting: null,
      },
      {
        instance: "broken", soul: "dev", home: "/w/agents/dev/instances/broken", parent: null, human: null, alias: null, team: null,
        address: null, backend: "tmux", server: null, projectId: null, threadId: null, running: null, runtimeState: "unreachable",
        runtimeError: "E_UNIDENTIFIED_INSTANCE_HOME: cannot be read", waiting: null,
      },
    ]);
  });

  it("names an agent's soul by the row's agent, whatever key the roster gives the group", async () => {
    const instance = (name: string, agent?: string) => ({ ...(agent ? { agent } : {}), instance: name, home: `/w/agents/x/instances/${name}`, running: null });
    const roster = {
      root: "/w/agents",
      agents: [
        { name: "oats-framework--oats-setup-expert", key: "oats.framework/oats-setup-expert", instances: [instance("setup-1", "oats-framework--oats-setup-expert")] },
        { name: "oats-okf--knowledge-harvester", key: null, instances: [instance("harvest-1", "oats-okf--knowledge-harvester")] },
        { name: "dev", instances: [instance("dev-1")] },
      ],
    };
    await fake.behave({ status: { stdout: JSON.stringify(roster) } });
    const status = await oats().status();
    expect(status.ok && status.value.agents.map((agent) => agent.soul)).toEqual(["oats-framework--oats-setup-expert", "oats-okf--knowledge-harvester", "dev"]);
  });

  it("answers the kernel's own code and message for a refusal", async () => {
    await fake.behave({
      status: { stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_LOCAL_MISSING", message: "no oats-local.yaml in reach of /somewhere" } }) },
    });
    expect(await oats().status()).toEqual({ ok: false, error: { code: "E_LOCAL_MISSING", message: "no oats-local.yaml in reach of /somewhere" } });
  });

  it("says so when oats is absent", async () => {
    const status = await new Oats({ bin: join(fake.deployment, "no-such-oats"), cwd: fake.deployment, processes }).status();
    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.error.code).toBe(codes.notFound);
  });

  it("says what oats said when it fails with no JSON", async () => {
    await fake.behave({ status: { stdout: "", stderr: "oats: the workspace cannot be read\nmore\n", exit: 3 } });
    expect(await oats().status()).toEqual({ ok: false, error: { code: codes.failed, message: "`oats` exited 3: oats: the workspace cannot be read\nmore" } });
  });

  it("stops a call whose signal aborts", async () => {
    await fake.behave({ status: { sleepMs: 60_000 } });
    const controller = new AbortController();
    const pending = oats().status(controller.signal);
    let calls = await fake.calls();
    for (let tries = 0; calls.length === 0 && tries < 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      calls = await fake.calls();
    }
    controller.abort();
    const status = await pending;
    expect(status.ok === false && status.error.code).toBe(codes.aborted);
    await gone([calls[0]!.pid]);
  });
});
