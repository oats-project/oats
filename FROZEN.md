# FROZEN: Desktop UI rework, slice 6b, the Graph

Frozen on 2026-11-20 by Joan's decision (relayed by desktop-rework-lead): the work stops here and is kept for
later. Today's Desktop may be replaced by a bb-based app; if not, the work resumes from this branch.
Delete this file in the first commit of a resumed effort.

## Where the work stands
- Branch `agents/redesign-graph-developer`. Its first commit is a merge of #1979 (slice 3b, then open) into main
  e5b6c5ac4; the slice's own commits follow it.
- The Graph is built: `packages/desktop/renderer/views/graph.mjs` (a page of its own: Home › Graph, the palette's
  "Workspace: Graph") over the pure layout `packages/client/instance-graph.mjs`. `views/hierarchy.mjs` and
  `views/clusters.mjs` are removed with their tests; Machines' List | Map is gone. Docs: `docs/desktop.md` "The
  Graph", the Desktop and renderer READMEs, `docs/release-notes/next/desktop-graph.md`.
- Tests: `packages/desktop/test/graph-slice6b.test.mjs` (the six pinned acceptance tests and more),
  `test/client-instance-graph.test.mjs`. Linux tests (hand-started) were green on every fix head up to 375e14930;
  the run for 064724c07 (44640174933) was not read.
- The lead's decisions that amend the spec (mail 3bf1bb85): one column per deployment (machineLabels, this computer
  first, a "You" root per column); a dotted cross-machine edge only on a unique name match, a display rule; the Graph
  reads the roster Home reads; "Recent events…" in the node menu is interim until slice 6a's Details carries it;
  Alt+G (Ctrl+Alt+G) is this slice's once slice 4 (#1986) lands.
- The live real-app tier is done at 064724c07 (headless ozone Desktop over CDP, private HOME, OATS_HOME_DIR and
  TMUX_TMPDIR, a fixture of five agents): Home › Graph, keys, the menu, one field, Enter opening a terminal tab,
  Details on a stopped agent (no start), dark and light.

## Review state
- Four fresh review rounds (gpt-6.1-sol), none clean: r1 4 majors + 1 minor, r2 2 + 2, r3 1 + 1, r4 2 + 1. All
  findings are fixed; r4's fixes are at 064724c07.
- Open: r4's fixes have not been read. The lead's ruling (mail 6097e911): no fifth whole round, one fresh Sol reader
  on the delta 375e14930..064724c07, briefed with r4's three findings and the Graph's focus and camera model. A
  reader was started and stopped by the freeze before it reported. If it finds another major in focus or camera
  handling, take it to the lead: the rule would be simplified (for example, never restore focus across a repaint that
  changes the column set; land on the column heading instead).
- No PR was opened; there is no VERIFIED.

## What a resumer does first
1. Rebase onto main with rerere off (`git -c rerere.enabled=false rebase …`; the shared clone's rr-cache holds other
   developers' resolutions): drop the #1979 merge commit for the merged slice 3b, take slice 4 (#1986: add Alt+G and
   its Ctrl+Alt twin) and slice 6a (pages as tabs: `openViewTab('page:graph')`; Details through `ctx.openDetails(row)`
   or the 'details' action, `openDetailsTab(row)`, replacing the interim `ctx.openAgentDetails` and the node menu's
   "Recent events…"; read the roster model 6a gives Home, #1987), and Pepe's related work.
2. Run the delta read of r4's fixes (above), then the review loop on what the rebase changed.
3. Hand back to the effort's lead; open the PR (lane:product, maintainer joan-product-maintainer) only on VERIFIED.

## Known leftovers
- The live fixture's private session server (socket under /tmp/g6b-live): the runtime guard refuses an agent
  tearing it down; Joan removes it.
