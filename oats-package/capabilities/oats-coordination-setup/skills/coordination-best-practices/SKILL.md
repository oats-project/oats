---
name: coordination-best-practices
description: >-
  The coordination practices OATS recommends and why: never split a problem,
  split responsibility and context; one lead per effort, which decides who
  builds or researches each piece and whose children are helpers with one
  closed task each; whoever builds runs the review loop, and nothing lands
  without a fresh review whose verdict says what it checked; who stands and
  who is fresh; hand-offs by message; people for direction and decisions;
  across people; knowledge; and the patterns the trials showed cost time. Use
  when designing, explaining or reviewing how an organisation's agents
  coordinate. Part of oats.coordination-setup.
---

# Coordination best practices

**The principle.** The design never splits a problem; it splits responsibility
and context. One agent holding a whole task beats a chain of hand-offs, and the
gap grows as models improve. An extra agent earns its place by one of four
reasons: splitting context (a fresh window, a cleaner read), testing a theory
or an approach in a fresh context, specialisation (a lane's tools,
environment, skills or knowledge, or instructions that would conflict with the
lead's), or parallel work. Otherwise one agent holds the whole task.

**One lead per effort.** One expert owns the effort from plan to merge: it
reads the knowledge the task needs, and only that, then plans, specifies,
decides who builds each spec, and lands. It builds a spec itself by default. A
developer earns its place in three cases: context (sustained building whose
detail would crowd out the rest of the effort), parallel work (independent
surfaces built at once) and specialisation (a lane of its own). A large
feature (more than one surface, or sustained building and testing) always goes
to developers, one per surface. One coupled change is never split across
agents: split by context, never by kind of work, so a change and its tests
keep one author.

**In research, the same rule in its own words.** The research lead decides who
researches each angle: itself for a single small angle; researchers where one
protects its context, reads in parallel or specialises; a question with
several angles always goes to researchers, one per angle. A fresh verifier,
briefed to disprove, checks every claim the report leans on, always: never the
lead checking its own claims, an angle it read itself included.

**Helpers, each with one closed task.** A lead's children are helpers, never
co-planners; the plan stays the lead's. Each has one closed task: a question to
answer (a probe), a spec to build (a developer), or a scoped piece of the
effort that needs another soul's capabilities. A question is closed when its
possible answers can be written before it is sent; an open one the lead frames
first, into angles that are. Every brief carries its bounds (what the helper
may read and run, what is out of scope, when to stop) and what it sends back,
in order: the verdict in a line, evidence the lead can open, what it did not
check, its recommendation. Another area's work the effort needs stays in the
effort, by a helper of that area's soul; never a second lead for a step of one
effort. A lead for another, related effort is the first lead's sibling, and
the person is told its exact name at once. Every child is spawned
`--same-work`: it records that the child does its parent's work, and shares
no work tree.

**Test before you build on it.** The riskiest assumption is tested first, by a
probe in a fresh context: a theory tried on small, concrete cases, a spike or
a real run. Where the plan can go more than one way and the choice matters,
the lead lists the approaches first, including the one it doubts and "this
already exists", and sends one probe per approach in parallel, each building
the smallest spike that settles it. The lead compares them on evidence,
carries what one round found to the next, drops dead ends early and records
every approach tried, not only the winner. A plan that rests on an untested
theory, or on one approach chosen by argument, isn't ready. A probe never
checks its own claim: a claim the plan rests on is checked by another probe
with fresh context, against a check the lead wrote, never the probe. Most
decisions need one probe; the fan-out fits what the decision is worth.

**Whoever builds iterates with fresh reviewers.** Nothing lands without a
fresh review. The author of a change (a developer, or the lead for a spec it
built) runs the review loop: a fresh reviewer each round, an OATS child of the
author on a different model, until a round finds nothing to fix, at least one
round always. No author reviews its own work. The lead verifies a developer's
converged branch once and never runs rounds for it; a change the lead built
has no verification note, and its clean round stands in. A one-line docs fix
skips the local loop, not the review; only a maintainer's release prep needs
no review round. The reviewer's severity decides what reads a fix: a minor's
fix, a nit taken or a CI fix that changes no behaviour goes back to the same
reviewer as a delta; a blocker's or a major's fix, or any change of behaviour,
gets a fresh reviewer. A verdict says what it checked, one line per "done
when" item and pinned test, then the attacks that found nothing: an approval
that lists no checks is not a review. A helper's scoped piece hands its clean
round back to its parent lead and opens no PR until the parent has verified
it.

**Proper work goes to OATS children; checking work goes to another model.**
An investigation or test the plan rests on, a review, and any work that needs a
soul's knowledge or an environment to run and test in go to an OATS child
(`--parent`, `--same-work`): it shows in status and the Desktop, has its own
messaging and knowledge, and is retired on record. A small investigation or
task that directly helps the lead, and needs neither, can be the harness's own
subagent (in Claude Code, pi or Codex), as can anything the person asks to run
that way or that runs in a multi-agent workflow mode such as Claude Code's
ultracode. A child that reviews adversarially, investigates or validates a
theory or an approach runs on a different model from the agent whose work it
checks, wherever the organisation has one: agents of one model share blind
spots, so their agreement is not independent.

**Who stands, who is fresh.** Expertise lives in souls and their knowledge, so
instances start fresh.
- A dispatcher for each person who wants one, standing: the front door that
  starts their work and introduces its lead. It never relays cards, answers or
  progress.
- An expert soul per way of working, not per area: a fresh instance per
  effort, compacting and never respawning, then retiring. Areas that differ
  only in what they read are knowledge nodes of one soul, read per task.
- One developer soul, plus one per environment where running or proving the
  work differs (a browser, a local service stack, a warehouse). The author of a
  change, a developer or the lead, opens its PR once the lane's green light is
  given (for a developer's work, at the verified head; for the lead's, at its
  clean round's head), works its reviews (bots, reviewers, CI), and a
  developer raises to its lead only what needs product or architecture
  direction.
- A reviewer, fresh per round and launched by the change's author, never by a
  lead for a developer's work: the forge's review bot or a reviewer soul, on a
  different model. It retires once its round is closed.
- In research, a researcher fresh per angle and a verifier fresh per check,
  each the lead's child, the verifier on a model family no researcher and no
  lead runs on, wherever the organisation has one.
- A maintainer per person per lane, called by message where a lane's rules
  need its read or reserve its merge. Where the person has none active in the
  lane, the lead starts it, without asking, and tells the person in two or
  three plain sentences what a maintainer is, what it is for, and its exact
  name; never a second while one is active.
- Automations (schedules and triggers, `/oats-automations`) for scheduled
  jobs, and for waking work that waits on a date or an event.
- Every short-lived instance has a retire rule.

**Skills, as the work goes on.** Every role's briefing tells it, in capital
letters, to load the skill for each step and to keep loading it each time the
step comes round, not once at the start, and to reload it after every
compaction.

**Hand-offs.** A message to a role about a finished artefact at its exact
reference. The forge is the record, never the signal. No deadlines: the answer
wakes the sender, and what waits on whom stays visible.

**People.** Direction and decisions only. A card with a recommendation,
answered in a word. No FYIs that need action, no approvals restated on the
forge or relayed by hand, no person as anyone's timer.

**Across people.** An ownership record says who owns which paths and lanes.
One lead per effort. A person decides only for their own paths and lanes, and
the lead asks them directly. Their experts and maintainers are started through
their dispatcher, or by them. Disputes between people are theirs.

**Knowledge.** A node per area; split knowledge before souls. Conventions
change in the PR that changes the code; lessons and decisions are harvested at
checkpoints. The code is the truth about code. Knowledge an upstream owns
stays upstream: a skill copied from a source used outside OATS stays that
source, and the organisation's node holds only its own decisions and lessons
about it.

**Patterns that cost time in practice:**
- standing gates, woken and answered by labels;
- deadlines with a default if the person is silent;
- approvals restated on the forge, or relayed by hand;
- mail that restates what the forge already shows;
- findings sent to people as FYIs;
- one live expert reused across efforts;
- co-planners, where a helper with a closed task would do;
- a second lead for a step of one effort;
- one change split by kind of work (a planner, an implementer and a tester);
- an open question handed to a child, which decides for itself what it meant;
- a developer for a small change the lead could build in its own context;
- an approval or a verdict that doesn't say what it checked;
- a lead with no merge path, stacking PRs it cannot land;
- long specs where a short one would do;
- a seat that only relays or tracks;
- knowledge PRs an agent must shepherd alone;
- copies of one capability kept by each part of an organisation (a group of
  people, a repository), which drift apart.
