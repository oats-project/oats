---
name: landing-rules-detail
description: The exact definitions behind the landing rules - what CI green means, what opens a PR and what VERIFIED asserts, how a review or a verdict carries to a new head, a maintainer's green light where a lane asks for one (the call, the verdict, what it checks), the model floor for children, who builds a change and the review loop's cap, the one-line docs fix, what goes to a maintainer before a build, a PR with no lead, and where effort records and holds are kept. Use before judging that an agreement holds at a head, before a merge, when a head moved after a verdict, before choosing a child's model, when recording a hold or a finding, and whenever the landing rules in the briefing leave a case open.
---

# The landing rules, in detail

Your briefing's landing rules name the lanes, the agreements that merge a change, who
merges, and the one-way doors kept for people. This skill holds the definitions behind
them. Where the two differ, a change you recorded since your spawn wins, then the
briefing.

## CI green
At least one check ran at the head, every check the forge requires is among them, and
every check that ran succeeded: none failing, none pending. A skipped check didn't run. A
head where no check ran isn't green. Where no hosted check runs the tests, the author
runs the repository's own test gate at that head and says so in the PR. OATS's
repositories require no check on their default branches (no branch protection, no
rulesets), so this definition holds as written: it needs a check to have run, and every
one that ran to have succeeded.

A review thread is **answered** by a fix, or by a decline with a concrete reason.

## Opening a PR
- **A developer's work, or a helper's scoped piece,** opens on `VERIFIED at <head>` from
  whoever specified it (the effort's lead, or the specialist of its area). Its builder
  opens the PR at that head and works its reviews.
- **A change a lead or a specialist built itself** opens on the round of its review loop
  that found nothing to fix, with that round's Checked section.
<!-- OATS: the lane map: every PR carries its lane's label and names its maintainer, who runs it from there. -->
- **Either way** the PR carries its lane's `lane:` label and names its maintainer in its
  description, and whoever lands it hands it at that head to that maintainer
  (`/land-on-agreement`); from there the lane's arrangement on the map runs it.
- **`VERIFIED` asserts** what was checked against each acceptance criterion: the spec's
  pinned acceptance tests and the suite that bears on the change ran at that head, the
  cases that must fail included.

Why: whoever specified the work holds its design, and nobody verifies their own work.

## What carries to a new head
A review carries to a new head:
- **with no re-read,** through a rebase whose range-diff shows every commit unchanged, or
  an update from the default branch that leaves the PR's own diff unchanged;
- **through a read of the delta alone,** where the review is the author's loop and the
  delta only fixes a minor, takes a nit, or fixes CI with no change in behaviour: the
  review bot's review at the new head, on an open PR where one runs; otherwise a fresh reviewer
  briefed with the delta, the findings it answers and the spec. That reviewer's verdict
  on the delta, with the round's Checked section, holds at the new head;
- **otherwise not:** a fix to a blocker or a major, or any delta that changes behaviour,
  a contract or the design, gets a fresh reviewer on the whole change. Where the review
  is the bot's, any new head gets a new review, which the author asks the bot for where
  it doesn't review each push by itself.

A `VERIFIED` note and a green light carry with no re-read through the same unchanged
rebase or update, and in no other way: at any other new head, whoever gave it reads the
delta and gives it again at that head. A reviewer's verdict never stands in for either.

The reviewer's severity decides which, not the author's wish: a fix ranked minor that
turns out to change behaviour gets a fresh reviewer.

## A maintainer's green light
<!-- OATS: OATS is a large project, so every lane asks for its maintainer's green light (the landing rules). -->
Only in a lane whose landing rules ask for it: here every lane does. "Green light" means
only a lane maintainer's verdict on a PR, at an exact head.
- **The call:** by message at that head, from the lead or the specialist landing the PR,
  once CI is green and every review thread is answered there.
- **The verdict:** by message to whoever called. `GREEN LIGHT at <head>` with what it
  checked; `RETURN at <head>` with findings; or `ESCALATE`, when a direction question
  must go to whoever decides it first.
<!-- OATS: decided 17 Nov 2026 (oats#1943): the green light also reads the code and judges direction, roadmap and product fit. -->
- **What it checks:** the lane's direction, its roadmap and the product fit, contracts,
  coherence, the PR's scope against its task, and the evidence against the task's
  acceptance criteria. Here it also reads the whole diff once, from its own checkout: a
  defect it finds there blocks like a finding on the five. It repeats none of the
  author's review rounds.
- **Two lanes:** each maintainer's green light.
<!-- OATS: the lane map: the PR's maintainer, after its green light, brings in the second reader and the release lane's sign-off. -->
- **After it, here:** the maintainer that gave it asks the PR's second reader and, where
  the lane's line asks, the release lane's sign-off, at that head; the lead or the
  specialist doesn't. A RETURN from any of them goes to the change's author.
<!-- OATS: decided 17 Nov 2026 (oats#1943): the release lane's sign-off keeps the four gates, as the final gate on main. -->
- **The release lane's sign-off, here:** its verdict by the four gates of a PR with no
  lead (direction, roadmap and product fit; correctness over the whole diff; security;
  mergeability), at the exact head being merged: the final gate on main, not the green
  light's five checks.

Why, where an organisation asks for it: one seat holds a lane's direction across parallel
efforts.

## The model floor
The floor in your briefing binds every child, an OATS child or a native subagent, and it
is checked before model diversity.
<!-- OATS: the floor is absolute here (by tier, not the parent's own), so a parent's own model is the fallback only where it meets the floor, and every model picked is one this workspace allows. -->
- It binds the model a child would actually launch on, wherever that comes from: a soul's
  default or a machine's override that is below the floor is not used. Spawn that child
  on a model at or above the floor instead, your own where that meets the floor, and
  tell your person once that the configuration is below the floor, naming the soul and
  the machine.
- A model whose tier you can't establish is below the floor.
- A child that checks work runs on another family's model only where one at or above the
  floor is available; otherwise on your own model where that meets the floor, or on a
  model of your own family that does, and you say that diversity was lost. Where no model
  at or above the floor is available at all, spawn no child and tell your person. Every
  model you pick to meet the floor is one this workspace allows.

## The rest
[references/more-rules.md](references/more-rules.md) holds who builds a change and the
review every change gets (the loop's cap, the one-line docs fix, release prep), what goes
to a maintainer before a build, a PR with no lead, the records, and what happens after
these rules change.
