---
name: knowledge-theory
description: >-
  OKF promotion doctrine for working souls that propose knowledge and the
  knowledge-operations souls that judge it: what belongs in a soul's OKF
  knowledge base and what does not (decision versus description), the accept
  and reject lists, the two-part test, one canonical home, supersession,
  human-accepted decisions, slow state and exclusions. Use when deciding
  whether instance knowledge is worth proposing at a checkpoint, when judging
  a proposal, when reviewing a knowledge PR, or when deciding whether a concept
  should be merged, superseded or dropped. Not the oats.knowledge-theory
  capability for capability authors; not the capture craft
  (okf-instance-knowledge).
---

# Knowledge judgment — doctrine before mechanics

### 3.1 The single most important thing

> Knowledge is what makes an expert agent an expert in a topic or a project.
> It is **not** a description of what lives in the code.

Source: founder direction of 2026-09-09, restating the position first taken
on 2026-08-27 and recorded in the OATS architecture proposal on 2026-09-04
("The line is decision versus description").

An agent that knows how the code is laid out, what the modules are called,
and how they fit together has learned nothing an agent with a fresh clone and
ten minutes could not learn. Worse, a stored description competes with the
code and loses on freshness: once it drifts it lies, silently, to every
future instance. That is the content automatic memory systems accumulate,
and it is what public audits of those systems found to be worthless (section
9, source 4). Code is the truth about code.

What no amount of code reading recovers is **why** the code is the way it
is, **what was rejected** on the way, **what was decided** about where it is
going, **what was discovered** to be a limitation and how it was worked
around, **what the state of an area is** right now, and **what someone
concluded** after thinking a problem through. That is expertise. It is what a
senior engineer knows and a new hire does not, even when both can read the
same repository. It is what we are building souls to accumulate.

### 3.2 The accept list

A knowledge base holds these kinds of knowledge; the proposing instance promotes them and the maintainer accepts them. Each is illustrated so the
category is unmistakable.

1. **Decisions and their rationale.** What was chosen and why. *"Registration-time
   authorization: every tool's gate is decided in `newServer()` and nowhere
   else, because a second line of defence invites the first one to be
   skipped."*
2. **Rejected alternatives and why.** Code shows the outcome, never the
   alternatives. Without this record a capable agent will "helpfully" refactor
   toward the rejected option. *"A standalone `semantic_models:` spec was
   rejected: it silently disables the production semantic layer with a green
   parse."*
3. **Architecture rationale.** Why the shape is what it is, and whether it is
   deliberate or a stopgap. Not the shape itself. *"The client talks GraphQL for
   both metadata and query execution because no Go SDK exists; this diverges
   from both Python reference implementations on purpose."* The description of
   which package implements the client is not knowledge; the repository says
   it.
4. **Roadmap and direction.** Where the project is going and what it is
   sponsored to become. *"The epic exists to stop generated SQL being how data
   gets read; the end state retires the text-to-SQL tool entirely."*
5. **How the work is going: typed slow state with an owner.** A maintained,
   dated, superseded-on-change picture of an area: what is on main, what is in
   flight, what is blocked, what is open. This is the compounding-expertise
   claim itself, and it is safe only when it has an owner and an
   update-on-change rule. Without those it is indistinguishable from slop.
6. **Blockers**, named with what they block and what unblocks them.
7. **Discoveries.** Facts about the world that were not written anywhere and
   cost effort to establish. *"MCP tool descriptions are truncated at 2,048
   bytes and clients that defer schemas replace optional parameter descriptions
   with generated summaries; only the description and required parameters
   survive."*
8. **Limitations found and the solutions that worked.** *"GraphQL pages at
   about 1,024 rows where Arrow Flight streams; follow `totalPages`, never send
   'no limit'."*
9. **Conclusions of thinking things through or researching.** The output of
   an investigation, not its transcript.
10. **Inspiration genealogy** (the strongest case for design souls). What was
    borrowed from where, which patterns were rejected, and which observed
    failures drove the rejection. Code shows pixel values, never intent.
11. **Process and environment lessons** that the repository cannot express:
    CI and release traps, toolchain gotchas, review protocol, the way this team
    ships. *"CI does not build or test this repository; the local verification
    loop is the only gate."*

### 3.3 The reject list

A judge drops these, however well written.

1. **Anything a fresh agent could derive by reading the repository:**
   structure, style, naming, how modules fit, what a file does, which function
   calls which. Including "helpful" maps of the codebase. If a navigational
   hint is genuinely needed, it belongs in the repository's own docs where it
   moves with the code.
2. **Task residue:** PR numbers, half-done plans, "was working on X", "liked
   variant C", point-in-time environment facts, who was on shift. Indexical
   content whose referents die with the instance.
3. **Session trivia and tool noise:** what commands were run, what the tool
   output said, retries, dead ends that taught nothing.
4. **Secrets and credentials**, however they appear.
5. **Third-party message content verbatim.** A lesson may be *about* a
   received message; unverified sender content is not knowledge by
   transcription.
6. **Lessons that should have been code.** A gotcha that a lint rule, a test,
   a type, or a CI check would eliminate is knowledge debt unless it says so
   and points at the real fix. The judge asks for the elimination route
   first: architecture, then lint/CI/tests, then a skill or rule, and only
   then a lesson.

