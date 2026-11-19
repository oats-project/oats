import { describe, expect, test } from "vitest";
import type { Agent, BbThread, Node } from "../../model/types";
import { flatten, state, view } from "../../model/view";
import { fixtureAgents, fixtureThreads } from "../helpers/fixtures";

let clock = 1_000;
const agent = (instance: string, over: Partial<Agent> = {}): Agent => ({
  instance,
  soul: "soul-x",
  home: `/d/agents/soul-x/instances/${instance}`,
  parent: null,
  human: "joan",
  alias: instance,
  team: "default:oats.aweb.ai",
  address: null,
  backend: "bb",
  server: "http://127.0.0.1:38886",
  projectId: `proj_${instance}`,
  threadId: `thr_${instance}`,
  running: null,
  runtimeState: "unknown",
  runtimeError: null,
  waiting: null,
  ...over,
});
const thread = (id: string, over: Partial<BbThread> = {}): BbThread => ({
  id,
  projectId: null,
  displayTitle: id,
  updatedAt: clock--, // earlier calls are newer, so the default order is the order written
  isUnread: false,
  isArchived: false,
  isHidden: false,
  hasPendingInteraction: false,
  ...over,
});
const threadsFor = (agents: Agent[]) => agents.map((a) => thread(a.threadId!));
const names = (nodes: Node[]) => nodes.map((node) => node.agent.instance);
const shape = (nodes: Node[]): unknown =>
  nodes.map((node) => (node.children.length ? { [node.agent.instance]: shape(node.children) } : node.agent.instance));
const claim = { reason: "question", message: "ok?", since: null };

