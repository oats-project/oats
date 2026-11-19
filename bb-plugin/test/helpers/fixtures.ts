// The pinned fixtures, as the app receives them: the kernel's status rows reduced to the plugin's
// `Agent` (the mapping `kernel/` does in the host entry), and bb's sidebar threads.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Agent } from "../../model/types";

// vitest runs from the package root, under node and under jsdom alike.
const read = (name: string): unknown => JSON.parse(readFileSync(resolve(process.cwd(), "test/fixtures", name), "utf8"));

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

/**
 * What bb-app 0.50.1 reports for the fields the pinned threads.json leaves out (recorded in the
 * backend probe's b2-frontend-useSidebarThreads.json): bb's own status glyph reads `activity`
 * and `queuedWork`, and bb's thread menu reads the rest.
 */
const RECORDED_DEFAULTS = {
  titleFallback: null,
  queuedWork: "none",
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
  parentNotifications: "off",
  lifecycleOwnerThreadId: null,
  sourceThreadId: null,
  sectionId: null,
  originKind: null,
  originPluginId: null,
  isPinned: false,
  pinnedAt: null,
  pinSortKey: null,
  archivedAt: null,
  lastReadAt: null,
  latestAttentionAt: 0,
} satisfies Partial<PluginSidebarThread>;

export function fixtureThreads(): PluginSidebarThread[] {
  // testing/app 0.6.157 exports no sidebar-thread fixture, so the rows are the pinned recording
  // over the recorded defaults.
  const { threads } = read("threads.json") as { threads: Partial<PluginSidebarThread>[] };
  return threads.map((thread) => ({ ...RECORDED_DEFAULTS, ...thread }) as PluginSidebarThread);
}

export const DEPLOYMENT = { root: "/abs/deployment", workspace: "oats", machine: "falcon" };

export function fixtureSnapshot(agents: Agent[] = fixtureAgents()) {
  return { ok: true as const, at: "2026-11-19T12:30:00.000Z", deployment: DEPLOYMENT, agents };
}
