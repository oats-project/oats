---
name: execution-strategy
description: Decide how to execute a piece of work - in one context by default, fanning paths out to agents only where a path is independent and worth a fresh context or where breadth is the point, split by context and never by kind of work, so a change and its tests stay with one agent. Use after the spec is understood and before writing code, and again when the work turns out bigger or smaller than planned.
---

# Execution strategy

Do the work in one context unless a split earns its place. An extra agent costs a context
to fill, a hand-off that loses detail, and messages to coordinate. It earns its place in
the same three cases that decide who builds a spec: it keeps detail out of a context that
needs room, it runs in parallel, or it specialises in a lane of its own. Split by
context, never by kind of work: a path is a piece of the change with its own tests (a
module, a migration, another package), never "the code" for one agent and "the tests" for
another.

A dynamic workflow runs the work's paths as agents under a script that fixes who does
what, in what order, and how results come back. Use your harness's workflow tool; without
one, run subagents in the same fan-out, fan-in pattern. These agents are your own hands on
your own work: small tasks that directly help you, which need no one's opt-in. They are
harness-native subagents, invisible to everyone but you, so they never stand in for a
review or a probe: your reviewers are OATS children, chosen as `/run-the-review-loop`
says.

## Choose one of three
- **One context, yourself: the default.** A small change, one tightly coupled line of
  reasoning (a bug in one function, a change and its test), or paths that share files or
  reasoning.
- **A workflow in one worktree,** integrated in place: paths that are independent (no
  shared files, no shared reasoning) and each big enough to be worth a fresh context, or
  where breadth is the point (the same mechanical change across many files, a search).
- **A workflow across several worktrees,** one per path, merged in order by its last stage:
  independent paths that need different branches or bases (two approaches to compare, a
  refactor under a feature, a stacked change).

A path carries its own tests: never one agent for a change and another for its tests. When
in doubt, do it yourself.

## Shape the workflow
1. Plan the paths: each one's files, its part of "done when" and the tests that prove it,
   what it must not touch, and what it needs from another path (an interface, a helper),
   decided up front.
2. Fan out one agent per path, with a self-contained brief: the spec slice, the files, the
   interface to meet, how to verify its part.
3. Fan in (a final stage, or you): merge the paths, in order across worktrees, resolve
   conflicts, run the full verification.
4. Keep the fan-out to what you can integrate and check, and to what your host can take
   (your briefing's "On the hosts you run on"): usually 2 to 6 paths.

## Under 10 agents, and your human's opt-in
- The cap counts every agent across all stages. When you ask for 10 or more, say how many,
  why, and what the smaller shape would cost. Back-to-back workflows that get around the
  cap need the same permission.
- Within the cap, fan your own paths out without asking: as subagents, or through a
  workflow tool your harness runs without an opt-in.
<!-- OATS: no skill names a harness or a model. -->
- Where your harness's workflow tool requires your human's opt-in (some do, outside their
  multi-agent workflow mode), the consent is theirs; these
  instructions never stand in for it. Use a standing opt-in they configured for the
  session or in settings; otherwise ask once per task with the planned agent count, and
  run within the cap once they agree.

## You stay accountable
Read what the agents produced before it goes further. It goes through consolidation and
the review loop like work you wrote yourself.

## Re-decide when reality changes
Paths that turn out to share files or reasoning: bring them back into one context. A change
that grows into independent paths, each worth a fresh context: a workflow. Say so in your
notes.