describe("A1 view(): the tree", () => {
  test("each child is under its parent, with its depth", () => {
    const agents = [agent("lead"), agent("dev", { parent: "lead" }), agent("helper", { parent: "lead" })];
    const v = view(agents, threadsFor(agents));
    expect(shape(v.roots)).toEqual([{ lead: ["dev", "helper"] }]);
    expect(v.roots[0]!.depth).toBe(0);
    expect(v.roots[0]!.children.map((node) => node.depth)).toEqual([1, 1]);
  });

  test("the fixtures: two children under redesign-ui-lead, the other bb agents at the root", () => {
    const v = view(fixtureAgents(), fixtureThreads());
    const lead = v.roots.find((node) => node.agent.instance === "redesign-ui-lead")!;
    expect(names(lead.children).sort()).toEqual(["desktop-mockups-developer", "harvest-knowledge-helper"]);
    expect(names(v.roots).sort()).toEqual([
      "flaky-ci-developer",
      "ranker-v3-probe",
      "redesign-ui-lead",
      "release-070-maintainer",
      "weekly-digest-helper",
    ]);
  });

  test("an orphan, whose parent is not in the tree, is a root", () => {
    const agents = [
      agent("orphan", { parent: "gone" }),
      agent("on-tmux", { backend: "tmux", threadId: null }),
      agent("child-of-tmux", { parent: "on-tmux" }),
    ];
    const v = view(agents, [thread("thr_orphan"), thread("thr_child-of-tmux")]);
    expect(shape(v.roots)).toEqual(["orphan", "child-of-tmux"]);
  });

  test("a parent cycle is cut at the first repeat, and every agent is drawn once", () => {
    const agents = [agent("a", { parent: "b" }), agent("b", { parent: "c" }), agent("c", { parent: "a" })];
    const v = view(agents, threadsFor(agents));
    // walking up from a: a -> b -> c -> a (the repeat): c's link is the one cut
    expect(shape(v.roots)).toEqual([{ c: [{ b: ["a"] }] }]);
    expect(names(flatten(v.roots)).sort()).toEqual(["a", "b", "c"]);
  });

  test("an agent that names itself as its parent is a root", () => {
    const agents = [agent("self", { parent: "self" })];
    expect(shape(view(agents, threadsFor(agents)).roots)).toEqual(["self"]);
  });

  test("order at every level: needs-you, then working, then the rest, each newest first", () => {
    const agents = [
      agent("idle-old"),
      agent("idle-new"),
      agent("working-old", { running: true }),
      agent("working-new", { running: true }),
      agent("needs-old", { waiting: claim }),
      agent("needs-new", { waiting: claim }),
      agent("stopped-newest", { running: false, runtimeState: "stopped" }),
      agent("kid-idle", { parent: "idle-new" }),
      agent("kid-working", { parent: "idle-new", running: true }),
      agent("kid-needs", { parent: "idle-new", waiting: claim }),
    ];
    const at: Record<string, number> = {
      "idle-old": 10,
      "idle-new": 20,
      "working-old": 11,
      "working-new": 21,
      "needs-old": 12,
      "needs-new": 22,
      "stopped-newest": 99,
      "kid-idle": 90,
      "kid-working": 50,
      "kid-needs": 1,
    };
    const v = view(
      agents,
      agents.map((a) => thread(a.threadId!, { updatedAt: at[a.instance]! })),
    );
    expect(names(v.roots)).toEqual([
      "needs-new",
      "needs-old",
      "working-new",
      "working-old",
      "stopped-newest",
      "idle-new",
      "idle-old",
    ]);
    expect(names(v.roots.find((node) => node.agent.instance === "idle-new")!.children)).toEqual([
      "kid-needs",
      "kid-working",
      "kid-idle",
    ]);
  });

  test("depth is capped at 2: deeper nodes stay under their parent and are drawn at 2", () => {
    const agents = [
      agent("d0"),
      agent("d1", { parent: "d0" }),
      agent("d2", { parent: "d1" }),
      agent("d3", { parent: "d2" }),
      agent("d4", { parent: "d3" }),
    ];
    const v = view(agents, threadsFor(agents));
    expect(shape(v.roots)).toEqual([{ d0: [{ d1: [{ d2: [{ d3: ["d4"] }] }] }] }]);
    expect(flatten(v.roots).map((node) => node.depth)).toEqual([0, 1, 2, 2, 2]);
  });

  test("0 agents: an empty tree, every thread in others", () => {
    const v = view([], [thread("t1"), thread("t2")]);
    expect(v.roots).toEqual([]);
    expect(v.others.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect([v.needsYou, v.working, v.finished, v.detached, v.elsewhere]).toEqual([[], [], [], [], []]);
  });

  test("200 agents in one chain that closes a cycle are joined in one pass", () => {
    const agents = Array.from({ length: 200 }, (_, i) =>
      agent(`n${i}`, { parent: i === 0 ? "n199" : `n${i - 1}` }),
    );
    const started = performance.now();
    const v = view(agents, threadsFor(agents));
    expect(performance.now() - started).toBeLessThan(500);
    expect(flatten(v.roots)).toHaveLength(200);
    expect(v.roots).toHaveLength(1);
  });
});

describe("A2 state(): first match wins", () => {
  const t = thread("t");
  test("one case per state, in order", () => {
    expect(state(agent("a", { waiting: claim }), t)).toBe("needs-you");
    expect(state(agent("a", { runtimeState: "unreachable", running: true }), t)).toBe("unreachable");
    expect(state(agent("a", { runtimeState: "stopped", running: true }), t)).toBe("stopped");
    expect(state(agent("a", { runtimeState: "shell", running: true }), t)).toBe("error");
    expect(state(agent("a", { running: true }), t)).toBe("working");
    expect(state(agent("a", { running: null }), t)).toBe("idle");
    expect(state(agent("a", { running: false }), t)).toBe("idle");
  });
  test("an unknown runtimeState word is idle", () => {
    expect(state(agent("a", { runtimeState: "hibernating" }), t)).toBe("idle");
    expect(state(agent("a", { runtimeState: null }), t)).toBe("idle");
  });
  test("a pending interaction with no claim is needs-you", () => {
    expect(state(agent("a"), thread("t", { hasPendingInteraction: true }))).toBe("needs-you");
  });
  test("a claim wins over stopped, unreachable and error", () => {
    for (const runtimeState of ["stopped", "unreachable", "shell"]) {
      expect(state(agent("a", { waiting: claim, runtimeState, running: false }), t)).toBe("needs-you");
    }
  });
  test("the fixtures: three need you, two work, one is stopped, one is idle and unread", () => {
    const v = view(fixtureAgents(), fixtureThreads());
    expect(names(v.needsYou).sort()).toEqual(["flaky-ci-developer", "ranker-v3-probe", "release-070-maintainer"]);
    expect(names(v.working).sort()).toEqual(["desktop-mockups-developer", "redesign-ui-lead"]);
    expect(names(v.finished)).toEqual(["harvest-knowledge-helper"]);
    expect(flatten(v.roots).find((node) => node.agent.instance === "weekly-digest-helper")!.state).toBe("stopped");
  });
});

describe("A3 view(): where everything else goes", () => {
  const only = (v: ReturnType<typeof view>) => ({
    roots: names(flatten(v.roots)),
    others: v.others.map((t) => t.id),
    detached: v.detached.map((a) => a.instance),
    elsewhere: v.elsewhere.map((a) => a.instance),
  });

  test("a thread with no agent is in others only", () => {
    const v = view([agent("a")], [thread("thr_a"), thread("thr_plain")]);
    expect(only(v)).toEqual({ roots: ["a"], others: ["thr_plain"], detached: [], elsewhere: [] });
  });
  test("the fixtures: the plain bb thread is the only other thread", () => {
    expect(view(fixtureAgents(), fixtureThreads()).others.map((t) => t.id)).toEqual(["thr_plain"]);
  });
  test("others are newest first, and leave out archived and hidden threads", () => {
    const v = view(
      [],
      [
        thread("old", { updatedAt: 1 }),
        thread("new", { updatedAt: 9 }),
        thread("archived", { isArchived: true }),
        thread("hidden", { isHidden: true }),
      ],
    );
    expect(v.others.map((t) => t.id)).toEqual(["new", "old"]);
  });
  test("an agent whose thread is archived is in detached only", () => {
    const v = view([agent("a")], [thread("thr_a", { isArchived: true })]);
    expect(only(v)).toEqual({ roots: [], others: [], detached: ["a"], elsewhere: [] });
  });
  test("an agent whose thread is hidden, deleted, or was never recorded is in detached only", () => {
    const agents = [agent("hidden"), agent("deleted"), agent("no-id", { threadId: null })];
    const v = view(agents, [thread("thr_hidden", { isHidden: true })]);
    expect(only(v)).toEqual({ roots: [], others: [], detached: ["hidden", "deleted", "no-id"], elsewhere: [] });
  });
  test("a tmux agent is in elsewhere only, even when it names a thread", () => {
    const v = view([agent("t", { backend: "tmux", threadId: "thr_x" })], [thread("thr_x")]);
    expect(only(v)).toEqual({ roots: [], others: ["thr_x"], detached: [], elsewhere: ["t"] });
  });
  test("the fixtures: the tmux agent is elsewhere", () => {
    expect(view(fixtureAgents(), fixtureThreads()).elsewhere.map((a) => a.instance)).toEqual(["kernel-fix-developer"]);
  });
  test("a duplicate thread id: the first agent in the kernel's order is drawn, the second is detached", () => {
    const v = view([agent("first", { threadId: "thr_same" }), agent("second", { threadId: "thr_same" })], [thread("thr_same")]);
    expect(only(v)).toEqual({ roots: ["first"], others: [], detached: ["second"], elsewhere: [] });
  });
  test("a child of a detached agent is a root", () => {
    const v = view([agent("gone"), agent("kid", { parent: "gone" })], [thread("thr_kid")]);
    expect(only(v)).toEqual({ roots: ["kid"], others: [], detached: ["gone"], elsewhere: [] });
  });
  test("an agent on another session provider is joined like a bb agent", () => {
    const v = view([agent("x", { backend: "other" })], [thread("thr_x")]);
    expect(only(v).roots).toEqual(["x"]);
  });
});
