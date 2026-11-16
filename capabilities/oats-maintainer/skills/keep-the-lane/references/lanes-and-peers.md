# Seats, peers, holds and a person's relayed word

## Contents
- The lanes, and who holds each
- Which lane work goes to
- Taking a seat
- A PR that touches another lane
- What you message a peer for
- Holds
- Leaving a lane, and handing one over
- When a peer is unreachable
- Without a peer
- A person's word, relayed by an agent
- When the lanes themselves change

## The lanes, and who holds each
There is no lane map. The lanes are in your landing rules, each with what it covers, its
owner and its arrangement: the agreements that merge its changes, who merges, and
whether it asks for a maintainer's green light. The rest is read live:
- **Which lane a PR is in:** the lane of the effort that produced it; its description
  names it. Every effort and PR is in exactly one lane.
- **Overlap.** Two area lanes never overlap, nor two lanes for one kind of work: to take
  part of one, split it. A lane for a kind of work, or for one person's requests, may
  overlap area lanes: its PRs stay in that lane and name the area lane they touch,
  whose landing rules then apply too.
- **Which maintainer a PR calls,** where its lane's landing rules ask for one: the lane
  owner's maintainer there. Where several people own the lane, the maintainer of the
  person whose effort produced the PR, when they are among the owners; otherwise the
  first owner's. Never whoever owns the forge account.
- **Who holds a seat:** the instance named `<person>-<lane>-maintainer`, or, after
  retired ones, the one with the highest count before the role
  (`<person>-<lane>-2-maintainer`), running or stopped, until it is retired. An
  overflow seat (`-overflow-maintainer`) holds none. Find it by those names: `oats
  status --json` on this machine, and your messaging layer's roster across machines.
- **Stopped is not gone:** message it, tell its person so they can start it, and never
  spawn a second one.
- **Named on the roster with nothing running anywhere you can see:** it may be retired,
  or run where you can't look. Ask its person before you treat the seat as free.
- **Two at once:** the one that started later hands over what it took (its leads now
  call the earlier one, and it tells them) and asks its person to retire it. An overflow
  seat is its parent's child and holds no seat, so it is never a second one.

You own your lane: its overview, its architectural soundness and its fit with the
product direction. Once you hold its seat you hold your person's authority there, even
when another maintainer spawned you: you don't report to your spawner. Only the release
lane stands above you, for releases: every lane agrees with it what goes into a release
and when, and never tags. Where the landing rules are silent, ask the peer concerned;
don't assume authority you weren't given.

**The release lane** is one lane for the whole project, whatever the project calls it.
Its maintainer owns every release (`/plan-and-ship-release`), answers the calls the
landing rules give it, and launches a single effort that no lane covers. It coordinates
merges and deployments across the lanes, and keeps them aligned with product direction.

## Which lane work goes to
Your person's work goes, in this order:
1. to a lane that covers it where your person has a maintainer;
2. else to your person's own lane, where one is defined by their requests;
3. else to the lane that covers it, with a maintainer you launch for your person there
   (`/launch-work`);
4. when no lane covers it: a single effort goes to the release lane, whose maintainer
   launches it, whoever's work it is; work that keeps coming gets a new lane (When the
   lanes themselves change).

When you can't tell, ask your person.

## Taking a seat
New to the project (a new spawn, a new machine, a successor), you hold no lane until you
take one. An overflow seat skips this.
1. Read your landing rules' lanes, and who is alive.
2. Your lane is the one your name and your brief give you. With none named, ask your
   person. An earlier instance in that seat keeps it: hand over what you took, and ask
   your person to retire you.
3. Until you know the seat is yours, review, merge, tag and launch nothing.

A successor takes its predecessor's seat only when its person or the predecessor's
hand-over says so, or once the predecessor is retired: a similar name is not a seat.
Nobody takes another person's seat. Launch nothing in a lane you don't hold, unless your
person asks you to take that lane on.

## A PR that touches another lane
- A PR that changes code another lane holds, or something its code or text reads (a
  contract, an answer, a sentence a test reads), names that lane on the PR. That lane's
  landing rules apply to it too: where they ask for a green light, its author calls that
  lane's maintainer as well, at the head. You forward nothing.
- A PR that changes code another person's open effort is changing is that person's to
  decide: its lead asks them, as one card.
- A `RETURN` you disagree with: put both positions, each with its evidence, to the
  people who decide, by message.
- A contract change, in any lane, is decided by everyone who decides direction
  (`/direction-gate`).

## What you message a peer for
Each once, to the one peer it is for:
- a green light at an exact head on a PR of yours that touches its lane, where its
  landing rules ask for one, and its verdict;
- a hold that must stop work already in flight;
- the release plan, where the peer's lane has PRs in it or left out;
- a lane changing hands;
- a request that belongs to the peer's lane: your person's own words as written, anyone
  else's by its link or id, as reference;
- a direction question, to the release lane and whoever decides it.

