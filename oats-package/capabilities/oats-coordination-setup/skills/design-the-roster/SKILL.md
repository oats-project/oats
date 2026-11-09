---
name: design-the-roster
description: >-
  Propose an organisation's souls and standing instances: an expert soul per
  way of working (areas become its knowledge nodes), developer souls by
  environment, reviewers, maintainers per person per lane when needed, a
  dispatcher per person who wants one, and routines; each with its reason, as
  few as the clear ways of working allow. Use at onboarding, and when the
  setup is reviewed. Part of oats.coordination-setup.
---

# Design the roster

A soul earns its place by a different way of working, a different core set of
skills, or a different authority. A difference in what it reads is a knowledge
node, not a soul.

1. **People.** List each person and what they own: paths, lanes, products.
2. **Experts.** List the ways of working that plainly differ: product
   direction against engineering, say, or warehouse modelling against service
   code. Give each one expert soul.
   - The areas inside it become its knowledge nodes, read per task.
   - Many services on one stack under one owner make one expert reading a
     node per service, not a dozen experts.
   - One expert leads work that crosses repositories. It owns the
     architecture decisions and lessons across them, and reads each
     repository's node per task.
3. **Upstream sources.** For each skill or handbook the organisation copied
   from an upstream used outside OATS, the skill stays that source. The
   expert's node holds only the organisation's own decisions and lessons about
   it. Never move it into a node.
4. **Developers.** One developer soul by default.
   - Check that each repository says how to build, run and test it (its
     `AGENTS.md` or `CLAUDE.md`, its dev skills). Where one doesn't, propose
     adding that to the repository first.
   - Add a developer soul only for an environment the default one can't
     provide: a browser or display, a local service stack, warehouse access, a
     tool rig.
5. **Dispatchers.** One per person who wants a front door that starts their
   work and introduces its lead. Introducing one is that person's call.
6. **Maintainers.** A maintainer soul exists where a lane's landing rules
   need a maintainer's read or reserve its merges; no maintainer instance is
   started at setup. One is started for the person who owns that lane when
   first needed (`/set-landing-rules`).
7. **Reviewers.** The forge's review bot if the organisation runs one,
   otherwise a reviewer soul, fresh per change.
8. **Routines.** Only the organisation's scheduled jobs.
9. **Retire rules.** Every short-lived soul says when its instance retires:
   reviewers and probes when they have answered, developers once their PR has
   merged or closed, experts when their effort is done.

Give each line its reason in one sentence. Never one soul per imagined area,
repository or topic.
