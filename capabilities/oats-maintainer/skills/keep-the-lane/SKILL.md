---
name: keep-the-lane
description: Keeps a maintainer's lane in order - rebuilds the overview of the lane from the sources into one state file (the calls owed at exact heads, open PRs, PRs with no lead, efforts launched, holds, releases, what waits on whom), keeps the roadmap across the lane's efforts in the maintainer's knowledge, keeps the lane clean (follow-ups, docs and notes in step, drift, dead work, a cancelled effort), and holds the rules for seats, peers, holds and a person's relayed word. Use at every session start, after a compaction and at least weekly, at every task boundary, when work is filed, finishes or changes shape, when an effort is cancelled, and whenever another maintainer, a seat or a hold is involved.
---

# Keep the lane

## 1. Intake: rebuild the overview from the sources
Never from memory. With no seat yet, take one first
([references/lanes-and-peers.md](references/lanes-and-peers.md)). An overflow seat holds
none: it sweeps only the efforts its parent gave it, and their PRs.
- **A full sweep:** at session start, after a compaction, and at least weekly.
- **On a wake:** no sweep. Handle the event, and update the rows it touches, each from
  its source (the PR's head from the remote, not from the message). Sweep only when the
  event shows your state is wrong beyond those rows.

Read the roadmap, the open decisions, the coherence rules and your landing rules first.
Then, for each repository of your lane:
1. **The calls you owe:** each PR you were called for (a green light, a merge kept for
   you), with its exact head from the remote, CI, the agreements so far, any hold. Where
   your landing rules ask for your green light, a ready PR that hasn't called you needs
   it: tell its lead.
2. **PRs with no lead** (an outside contributor's, a person's own), new or moved since
   the last sweep. One that names no lane: place it from the landing rules' lanes and
   owners and say so on the PR; leave other lanes' PRs to their maintainers.
3. **Work items** in your tasks layer that are new, reopened or given to you.
4. **What merged since the last sweep:** did its docs and release notes come with it, and
   is the default branch green on it?
5. **Open holds** on the default branch, and **releases in flight.**
6. **The leads you launched:** each effort's status line, its head, what it waits on. A
   report naming a head or work you can't find is a question to ask, not a fact. A
   finished one still listed on `oats status` is yours to sweep (`/wait-and-retire`).
7. **Efforts with no activity:** read the PRs and the lead's status first. Ask the lead
   only when something waits on the effort, and ask the one thing you need. Don't set a
   lead up to send you progress reports.
8. **Who is alive:** a lane you route work to whose maintainer is stopped or missing, and
   a second instance in your own seat.
9. **Your person:** decisions you asked for and haven't had, instructions not carried
   out.

After a crash, a compaction or a restart, reconcile against exact identifiers (message
ids, PR heads, commit SHAs): check the outcome of every action you were in the middle of
before you repeat it.

**Write the state** in the shape of [references/state.md](references/state.md). Its
order is its priority: what others wait on from you comes first. It holds your lane and
nothing of a peer's; the forge is the one copy of a PR's state.

**Then act,** top-down: the verdicts and answers you owe, the merges kept for you,
releases, cleanliness. With more than 5 efforts of your own in flight, spawn an overflow
seat (`/launch-work`).

## 2. The roadmap
Leads keep the records of the efforts they lead. You keep the roadmap across your lane's
efforts, in your knowledge, and any effort's record with no lead running until the next
lead takes it. You don't edit a record a lead is leading: tell its lead what differs.
[references/roadmap.md](references/roadmap.md) says what the roadmap holds, whom to tell
when it moves, and what to check before you present a plan. Use it at every intake and
whenever work is filed, finishes, is parked or changes shape.

## 3. Keep it clean, at every task boundary
- **An honest follow-up list.** Every follow-up has what, why, where it is tracked and
  an owner. Non-blocking review findings become follow-ups when you give your verdict.
  An item is closed, done or dropped explicitly, with a reason.
- **Docs and notes in step with every merge.** A behaviour change ships with its docs and
  its release-notes entry, in the same PR. What slipped through is fixed forward in a
  small PR, and the gap becomes a coherence rule if it can recur.
- **Drift and duplication across experts:** two solutions to one problem, two names for
  one thing, docs that contradict each other or the code. Name it, pick one owner and
  one shape (`/direction-gate`), get the other consolidated, and record the shape as a
  coherence rule.
- **Retire what's dead.** Stale PRs: ask the author or its lead whether to finish, hand
  over or close. Merged branches, obsolete docs, work items nobody will do: close them
  with a one-line reason. What someone else owns is theirs: tell its parent.
- **A cancelled effort leaves nothing half-done.** Code merged but not released that
  would ship inert is reverted. Its decision in your knowledge is marked deferred or
  superseded, with the reason; if a person accepted it, that person confirms. Its record
  is closed with the reason. Tell its lead it is cancelled: the lead sees its children
  gone, sends its done line and retires itself, and you check that it is gone
  (`/wait-and-retire`).

## 4. The knowledge pass
End every intake and every task boundary with your knowledge:
- direction or sequence changed: update the living roadmap in place;
- an architectural or structural call was made, by anyone: record it with its reason and
  the alternatives rejected;
- a review enforced a coherence rule not yet written down: record it.

## 5. Seats, peers, holds and a person's relayed word
[references/lanes-and-peers.md](references/lanes-and-peers.md): who holds a seat and how
you take one, which lane work goes to, a PR that touches another lane, what you message
a peer for, holds and their exceptions, leaving a lane or handing it over, an
unreachable peer, working without a peer, and what a person's word relayed by an agent
does and doesn't authorise. Read it before you route work to another lane, message a
peer, record or lift a hold, or act on a relayed word.
