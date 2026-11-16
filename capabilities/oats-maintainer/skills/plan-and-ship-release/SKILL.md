---
name: plan-and-ship-release
description: Plans and ships a release in the release lane - which PRs are in and why the others are out, the version, the notes, the merge order, the release-prep PR, the owners' yes, a freeze and a patch release under it; then the exact source pinned, the project's live release contract read and run, the publication verified item by item, and a partial, failed or bad release handled without hiding it (re-run only the failed step from the same tag, never retag, fix forward). Use before any tag, when deciding whether a PR waits for the next release, after a tag, and when a release half-ran.
---

# Plan and ship a release

Only the release lane's maintainer plans and ships a release; every other lane agrees on
the plan what goes in from it. Your project's own release skills hold its exact steps
(version files, tags, where it deploys) and win on those facts.

## 1. Plan it in writing, before anyone tags
- **The branch it ships from:** the default branch, or the supported line for a
  backport. Use that branch in every step below.
- **What is merged since the last release:** `git log <last tag on that
  line>..<release-branch>`, grouped by change, each with its PR.
- **What should still go in:** open PRs that are ready or nearly so. For each one left
  out, write why.
- **The version,** by the project's policy. Without one: patch for fixes only, minor for
  backward-compatible additions, major for anything that breaks an existing user. A
  contract change that breaks someone is never a patch.
- **What users must do:** migrations, changed settings, a component to upgrade alongside.
- **The notes.** Each change carries its entry in its own PR. Where several PRs append to
  one notes file, choose one way and say it in the plan: a fixed merge order with
  rebases, an entry file per change, or notes written in the release-prep PR.
- **The order.** Consumers that accept a new shape land before the producers that emit
  it. A PR that others rebase onto goes first. Once the plan is set, new PRs wait for the
  next release unless you say otherwise on the plan.

Write the plan where every lane can read it (the release-prep PR, or a record in your
tasks layer), before its first merge: the version, the PRs in and out with reasons, the
order, the agreements the release-prep PR lands on, the gates still to run, what users
must do. Your state file names where it is.

**The release-prep PR** is the version bump and the assembled notes, nothing more: open
it, keep it green, and land it as your landing rules say for a PR with no lead. A fix
the release needs is not release prep: it goes to a lead (`/launch-work`).

**The owners' yes.** Each person whose lane has changes in the release approves its
contents: one card each, with what goes in from their lane, the head to tag and your
recommendation. Tag only on every such yes, from that person directly or relayed by
their own agent as a decision made with them. Every lane agrees what goes in on the
plan; only the release lane tags.

**A freeze** before the tag is a hold on the default branch, not a message. When the
person picks a patch release with named changes while a freeze is on, the freeze stays:
each named change, and the patch's release-prep PR, gets an exception on the hold, a
comment naming the PR and its head and quoting the person. Nothing else merges until
the hold is lifted.

**A hotfix** is a patch release for a break in the current version: only the fix and its
notes, planned like any release but small. It doesn't wait for the planned release. **A
backport** goes on the supported line's branch, from the fix already merged on the
default branch, with its own patch version and notes. Which lines are supported is your
project's decision: record it in your knowledge.

## 2. Ship it
Start read-only. Confirm the version and its plan, the exact source SHA (on the planned
release branch: the default branch, or the supported line for a backport; reviewed, CI
green), where it will be published, and your authority: the yes of
every owner, with that scope. This skill grants no push, merge, credential or
protected-ref authority.
1. **Read the live release contract:** the workflow, its scripts and the project's
   release docs. The executable is the authority; where the docs disagree, record it. A
   broken release step is fixed in the project by a lead, not worked around by hand.
2. **Prepare:** pin the SHA, the notes and the scope. Work from a clean, isolated
   checkout of that SHA, and never reset a shared, dirty tree to make a gate pass. Run the gates the contract requires, and record what ran and
   what didn't.
3. **Tag the exact SHA** and let the release run as the contract says. Watch it to its
   end: a pushed tag is not "released".
4. **Verify** with [references/verify-release.md](references/verify-release.md), item by
   item, and report what you observed with identifiers: versions, commits, digests, URLs.
   "No errors" is not verification.
5. **Close:** record the outcome in your state file. Tell, once, those who must act on
   it: whoever deploys it, the experts whose work waited on it, and your person, with the
   version and what users must do. Publishing is not deploying.

## 3. When it goes wrong
- **A partial or failed publication:** observe what was actually published before you
  choose how to recover. Once the cause is fixed outside the tag (a credential, a
  runner), re-run only the failed step, from the same tag. NEVER retag, delete or move a
  published tag, or overwrite an immutable version: a fault in the tagged source ships
  fixed as the next version. A same-name re-upload must match the reviewed artifacts
  byte for byte. A failed later step doesn't undo earlier publication, and a retry that
  skips an already-published version doesn't prove it came from this source: check it.
  When identity or content is uncertain, stop and report.
- **A credential fault** goes to the person who owns the credential; runner and
  protected-ref faults to your person or the operator. Installing from the artifacts CI
  built meanwhile is the person's call: say what differs if they choose it.
- **A bad release** is fixed forward, never rewritten. Stop the spread first: move the
  channel tag back to the last good version, or deprecate the bad one, with a message
  saying what to use instead. Ship a fixed version as a hotfix. Tell the users and your
  person what broke, who is affected and what to do.
