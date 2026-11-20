import test from "node:test";
import assert from "node:assert/strict";
import { instanceId, visibleClusters } from "../../client/instance-tree.mjs";
import { treeGuideSegments } from "../renderer/instance-tree-view.mjs";
import { RELATED_WORK_FEATURE } from "../../client/related-work.mjs";

// Every row of a host that declares instance-related-work, related to its parent, so every lineage guide the identity
// rules allow is drawn (related-work.mjs: no flag, no line; related-work-lines.test.mjs pins the unflagged cases).
const RELATED = { relatedWorkKnown: RELATED_WORK_FEATURE, relatedWork: true };
const row = (instance, root, extra = {}) => ({
  instance, agentsRoot: `/${root}/agents`, home: `/${root}/${instance}`, ...RELATED, ...extra,
});
const guides = (items, original, full = items) => {
  // Clustering annotates copies; resolve the displayed row by identity.
  const item = items.find((i) => instanceId(i) === instanceId(original));
  assert.ok(item, "fixture row is visible");
  return treeGuideSegments(items, item, full);
};
const clusterRows = (full, visible = full) => {
  const clusters = visibleClusters(full, visible);
  assert.equal(clusters.length, 1, "fixture stays one related cluster");
  return clusters[0].instances;
};

function duplicateParents() {
  const top = row("top", "a");
  const parentA = row("parent", "a", { parentInstance: "top" });
  const childA = row("child", "a", { parentInstance: "parent" });
  const parentB = row("parent", "b", { parentInstance: "top" });
  const childB = row("child", "b", { parentInstance: "parent" });
  return { top, parentA, childA, parentB, childB, full: [top, parentA, childA, parentB, childB] };
}

test("lineage guides distinguish duplicate parents and children within one cross-root cluster", () => {
  const { top, parentA, childA, parentB, childB, full } = duplicateParents();
  const items = clusterRows(full);
  assert.deepEqual(items.map(instanceId), full.map(instanceId));
  assert.deepEqual(items.map((i) => i.depth), [0, 1, 2, 1, 2]);
  assert.deepEqual(guides(items, top, full), []);
  assert.deepEqual(guides(items, parentA, full), ["branch"]);
  assert.deepEqual(guides(items, childA, full), ["continue", "end"],
    "the other root's same-named child is not a later sibling");
  assert.deepEqual(guides(items, parentB, full), ["end"]);
  assert.deepEqual(guides(items, childB, full), ["none", "end"]);
});

test("lineage guides keep same-path local and remote trees separate", () => {
  const full = [undefined, "first", "second"].flatMap((server) => [
    row("root", "same", { server }),
    row("child", "same", { server, parentInstance: "root" }),
    row("grandchild", "same", { server, parentInstance: "child" }),
  ]);
  const clusters = visibleClusters(full, full);
  assert.equal(clusters.length, 3, "hosts never become sibling clusters");
  for (const { instances } of clusters) {
    assert.deepEqual(guides(instances, instances[1], full), ["end"]);
    assert.deepEqual(guides(instances, instances[2], full), ["none", "end"]);
  }
  // Even a flattened multi-tree list must not count another host's children
  // as later siblings, or follow a same-path ancestor on that other host.
  for (let at = 0; at < full.length; at += 3) {
    assert.deepEqual(guides(full, full[at + 1]), ["end"]);
    assert.deepEqual(guides(full, full[at + 2]), ["none", "end"]);
    const withoutOwnRoot = full.filter((i) => i !== full[at]);
    assert.deepEqual(guides(withoutOwnRoot, full[at + 1], full), []);
  }
});

test("lineage guides retain unique cross-root parents and visible sibling elbows", () => {
  const full = [row("root", "a"),
    row("child-a", "b", { parentInstance: "root" }),
    row("child-b", "c", { parentInstance: "root" })];
  const items = clusterRows(full);
  assert.deepEqual(items.map((i) => i.depth), [0, 1, 1]);
  assert.deepEqual(guides(items, full[1], full), ["branch"]);
  assert.deepEqual(guides(items, full[2], full), ["end"]);
});