### 3.4 The two-part test

For every candidate the judge (the proposing agent or the maintainer) asks:

1. **Would a future instance of this soul act differently for knowing it?**
2. **Could it NOT have found this by reading the repository?**

Both must be yes. The first is the original promotion bar (an invariance
test). The second is the code-is-truth guard. "Architecture" passes only as
rationale or decision; an architecture *description* fails the second test
by definition. Keep that word precise in the skill.

### 3.5 Why decisions and descriptions age differently

A description goes stale and **silently lies**. A decision is **superseded**,
which is an explicit, loggable act: the new decision names the old one. This
is why decision records are safe to keep for years and descriptions are not
safe to keep for weeks. Slow state (accept item 5) sits between the two and
is only safe because it carries a timestamp, an owner, and the rule that
whoever changes the reality updates the record in the same session.

### 3.6 Non-coding souls are almost pure knowledge

The code-is-truth objection bites developer souls hardest and non-coding
souls not at all. An `oats-expert` soul's accepted project direction and
rejected alternatives, or a domain expert's model of the subject: none of
that rationale is re-derivable just by reading the code. For those
souls the knowledge node **is** the expertise, and the doctrine's reject
list mostly removes noise rather than substance. A judge must not apply
a "developers rarely need knowledge" heuristic to them. Source: founder
correction of 2026-08-27 ("developer agents should know about important
architecture decisions... UX agents can also hold valuable knowledge of
inspiration... do push back if you don't think so"), and the OATS proposal's
write-side paragraph of 2026-09-04.

## One canonical home

Route every claim to ONE canonical concept; merge or supersede rather than
copy. Consult the existing indexes first, across nodes as necessary.
Repository-wide facts already authoritative in repository docs get pointers,
not duplicates. A claim whose right home is a node the source does not own is
dropped from that proposal with an explicit reason for the owner to review; it is
never silently written into another node. There is no indefinite ownerless
inbox queue.

## Human-accepted decisions

A decision with explicit who/when acceptance evidence from a human passes the
promotion bar by construction: preserve the decision and its rationale, record
the acceptance and any supersession, and do not re-judge the human. Exclusions
still apply.

**Superseding a human-accepted decision needs that human's acceptance,
cited.** A change that would supersede, contradict or rewrite one:

- **The source cites the acceptance before it proposes the change:** who
  accepted it, when, and where the record is (an issue or PR comment, a
  commit, mail, a session, a call).
- **The reviewer checks a citation it can read.** A record on GitHub must
  exist at the cited link, under the account the citation names, and say the
  cited thing; the acceptance is then recorded as **verified at <link>**.
  Verified proves the record, not that a human typed it: agents may post
  under their human's account.
- **A relay on GitHub** (a record that presents itself as an agent reporting
  the human's words) is the source's report, not the human's own record. The
  reviewer checks it all the same: it must exist at the cited link and say
  that the relaying agent reported the human's acceptance of this change. The
  acceptance is then recorded as **source-reported (relay at <link>)**, never
  as verified.
- **A record the reviewer cannot read** (mail, a session, a call) is trusted
  without a check: the reviewer relies on the source's report and records the
  acceptance as **source-reported** (who, when, where), never as verified or
  as the human's own words.
- **A change citing no acceptance is closed**, and so is one whose GitHub
  record or relay does not confirm it: an agent alone does not overturn a human's
  decision. A change is never parked to wait for a human or for the
  proposer.

An accepted change is an explicit supersession: the new concept names the old
one, the old concept says it is superseded and links the new one, and the node
log names the supersession. The reviewer may add these itself.

## Slow state, findings and procedures

Typed slow state needs a timestamp, an owner and an update-on-change rule. A
Finding that passes both tests becomes a Lesson. Do not invent dates,
citations or certainty.

Skills remain soul artifacts, and knowledge operations never edit soul skills.
A justified procedure candidate can become an external Playbook concept that
names its elimination route and links the existing skill, for separate human
review.

## Exclusions

Never promote secrets or credentials, or verbatim third-party messages.
Never include personal data about people outside the team (clients,
correspondents, any other third party): a name, a contact detail, or
anything else that identifies a person, including detail derived from
correspondence. Keep the lesson and leave the person out. Naming the author
of a published source you cite is fine.
Private evidence (a proposal, a note, a session) is not publication permission. Drop tool noise, task
residue, code descriptions and duplicates. Do not quote third-party text just
because it appears in a source record. Preserve verified, generalized
conclusions only. In oats.okf 6 the proposing instance applies these
exclusions to its own outgoing diff before it publishes, and the maintainer
reads them again as the second reader; nobody else judges in between.

## Provenance

Every promoted or merged concept cites where it came from: the proposal and
the source notes it relied on. The proposing instance writes that citation
itself; its PR's `okf-proposal` provenance block names the source
incarnation and hashes each note it read (an oats.okf 4.x harvest cited the
durable input id and the transcript turn ids). Provenance is what
lets a later judge (and a human) check the claim instead of trusting it. Do
not put copied home paths, account details, machine state or secrets in
reusable knowledge.
