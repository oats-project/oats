---
name: orchestrate-agents
description: Decides whether a piece of an effort goes to another agent, and runs that agent well - when a child is worth its cost and when to do the work yourself, which kind (a short-lived probe, helper or developer, or a long-lived specialist that leads one area), whether the new instance is a child, a sibling lead or an independent lead, the brief, what comes back, and its retirement. Use before starting or briefing any instance, when a step of the plan lies in another area, and when a theory or an approach the plan rests on needs testing.
---

# Orchestrate agents

Your children do parts of your effort. The effort, the plan and every decision in it stay
yours, whichever areas they cross.

## 1. Is a child worth it?
One agent is the default: several cost 3 to 10 times the tokens of one. Start a child
only when one of your briefing's three reasons holds (protecting context, parallel work,
specialisation), and name it in the brief. Otherwise do the work yourself. The reviewers
of a change you build are the exception: the review loop requires them, with its own
brief (`/run-the-review-loop`), and so are your own workflow's agents.

Good boundaries are independent questions, areas with a written interface, and black-box
checks. Bad ones are phases of one piece of work (a planner, an implementer and a tester
for one change), tightly coupled parts, and anything that needs shared state or constant
back-and-forth.

First check that it isn't known already: in the code, your knowledge, a library or the
forge's history. Record a search that found nothing, so nobody runs it again.

## 2. Which kind
- **Short-lived:** a probe with one closed question, a helper with one scoped piece, or a
  developer with one spec (`/coordinate-developers`). It reports once, distilled, and is
  retired. Send one whenever a reason holds, at any size of effort and any level of the
  tree.
- **A long-lived specialist:** it leads one area of a large effort, for the whole effort.

A step of your plan in another area is still your effort. Where a read answers it, read
that area's knowledge yourself: every area is readable. Where it needs that area's
judgment, skills or a clean context, it goes to the area's specialist, or to a helper: a
fresh instance of that area's expert or developer soul.

## 3. Child, sibling or independent
An effort is one goal that can land on its own. Work its "done means" needs stays in it;
work it can finish without is another effort. In doubt, it is yours.

| Its work | Relation | Spawn with |
|---|---|---|
| A part of your effort: a specialist, a helper, a probe, a developer | your **child** | `--parent <your instance> --same-work` |
| A new effort that arises from yours: a follow-on, a discovery that bears on your work, a piece your person wants tracked apart | your **sibling**, a lead of its own | `--relation sibling --relative-to <your instance>` |
| A new effort with no bearing on yours | **independent**, a lead of its own | `--relation unrelated` |

- A child asks you and hands back to you, and you make sure it is retired. Retiring
  you stops it first, so a lead of another effort is never your child.
- A sibling or independent lead gets your message as its task (`/hand-off-and-ask`),
  opening with its seat (root lead of the new effort), and its own effort record, linked
  both ways with yours. Tell your person at once its exact name, what it leads and where
  its record is, and put it on your effort's record. In doubt between the two: would your
  person look for it next to this effort? Then sibling.
- Only a root lead started by a dispatcher or a person spawns a sibling. Where a
  maintainer launched you, ask it to launch the new lead. As a specialist, hand a new
  effort to your parent.

```bash
oats spawn <soul> --parent "$OATS_INSTANCE" --same-work --name <task>-<role> --task-file <brief.md>
```
`--same-work` records that the child does your work; it shares no work tree. A child of
a worktree soul that needs another repository's code also gets `--repo <clone> --base
origin/<its default branch>`: preview it and check its start point against the remote
before you apply, as `/coordinate-developers` says for a developer. Where
`$OATS_INSTANCE` is empty (a resumed session), write your instance name.

## 4. A specialist
Start one per area when the effort is large or crosses several areas: a fresh instance of
the expert soul that knows the area.
<!-- adapt: Which expert souls can lead an area as a specialist, and what does each bring (knowledge, tools, an environment)? -->
The generalist `engineering-expert` takes any area, one fresh instance per area.

An area has its own repositories, toolchain or knowledge, and an interface to the rest
that can be written down. Parts that share code or need constant back-and-forth are one
area.
- **It owns its area from spec to verified branch,** up to the last agreement on its PRs,
  with its own developers, probes and helpers. It sizes its own tree as you do, with specialists
  of its own only for distinct, narrower sub-areas, and you keep what your briefing gives
  the root lead.
- **Read its area's knowledge yourself,** enough to plan and to write the interfaces. The
  specialist carries the depth.
- **Interfaces:** write each one before either side builds on it. From then on the two
  specialists agree a change directly and record it on the effort's record. What they
  can't settle is yours.
- **It reports** at its area's milestones only: its specs ready, a PR whose agreements
  hold at its head, the area landed.

## 5. Probes and helpers
A probe tests one thing the plan rests on, by experiment in a fresh context. A plan that
rests on an untested theory, or on one approach chosen by argument, isn't ready.
[references/probes.md](references/probes.md) has the method: closed questions, exploration
with bounds, competing approaches in parallel, why a probe never checks its own claim, and
choosing its model.

A helper with a scoped piece builds like a developer: it runs its own review loop, hands
back at its clean head, and opens no PR until you have verified it
(`/coordinate-developers`).

An OATS child is visible to your person and retired on record. Use a native subagent of
your harness only for a small lookup that needs no soul's knowledge or environment, where
your person asks for one, or inside your harness's multi-agent workflow mode. Either
kind runs at or above the model floor your landing rules set.

## 6. Brief it, and take back its result
Write the brief from [references/briefs.md](references/briefs.md). For an expert
instance, ALWAYS name its seat on a `Seat:` line (specialist, or helper or probe): it
acts by the seat its task names.
Then:
- Set a checkpoint before you wait on it (`/wait-and-retire`), and don't ask it for
  progress: it reports its result, a question or a blocker.
- Read what comes back against the plan. Check a claim the plan will rest on against what
  the child points to (the file, the run, the source), not its summary. Record what you
  rejected, and why, one line each.
- A finished child retires itself. Check that it is gone, and retire one that is
  finished or stalled and still listed (`/wait-and-retire`, "The parent's sweep").
