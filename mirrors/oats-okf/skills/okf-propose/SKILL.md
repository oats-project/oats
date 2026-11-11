---
name: okf-propose
description: >-
  The compulsory proposing procedure for working instances with oats.okf 6:
  keep instance knowledge current and, at every knowledge checkpoint (a PR
  handed over for review, a finished task, and in a long-lived role such as
  a maintainer's a feature ready, a release or deploy shipped, or a direction
  decision taken with the human), judge durable claims yourself, write them
  in a clone of your owned nodes with `oats okf propose --plan`, read the
  outgoing diff `--check` prints, and open one reviewed PR per base with
  `--apply`. Read at task start and at each checkpoint. Covers the
  checkpoints, the soul opt-out, promotion and duplicate checks, the write
  surface, the refusals, the checkpoint record and hand-back. The knowledge
  maintainer gates every merge; you never shepherd the PR.
---

# Propose knowledge at checkpoints

This duty comes from `oats.okf`, not from a task briefing. Keep STATE.md,
log.md and notes/ current throughout the work; use `okf-instance-knowledge`
for what to capture. You propose knowledge yourself, as a pull request on
the knowledge base; the **knowledge maintainer** reviews it and gates every
merge. Never push to an accepted branch, never merge your own proposal.

## Read your duty from the provider

At task start and before a checkpoint, run `oats okf status` from instance
home. Its `result.harvest` (and the same value as `result.publish`) is the
state the provider wrote at spawn:

- `on`: follow the checkpoint procedure below.
- `off` (`reason: soul-opt-out`): no duty to propose; never propose, but
  still consult and keep instance knowledge current.
- `unknown` (`reason: spawn-state-missing`), or a command failure: do not
  propose. Report it; a new spawn with the current provider establishes the
  state. Never infer `on`, read the soul file to decide, or repair the policy
  by hand. A restart does not recompose an old home's provider.

This is the one provider-owned answer. A task briefing does not decide your
duty. The private `okf-harvest-policy.json` in home is written by the
provider, not a user setting or a publication authorization;
`oats okf propose` refuses an opted-out or unknown home on its own.

## When to propose

A **knowledge checkpoint** is any of these moments. Each one is yours to act
on, and none waits for a task to close:

- **You hand over a PR for review:** you open it, or mark it ready, and tell
  its reviewer or maintainer. The work it carries is done enough to know
  what it taught.
- **You finish a task,** before you hand back or retire.
- **In a long-lived role** whose task never finishes (a maintainer, an
  expert holding an area, a support desk):
  - **a feature is ready:** its last PR merged or approved;
  - **you ship a release or a deploy;**
  - **a direction decision is taken with your human.**

These are not checkpoints: a commit, a review round or a new head of the
same PR, and each decision you make while working (a direction decision taken
with your human is the checkpoint above). Capture decisions and discoveries
the moment they happen, in notes/; the next checkpoint carries them.

**One proposal per checkpoint, carrying only what no earlier proposal
carried.** A PR handed over and then the same task closing are two
checkpoints, and the second proposes only what was learned since the first.

## Judge first

At a checkpoint, first update STATE.md, log.md and the relevant notes. Then:

1. **Respect the soul opt-out.** `knowledge: { harvest: off }` (also spelled
   `publish: off`) removes the duty to propose, not consultation or
   working-memory upkeep. No task, note, host or spawn setting can turn it
   back on, and `oats okf propose` refuses such a home (`E_OPTED_OUT`).
2. **Read `knowledge-theory` and apply its promotion test.** Keep only what
   changes how a future instance of this soul decides or acts and cannot be
   recovered by reading the repository. No code descriptions, task residue,
   secrets, personal data or tool noise. Nothing durable, no proposal.
3. **Consult accepted knowledge first:** `oats okf search` for the claim,
   then `cat` the relevant concept. Already accepted with nothing to add:
   no proposal. A refinement or candidate supersession cites the accepted
   concept and says what changes and why. A blocked read is not evidence
   that the claim is new: record the blocker rather than inventing knowledge.
4. **Claim only for nodes your soul owns.** Each concept is its own claim
   within the one proposal. For a lesson whose home is a node you only read,
   name the lesson and that node in one line in your hand-back for its owner;
   never write it there.
