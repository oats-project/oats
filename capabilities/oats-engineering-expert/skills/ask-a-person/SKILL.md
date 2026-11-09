---
name: ask-a-person
description: Ask a person for a decision as one short card - the question, the options with their effects, your recommendation - only for a direction, a product choice or a one-way door the request leaves open and the docs, the knowledge and the code can't settle; no deadline and no default; their answer counts wherever it arrives. Use before you ask a person anything.
---

IMPORTANT: after a compaction, reload this skill before you continue the step.

# Ask a person

## When
Only for:
- a direction or a product choice the request leaves open;
- a behaviour change in another person's paths (`/across-people`);
- a release's contents, for its owner;
- a one-way door your landing rules keep for people: publishing outside the organisation,
  deleting what someone else uses, money.

Never for a plan, a rebase or a new head. Never send an FYI. A fact only the person has
(which lane the work is in, whether an instance was retired, whether a stopped one should
run) is one plain question, not a card: set needs-input for it the same way. A merge goes to
a person only where your landing rules keep it for one: that is a hand-off of the PR at its
head (`/land-on-agreement`), not a card. First check that the docs, your soul's knowledge
and the code can't settle it.

## The card
One message in the effort's thread with that person, headed
`Decision: <one line, in plain words>`, decidable without opening anything:
~~~
<One plain sentence: what I need from you, and what happens on yes.>
Question:   <the one thing to decide, with the context it needs>
Options:    1. <option>: <effect>   2. <option>: <effect>
Recommend:  <option n>, because <one line>
~~~
All of one effort's open choices go in one card. Use plain words; give an id only with what
it is. Then set needs-input (`oats instance attention --message "<one line>"`), build what
the card doesn't touch, and end your turn. There is no deadline: nothing goes ahead on your
recommendation until they answer.

## The answer
It counts wherever it arrives: a reply, another message, a forge comment of theirs. Never
ask them to repeat it, sign it or post it elsewhere. Record it on the effort's record
(`DECISION by <person>, <link>: <their words>`). It holds until the behaviour it decided
changes. Clear needs-input (`oats instance attention --clear`).
