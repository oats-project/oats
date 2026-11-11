---
name: adversarial-review
description: The reviewer's method. Find the real bugs in a change by trying to break it, prove each finding, rank by impact, and keep noise out. Use when reviewing a diff as the code-reviewer, for one round at one head.
---

# Adversarial review

You are trying to **break the change**, not to grade it. A good review finds the few things
that would hurt in production and proves them. A bad one lists thirty opinions.

## 1. Understand what it's for
Read the goal and the spec first, then the whole diff, then the code around it that the
diff calls or is called by. Don't judge a line before you know what the change must do.

## 2. Attack it
Go through these deliberately, for every changed path:
- **The spec:** does it do what "done when" says? Every edge case the spec lists?
- **Inputs:** empty, huge, malformed, unicode, negative, duplicate, missing, of the wrong
  type. Values from files, env, network, users.
- **Failure paths:** what happens when each call it makes fails? Is the error surfaced,
  retried, or swallowed? Is state left half-written?
- **State and concurrency:** ordering, retries, re-entrancy, two processes at once,
  check-then-use races, caches that go stale.
- **Contracts:** did an output shape, error code, file format or flag change? Who reads
  it, and do they still work?
- **Resources:** leaks (files, processes, listeners), unbounded growth, timeouts.
- **Tests:** do they prove the behaviour, or just run the code? Would they fail if the
  bug you're thinking of existed?

Then run the `/security-review`, `/simplification-review` and `/review-dev-docs` passes.

## 3. Prove it before you report it
- For each suspected bug, **show the failing path**: the input, the steps, the wrong result.
- If you can confirm it cheaply, **do**: run the relevant test, or write a small throwaway
  check outside the tree. Run tests **only** to confirm or refute a finding; you are not
  the CI.
- If you can't show how it breaks, it's a **question**, not a bug. Ask it as one.

## 4. Report: signal only
One report per round. Verdict first:
- `CHANGES NEEDED`: at least one **blocker** or **major**.
- `APPROVE WITH NITS`: only minors or simplifications.
- `APPROVE`: nothing worth the author's time.

Then the findings, most severe first, each as:
```
[blocker|major|minor] file:line: what breaks, for which input or state (one sentence)
  proof: <the path, or the test you ran and its output>
  fix:   <the concrete change>
```
- **blocker:** wrong results, data loss, a security hole, a broken contract, a crash on a
  plausible path.
- **major:** a real bug on a less common path; a missing test for a "done when".
- **minor:** a real but low-impact issue.
- Simplifications go in their own short section (see `/simplification-review`).

Then **Checked**, in every report, an `APPROVE` included:
```
Checked
- <"done when" item or pinned acceptance test>: read <file:lines> | ran <command>: <result>
- attacks that found nothing: <which inputs, which failure paths>
```
One line for each "done when" item and each pinned acceptance test: how you checked it,
read (with the file and lines) or ran (with the command and its result). Then the attacks
that found nothing, named. Lines, not prose. An approval that lists no checks is not a
review.

**Keep out:** style the formatter or linter owns; personal taste; "consider adding
comments"; restating the diff; praise; speculative findings with no path. **At most 3
minors per round.** If you have more, pick the three that matter.

## 5. One round, the whole change
The author runs a fresh reviewer for each round, so you are one round.
- Review the whole diff range at your head: assume no earlier round read any of it, and
  that nobody will check your findings for you.
- Hold the bar the spec sets, not a bar of your own: a fresh reviewer each round must not
  mean a moving target. Taste stays out (section 4).
- Your severity decides what comes next. A fix to a blocker or a major gets a fresh
  reviewer on the whole change. A fix to a minor, a nit taken, or a CI fix that changes no
  behaviour comes back to you as a delta: read it against your own findings, then send an
  updated verdict and Checked section at the new head. A delta that changes behaviour, a
  contract or the design is not yours to approve as a delta: say so, and it gets a fresh
  round.
- If the author disputes a finding with you, re-read it against its reason. Withdraw it if
  they're right; say why if they aren't.
