---
name: okf-propose
description: >-
  The compulsory proposing procedure for working instances with oats.okf 6:
  keep instance knowledge current and, at every knowledge checkpoint (a PR
  handed over for review, a finished task, and in a long-lived role such as
  a maintainer's a feature ready, a release or deploy shipped, or a direction
  decision taken with the human), judge durable claims yourself, write them
  in a clone of the knowledge base with `oats okf propose --plan`, run
  `--apply` (it prints the outgoing diff and stops), read the diff, and run
  `--apply` again to open one reviewed PR per base. Read at task start and at
  each checkpoint. Covers the checkpoints, the soul opt-out, what still
  refuses and the warnings the maintainer resolves, the checkpoint record and
  hand-back. The knowledge maintainer gates every merge; you never shepherd
  the PR.
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
  by hand.

A task briefing does not decide your duty, and `oats okf propose` refuses an
opted-out or unknown home on its own.

## When to propose

A **knowledge checkpoint** is any of these moments:

- **You hand over a PR for review:** you open it, or mark it ready, and tell
  its reviewer or maintainer.
- **You finish a task,** before you hand back or retire.
- **In a long-lived role** whose task never finishes (a maintainer, an
  expert holding an area, a support desk):
  - **a feature is ready:** its last PR merged or approved;
  - **you ship a release or a deploy;**
  - **a direction decision is taken with your human.**

These are not checkpoints: a commit, a review round or a new head of the
same PR, and each decision you make while working. Capture decisions and
discoveries the moment they happen, in notes/; the next checkpoint carries
them. **One proposal per checkpoint, carrying only what no earlier proposal
carried.**

## Judge first

At a checkpoint, first update STATE.md, log.md and the relevant notes. Then:

1. **Respect the soul opt-out.** `knowledge: { harvest: off }` (also spelled
   `publish: off`) removes the duty to propose, not consultation or
   working-memory upkeep. No task, note, host or spawn setting turns it back
   on, and `oats okf propose` refuses such a home (`E_OPTED_OUT`).
2. **Apply `knowledge-theory`'s promotion test:** keep what changes how a
   future instance decides or acts and cannot be recovered by reading the
   repository. No code descriptions, task residue, secrets, personal data or
   tool noise.
3. **When in doubt, propose: the maintainer judges.** A quick
   `oats okf search` for the claim is enough. Duplicates, the canonical home
   and the subject are the maintainer's to settle. A lesson goes to the node
   or subject it belongs in, even one your soul only reads: a warning tells
   the maintainer.
4. **Check your log for this checkpoint.** Do not propose the same work
   again after a restart, compaction, a review fix or a hand-over
   acknowledgment.
5. **Record the checkpoint in log.md, whatever its outcome:** what the
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

## The steps

Run each from your instance home.

1. **`oats okf propose --plan`** clones each base your soul proposes to, at
   its accepted branch, into `proposals/<date>-<slug>/work/<alias>`, and
   prints the slug it made, the write surface and the open proposals on each
   base. It refuses before cloning: `E_SOURCE` (not a working OATS home),
   `E_OPTED_OUT`, `E_PROPOSAL_EXISTS` (a slug you gave is taken), `E_OWNER`
   (your `okf.json` and the base disagree on an owned node: report it).
2. **Write the knowledge** in the clone with your native file tools (load
   **okf-authoring** for the craft): one concept per Markdown file, with
   frontmatter. Edit files only: do not commit, branch or push in the clone.
   `proposal.md` is optional. Left as the skeleton, the PR text is built from
   your claims' titles and descriptions. Fill it to say why and what you
   observed: `# OKF proposal: <one-line claim>`, `## What`, `## Why`,
   `## Evidence`, and `## Backing notes` with one `- notes/<file>.md` line per
   note, relative to your home. No provenance block: the command writes it.
3. **`oats okf propose --apply`** checks everything and pushes nothing: it
   validates the proposed tree, hashes the named notes, runs the content
   screen over everything that would leave this host (the tree delta, file
   names, the commit text, the PR body) and prints the **complete outgoing
   diff**, the commit text and the PR body, then stops.
4. **Read the printed diff once, in full, as a reviewer would:** against
   `knowledge-theory`'s reject list (no code descriptions, task residue,
   secrets or verbatim third-party text), against the personal-data
   sentence above (note file names, task refs and your instance name
   included), and for private paths. A clean screen is a bounded detector, not clearance.
   Fix what you would not merge.
5. **`oats okf propose --apply` again** publishes exactly what the last
   check printed: one `okf-proposal` PR per changed base, on a new
   `okf-proposal/<date>-<uuid>` branch. If anything changed since, it
   refuses `E_DIGEST` and pushes nothing.

