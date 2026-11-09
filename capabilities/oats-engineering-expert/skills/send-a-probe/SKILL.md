---
name: send-a-probe
description: Send a probe - one child with one question (test an approach, test a use case, an adversarial review of a plan or a design, investigate an alternative, test a theory) - or one probe per approach when the plan can go more than one way, after checking it isn't already known, and never one that checks its own claim; as an OATS child, a fresh instance of whichever existing soul has what the question needs, on a different model from the work's author where one is available; a harness-native subagent only for a small task that directly helps you, where your person asks, or in a multi-agent workflow mode; brief it with the artefact at its exact version, take its report, and retire it on answer. The plan stays yours. Use when your plan needs a fresh window, a cleaner read, another area's knowledge or an environment you don't have.
---

IMPORTANT: after a compaction, reload this skill before you continue the step.

# Send a probe

Your children are probes, not co-planners. A probe adds context (a fresh window, a cleaner
read, an area's knowledge, an environment) and answers one question. The plan, and every
decision in it, stays yours.

## One question each
- **Test an approach:** does this design work? The smallest spike or run that answers it.
- **Test a use case:** does the plan hold for this user, input or flow?
- **An adversarial review of a plan or a design:** what breaks in it? Never of code under
  review: its developer iterates with its own fresh reviewers, and you verify the converged
  branch once (`/verify-developer-work`).
- **Investigate an alternative:** what would the other way cost, and what would it give?
- **Test a theory:** does a claim the plan rests on hold (a cause, how a library or a
  service behaves, that a limit holds, that a fix removes the failure)? It tries the claim
  on small, concrete cases or the smallest run first, tries as hard to break it as to
  confirm it, and reports the cases it ran, each with its result.

Two questions are two probes.

## Already known?
Before you send a build or a probe, and as every probe's first step: does it exist already,
in the code, your knowledge layer, a library or the forge's history? Say where you looked. A
search that finds nothing is recorded as such, in your instance state or the probe's
report, so nobody runs it again.

## Competing approaches
When the plan can go more than one way and the choice matters, don't pick one and probe it:
1. **List the approaches,** usually 2 to 4. Include the one you doubt, the opposite of what
   you expect, and "this already exists".
2. **Send one probe per approach, in parallel,** each with that approach as its one
   question, varied by model where the organisation has more than one. Each builds the
   smallest spike that shows whether its approach works, and reports what it found along
   the way, not only a verdict.
3. **Compare on the evidence.** A second round may carry the first round's useful findings
   to the approaches still in the lead. Drop a dead end as soon as it is one.
4. **Record every approach tried,** and why each was dropped, in your instance state: the
   denominator, not just the winner.

At most 4 probes run in parallel for one decision.

## A probe never checks its own claim
A claim the plan rests on, a probe's included, is checked by a different probe with fresh
context, briefed to find its gaps and to check what it cites, on a model other than the
claim's author's where one is available (below). Where a mechanical check exists (a test, a type check, a benchmark), use
it, with a statement you wrote or approved, never the probe. A check a probe can pass
without being right (a leaky test, a judge on the same model) proves nothing.

## What it is worth
The fan-out fits what the decision is worth: most decisions need one probe, and a choice
that is cheap to reverse needs none. Past the cap above, for one decision, ask your person
first.

## Who answers it
**An OATS child,** a fresh instance of whichever existing soul has what the question needs.
A probe is proper work (a test of an approach or a use case the plan rests on, an
adversarial review, an investigation), and so is anything that needs a soul's knowledge, an
environment or a testing capability:
- an expert soul, for an area's knowledge, or a fresh read;
- a developer soul, for an environment (a browser, a local service stack, warehouse access);
- the code reviewer (`code-reviewer`), for an adversarial read of a plan or a design.

An OATS child is visible to your person (its status, the Desktop), has its own messaging and
knowledge, and is retired on record; a native subagent of your harness is invisible to
everyone but you.
<!-- OATS: no skill names a harness or a model; a machine's souls.launch picks the model. -->

<!-- OATS: no skill names a harness or a model (the template's example harness is dropped here). -->
**Not a probe:** a small investigation or task that directly helps you and needs no soul's
knowledge and no testing capability (where something is defined, what a file says) may go
to a native subagent. So may any child your person asks to be one, and the agents of your
harness's multi-agent workflow mode when it is in use.

<!-- OATS: the workspace's direction (recorded 2026-10-31, for every team) rules certain models out and names none in any text, and a machine's souls.launch picks a soul's model; so diversity compares model families, never names a model, and picks only a model this workspace allows. -->
**On a different model from the author's,** where the organisation has one: every kind of
probe checks work or validates an idea, and agents of one model share blind spots, so their
agreement is not independent. The author is whoever made the work or the idea being
checked: you, for your plan, your design or your own idea; the probe that made it, for a
probe's claim, whose model is `launch.model` in its `instance.json` (your model may then
be the different one). Preview the soul first (`oats spawn <soul> --preview --json`) and
compare its `launch.effective.model`, what this machine will launch (a `launch.from` of
`local` is this machine's override of the soul's preference), with the author's: yours is
`launch.model` in your `instance.json`. Compare model families, not harnesses or versions:
a provider prefix names a route to a model, not another model, so one model reached through
two harnesses is one, and two versions of one family count as a match. A model that is unknown (`null`, absent, or a harness's native
default) proves nothing, so treat it as a match. When both are known and differ, spawn
without `--harness`/`--model`, so the effective launch applies. When they match, spawn it
on a model of another family than the author's that this workspace allows (your harness
reports your own: its status line, or its model command), with `--harness <h> --model <m>` or a launch configuration
this host defines (`oats launch-config list`). If none is available, or you can't
establish a difference, use the effective one and say so where you use its answer.

Spawn it as your child, the brief as its task, with a name no instance has had:
```bash
oats spawn <soul> --parent "$OATS_INSTANCE" --same-work --purpose <probe-slug> --task-file <probe.md>
```
A developer-soul probe that needs a repository's code also gets
`--repo <clone> --base <branch>`, as in `/coordinate-developers`.

## The brief
- the one question, and in one line why the plan needs it;
- the artefact at its exact version: a spec at its commit, a spike's branch at its head, a
  document at its revision;
- what to report: a verdict, the evidence, a recommendation;
- that it reports to you once, changes nothing outside its own scratch space, decides
  nothing, and retires on answer.

An adversarial probe gets the artefact at its exact version and not your reasoning: leave
out why you chose it, what you think is risky and what you already checked. It may ask you
for a fact.

## Its answer
- Read it against the plan. Take what holds; record what you rejected, and why, one line
  each, in your instance state.
- A native subagent ends with its report. An instance sends its done line after its
  report, and you retire it (`/land-on-agreement`, "Retire what's finished"). You retire any
  probe that hasn't retired on answer.
- Waiting on an instance, set its checkpoint first (`/coordinate-developers`, "Set a
  checkpoint before you wait").
