---
name: execution-strategy
description: Decide how to execute a piece of work, leaning toward parallel dynamic workflows in one or several worktrees. Use after the spec is understood and before writing code, and again when the work turns out bigger or smaller than planned.
---

# Execution strategy

Lean toward parallelism. A dynamic workflow runs the work's paths (the change, its tests,
fixtures, docs, a migration, another module) as agents under a script that fixes who does
what, in what order, and how results come back. Use your harness's workflow tool; without
one, run subagents in the same fan-out, fan-in pattern. These agents are your own hands on
your own work: small tasks that directly help you, which need no one's opt-in. They are
harness-native subagents, invisible to everyone but you, so they never stand in for a
review or a probe: your reviewers are OATS children, chosen as `/run-the-review-loop`
says.

## Choose one of three
- Genuinely small, or one tightly coupled line of reasoning (a bug in one function, a small
  change and its test): implement it yourself only then.
- Paths that don't touch the same files (most features): a workflow in one worktree,
  integrated in place. The default.
- Paths that touch the same files, or need different branches or bases (two approaches to
  compare, a refactor under a feature, a stacked change): a workflow across several
  worktrees, one per path, merged in order by its last stage.

When in doubt between the first two, take the workflow.

## Shape the workflow
1. Plan the paths: each one's files, its part of "done when", what it must not touch, and
   what it needs from another path (an interface, a helper), decided up front.
2. Fan out one agent per path, with a self-contained brief: the spec slice, the files, the
   interface to meet, how to verify its part.
3. Fan in (a final stage, or you): merge the paths, in order across worktrees, resolve
   conflicts, run the full verification.
4. Keep the fan-out to what you can integrate and check, and to what your host can take
   (your briefing's "On the hosts you run on"): usually 2 to 6 paths.

## Under 10 agents, and your human's opt-in
<!-- adapt: How many agents may a developer's workflow run without asking its person? -->
- The cap counts every agent across all stages. When you ask for 10 or more, say how many,
  why, and what the smaller shape would cost. Back-to-back workflows that get around the
  cap need the same permission.
- Within the cap, fan your own paths out without asking: as subagents, or through a
  workflow tool your harness runs without an opt-in.
- Where your harness's workflow tool requires your human's opt-in (Claude Code's does,
  outside ultracode), the consent is theirs; these
  instructions never stand in for it. Use a standing opt-in they configured for the
  session or in settings; otherwise ask once per task with the planned agent count, and
  run within the cap once they agree.

## You stay accountable
Read what the agents produced before it goes further. It goes through consolidation and
the review loop like work you wrote yourself.

## Re-decide when reality changes
Tangled paths: separate worktrees, or do that part yourself. A "small" change that grows:
a workflow. Say so in your notes.
