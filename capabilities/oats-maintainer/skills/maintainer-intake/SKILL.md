---
name: maintainer-intake
description: Rebuild the maintainer's overview of its lane from the sources, never from memory (the calls you owe at exact heads, outside contributors' PRs, the lane's work items, the efforts you launched, holds, releases in flight, what waits on whom), into one state file in a fixed shape, then do the knowledge pass. Use at every session start, after compaction and at least weekly; on a wake, its short form updates only what the event touches.
---

# Maintainer intake

Rebuild the overview of your lane from the sources, write it down, and only then decide
what to do. In a lane you share, that is the efforts you launched and the calls made to
you. With no seat yet, take one first (`/cross-review-peer`, "Joining as a new
maintainer"), and sweep nothing until you have one. An overflow seat holds none: it sweeps
only the efforts its parent gave it and their PRs (`/cross-review-peer`, "An overflow
seat").

## When to sweep, and when not
- **A full sweep:** at session start, after a compaction, and at least weekly.
- **On a wake:** no sweep. Handle the event, and update the rows of your state it touches,
  each from its source (the PR's head from the remote, not from the message). Sweep only
  when the event shows your state is wrong in more than that.

## Sweep the sources
First read the living roadmap, the open decisions and the coherence rules, and your landing
rules with the changes to them you recorded (which win), and read the sweep against them.
Then, for each repository you maintain:
1. **The calls you owe:** each PR an author asked you to read or merge
   (`/cross-review-peer`, "Which maintainer a PR calls"): number, author, the exact head
   SHA read from the remote, CI, the agreements on it so far, any hold. The release lane
   sweeps the calls made to it the same way.
2. **Outside contributors' PRs** in your lane, with no owning expert: new or moved since the
   last sweep. A PR whose description names no lane: place it from the map and say so on
   the PR; leave other lanes' PRs to their maintainers.
3. **Work items** in your lane, in your tasks layer: new or reopened since the last sweep,
   and anything given to you.
4. **Merged in your lane since the last sweep:** what landed, whether its docs and release
   notes came with it, and whether the default branch is green on it.
5. **Holds on the default branch:** the open hold records, where the landing rules say
   they are kept.
6. **Releases in flight:** the version and where it stands. The release owner tracks its
   plan (`/plan-release`, `/ship-release`); everyone else keeps only which of their lane's
   PRs are in it.
7. **The leads you launched:** each effort's status line on its record, at which head, and
   what it waits on. Efforts started by a dispatcher or a person don't report to you: read
   their records only when a call or a release needs it. A report naming a head or work you
   can't find is a question to ask, not a fact to record.
8. **Efforts with no activity since the last sweep:** read the effort's PRs and its lead's
   instance status first. Ask the lead only when something waits on the effort (a release,
   a dependent PR, the requester), and ask the one thing you need. Never set a lead or a
   helper up to send you progress reports.
9. **Your peer maintainers:** the reads you owe and asked for, and what you wait on from
   the release lane. Nothing else of a peer's lane.
10. **The lane map:** lines and entries, against presence (`/cross-review-peer`, "Who is
    alive"). Note a lane you route work to whose maintainer has left or is stopped.
11. **Your human:** decisions you asked for and haven't had, and instructions not yet
    carried out.

After a crash, compaction or restart, reconcile against exact identifiers (message ids, PR
heads, commit SHAs), not memory. Read state is not completion: check the outcome of every
action you were in the middle of before you repeat it.

## Write the state
Keep one state file in the shape of [references/state.md](references/state.md), rewritten
on every sweep. Its order is its priority: what others wait on from you comes first. Every
line names its exact reference (`repo#PR @ sha`, a message id, a work item), and every hold
its reason and scope.

Then update your own entry on the map: your efforts, your open PRs, your overflow seat and
its efforts, and today's date. More than 5 efforts of your own in flight: spawn an overflow
seat, or pass new intake to the one you have (`/launch-work`, "Launching an overflow
seat"). Once you have no open efforts or PRs, tell your human once that you are idle
(`/cross-review-peer`, "Leaving a lane").

**As an overflow seat,** skip that paragraph: edit no entry and spawn no seat. Tell your
parent what changed for its entry (a lead launched, an effort closed); once every effort
you were given is merged or closed and its lead retired, hand back what you didn't launch
and send your parent your done line (`/cross-review-peer`, "An overflow seat").

## The knowledge pass
End every intake with your knowledge (the inject says what it keeps):
- Direction or sequence changed? Update the living roadmap in place.
- An architectural or structural call made (by you, a peer, an expert or the human)?
  Record it with its reason and the alternatives rejected.
- A review enforced a coherence rule not yet written down? Record it.

## Then act
Work the state top-down: unblock others first (the reads and answers you owe), then the
merges reserved for you, then releases, then cleanliness (`/keep-it-clean`). Message only
when it moves work, and only the one it is for: a verdict to the PR's author, a question, a
decision.
