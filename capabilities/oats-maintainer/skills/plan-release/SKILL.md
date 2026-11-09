---
name: plan-release
description: Plan a release before anything is tagged - which PRs are in and why the others are out, patch, minor or major, release notes for each change, the merge order (including PRs that all append to the same notes file), the release-prep PR and its review, what users must do, hotfixes and backports, and a freeze that carries to a patch release. The release lane's maintainer owns each release and posts its plan on the forge, where every lane agrees what goes in. Use before any tag, and when deciding whether a PR waits for the next release.
---

# Plan a release

Plan it in writing before anyone tags, so the merge order, the notes and the version agree.

## Scope
1. **What's merged since the last release:** `git log <last-tag>..<default-branch>`,
   grouped by change, each with its PR.
2. **What should still go in:** open PRs that are ready or nearly ready. For each one left
   out, write down why ("waits for the contract decision", "not reviewed").
3. **The version:** your project's versioning policy decides. Without one: patch for fixes
   only, minor for new features and backward-compatible additions, major for anything that
   breaks an existing user. A contract change that breaks someone is never a patch.
4. **What users must do:** migrations, changed settings, a component to upgrade alongside,
   errors they may hit and what each tells them to do.

## Notes
- Each change carries its own release-notes entry, written in the same PR as the change.
- Several PRs appending to the same notes file conflict. Before merging them, choose one
  way, say it in the plan, and keep to it:
  - merge in a fixed order and have each author rebase on the previous merge;
  - give each change its own entry file or section that a release step assembles; or
  - leave the notes to the release-prep PR, written by you from the merged PRs.

## Hotfixes and backports
- **A hotfix** is a patch release for a break in the current version: only the fix and its
  notes, planned like any release but small, and read as its landing rules say. It doesn't
  wait for the planned release, and the rule that new PRs wait doesn't hold it back.
- **A backport** to an older supported line goes on that line's branch, from the fix
  already merged on the default branch, with its own patch version and notes. Which lines
  are supported is your project's decision; record it in your knowledge.

## Order
- Consumers that accept a new shape land before the producers that emit it.
- A PR that others rebase onto goes first; say who rebases after each merge.
- Once the plan is set, new PRs wait for the next release unless the release owner says
  otherwise, on the plan.

## Project-specific steps
Version bumps across companion components, compatibility ranges, pinned dependencies,
generated files: list them once in your project's own release skill or docs, and follow
that list.

## The release-prep PR
The version bump and the assembled notes, nothing more, are your own small PR: open it,
keep it green and up to date, and merge it at an exact head once the agreements your
landing rules name for a PR with no lead hold. A fix the release needs is
not release prep: it goes to a lead and its developer (`/launch-work`).

## Write the plan down
The release lane's maintainer owns each release (`/cross-review-peer`, "The release lane").
Every lane, whatever its arrangement, agrees with it what goes in and when, on this plan;
only the release lane tags. It writes the plan where every lane can read it (the
release-prep PR, or a record on the forge or in your tasks layer), before the plan's first
merge: the version; PRs in, and those out with
their reasons; the merge order; the agreements the release-prep PR lands on (your landing
rules, a PR with no lead); the gates still to run; what users must do. Your state file names
where it is and doesn't repeat it.

A release's contents are approved by the owners your landing rules name for it: each person
whose lane has changes in it. Send each of them one card: what goes in from their lane, the
head to tag, and your recommendation. Tag only on every such yes, each from that person
directly or relayed as `/cross-review-peer` accepts ("Decisions passed on from a human"). A
peer whose lane has PRs in the plan, or left out of it, is told once where the plan is, and
answers there. A freeze before the tag is a hold on the default branch
(`/cross-review-peer`), not a message.

## A freeze carries to a patch release
When the human picks a patch release (x.y.1) with named changes while a freeze is on, the
freeze stays. Each named change, and the patch's release-prep PR, gets an exception on the
hold: a comment naming the PR and its head and quoting the human who picked the patch
release, confirmed as `/cross-review-peer` ("Decisions passed on from a human", "Holds")
says. Nothing else merges until the hold is lifted.

When the plan is done, ship it with `/ship-release`.
