## Changed

- **OATS's copy of the engineering template moves to template-v3.0.0** (oats-project/oats-engineering-coordination, commit fa871ed0), from template-v2.1.0, taking in template-v2.2.0 on the way. The ids stay, one is added (`oats.build`), and OATS's own rules still win where they differ, marked in the copy: the lane map, one second reader per PR, the release lane's sign-off where a lane asks, the lane's maintainer merges, CI is the test run, and no text names a harness or a model.
  - **The lead decides who builds each spec,** and builds it itself by default. It sends developers where one protects its context, builds in parallel, or specialises in a lane of its own (the Desktop's display, say). A large feature, more than one surface or sustained building and testing, always goes to developers. Whoever builds a change runs the review loop, a fresh `code-reviewer` each round, and the lead is never its own reviewer. It still verifies a developer's converged branch once and never runs a developer's rounds.
  - **Nothing lands without a fresh review,** a one-line docs fix included: the fix skips the local loop, not the review. A lead's own PR carries no `VERIFIED` note, since nobody verifies their own work: the clean round of its review loop stands in for it, in the landing rules and in the maintainer's `/pr-review` and `/cross-review-peer`.
  - **A new capability, `oats.build`,** holds the nine build skills, moved out of `oats.developer`: `/execution-strategy`, `/worktrees`, `/test-first`, `/diagnose-before-fixing`, `/design-while-writing`, `/prove-it-works`, `/run-the-review-loop`, `/work-the-reviews` and `/maintain-dev-docs`. `oats.developer` keeps `/understand-the-spec`. Ten souls compose it:
    - the developers, `oats-developer`, `oats-desktop-developer`, `oats-kernel-developer` and `oats-integrations-developer`, whose skill lists are unchanged;
    - the engineering experts that build their own specs, `oats-engineering-expert`, `oats-expert`, `oats-kernel-expert`, `oats-desktop-expert`, `integrations-expert` and `oats-operator-expert`, which gain those nine skills.

    `oats-product-expert` and `oats-public-expert` don't: each builds nothing, and its own text says so.
  - **Three of the moved skills change** (the other six are unchanged): `/execution-strategy` works in one context by default and splits only by context, never by kind of work, so a change and its tests stay with one agent; `/run-the-review-loop` sends a fix to a minor back to the same reviewer as a delta, and a fix to a blocker or a major to a fresh one; `/work-the-reviews` reviews each new head of a PR as its findings' severity says.
  - **`/send-a-probe` is now `/send-a-helper`.** A lead's children are helpers, each with one closed task: a question (a probe), a spec (a developer), or a scoped piece of its effort that needs another soul (a scoped helper hands its clean round back, and opens no PR until the lead has verified it). A helper is started for one of four reasons: to split context, to test a theory or an approach before the plan rests on it, to bring a specialist, or to work in parallel. Another area's step of an effort stays in that effort, never a second lead.
  - **Briefs are closed and verdicts are checked.** A helper's brief gives its bounds and what it sends back, in order. A reviewer's report lists what it checked, and a round counts as clean only with that list.
  - **A related effort's lead is a sibling** (`--relation sibling`), which outlives the first lead's retire, and the person is told its exact name. Every recipe that starts a child carries `--same-work`, which records that the child does its parent's work and shares no work tree.
  - **A lead with no maintainer for its lane starts one itself,** without asking, and tells its person in two or three plain sentences what a maintainer is, what it is for, and its name.
  - **Every role's briefing opens with a line to keep loading the skill for each step,** each time the step comes round, not once at the start. A lead's briefing also carries the quality floor and the host rules (CI is the test run here; never the kernel's or the Desktop's suites locally) for the specs it builds.
  - **`oats.workspace-experts` 1.3.0:** an expert's own worktrees are also for the specs it builds itself; a large feature goes to developers.
- **Running homes keep the texts they were spawned with** until they are respawned. A home of an expert soul spawned before this change builds nothing, as before.

### Hand steps for a deployment of this workspace

1. **Respawn the live homes onto the new souls,** once each has finished or handed off its effort (`oats status` lists them). For each home of `oats-expert`, the area experts, `oats-kernel-developer` or `oats-integrations-developer`:
   ```bash
   oats retire <name> --plan
   oats retire <name>
   ```
   New work starts on the successors, `oats-engineering-expert` and `oats-developer` (from your dispatcher, below). A home of `oats-engineering-expert`, `oats-developer` or `oats-desktop-developer` spawned before this change takes the new texts the same way: retire it once its work is done, and spawn a fresh one for the next effort.
2. **Start the dispatcher,** one standing instance for each person who wants one:
   ```bash
   oats spawn dispatcher --name <person>-dispatcher --task-file <who it serves.md>
   ```
   It starts a fresh expert of the right soul per effort, introduces its lead and steps aside.
