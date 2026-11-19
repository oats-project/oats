// The pinned fixtures, as the app receives them: the kernel's status rows reduced to the plugin's
// `Agent` (the mapping `kernel/` does in the host entry), and bb's sidebar threads.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Agent } from "../../model/types";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"));

type StatusRow = {
  instance: string;
  agent: string;
  home: string;
  parentInstance?: string | null;
  attributedHuman?: string | null;
  identityAddress?: string | null;
  capabilityMeta?: { "oats.aweb"?: { alias?: string; team?: string } };
  backend: string;
  session?: { endpoint?: { server?: string; projectId?: string; threadId?: string } } | null;
  running?: boolean | null;
  runtimeState?: string | null;
  runtimeError?: string | null;
  waitingOnYou?: { reason: string; message?: string | null; since?: string | null } | null;
};

export function fixtureAgents(): Agent[] {
  const status = read("status.json") as { agents: { instances: StatusRow[] }[] };
  return status.agents.flatMap((soul) =>
    soul.instances.map((row): Agent => {
      const aweb = row.capabilityMeta?.["oats.aweb"];
      const endpoint = row.session?.endpoint;
      return {
        instance: row.instance,
        soul: row.agent,
        home: row.home,
        parent: row.parentInstance ?? null,
        human: row.attributedHuman ?? null,
        alias: aweb?.alias ?? null,
        team: aweb?.team ?? null,
        address: row.identityAddress ?? null,
        backend: row.backend,
        server: endpoint?.server ?? null,
        projectId: endpoint?.projectId ?? null,
        threadId: endpoint?.threadId ?? null,
        running: row.running ?? null,
        runtimeState: row.runtimeState ?? null,
        runtimeError: row.runtimeError ?? null,
        waiting: row.waitingOnYou
          ? {
              reason: row.waitingOnYou.reason,
              message: row.waitingOnYou.message ?? null,
              since: row.waitingOnYou.since ?? null,
            }
          : null,
      };
    }),
  );
}

export function fixtureThreads(): PluginSidebarThread[] {
  // testing/app 0.6.157 exports no sidebar-thread fixture: the recorded rows carry the fields the
  // plugin reads, so the cast is the fixture's own claim.
  return (read("threads.json") as { threads: PluginSidebarThread[] }).threads;
}

export const DEPLOYMENT = { root: "/abs/deployment", workspace: "oats", machine: "falcon" };

export function fixtureSnapshot(agents: Agent[] = fixtureAgents()) {
  return { ok: true as const, at: "2026-11-19T12:30:00.000Z", deployment: DEPLOYMENT, agents };
}
