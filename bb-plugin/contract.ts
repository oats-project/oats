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
  /** the soul key: what `oats spawn` takes (`<package>/<soul>` for a package soul) */
  name: z.string(),
  /** the roster agent name of this soul's instances: equal to their `Agent.soul` */
  agent: z.string(),
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
/** `team` is null for a shared team no provider id is committed for yet ("not mapped"). */
export const team = z.object({ label: z.string(), team: z.string().nullable(), isDefault: z.boolean() });
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

// ---- The host contract: one method per entry of `hostVerbs`, each with its own typed input. ----
// Every method that runs `oats` answers `{ ok: true, value } | { ok: false, error: { code, message } }`
// and never throws for a kernel refusal or a failed process: `code` is the kernel's (`E_*`) or one
// of the plugin's own (kernel/result.ts), and `message` is the kernel's, unchanged.

/** Where the host entry runs `oats`: the deployment directory (its cwd) and the binary ("" = `oats` on PATH). */
const hostBase = { deployment: z.string().min(1), oatsBin: z.string() };
const kernelError = z.object({ code: z.string(), message: z.string() });
const answer = <Value extends z.ZodType>(value: Value) =>
  z.union([
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error: kernelError }),
  ]);
const hostRead = z.object(hostBase).strict();
const hostInstance = z.object({ ...hostBase, instance: instanceName }).strict();
const hostApply = z.object({ ...hostBase, instance: instanceName, revision: z.string(), key }).strict();
const hostHome = z.object({ ...hostBase, home: z.string().min(1) }).strict();
const hostSpawn = z.object({ ...hostBase, ...spawnInput.shape });
const threadAnswer = answer(z.object({ threadId: z.string().nullable() }));

/** `oats capabilities` rows; the server adds the number of souls from `oats souls`. */
export const hostCapability = capability.omit({ souls: true });

const hostMethods = {
  /**
   * Finds the deployment directory. `deployment` is the setting ("" = walk up from each of `roots`,
   * the bb project roots on this machine, to the first directory holding `oats-local.yaml`).
   */
  discover: {
    experimental_retryable: true,
    input: z.object({ deployment: z.string(), roots: z.array(z.string()) }).strict(),
    output: z.object({ deployment: z.string().nullable(), machine: z.string() }),
  },
  status: {
    experimental_retryable: true,
    input: hostRead,
    output: answer(z.object({ root: z.string(), workspace: z.string().nullable(), agents: z.array(agent) })),
  },
  souls: { experimental_retryable: true, input: hostRead, output: answer(z.object({ souls: z.array(soul) })) },
  capabilities: {
    experimental_retryable: true,
    input: hostRead,
    output: answer(z.object({ capabilities: z.array(hostCapability) })),
  },
  teams: { experimental_retryable: true, input: hostRead, output: answer(z.object({ teams: z.array(team) })) },
  servers: { experimental_retryable: true, input: hostRead, output: answer(z.object({ machines: z.array(machine) })) },
  /** `revision` is the kernel's decision revision for this soul, name and task. */
  spawnPreview: {
    experimental_retryable: true,
    input: hostSpawn.strict(),
    output: answer(z.object({ summary: spawnSummary, revision: z.string() })),
  },
  /**
   * The kernel takes an idempotency key only with the decision it confirms, so the host entry reads
   * the preview and applies it in one call. `revision` is the decision an earlier call with the same
   * key applied (null on the first call): with it the kernel replays that spawn instead of refusing.
   */
  spawn: {
    input: hostSpawn.extend({ key, revision: z.string().nullable() }).strict(),
    output: answer(z.object({ instance: z.string(), threadId: z.string().nullable(), revision: z.string() })),
  },
  stopPlan: { experimental_retryable: true, input: hostInstance, output: answer(plan) },
  stopApply: { input: hostApply, output: answer(z.object({})) },
  /** `home` is the home the kernel's status named for the instance; never a caller's. */
  start: { input: hostHome, output: threadAnswer },
  restart: { input: hostHome, output: threadAnswer },
  /** Not retryable: each retire plan appends one `retire-planned` event to the workspace log. */
  retirePlan: { input: hostInstance, output: answer(plan) },
  retireApply: { input: hostApply, output: answer(z.object({})) },
  /** Watches the deployment's event log; each batch is one `changed` signal. Null: nothing to watch yet. */
  watch: {
    input: z.object({ deployment: z.string().min(1) }).strict(),
    output: z.object({ watching: z.string().nullable() }),
  },
} satisfies Record<(typeof hostVerbs)[number], unknown>;

export const hostContract = defineRpcContract(hostMethods);