test("lineage guides do not replace a filtered parent or ancestor with a visible same-named twin", () => {
  const { parentA, childA, parentB, childB, full } = duplicateParents();
  const grandchild = row("grandchild", "a", { parentInstance: "child" });
  full.push(grandchild);
  const items = clusterRows(full, full.filter((i) => i !== parentA));
  assert.deepEqual(guides(items, childA, full), [], "hidden immediate parent draws no guide");
  assert.deepEqual(guides(items, grandchild, full), ["end"],
    "visible ancestry stops at the filtered ancestor, without climbing through its twin");
  assert.deepEqual(guides(items, parentB, full), ["end"]);
  assert.deepEqual(guides(items, childB, full), ["none", "end"]);
  const orphanOnly = clusterRows(full, [childA]);
  assert.deepEqual(guides(orphanOnly, childA, full), [], "no visible parent means no elbow");
});

for (const ambiguity of ["same-root", "cross-root"]) {
  test(`lineage guides refuse ${ambiguity} ambiguity even when a sibling cluster/filter hides a candidate`, () => {
    const a = row("parent", "a", { siblingInstance: "worker" });
    const b = row("parent", ambiguity === "same-root" ? "a" : "b", {
      home: "/other/parent", siblingInstance: "worker",
    });
    const worker = row("worker", ambiguity === "same-root" ? "a" : "c", { parentInstance: "parent" });
    const full = [a, b, worker];
    for (const visible of [full, [a, worker], [b, worker]]) {
      const items = clusterRows(full, visible);
      assert.ok(items.every((i) => i.depth === 0), "sibling links group roots without inventing parentage");
      for (const item of items) {
        assert.deepEqual(guides(items, item, full), [], "ambiguous parent names never draw ancestry guides");
      }
    }
    // A candidate can also be absent from items simply because it belongs
    // to another cluster, even when no filter is active.
    const unfiltered = [a, { ...b, siblingInstance: undefined }, worker];
    const clusters = visibleClusters(unfiltered, unfiltered);
    assert.equal(clusters.length, 2);
    const items = clusters.find((c) => c.instances.some((i) => instanceId(i) === instanceId(worker))).instances;
    assert.deepEqual(guides(items, worker, unfiltered), [], "another cluster's candidate still makes the name ambiguous");
  });
}

test("lineage guides project continuation onto visible siblings, retaining the two-argument API", () => {
  const full = [
    { instance: "root" },
    { instance: "child-a", parentInstance: "root" },
    { instance: "grandchild", parentInstance: "child-a" },
    { instance: "child-b", parentInstance: "root" },
  ].map((r) => ({ ...r, ...RELATED }));
  // Existing callers passing the actual displayed object keep their API.
  assert.deepEqual(treeGuideSegments(full, full[1]), ["branch"]);
  assert.deepEqual(treeGuideSegments(full, full[2]), ["continue", "end"]);
  assert.deepEqual(treeGuideSegments(full, full[3]), ["end"]);
  assert.deepEqual(treeGuideSegments(full, { ...full[3] }), ["end"],
    "a copied last child is not its own later sibling");
  const items = clusterRows(full, full.slice(0, 3));
  assert.deepEqual(guides(items, full[1], full), ["end"], "hidden siblings do not prolong elbows");
  assert.deepEqual(guides(items, full[2], full), ["none", "end"],
    "hidden siblings do not leave an ancestor continuation");
});

test("lineage guides follow repeated names at different ancestry levels by identity", () => {
  const full = [row("root", "a"),
    row("repeated", "a", { parentInstance: "root" }),
    row("middle", "a", { parentInstance: "repeated" }),
    row("repeated", "b", { parentInstance: "middle" })];
  const items = clusterRows(full);
  assert.deepEqual(items.map((i) => i.depth), [0, 1, 2, 3]);
  assert.deepEqual(guides(items, full[3], full), ["none", "none", "end"],
    "a same-named ancestor in another root is not a cycle");
});
