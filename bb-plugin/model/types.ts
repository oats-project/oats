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
