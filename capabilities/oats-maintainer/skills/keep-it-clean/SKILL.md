---
name: keep-it-clean
description: Keep the project clean as it grows - an honest follow-up list, docs and release notes in step with every merge, drift and duplication across experts caught and consolidated, dead PRs, branches, instances, docs and work items closed or retired, and a cancelled effort that leaves nothing half-done - plus the knowledge pass that keeps the roadmap, architectural calls and coherence rules current. Use before every task boundary, when an intake shows things piling up, and when an effort is cancelled.
---

# Keep it clean

A duty at every task boundary, not a quarter-end project.

## An honest follow-up list
- Every follow-up has: what, why, where it's tracked (a work item, a PR), and an owner.
- Non-blocking review findings become follow-ups when you approve, not "later".
- An item is closed, done or dropped explicitly with a reason. Nothing rots silently on
  the list, and nothing is left off it because it's embarrassing.

## Docs and notes in step with every merge
- A behaviour change ships with its docs and its release-notes entry, in the same PR. Check
  it in the reads you are called for (`/pr-review`, mergeability), and in your sweep of what
  merged in your lane.
- What slipped through is fixed forward quickly, in a small PR, and the gap added to the
  coherence rules if it can happen again.

## Drift and duplication across experts
Look for:
- two solutions to one problem, two helpers doing one job, two names for one thing;
- docs that contradict each other or the code;
- a change in one area that quietly copies a pattern another area replaced.

Name it, pick one owner and one shape (`/direction-gate`), get the other consolidated, and
record the shape as a coherence rule.

## Retire what's dead
- Stale PRs: ask the author or its lead whether to finish, hand over or close; close with a
  note.
- Merged or abandoned branches, finished instances you spawned, obsolete docs and skills,
  work items nobody will do: close or retire them with a one-line reason. A finished lead is
  retired without asking anyone (`/launch-work`, "Retire what's finished").
- Never retire what someone else owns: tell its parent instead (with none, the instance
  itself).

## A cancelled effort
Leave nothing half-done:
- **Code merged but not yet released** that would ship inert (unused, or behind a switch
  nothing turns on): revert it rather than carry it into the next release.
- **Its decision in your knowledge:** mark it deferred or superseded, with the reason. If a
  human accepted it, that human confirms (`/direction-gate`).
- **Its design record** (the effort's record, the spec, the proposal): close it with the reason.
- **Its instances:** the lead retires what it launched first and sends its done line; then retire
  the lead (`/launch-work`, "Retire what's finished"), and anything that retire stopped and
  kept.

## The knowledge pass
At the same boundary, keep your knowledge current, as the inject says: the roadmap updated
in place, new architectural calls with their reasons and rejected alternatives, new
coherence rules.
