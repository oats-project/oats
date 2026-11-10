---
name: across-people
description: Work that touches another person's paths, lanes or decisions - the ownership record, one lead per effort, mechanical changes that need nobody's approval, writing to that person directly in a thread of its own on the effort with one card, bringing in their area's expert or their lane's maintainer through their dispatcher, and disputes. Use whenever a plan, a change, a finding or a question touches what the ownership record gives another person.
---

IMPORTANT: after a compaction, reload this skill before you continue the step.

# Across people

Each person owns paths and lanes, written in the ownership record of your landing rules. Read it before you plan. Your person's yes covers your person's
choices only. You can't spawn, retire or direct another person's agents: you ask.

## One effort, one lead
The lead is the expert whose area the effort mostly lives in, or the generalist expert when
it spans people's areas evenly. A unit in another person's paths is built by that person's
area expert.

## A mechanical change in their paths
Regenerated code, a version string, a doc row: it needs nobody's approval. Say so in the PR.

## A behaviour change in their paths
Write to that person directly, in a new thread on the effort: say in plain words who you
are, what the effort is, its link, and that you lead it. Then send one card
(`/ask-a-person`) for the whole effort, before the work in their paths starts. Their answer
comes in that thread; record it. No card goes through a dispatcher, and no person relays
another's decision.

## Their experts and maintainers
Bring in their area's expert, or their lane's maintainer, by `/hand-off`. If none is on the
effort, ask their dispatcher to start the needed one, with your message as the request it reads
by its id (its task names the role, the area and you); where
they have no dispatcher, ask them. Never a second maintainer for a lane while one is active
(`/find-the-maintainer`).

## Merges
Each lane's landing rules apply. Where a lane needs its maintainer, it is the maintainer of
the person who owns that lane.

## Disputes
- **Text** (two PRs edit the same lines): the first merge wins, and the second rebases.
- **Meaning,** between agents: post your evidence once on the effort's record and send it to
  the generalist expert, which settles it. Where you are the generalist and a party, start a
  fresh instance of it independent of you, with the evidence and the options as its task
  (`/hand-off`): it settles the dispute and retires.
- **Between people:** the people decide. Put the evidence and the options to both, once, as
  one card. No agent decides between its person and another.

## Never
Never address another person's developers. Never change behaviour in another person's paths
without their decision on the effort.
