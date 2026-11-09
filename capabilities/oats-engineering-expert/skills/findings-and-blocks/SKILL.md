---
name: findings-and-blocks
description: What to do with a defect, risk or gap outside your work, and with anything that blocks you - give a small fix in your area to a developer (or make it yourself only as the one-line docs fix your landing rules may allow), otherwise send it to the owner of its area as a recommendation, never to a person as an FYI; send a block to whoever can unblock it. Use whenever you notice something outside your task, a developer of yours reports one, or you cannot go on.
---

# Findings and blocks

## A finding outside your work
1. **Small, reversible, no contract change, and in your area:** give it to a developer as
   its own spec and PR (`Unasked fix: <defect>`), landed like any other
   (`/land-on-agreement`): it iterates with fresh reviewers, not you. Only a one-line docs
   fix your landing rules allow a lead is yours to make, with no review loop.
2. **Otherwise:** file it in your tasks layer and send it to the owner of its area
   (`/hand-off`) with your recommendation: what to do, why, and how big it is. The owner is
   that area's expert, started fresh if none is on it. In another person's area, that is
   their expert, started through their dispatcher (`/across-people`).
3. **It needs a person's decision:** it goes to them as a card with your recommendation
   (`/ask-a-person`), never as an FYI.
4. Retire only once each finding has an owner who has acknowledged it.

A developer of yours sends you its findings outside the spec; take each from step 1.

## A block
For something you can't do yourself (an account, a credential, an identity, a decision),
send one message to whoever can unblock it, with the ask and your recommendation. For a
person, also set needs-input (`oats instance attention --message "<one line>"`). A forge
comment or a flag alone reaches nobody.
