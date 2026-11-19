// Pinned by the spec. No bb or React import in model/.

/** One OATS instance, as the kernel's `oats status --json` row describes it. */
export type Agent = {
  instance: string;
  soul: string;
  home: string;
  /** parentInstance */
  parent: string | null;
  /** attributedHuman; drawn as "parent · <human>" when parent is null */
  human: string | null;
  alias: string | null;
  team: string | null;
  address: string | null;
  /** "bb" | "tmux" | another session provider's name */
  backend: string;
  /** session.endpoint, null on a tmux row */
  server: string | null;
  projectId: string | null;
  threadId: string | null;
  /** The kernel's word. Never inferred. */
  running: true | false | null;
  /** "unknown" | "shell" | "stopped" | "unreachable"; any other word is drawn as idle */
  runtimeState: string | null;
  runtimeError: string | null;
  waiting: { reason: string; message: string | null; since: string | null } | null;
};

/** The fields of bb's sidebar thread that the model reads. */
export type BbThread = {
  id: string;
  projectId: string | null;
  displayTitle: string;
  /** epoch milliseconds, as bb gives it */
  updatedAt: number;
  isUnread: boolean;
  isArchived: boolean;
  isHidden: boolean;
  hasPendingInteraction: boolean;
};

export type AgentState = "needs-you" | "unreachable" | "stopped" | "error" | "working" | "idle";

export type Node = {
  agent: Agent;
  thread: BbThread;
  state: AgentState;
  depth: 0 | 1 | 2;
  children: Node[];
};

export type View = {
  /** the agents tree */
  roots: Node[];
  /** threads with no agent */
  others: BbThread[];
  /** agents on a session provider whose thread is archived, hidden, deleted or taken by another agent */
  detached: Agent[];
  /** agents on tmux */
  elsewhere: Agent[];
  needsYou: Node[];
  working: Node[];
  /** state idle and the thread unread */
  finished: Node[];
};

// ---- The rows of the four pages and of the spawn preview (contract.ts holds their schemas). ----

/** One soul of `oats souls`. */
export type Soul = {
  /** the soul key: what `oats spawn` takes (`<package>/<soul>` for a package soul) */
  name: string;
  /** the roster agent name of this soul's instances: equal to their `Agent.soul` */
  agent: string;
  description: string;
  /** display text, as the kernel words it */
  origin: string;
  /** names of the capabilities the soul composes; empty when the kernel cannot say */
  capabilities: string[];
  spawnable: boolean;
  /** "<code>: <message>", the kernel's, when the soul cannot be spawned */
  problem: string | null;
};

/** One capability of `oats capabilities`. */
export type Capability = {
  id: string;
  description: string;
  origin: string;
  /** how many of this deployment's souls compose it */
  souls: number;
};

/** One team of `oats teams`. */
export type Team = {
  label: string;
  /** the provider's team id; null for a shared team that is not mapped yet */
  team: string | null;
  isDefault: boolean;
};

/** This machine, or one registered server of `oats server list`. */
export type Machine = {
  id: string;
  /** the ssh alias the kernel recorded; null for this machine */
  route: string | null;
  isThisMachine: boolean;
  /** what the kernel last recorded about it */
  note: string | null;
};

/** What `oats spawn --preview` would do, as the form draws it. */
export type SpawnSummary = {
  modules: string[];
  teams: string[];
  /** harness and model, with where the model comes from */
  launch: string | null;
  warnings: string[];
  problems: string[];
};