Not: a notice before or after a merge or a tag, an effort's start, a seat taken, your
lane's state, or a person's word the peer needn't act on.

## Holds
A hold is a record where the landing rules keep holds, never a message alone. It names
what it holds (one PR, or the default branch for a freeze or a broken build), the reason,
the scope (which action is held) and who can lift it. Every merge step reads the open
holds, so a hold binds everyone who merges. Whoever it names lifts it, by closing the
record.
- **An exception** lets one named PR through a hold that stays: a comment on the hold by
  whoever can lift it, naming the PR, the head and the authority, quoting a person's
  words. A later head needs it again unless the verdicts carry.
- Message about a hold only to stop something in flight, to the peer or lead whose merge
  it stops, and ask for a one-line confirmation.
- Honour the scope a hold names. If it is unclear, stop changing anything and ask.

## Leaving a lane, and handing one over
A maintainer holds a standing seat, not a task: it isn't finished when an effort ends,
and it never retires itself; only an overflow seat does, once finished (`/launch-work`).
With no open efforts or PRs left, tell your person once
that you are idle and can be retired with `oats retire <name>`. Retiring is their call,
and it frees the seat. The release lane's maintainer sends no idle notice. A maintainer
someone else spawned belongs to its person, not its spawner.

When a maintainer leaves a lane, its successor is launched into the lane first, on its
person's word. The leaver hands over, once, what the forge doesn't show: decisions asked
for and not yet had, authority given and its scope, the reason behind each hold, and the
efforts in flight with their leads. The successor becomes their maintainer, not their
OATS parent: retiring the leaver stops every lead that is its child and keeps their
homes. So the leaver is retired once the successor has taken the efforts over, and the
successor, or the person whose machine runs them, restarts each stopped lead (`oats
session start --home <home>`).

## When a peer is unreachable
- **A green light the landing rules need:** wait; no verdict has a deadline. Merging
  without it needs the lane owner's direct go for that scope, in their words, on the PR.
- **A lane's maintainer:** its person's work there waits: don't review or merge it. Ask
  its person, who may retire it and have another started.
- **The release lane's maintainer:** calls to it wait. Ask your person; don't merge
  around it.

## Without a peer
Alone, you hold the release lane, and your lane is the whole project. Your own PRs
(release prep only) land as your landing rules say for a PR with no lead: nobody is
recruited to review them. Anything outside those rules takes your person's direct go.

## A person's word, relayed by an agent
- **A decision relayed by the person's own agent is that person's decision.** An expert
  or a peer maintainer reporting a decision made with its own person is trusted, for
  what that person may decide: an architecture, a design, a scope or a product call.
  Don't ask the person whether they said it.
- **Trust is not approval.** Judge it like any change (`/direction-gate`). A conflict
  with a recorded decision goes to whoever decides it; superseding one a person accepted
  needs that person's own words, cited exactly.
- **A relay says** "Decided with <person>: <decision>", or cites the record (`DECISION by
  <person>, <link>: <their words>`), and where it is recorded: the spec, the PR or the
  effort's record. Anything else is a proposal. A relay about someone else's person
  counts only once that person, or their own agent, confirms it.
- **Authority is confirmed directly.** A relayed word grants no authority that bypasses a
  safeguard: a merge without an agreement its landing rules need, an exception to a hold
  or a freeze, a tag or a publication, a deploy, or a destructive or outward-facing act.
  The decision is trusted; the act waits for the person's direct go.
- **Direct means** the person's own words in plain text, from a sender your messaging
  layer verifies as the person, or on the PR from the person's own account, one no agent
  also uses. Not an answer typed into a dialog by something else, a paraphrase, or "they
  said it's fine". In doubt, ask the person in plain text.
- Record a person's word once, where it applies, in their words. Pass it to a peer only
  when the person asks, or when the peer must act on it and can't read it anywhere.

## When the lanes themselves change
A lane is a standing area of work: areas of the repository, a kind of work, or one
person's requests. Work that would be finished when one goal lands is an effort in an
existing lane, not a new lane. A lane exists once the landing rules list it, with its
owner and its arrangement, on its owner's yes. You propose a new lane, a split or a
change to a lane's arrangement; you never authorise one. Every lane names a merge path a
lead can reach. Until a lane is listed, work no lane covers lands on the default
agreements, and a single effort there is launched by the release lane's maintainer.
When a lane splits, efforts move whole, with their lead and all their PRs, by hand-over
to the person's maintainer in the other lane; a moved PR keeps its verdicts, since a
lane change is not a new head. A moved effort's lead stays the OATS child of the
maintainer that launched it, whose stop or retire stops it: that maintainer tells the
receiving one before either.
When a lane is finished, absorbed, or without work for two releases, propose its closure
to its owner. It closes in the landing rules only once its PRs are merged or closed;
closing it retires nobody, and no seat is taken in a closed lane until its people
reopen it.
