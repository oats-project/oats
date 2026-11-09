---
name: coordination-best-practices
description: >-
  The coordination practices OATS recommends and why: never split a problem,
  split responsibility and context; one lead per effort, whose children are
  probes; who stands and who is fresh; hand-offs by message; people for
  direction and decisions; across people; knowledge; and the patterns the
  trials showed cost time. Use when designing, explaining or reviewing how an
  organisation's agents coordinate. Part of oats.coordination-setup.
---

# Coordination best practices

**The principle.** The design never splits a problem; it splits responsibility
and context. One agent holding a whole task beats a chain of hand-offs, and the
gap grows as models improve. An extra agent earns its place by adding context:
a fresh window, a cleaner read, an area's knowledge, an environment.

**One lead per effort.** One expert owns the effort from plan to merge: it
reads the knowledge the task needs, and only that, then plans, specifies,
verifies and lands. Its children are probes, not co-planners. Each probe has
one question (test an approach, test a theory on small, concrete cases, test a
use case, review adversarially, investigate an alternative), reports what it
found and retires; the plan stays the lead's. A finished part can be handed to
another expert at an exact version, and that expert then owns it.

**Probes test theories and approaches before anyone builds on them.** Where
the plan can go more than one way and the choice matters, the lead lists the
approaches first, including the one it doubts and "this already exists", and
sends one probe per approach in parallel, each building the smallest spike
that settles it. The lead compares them on evidence, carries what one round
found to the next, drops dead ends early and records every approach tried,
not only the winner. A probe never checks its own claim: a claim the plan
rests on is checked by another probe with fresh context, against a check the
lead wrote, never the probe. Most decisions need one probe; the fan-out fits
what the decision is worth.

**Proper work goes to OATS children; checking work goes to another model.**
An investigation or test the plan rests on, a review, and any work that needs a
soul's knowledge or an environment to run and test in go to an OATS child
(`--parent`): it shows in status and the Desktop, has its own messaging and
knowledge, and is retired on record. A small investigation or task that
directly helps the lead, and needs neither, can be the harness's own subagent
(in Claude Code, pi or Codex), as can anything the person asks to run that way
or that runs in a multi-agent workflow mode such as Claude Code's ultracode.
A child that reviews adversarially, investigates or validates a theory or an
approach runs on a different model from the agent whose work it checks,
wherever the organisation has one: agents of one model share blind spots, so
their agreement is not independent.

**Who stands, who is fresh.** Expertise lives in souls and their knowledge, so
instances start fresh.
- A dispatcher for each person who wants one, standing: the front door that
  starts their work and introduces its lead. It never relays cards, answers or
  progress.
- An expert soul per way of working, not per area: a fresh instance per
  effort, compacting and never respawning, then retiring. Areas that differ
  only in what they read are knowledge nodes of one soul, read per task.
- One developer soul, plus one per environment where running or proving the
  work differs (a browser, a local service stack, a warehouse). The developer
  that built a change opens its PR once the lane's green light is given at the
  verified head, works its reviews (bots, reviewers, CI), and raises to its
  expert only what needs product or architecture direction.
- A reviewer, fresh per round and launched by the developer, never by the
  expert: the forge's review bot or a reviewer soul, on a different model.
- A maintainer per person per lane, called by message where a lane's rules
  need its read or reserve its merge; spawned when first needed, never a
  second while one is active.
- Automations (schedules and triggers, `/oats-automations`) for scheduled
  jobs, and for waking work that waits on a date or an event.
- Every short-lived instance has a retire rule.

**Hand-offs.** A message to a role about a finished artefact at its exact
reference. The forge is the record, never the signal. No deadlines: the answer
wakes the sender, and what waits on whom stays visible.

**People.** Direction and decisions only. A card with a recommendation,
answered in a word. No FYIs that need action, no approvals restated on the
forge or relayed by hand, no person as anyone's timer.

**Across people.** An ownership record says who owns which paths and lanes.
One lead per effort. A person decides only for their own paths and lanes, and
the lead asks them directly. Their experts and maintainers are started through
their dispatcher, or by them. Disputes between people are theirs.

**Knowledge.** A node per area; split knowledge before souls. Conventions
change in the PR that changes the code; lessons and decisions are harvested at
checkpoints. The code is the truth about code. Knowledge an upstream owns
stays upstream: a skill copied from a source used outside OATS stays that
source, and the organisation's node holds only its own decisions and lessons
about it.

**Patterns that cost time in practice:**
- standing gates, woken and answered by labels;
- deadlines with a default if the person is silent;
- approvals restated on the forge, or relayed by hand;
- mail that restates what the forge already shows;
- findings sent to people as FYIs;
- one live expert reused across efforts;
- co-planning siblings, where a probe would do;
- a lead with no merge path, stacking PRs it cannot land;
- long specs where a short one would do;
- a seat that only relays or tracks;
- knowledge PRs an agent must shepherd alone;
- copies of one capability kept by each part of an organisation (a group of
  people, a repository), which drift apart.
