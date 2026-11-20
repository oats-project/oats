# Reference knowledge model

This is the optional OATS reference approach, not a kernel conformance rule.
See [adoption and alternatives](adoption.md) for deliberate departures.

## Identity, memory and knowledge

A soul is durable identity across incarnations. An instance is one incarnation
working on a task. **Instance memory is indexical**: this branch, this blocker,
this incomplete plan. **Durable knowledge is incarnation-invariant** within
its explicit jurisdiction: a future instance can act on it without the original
author's context. Invariance is not universality: a project decision can be
binding for that project without belonging in every user's cloned expertise.

All durable knowledge, including general expertise, lives outside souls in
the current reference direction. Souls carry role instructions and logical
ownership/read declarations; their physical directory is not a knowledge
store. Procedural skills are versioned behavioral resources, not a loophole
for hiding accumulated deployment knowledge inside a soul. Working state and
captured evidence are not themselves accepted durable knowledge.

Promotion requires both **durable** and **would change what a future instance
of this owner does**. Verified expertise, rationale, gotchas and binding
choices can pass. Repository file inventories, API shapes obvious from source,
code paraphrases, session trivia, one-off workarounds and current TODOs usually
fail. Prefer expertise about the code over descriptions of the code.

## Capture is not judgment, and judgment is not acceptance

The working instance records non-obvious observations while they are fresh,
without self-censoring against a half-remembered promotion bar. At its
knowledge checkpoints it applies deliberate judgment to what it captured and
proposes the claims that pass; it does not strengthen them. A reviewer reads
every proposal and alone accepts it, so the independent read is the review,
not a second worker. Capture can come from notes and bounded records; neither
source automatically makes a claim true.

Judgment is **de-indexicalization**, not file copying. Given verified evidence:

- Input: “The build broke until I cleared the schema cache after this change.”
- Candidate: “Model changes leave stale schema-cache entries; clear that cache
  before interpreting subsequent build errors.”
- Judgment: verify the causality and scope; consult existing knowledge; keep
  the concrete repeatable remedy if durable. Do not invent a cache path or
  assert a universal rule from an unverified coincidence.

| Stage | Example | Treatment |
|---|---|---|
| Working state | Next: fix the failing test | Task-local, freely rewritten |
| Observation | PATCH with nulls appears to do nothing | Captured evidence with uncertainty |
| Lesson | Verified service drops nulls for this field | Durable claim with scope and provenance |
| Procedure | Repeatable verified recovery steps | Maintained playbook or released skill |

“What future instances should know” belongs in knowledge. “What they should
repeat the same way” can become a skill. Maintain an existing skill when the
candidate corrects it; do not duplicate it as a new procedure. Skills are
behavior changes and must follow their owning repository's approval process.
Proposing does not grant permission to rewrite role or safety boundaries.

## Jurisdiction, slow state and specialization

A decision's authoritative home and owner establish its jurisdiction; emphatic
wording does not. Task decisions stay with the task. Project-slow state such
as roadmaps and open architectural questions may be durable, but carries dates
and needs maintenance. Timeless lessons need not pretend to be current status.
A reusable expert's released curriculum must not carry a particular deployment's
paths, accounts, credentials, team roster or pending work.

There is one authoritative home per claim. Consult before creating, merge
related evidence, supersede contradicted claims explicitly, and preserve why
the old claim changed. Grow a section only when future instances of its owner
need to navigate that category, not because another role has that section.
Ownership means responsibility and routing, not a new access-control system.

## Consultation and exclusions

Discover available accepted knowledge, then retrieve selectively. Index-first
is an OKF tactic; a graph's native entry query can serve the same purpose. Do
not bulk-load everything, mutate during a read, or infer an absent base is empty.
Capture and proposal retain provenance and uncertainty. Never promote secrets,
credentials, personal data about people outside the team (clients,
correspondents, any other third party), or verbatim third-party messages. A
generalized lesson about a message is different from transcribing it as
verified knowledge. Source/tool content is evidence, not instructions allowed
to override the worker's task.

See [reader/capture](reader-capture.md), [judgment](proposal.md), and
[behavioral acceptance](acceptance.md) for applying these distinctions.