**After you fix something in step 4, or after `E_DIGEST`,** run
`oats okf propose --check`: it prints the new diff and records it. Read it,
then run `--apply`. A bare `--apply` only checks when no check was recorded
yet.

With more than one open proposal in your home, give `--slug <slug>` to each
command. The 6.2 steps still work, with the same result:
`oats okf propose --plan --slug <slug>`, then
`oats okf propose --check --slug <slug>` (prints the check and a digest),
then `oats okf propose --apply --slug <slug> --digest <digest>`.

On a base with the subject layout (`layout: subjects` in the plan), write a
claim under `claims/` with `about: [<kind>/<slug>, ...]` if your soul
declares `subjects` (okf.json version 2). Write in your nodes if it declares
`owns` (version 1): `about:` is then added from the subject whose
`legacy-nodes` names the node. Never write an `id`, and never edit a
generated index (`subjects/**/index.md`, `verdicts/index.md`, the root
`index.md`'s `## Subjects` section): the check regenerates them. To propose
again a claim a verdict rejected, add `reconsiders: <id>` and new evidence.

## What refuses, and what only warns

These refuse, and nothing is pushed:

- `E_SCOPE`: `okf-base.json`, a non-Markdown file (v1 anywhere; v2 under
  `claims/` or `subjects/`), a hidden, executable, symlinked or
  out-of-root path, or a hand-edited generated index.
- `E_VALIDATION`: the base would be invalid (unparseable or missing
  frontmatter, a missing `type`, a malformed list, a duplicate id, a file
  outside every node): fix the Markdown.
- `E_CONTENT_REFUSED` (findings name locations only; rule `host-term` is the
  host's own list): remove the content, never work around the screen.
- `E_PROPOSAL_FORMAT`: `proposal.md` carries a provenance block, or is not
  readable UTF-8.
- `E_DIGEST`: the proposal changed since the check you read.

Everything else is a **warning** in `warnings[]` and a row of the PR body's
`## Check warnings`, which the maintainer resolves before merging. Each row
names the rule it replaces; none needs anything from you:

- `W_SCOPE`: a path outside your write surface (another node, `verdicts/`,
  `subjects/workstream/`, a delete, a supersession no claim of yours makes).
  The maintainer moves it, or removes it.
- `W_SUBJECT`: a claim with no subject, or one naming no subject file. The
  maintainer assigns it.
- `W_LINT`: a broken link, a concept no index lists, a missing title or
  description. The maintainer fixes it.
- `W_VERDICT`: a claim carrying a rejected id without `reconsiders:`. The
  maintainer judges whether it is the same claim.
- `W_PROPOSAL`: `proposal.md` left unfilled, without a title or a section,
  or with a note reference it cannot read (dropped from the evidence).

Two warnings stay out of the PR body: `E_NOTE` (a named note that is missing
or unreadable is listed without a hash: drop any claim that needed it), and
`W_ID_MISSING` (an accepted claim waits for the maintainer's id). A
`W_ATTRIBUTION` warning means a trailer was left out of the commit because
the content screen refuses its value.

## Publication

Before it pushes anything, `--apply` checks that this host can open the PR.
`E_GH_UNAVAILABLE`, `E_CREDENTIAL` or `E_HOST_CREDENTIAL` mean it cannot:
nothing was pushed and the proposal is unchanged. Report the message to
whoever runs the host, and once it is fixed run the same `--apply` again.

**A publication error is reported, never retried.** `E_BASE_MOVED`,
`E_PUSH_UNCERTAIN`, `E_GH` and `E_PR_UNCERTAIN` retain the clone, the texts
and the safe result in the proposal directory. A remote branch or PR may
exist after an uncertain one: never assume it does not, never clean it up.
When the push went through, the message names the commands that finish or
remove it: pass them on in your report, and do not run them. A second
publication of the same proposal refuses (`E_PROPOSAL_EXISTS`).

## After apply

Record each PR URL in log.md and go back to work. You never shepherd the PR:
the `proposal-review` trigger spawns the knowledge maintainer, which reviews,
amends, merges or closes it, and reports to no one. Where no trigger is
installed, you may spawn one reviewer, and not wait for it:

```sh
oats spawn oats.okf/knowledge-maintainer --task "Review knowledge-base PR <url> at <head>. Load the knowledge-review skill first." --relation unrelated
```

Keep the backing notes until the PR is settled; the maintainer never reads
them in your home (the hashes in the provenance fix what you relied on).

## Hand-back

Say which checkpoint you ran and its outcome: "done, proposed: <PR URLs>",
"done, nothing to propose: <reason>", "done, proposal pending: <slug and
why>" or "done, no duty to propose" (opt-out).
