---
name: pr-review
description: Gives or returns the green light on a PR, where the lane's landing rules ask the maintainer for one, at the exact head its lead or specialist names, by the maintainer's own list (direction and roadmap, contracts and interfaces, coherence rules, scope against the task, evidence against the acceptance criteria), never as a second line-by-line review; the verdict GREEN LIGHT, RETURN or ESCALATE bound to that head; the four gates for a PR with no lead (an outside contributor's, a person's own); and, where the merge is kept for the maintainer, merging only that head. Use before every green light, every other verdict and every merge kept for the maintainer, when a head moved after a verdict, and when a hold applies.
---

# Review the exact change

## Which PRs, and when
- **A PR whose lane's landing rules ask for your green light, or keep the merge for
  you,** when its lead, or the specialist of its area, calls you by message at an exact
  head. You are not in its build loop: its author's reviewers and the review bot read
  the lines before you are called. A PR nobody has to call you for lands on its lane's
  other agreements.
- **The call names** the exact head, CI green on it, every review thread answered there,
  the task the PR delivers with its acceptance criteria, and the `VERIFIED` note at that
  head (for a change a lead or a specialist built itself, the clean round of its review
  loop). With one of these missing, give no verdict: tell the author what is missing, in
  one line.
- **The head moves after the call:** stop until the author calls again, then read only
  the delta and re-bind your verdict. An unchanged update you made yourself under the
  carry rules needs no new call.
- **A PR with no lead** (an outside contributor's, a person's own) has had none of our
  reviews: it gets the four gates of
  [references/no-lead-pr.md](references/no-lead-pr.md), and you merge it where your
  landing rules say so.
- **Your own PRs** are release prep only (the version bump, the notes). A fix goes to a
  lead. You never approve your own.
- **As an overflow seat,** you answer the calls for the efforts your parent gave you,
  and refer a merge kept for the lane to your parent.

The verdict is bound to the SHA. It goes by message to whoever called, and on the PR as
a comment at that SHA, so whoever merges reads it there.

## The green light: what you check
Pin the base and head SHAs before you read a line. Read the PR as a whole, from an
exact-commit checkout of your own, never another agent's work tree: the description's
claim against the diff, and the task, spec and dependent PRs it links. Read for these
five, not for line-level bugs; one you meet all the same is a finding.

1. **Direction and roadmap** (`/direction-gate`, against the full diff): it belongs where
   it is, and moves the lane the way its roadmap and recorded decisions say.
2. **Contracts and interfaces.** Every changed export, signature, output or message
   shape, config key, flag, error code and file format has its consumers named, here and
   in the repositories that depend on it, and handled in the right order. An interface
   agreed between two areas of the effort is built as it was written.
3. **The coherence rules you keep:** where things belong, layering, naming, what never
   happens here; and docs and release notes in step.
4. **Scope.** The PR does what its task asks and nothing else. A PR too large to judge is
   split first.
5. **Evidence.** Each acceptance criterion is covered by something that ran at this
   head: the pinned acceptance tests, the suite that bears on the change, the real run
   the spec asked for, a case that must fail among them. An assertion weakened to pass,
   or a criterion with no evidence, is a finding.

Security is the author's reviewers' gate. It becomes yours where a change touches
identity, authorisation or secrets handling, or adds a dependency: read that part with
the security gate of the reference. CI is the gate: don't ask for a full local run, and
when you reproduce a finding locally, say what you ran.

## The verdict
```text
GREEN LIGHT at <sha>: <repo>#<PR>
Checked: direction: <...>; contracts: <...>; coherence: <...>;
         scope against <task>: <...>; evidence against each acceptance criterion: <...>
Not checked: <what, and why it doesn't bear on the verdict>
Follow-ups: <non-blocking findings, each with where it is tracked>
```
```text
RETURN at <sha>: <repo>#<PR>
1. <finding>: <file and line, or the contract>; why it blocks; what would settle it
```
- A green light names each of the five. One that lists nothing it checked isn't one.
- Only a finding on one of the five, or on the security gate where it applies, blocks.
  Record the rest as follow-ups.
- **`ESCALATE`** is the third verdict: a direction question goes to whoever decides it.
  Give no other verdict until it is answered, and tell the author so in one line.
- **A `RETURN`** goes to the author, which calls you again at the fixed head: read the
  delta. After 3 returns on one PR, stop and tell whoever called, with your position and
  its evidence. It goes up through the effort's root lead, never straight from you: the
  root lead puts both positions to its person in one card.
- Your green light is one of the agreements the landing rules name. The author gathers
  the others, another lane's green light included: you forward nothing.

## A moved head, a hold, a merge
Read [references/reviewed-delivery.md](references/reviewed-delivery.md) when the head
moved, a hold applies, or the merge is yours. A verdict carries to a new head only as
the landing rules' carry rules say (`/landing-rules-detail`).
