// Pinned by the spec: the contracts between the plugin's three parts.
//   app.tsx -> server.ts : rpcContract (bb.rpc)
//   server.ts -> host.ts : hostContract (bb.hosts), signal `changed`
//   server.ts -> app.tsx : realtime channel REALTIME_CHANGED, payload { at }
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const REALTIME_CHANGED = "oats/changed";

/** The kernel's instance-name rule, as the plugin enforces it before any process starts. */
export const instanceName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const soulName = z.string().min(1).max(128);
const key = z.string().min(8).max(128);

export const agent = z.object({
  instance: z.string(),
  soul: z.string(),
  home: z.string(),
  parent: z.string().nullable(),
  human: z.string().nullable(),
  alias: z.string().nullable(),
  team: z.string().nullable(),
  address: z.string().nullable(),
  backend: z.string(),
  server: z.string().nullable(),
  projectId: z.string().nullable(),
  threadId: z.string().nullable(),
  running: z.boolean().nullable(),
  runtimeState: z.string().nullable(),
  runtimeError: z.string().nullable(),
  waiting: z
    .object({ reason: z.string(), message: z.string().nullable(), since: z.string().nullable() })
    .nullable(),
});

export const snapshot = z.union([
  z.object({
    ok: z.literal(true),
    at: z.string(),
    deployment: z.object({ root: z.string(), workspace: z.string(), machine: z.string() }),
    agents: z.array(agent),
  }),
  z.object({ ok: z.literal(false), at: z.string(), code: z.string(), message: z.string() }),
]);

// The page rows carry only what the pages draw. The backend builder fills these from the kernel's
// real answers; adding a field is agreed with the frontend builder, through the spec's author.
export const soul = z.object({
  name: z.string(),
  description: z.string(),
  origin: z.string(),
  capabilities: z.array(z.string()),
  spawnable: z.boolean(),
  problem: z.string().nullable(),
});
export const capability = z.object({
  id: z.string(),
  description: z.string(),
  origin: z.string(),
  souls: z.number().int(),
});
export const team = z.object({ label: z.string(), team: z.string(), isDefault: z.boolean() });
export const machine = z.object({
  id: z.string(),
  route: z.string().nullable(),
  isThisMachine: z.boolean(),
  note: z.string().nullable(),
});
export const spawnSummary = z.object({
  modules: z.array(z.string()),
  teams: z.array(z.string()),
  launch: z.string().nullable(),
  warnings: z.array(z.string()),
  problems: z.array(z.string()),
});
const plan = z.object({ revision: z.string(), lines: z.array(z.string()) });
const spawnInput = z.object({ soul: soulName, name: instanceName, task: z.string().min(1).max(100_000) });

const verbs = {
  snapshot: { input: z.null(), output: snapshot },
  souls: { input: z.null(), output: z.object({ souls: z.array(soul) }) },
  capabilities: { input: z.null(), output: z.object({ capabilities: z.array(capability) }) },
  teams: { input: z.null(), output: z.object({ teams: z.array(team) }) },
  machines: { input: z.null(), output: z.object({ machines: z.array(machine) }) },
  spawnPreview: { input: spawnInput.strict(), output: z.object({ summary: spawnSummary }) },
  spawn: {
    input: spawnInput.extend({ key }).strict(),
    output: z.object({ instance: z.string(), threadId: z.string() }),
  },
  stopPlan: { input: z.object({ instance: instanceName }).strict(), output: plan },
  stopApply: {
    input: z.object({ instance: instanceName, revision: z.string(), key }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  start: { input: z.object({ instance: instanceName }).strict(), output: z.object({ threadId: z.string() }) },
  restart: { input: z.object({ instance: instanceName }).strict(), output: z.object({ threadId: z.string() }) },
  retirePlan: { input: z.object({ instance: instanceName }).strict(), output: plan },
  retireApply: {
    input: z.object({ instance: instanceName, revision: z.string(), key }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
} as const;

/** app -> server. `refresh` asks the server to reread now (Retry). */
export const rpcContract = defineRpcContract({
  ...verbs,
  refresh: { input: z.null(), output: z.object({ at: z.string() }) },
});

/**
 * server -> host. The host entry builds every argv itself from a closed list of verbs: the server
 * never sends a command, a flag or a path other than the deployment and the home the kernel named.
 * The builder of host.ts gives each verb its own typed input here (deployment root, oats binary,
 * and that verb's arguments) and marks the read verbs `experimental_retryable`.
 */
export const hostVerbs = [
  "discover",
  "status",
  "souls",
  "capabilities",
  "teams",
  "servers",
  "spawnPreview",
  "spawn",
  "stopPlan",
  "stopApply",
  "start",
  "restart",
  "retirePlan",
  "retireApply",
  "watch",
] as const;

export const hostSignals = {
  changed: { payload: z.object({ reason: z.string() }).strict() },
} satisfies ExperimentalHostSignals;
