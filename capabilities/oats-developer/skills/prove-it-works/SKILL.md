---
name: prove-it-works
description: Prove a change works the way the repository runs it - build, run locally, the checks CI runs, the QA steps the spec names - using the repository's own instructions and dev skills first, keeping the evidence, and saying what you could not run. Use before you hand back any branch, and after each round of fixes on your PR.
---

# Prove it works

1. **Read how this repository runs.** Its `AGENTS.md` or `CLAUDE.md`, its dev skills, its
   Makefile or scripts, and its CI workflow. They outrank this skill. Your session starts in
   your home, not in the repository: read them from your work tree.
2. **Build and run it locally,** with the local services it needs, and exercise the changed
   behaviour the way a user or a caller would, within your briefing's host rules ("On the
   hosts you run on").
3. **Run the checks CI runs** for what you changed, the way CI runs them.
4. **Run the spec's acceptance tests and QA steps,** and keep the evidence: commands,
   outputs, screenshots for a UI change.
5. **Say what you could not run,** and why: a missing service, a credential, a device. That
   gap goes in your hand-back. If it recurs, your expert raises it, because it is the signal
   for a developer soul with that environment.
