---
name: prove-it-works
description: Prove a change works the way the repository runs it - build, run locally, the checks the repository's own gate names, the QA steps the spec names - using the repository's own instructions and dev skills first, keeping the evidence, and saying what you could not run. Use before you hand back any branch, and after each round of fixes on your PR.
---
<!-- OATS: the description names the repository's own gate, not "the checks CI runs": CI is the gate in the oats repository (step 3). -->

# Prove it works

1. **Read how this repository runs.** Its `AGENTS.md` or `CLAUDE.md`, its dev skills, its
   Makefile or scripts, and its CI workflow. They outrank this skill. Your session starts in
   your home, not in the repository: read them from your work tree.
2. **Build and run it locally,** with the local services it needs, and exercise the changed
   behaviour the way a user or a caller would, within your briefing's host rules ("On the
   hosts you run on").
<!-- OATS: CI is the gate; the oats repository forbids its kernel and Desktop suites locally. -->
3. **Run the checks your repository's gate names** for what you changed, the way it says to
   run them. Where CI is the test run (the oats repository: `npm run validate`, `npm run
   check`, at most one or two test files), push and read CI for the rest, and name it as
   not run locally.
4. **Run the spec's acceptance tests and QA steps,** and keep the evidence: commands,
   outputs, screenshots for a UI change.
5. **Say what you could not run,** and why: a missing service, a credential, a device. That
   gap goes in your hand-back. If it recurs, your expert raises it, because it is the signal
   for a developer soul with that environment.
6. **Each claim names its evidence.** In your hand-back, every claim (the tests pass, the
   bug is fixed, the build succeeds, a spec item is met) names the command you ran at that
   head and what it printed. "Should pass" is not evidence, and neither is a subagent's or a
   workflow agent's report of success: rerun what it reports, and read its diff.

Adapted from sources listed in THIRD-PARTY-NOTICES.md
