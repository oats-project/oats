---
name: understand-the-spec
description: Evaluate the spec you were given before implementing it, or write one when you have none. Use at the start of every piece of work, when a spec seems ambiguous or incomplete, or when the task is only a one-line request.
---

# Understand the spec

## If you have a spec
Read it twice, and read the code it touches before deciding it is right: the spec's model
of the code can be wrong. Check:
- Done when: can you check each outcome, and write its test now?
- Contracts: every interface you keep or change, and who consumes it.
- Edge cases: the inputs, failures and unusual states it leaves undecided.
- Consistency: with the code, the repository's docs, and itself.
- Scope: what's out of scope; which files you must not touch.
- Size: one piece of work, or several to split?

Questions go to your expert (what's ambiguous, contradictory or missing, and anything
else), batched, each with your proposed answer. Hold the parts a question affects until
it's answered; the rest can go ahead.

## If you have no spec
After reading the code, write one carefully in the standard shape (goal, done when,
design, contracts, edge cases, tests, out of scope, files) and send it to whoever gave you
the task. Wait for a yes on anything that changes a contract or a user-visible behaviour. A
small, contained fix can proceed with the spec stated in your first commit message.

## Record your understanding
Note the decisions and answers in your working notes, so a reviewer, your expert or a
successor sees why the code is shaped as it is.
