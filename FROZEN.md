# FROZEN: Desktop UI rework, slice 6a (pages as tabs, Details for any agent, the rail, Home off the sidebar's DOM)

Frozen on 2026-11-20 by Joan's decision: Desktop may be replaced by a bb-based app. If it isn't, the work resumes
from this branch. Remove this file in the first commit that resumes it.

## Where it stands

- The spec: desktop-rework-lead's briefs/spec-slice6a-tabs-details-rail.md with common.md. A copy is in
  redesign-sidebar-roster-developer's home under review/.
- Base: main at e5b6c5ac (slice 2 merged). The code is at 918a66f6b. Everything is built: page tabs, the empty
  state, views/details.mjs (Details per workspace for any row), per-group page-tab memory, the rail, Home reading the
  roster model (#1987), Home › Agents pins first, and /api/forge-roster removed (#1973). Docs and the release note
  (docs/release-notes/next/desktop-tabs-details-rail.md) are written, and the pinned tests are in
  packages/desktop/test/slice6a.test.mjs.
- Review: four fresh whole-range rounds and one delta read, all on github-copilot/gpt-6.1-sol. Every finding from
  rounds 1 to 4 is fixed. The delta read of 95461bd74..918a66f6b found one more major, still open (below).
- CI (hand-started "Linux tests"): all 24 batches at 7dcbb8995, with later fixes run on their affected files
  (44648365897, 44650316332, 44653680691, 44705861681). No full run at 918a66f6b.

## Open finding and its fix plan

- [major, delta read] Restoring a Workspace tab that had a capability page open revokes the restoration's own
  ticket. reopenPageTabs takes `owns = tabOpenIntents.watch()` and preselects the capability. applyCapability
  (views/spawn.mjs) switches discovery to Capabilities. The discovery's onIntent mints a selection intent
  (spawn.mjs nextSelectionIntent), and ctx.onSelectionIntent in shell.mjs invalidates `owns`. Page tabs saved after
  it don't reopen, and the final strip-order and active-tab restore is skipped.
  Fix: make the capability's tab switch part of the handoff, as applyWorkspaceTab does with `s.handoffTab`, so it
  mints no competing intent. Add an integrated test with the real spawn.mount, the real ctx.onSelectionIntent and a
  page saved after Workspace; assert every page, the strip order, group focus and the active tab.

## What a resumer does first

1. Rebase onto current main. Expect slice 3a (#1977), #1979, slice 4 (#1986, Alt+H/I: bind "Home" and
   "Agent: Details" to them), slice 1b (same-work lines in renderContextRoster), Pepe's
   sidebar-collapsed-sibling-lines, and bb's C1. If C1 landed, carry its backend and thread fact into the Details
   "session" fact (views/details.mjs detailsFacts), not into context-panel.mjs, and keep its recall() filter in
   workspace-tab-memory.
2. Fix the open finding above.
3. The reviewer asked for a fresh whole-slice review round after that fix; the lead decides.
4. Run the full 24 Linux-tests batches at the head, retake live screenshots (on a port you've checked is free and
   yours), then hand back to the lead for VERIFIED and open one PR (lane:product, maintainer
   joan-product-maintainer). It lands after #1986.
5. For the PR, list the tests rewritten or removed for superseded behaviour, the stated limits (one tab per page
   view per workspace, Home one per pane; keys arrive with slice 4) and #1973 closed. All are in the hand-back mail
   to desktop-rework-lead, 8dcdffa6.
