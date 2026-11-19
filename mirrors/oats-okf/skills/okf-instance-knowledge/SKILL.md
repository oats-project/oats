---
name: okf-instance-knowledge
description: >-
  Keeping this instance's own knowledge (STATE.md, log.md, notes/) with
  judgment: the capture test, what is worth writing down and what is not,
  one concept per note with type, claim, why, evidence and generality, when to
  write (at the decision, before compaction, before a task boundary, at a
  checkpoint), and how a note cites the soul knowledge it confirms or
  contradicts. Use at the start of every task, when a
  decision is taken or rejected, when something costs effort to find out,
  when a human corrects you, before compaction, at a checkpoint, and before
  finishing a task.
---

# Instance knowledge

Your instance knowledge is your working memory: what you are doing, what
happened, and what you learned. It lives in instance home (not ./work):
- **STATE.md**: the current task picture, **rewritten** as it changes. What
  the task is, where it stands, what is decided, what is blocked. `# Next`
  names ONE next step.
- **log.md**: dated significant events, **append-only**. Never rewrite
  history.
- **notes/**: **one concept per insight**, one Markdown file each.

Your future self reads it after compaction, and, when your soul proposes
knowledge, a judge may read the notes a proposal names. Write for both.

## The capture test

> Would my future self after compaction, or a judge of what my soul should
> know, decide or act better for having it — and is it absent from the code,
> the tracker and the repository docs?

Both halves must hold. The capture bar is lower than the promotion bar: you
capture what might matter; promotion is a later, stricter judgment. Do not
self-censor a real decision because it might not be promoted.

## Capture

- **Decisions taken, and why.** The why is the part that dies with you.
- **Alternatives rejected, and why.** Code shows the outcome, never the road
  not taken; without this, a later instance "helpfully" takes it.
- **Discoveries that cost effort**: facts about the world that were written
  nowhere.
- **Limitations, and the workaround that worked.**
- **Conclusions of an investigation**, not its transcript.
- **Blockers**, with what they block and what unblocks them.
- **Human direction and corrections**, as you understood them, with when.
- **Surprises**: the world behaved differently from what your soul knowledge
  says. That is a *candidate supersession*: flag it as one and cite the
  concept it contradicts.
- **Process and environment lessons** the repository cannot express.

## Don't capture

- Descriptions of the code, or maps of the repository: code is the truth
  about code, and a stored description drifts and lies.
- Command logs and tool output; retries that taught nothing.
- Secrets and credentials, however they appear.
- Third-party messages verbatim (a lesson *about* one is fine).
- Personal data. Never include personal data about people outside the team
  (clients, correspondents, any other third party): a name, a contact
  detail, or anything else that identifies a person, including detail
  derived from correspondence. Keep the lesson and leave the person out.
  Naming the author of a published source you cite is fine. That covers the
  names you choose as well: a note's file name, a task ref and an instance's
  name are published as provenance when knowledge is proposed.
- What the tracker or the docs already hold: link to it instead.

## The form of a note

```markdown
---
type: Decision            # Decision | Rejected | Discovery | Limitation | Conclusion | Lesson | Blocker
title: Retry budget is per request, not per connection
description: One-line claim, the sentence an index would show.
generality: soul          # instance (true only for this task) | soul (likely true for the soul) — a hint, not a verdict
observed: 2026-09-26, load test on the staging cluster (turns around the 14:10 run)
---

The claim, then **why**: the reasoning, the alternatives, the evidence.
Relates to: oats/expert/decisions/retries.md@5b6a9cab (refines it).
```

- A one-line claim in `description`; the *why* in the body.
- Evidence and provenance: what was observed, when, from what.
- **Generality** says whether you think it outlives the task.
- A note that confirms, refines or contradicts soul knowledge **cites it**
  (`alias/node/concept.md@<short-oid>`, from `oats okf`'s receipt). That is
  what lets a later judge situate it.

## When

- **At the decision, as it happens.** A decision reconstructed at the end has
  lost its why.
- **Before compaction** and **before a task boundary**: update STATE.md and
  log.md, and write the notes you have been meaning to write.
- **At a knowledge checkpoint** (a PR handed over, a task finished, and in a
  long-lived role a feature ready, a release or deploy shipped, or a
  direction decision taken with your human): first update STATE.md, log.md
  and the relevant notes, then follow `okf-propose`. A decision you make
  while working is captured, not proposed: the next checkpoint carries it.
- **Consult first**: before writing a note, check notes/ and `oats okf search`
  so you refine or cite rather than duplicate.

## Proposing knowledge

Soul knowledge changes only through a reviewed PR that the knowledge
maintainer merges. The duty to propose comes from the `oats.okf` capability,
not a task briefing: follow the `okf-propose` skill (`oats okf propose`), one
proposal per knowledge checkpoint, only for durable, non-duplicate claims in
nodes your soul owns, and a line in log.md for every checkpoint, including
one with nothing to propose. A soul with `knowledge: { harvest: off }` (or
`publish: off`) has no duty to propose: keep consulting and capturing for
your own work, but do not propose.

## The theory, briefly

- **Decision versus description.** A decision is superseded explicitly, and
  the new one names the old; a description goes stale silently. Capture
  decisions, not descriptions.
- **Code is truth about code.** Anything a fresh instance could learn from
  the repository in ten minutes is not worth your note.
- **Indexical residue dies with the instance.** "Was working on X", "the PR
  from this morning" mean nothing to anyone else. Write the durable claim
  underneath it, or nothing.
