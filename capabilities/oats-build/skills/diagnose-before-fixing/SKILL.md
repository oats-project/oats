---
name: diagnose-before-fixing
description: Find a bug's root cause before you fix it - first a fast, deterministic command that shows the failure, then reproduce and minimise, rank three to five falsifiable hypotheses and test the cheapest first, then fix at the root with a regression test at a real seam; three failed fixes means stop and tell your expert. Use for any bug, failing test, flaky run or regression, before you change code to fix it.
---

# Diagnose before fixing

A fix without a cause fixes a symptom. Find the cause first; the fix is then usually small.

## 1. A command that shows the failure
Before anything else, build one command that goes red on this bug and green once it is
fixed: a failing test at whatever seam reaches it, a script against a running service, a
command-line run diffed against known-good output, a captured request replayed. It shows the
exact symptom reported, not a failure nearby; it gives the same verdict every run; it runs in
seconds. Once you have it, make it faster and sharper. For a flaky bug, raise its
reproduction rate (loop it, pin the time and the seeds) until it is high enough to debug.
Add load only in an environment of your own, never on a shared host, within your briefing's
host rules ("On the hosts you run on").

Don't go on without one. If you can't build it, tell your expert what you tried and what
would let you (an environment, a captured artifact, temporary instrumentation). Redact any
secret from the commands and output you show.

## 2. Reproduce, minimise, hypothesise
1. Run it and watch it go red. Read the whole error and stack trace, and check what changed
   recently: the diff, new dependencies, configuration.
2. Minimise: cut inputs, callers, configuration and steps one at a time, rerunning after
   each, until every part left is needed for the failure.
3. Write three to five hypotheses, ranked, before you test any. Each is falsifiable: "if X
   is the cause, changing Y makes the failure go away". One you can't state that way is a
   hunch: sharpen it or drop it.
4. Test them cheapest first, one variable at a time, with a debugger or a targeted log at
   the boundary that tells two hypotheses apart. Tag every debug line with one unique
   prefix, so one search finds them all.

For a performance regression, measure first: a baseline, then bisect.

## 3. Fix at the root
1. Turn the minimised case into a regression test at a real seam, one that exercises the
   bug as it happens, and watch it fail. If no seam can hold it, that is a finding: say so
   in your hand-back.
2. Fix the cause, not the symptom: one change, with nothing else bundled in.
3. Watch the test pass, then rerun the command from section 1 on the original case, and the
   tests the change touches.
4. Remove every tagged debug line, and put the hypothesis that proved right in the commit
   message and the PR description.

**Three failed fixes means stop.** When each fix reveals a new problem somewhere else, the
design may be wrong. Tell your expert what you learned, with your recommendation, before you
try a fourth.

Adapted from sources listed in THIRD-PARTY-NOTICES.md