5. **Check your log for this checkpoint.** Do not propose the same work
   again after a restart, compaction, a review fix or a hand-over
   acknowledgment. An `--apply` that reported an error or an uncertain
   result is never rerun: report it.
6. **Record the checkpoint in log.md, whatever its outcome:** what the
   checkpoint was (`PR #123 handed over`, `v2.4.0 shipped`), and either the
   proposal's PR URLs, or `nothing to propose` with the reason in a few
   words. A checkpoint with no line in log.md is a proposal skipped.

Never include personal data about people outside the team (clients,
correspondents, any other third party): a name, a contact detail, or anything
else that identifies a person, including detail derived from correspondence.
Keep the lesson and leave the person out. Naming the author of a published
source you cite is fine. That covers the names you choose as well: a note's
file name, a task ref and an instance's name are published as provenance when
knowledge is proposed.

## The three steps

Run every step from your instance home. `<slug>` names this proposal
(lowercase letters, digits and inner dashes).

### 1. Plan: `oats okf propose --plan --slug <slug>`

It clones every base your soul owns, at its accepted branch, into
`proposals/<date>-<slug>/work/<alias>` in your home, writes the skeleton
`proposals/<date>-<slug>/proposal.md`, and prints:

- the **write surface** per base: your owned nodes' directories and the base
  root `index.md`. Nothing else may change.
- the open `okf-proposal` and `okf-harvest` PRs on each base: duplicate
  candidates. Read the ones that touch the same concepts; a claim already
  pending there is a duplicate: drop it.

It refuses, before cloning: `E_SOURCE` (not a working OATS home, or one
spawned before 5.2: respawn it), `E_OPTED_OUT`, `E_PROPOSAL_EXISTS` (that slug
is taken: choose another), `E_OWNER` (your `okf.json` and the base disagree on
an owned node: report it). A directory base is skipped: convert it to a Git
base or edit it in a reviewed change.

### 2. Write, then check: `oats okf propose --check --slug <slug>`

Load **okf-authoring** for the craft and situate before writing: read the
base's indexes and the neighbouring concepts in the clone, so every claim
lands in ONE canonical home. Then, with your native file tools, in the clone:

- one concept per Markdown file in an owned node, with frontmatter;
- its `index.md` entry, and a line in the node's `log.md`;
- supersessions explicit: the new concept names the old one, the old one says
  it is superseded and links the new one, the log names it;
- each concept cites its evidence, with no home, machine or account path:
  `Evidence: OKF proposal from <soul>/<instance>, <date>; notes/<file>.md.`

Edit files only: do not commit, branch or push in the clone. Then fill
`proposal.md`: the `# OKF proposal: <one-line claim>` title, `## What` (each
claim and its node), `## Why` (what a future instance would do differently),
`## Evidence` (what was observed and when, task refs, the accepted concepts
confirmed, refined or contradicted, cited `alias/node/concept.md@<oid>`) and
`## Backing notes`, one `- notes/<file>.md` line per note, relative to your
home. The skeleton's `<!-- -->` guidance is not published. No `Source:` line
and no provenance block: the command writes the provenance.

`--check` validates the proposed tree (`okf-validate --strict`), checks every
changed path against the write surface, hashes the named notes, runs the
content screen over everything that would leave this host (the tree delta,
file names, the commit text, the PR body) and prints the **complete outgoing
diff**, the commit text, the PR body with its provenance block, and a
**digest**. Nothing remote changes. Its refusals:

- `E_SCOPE`: a path outside the write surface (named): move or drop it.
- `E_OWNER`: a path in a node your soul does not own: drop that claim and
  name it in your hand-back for the node's owner.
- `E_VALIDATION`: the base would not validate: fix the Markdown.
- `E_CONTENT_REFUSED` (findings name locations only; rule `host-term` is the
  host's own list): remove the content, never work around the screen.
- `E_PROPOSAL_FORMAT`: `proposal.md` or a backing-note line is malformed.
- A named note that is missing or unreadable is a warning (`E_NOTE`): it is
  listed without a hash. Drop any claim that needed it.

**Read the printed diff once, in full, as a reviewer would**, before step 3:
against `knowledge-theory`'s reject list (no code descriptions, task
residue, secrets or verbatim third-party text), against the personal-data
sentence above (note file names, task refs and your instance name included),
and for private paths. A clean screen is a bounded detector, not clearance.
Fix and run `--check` again until the diff is one you would merge.

