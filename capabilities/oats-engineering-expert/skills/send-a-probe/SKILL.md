---
name: send-a-probe
description: Send a probe - one child with one question (test an approach, test a use case, an adversarial review of a plan or a design, investigate an alternative) - as an OATS child, a fresh instance of whichever existing soul has what the question needs, on a different model from yours where one is available; a harness-native subagent only for a small task that directly helps you, where your person asks, or in a multi-agent workflow mode; brief it with the artefact at its exact version, take its report, and retire it on answer. The plan stays yours. Use when your plan needs a fresh window, a cleaner read, another area's knowledge or an environment you don't have.
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

Two questions are two probes.

## Who answers it
**An OATS child,** a fresh instance of whichever existing soul has what the question needs.
A probe is proper work (a test of an approach or a use case the plan rests on, an
adversarial review, an investigation), and so is anything that needs a soul's knowledge, an
environment or a testing capability:
- an expert soul, for an area's knowledge, or a fresh read;
- a developer soul, for an environment (a browser, a local service stack, warehouse access);
- the code reviewer (`code-reviewer`), for an adversarial read of a plan or a design.

An OATS child is visible to your person (its status, the Desktop), has its own messaging and
knowledge, and is retired on record; a native subagent of your harness (Claude Code's, pi's
or Codex's) is invisible to everyone but you.

**Not a probe:** a small investigation or task that directly helps you and needs no soul's
knowledge and no testing capability (where something is defined, what a file says) may go
to a native subagent. So may any child your person asks to be one, and the agents of your
harness's multi-agent workflow mode (Claude Code's ultracode, say) when it is in use.

**On a different model from yours,** where the organisation has one: every kind of probe
checks work or validates an idea, and agents of one model share blind spots, so their
agreement is not independent. Preview the soul first (`oats spawn <soul> --preview
--json`) and compare its `launch.effective.model`, what this machine will launch (a
`launch.from` of `local` is this machine's override of the soul's preference), with yours,
`launch.model` in your `instance.json`. Compare the models, not the harnesses: a provider
prefix names a route to a model, not another model, so `github-copilot/gpt-6-astra` and
`gpt-6-astra` are one. A model that is unknown (`null`, absent, or a harness's native
default) proves nothing, so treat it as a match. When both are known and differ, spawn
without `--harness`/`--model`, so the effective launch applies. When they match, spawn it
on a model you know differs from the one you run (your harness reports yours: its status
line, or its model command), with `--harness <h> --model <m>` or a launch configuration
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