### On a base with the subject layout (oats.okf 6.0)

When `--plan` shows `layout: subjects` for a base (its `okf-base.json` lists
the reserved nodes `claims`, `subjects` and `verdicts`), knowledge is
organised by **subject** (`oats okf subjects`; the okf-authoring skill has
the craft):

- **Your soul declares `owns` (okf.json version 1):** write in your owned
  nodes as above. `--check` adds `about: [<subject>]` to every new claim from
  the subject whose `legacy-nodes` names that node (`E_SUBJECT` when none
  does: report it to the knowledge maintainer).
- **Your soul declares `subjects` (okf.json version 2):** write each claim
  under `claims/` with `about: [<kind>/<slug>, ...]` (one or more existing
  subjects). You may also add a new system or project subject file under
  `subjects/system/` or `subjects/project/` when a claim needs one, and set
  `status: superseded` on a concept your claim supersedes; the claim says so
  with `supersedes: [/<path>]` (or the concept's id). Never touch
  `verdicts/`, `subjects/workstream/`, `okf-base.json`, the root `index.md`
  by hand, or any other existing concept (`E_SCOPE` names the path and the
  rule). The tool's check is advisory; the maintainer's review is the gate.
- **Never write an `id`:** the maintainer stamps it at acceptance. To propose
  again a claim a verdict rejected, say so with `reconsiders: <id>` and bring
  new evidence; without it `--check` refuses `E_VERDICT` with the verdict's
  reason. Before writing, `oats okf verdicts --check <claim file>` answers
  the same; a title-hash candidate is listed in the PR body for you and the
  reviewer to resolve.
- **Never edit a generated index** (`subjects/<kind>/<slug>/index.md`,
  `subjects/index.md`, `verdicts/index.md`, the root `index.md`'s
  `## Subjects` section): `--check` regenerates them in the clone, and the
  printed diff shows it.

### 3. Apply: `oats okf propose --apply --slug <slug> --digest <digest>`

Use the digest the last `--check` printed. If anything changed since,
`E_DIGEST`: check again and read the new diff. On success it commits with the
package's fixed author text, pushes a new `okf-proposal/<date>-<uuid>` branch
(create-only, never the accepted branch), labels it `okf-proposal`, opens one
PR per changed base and prints each PR's URL, head, branch, the accepted
commit it is parented on and `recovered` (how often an accepted branch that
moved before the push was replayed onto; 0 normally).

**A publication error is reported, never retried.** `E_BASE_MOVED` (the
recovery could not replay), `E_PUSH_UNCERTAIN`, `E_GH` and `E_PR_UNCERTAIN`
retain the clone, the commit text, the PR body and the safe result in the
proposal directory. A remote branch or PR may exist after an uncertain one:
never assume it does not, never clean it up. A second `--apply` of the same
proposal refuses (`E_PROPOSAL_EXISTS`). Report the code and the PRs already
opened in your hand-back.

## After apply

Record each PR URL in log.md and go back to work. You never shepherd the PR:
the `proposal-review` trigger spawns the knowledge maintainer, which reviews,
amends, merges or closes it on what the PR and its cited evidence show, and
reports to no one. Where no trigger is installed, you may spawn one reviewer:

```sh
oats spawn oats.okf/knowledge-maintainer --task "Review knowledge-base PR <url> at <head>. Load the knowledge-review skill first." --relation unrelated
```

That is a call, not a station: do not wait for it. Keep the backing notes
until the PR is settled, for your own audit and any re-proposal; the
maintainer never reads them in your home (the hashes in the provenance fix
what you relied on).

## Hand-back

Say which checkpoint you ran and its outcome: "done, proposed: <PR URLs>",
"done, nothing to propose: <reason>", "done, proposal pending: <slug and
why>" or "done, no duty to propose" (opt-out). Name any claim you dropped
for a node you only read, with that node.
