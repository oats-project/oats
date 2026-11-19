# Knowledge, instances and evolving expertise

This is the canonical explanation of the OATS knowledge and specialization model: the reference theory behind the default `oats.okf` capability, and the freedom other knowledge capabilities retain. The [README](../README.md) introduces the framework. This page describes the model, not every mechanism that implements it; see [implementation boundaries](#implementation-boundaries).

## The central distinction

> **A soul defines a reusable specialization. An instance develops expertise in a particular situation. Knowledge preserves learning that should survive that situation.**

Separating them lets a team retain learning without tying its expertise to one conversation, machine, model or knowledge system.

- A **soul** is an enduring identity and reviewed curriculum: responsibilities, boundaries, capabilities, skills and knowledge interests.
- An **instance** is a particular working continuity, with its own assignment, context, state and lifecycle.
- A **knowledge capability** determines how relevant knowledge is provided, how experience is captured and how learning is retained or shared.

The soul is not the complete mind of a running agent, nor a place to paste everything an instance has learned.

## Instances can be short-lived or long-running

An instance is not necessarily a single task or chat session; an assignment may span many tasks and session continuations. Short-lived developer and reviewer instances suit bounded implementation work; longer-running instances of expertise souls suit planning, investigation and sustained work on a domain. These are examples, not rules.

Over time, an instance develops familiarity with the relevant systems and people, verified observations and open questions, an understanding of what has been tried and why it failed, and effective procedures. This is **situated expertise**, valuable even when some of it belongs only to that assignment. "Disposable" describes a lifecycle possibility, not a recommendation to discard context often. Retirement should preserve required learning, work and handoff evidence, and duration alone does not turn an instance into a soul.

### Four different kinds of value

| What an experienced instance offers | Home in the reference model |
|---|---|
| Reusable workflows and practical know-how | Reviewed skills and capabilities |
| Durable judgment and awareness of the larger picture | Accepted knowledge |
| A working understanding of the particular problem | Instance context |
| Unfinished work, current experiments and next steps | Instance state |

One investigation can produce all four: a new verification procedure may become a skill, the reason it is necessary a lesson, and the current experiment and next action remain local state. Persistence is not the distinction: information may stay useful for months and still be specific to one investigation.

## Shared souls do not imply identical instances

Several developers can use instances of the same semantic-layer expert: one studies revenue definitions, another investigates performance, another supports a warehouse transition. They share a specialization but develop different working understanding. Neither person-to-instance nor instance-to-task needs to be one-to-one.

A shared knowledge base is not a shared active mind: making a finding available does not mean every instance has read it. In the reference model, instances consult relevant knowledge at session start, after context compaction and when a decision may already have been made, fetching detail selectively. The knowledge capability chooses these conventions and decides which experience stays with an instance; it does not redefine the kernel's source or instance identity.

## What deserves to become knowledge

> **Knowledge is what makes an expert an expert in a subject or project. It is not a description of what lives in the code.**

Code is the truth about code. A stored description of modules, functions or configuration competes with the repository and misleads once it drifts.

The reference promotion test asks:

1. **Would an appropriate future instance act differently for knowing this?**
2. **Could it not have obtained this simply by reading the repository?**

Both answers must be yes. "Appropriate" does not mean every instance: specialized learning can be valuable without becoming everyone's initial context.

### Preserve judgment

The reference model accepts:

- **Decisions and rationale:** what was chosen, why, and whether it is deliberate or a stopgap.
- **Rejected alternatives:** what was considered and why it did not fit.
- **Architectural judgment:** why a boundary exists, not a second map of its implementation.
- **Direction and priorities:** what the project is trying to become and the reasoning governing it.
- **Discoveries and limitations:** findings that required investigation, with scope, evidence and solutions that worked.
- **Research conclusions:** conclusions rather than transcripts, with uncertainty and recheck conditions where needed.
- **Design inspiration:** what informed a design and which failures shaped it.
- **Review and process patterns:** verified judgment that code alone does not communicate.
- **Maintained slow state:** a dated interpretation of an area that orients future work.

Human-accepted decisions pass the promotion bar by construction: preserve their meaning, scope and acceptance evidence rather than having anyone re-judge the person. Confidentiality, provenance and duplication checks still apply.

### Keep the larger picture, not a second issue tracker

A useful slow-state record might explain:

> We are replacing approach A with B because of this limitation. These parts are established; this unresolved question prevents the next stage.

It needs a clear scope, a responsible maintenance process, an as-of date and an update or supersession rule. Ownership does not make each working instance responsible for maintaining the base directly. The task tracker remains authoritative for issue status; knowledge can link a decision to the work that established it without copying lists of open issues into permanent prose.

### Put other material elsewhere

| Material | Appropriate home |
|---|---|
| Shared project facts, API contracts and code navigation | Repository code and documentation |
| Repeatable operational steps | Skills |
| Why an approach works and when its trade-offs matter | Knowledge, if it passes the promotion test |
| Current investigation, provisional reasoning and next action | Instance context and state |
| Raw records and notes awaiting judgment | Evidence, not accepted knowledge |

A bare sequence of commands belongs in a skill; if an insight already has an authoritative home, point to it. Exclude secrets, improperly disclosed private material, personal data about people outside the team (clients, correspondents, any other third party), wholesale copies of third-party messages, tool noise and ordinary task residue; for the full rule and what enforces it, see [What a proposal leaves out](knowledge.md#what-a-proposal-leaves-out). If code, a test or a clearer contract can eliminate a recurring problem, fix it instead of writing it down.

"Invariant across incarnations" means useful beyond its author, not true forever. Date and scope contingent claims, and supersede changed decisions explicitly rather than leaving contradictory truths or erasing their history.

## Default organization: centralized and per soul

The default is a shared knowledge base with a stable knowledge home for each adopted soul, so a team need not design a topic taxonomy first.

```text
A team's chosen knowledge base
  kernel-expert
  ux-expert
  customer-support-expert
```

The layout is illustrative, not a kernel schema.

- Instances of a soul consult its accepted expertise and relevant shared material.
- Their proposals have explicit destinations; task context is not published wholesale.
- A claim has one canonical home; other readers use references rather than copies.
- A public soul's publisher does not become the default recipient of an adopter's private learning.
- Knowledge identity and lifetime do not depend on one instance or on a changeable display name.

In the reference model, **owns is proposal routing**, not authorship, an access right or a duty to keep the base honest. **Reads is context selection**, not an access list; repository or service access still governs what can be read. Centralization simplifies where a proposal goes; it does not remove the need for judgment, deduplication, freshness or acceptance.

## Per-soul knowledge can evolve

Fluidity depends on being able to revise expertise boundaries, not on naming collections after topics rather than souls.

### Grow without creating another soul

A kernel expert that starts with capability boundaries may later develop sections for runtime behavior and packaging. It can remain one soul while its instances routinely need those subjects together; size alone is not evidence for a split.

### Split a recurring specialization

An overall expert handles project direction and some UX work until UX assignments consistently require different skills and reading context. A reviewed change can then establish a UX-expert soul:

```text
Before                              After
project-expert                      project-expert
  direction                           direction
  UX decisions                        reads UX expertise
                                    ux-expert
                                      UX decisions
```

The specialist material keeps one canonical home, and role instructions, skills and knowledge declarations are reconciled together.

### Merge or widen

Separate CLI and runtime experts whose boundary creates more handoffs than useful specialization can be consolidated into a kernel expert by a reviewed change. Reconcile overlapping claims, preserve provenance and references, and deliberately retire or revise the former definitions; concatenating conflicting collections is not accepted knowledge.

### Reassign a concept without changing the roster

A kernel decision may first land with the overall expert because that instance investigated it. Moving its canonical home to the kernel expert needs no new soul; other readers keep access through the capability's reference or migration mechanism.

## Speciation: changing the reusable specialization

**Speciation is one soul becoming two or more because a distinct, reusable specialization has emerged from its work.** Signals include sustained differences in the skills instances need or the knowledge they consult and produce, and a recurring class of work that would benefit from a different charter. Repeated spawning is evidence, not a requirement. The useful counterfactual is:

> Would we deliberately want future instances to start with this narrower charter, skill set and reading context?

A busy two weeks or a large set of notes is not enough; widening or keeping the existing soul may be right. Proposals supply evidence and maintenance can propose changes, but a person accepts structural change: souls do not split themselves. Drafting a new soul is a skill used in a maintenance proposal, not a separate agent's job.

### Maintenance is a responsibility, not a compulsory background agent

| Responsibility | Focus |
|---|---|
| Proposing | What an instance's evidence contributes to accepted knowledge |
| Maintenance | Consistency, freshness, structure, ownership and declarations across the base |

In the default capability, each working instance with a duty to propose proposes its own knowledge, and the `knowledge-maintainer` package soul maintains a base by reviewing those proposals. A human can perform maintenance instead; automation is optional, not a prerequisite for per-soul knowledge. A maintainer never silently accepts its own structural proposal or supersedes a human-accepted decision.

Evidence of what instances actually used, such as their purpose, skills and knowledge consulted, can inform these proposals. It is operational evidence, not knowledge or a copy of private transcripts.

### Changing structure must preserve running work

A knowledge move or soul split must account for references, pending proposals and existing instances:

- Update ownership and reading declarations in the same reviewed change.
- Preserve a single canonical home and the provenance of claims.
- Use explicit migration or redirects where the capability supports them; path changes are not free.
- Do not silently rewrite an active instance's retained role or skills, or retarget its pending write because ownership changed; reconcile it through a supported transition or hold it for review.

Refreshing accepted knowledge and changing an instance's retained curriculum are separate operations.

## Topic-first knowledge is an alternative, not a requirement

A topic-first model organizes the base around subjects, such as runtime execution or interface accessibility, and maps souls to them; ownership can change while subject identities stay stable. Per soul starts from an expert's scope and organizes knowledge within it; per topic starts from subjects and assigns ownership and reading interests over them. Topic-first organization helps when subjects evolve independently of the roster, at the cost of explicit structure and maintenance. It is valid for a capability or profile, not a universal kernel rule, and a deployment need not use one shape everywhere.

## Knowledge procedures and learning are capability choices

OATS supplies contracts and a default implementation; users can adapt capabilities or write their own procedures for working and learning. A capability might, for example, start new instances with expertise accumulated by earlier instances of their soul, keep a long-running instance's investigations across many tasks, or share selected, reviewed learning while task context stays local.

Three choices should remain independent:

| Choice | Examples |
|---|---|
| Organization | Per soul, per topic, per project |
| Placement | Shared repository, co-located directories, multiple stores, graph system |
| Learning and governance | Reading, capture, judgment, review, maintenance and acceptance workflows |

A capability can offer coherent profiles rather than many switches, and changing a directory layout should not require a new integration.

### Co-located knowledge remains a valid model

A capability could keep mutable knowledge alongside the editable soul definition:

```text
agents/example/soul/
  AGENTS.md
  skills/
  knowledge/
```

The architecture allows this; `oats.okf` does not support that layout. Such a capability needs explicit read and write destinations and custody, and co-location means an editable authoring repository, not writes into whatever copy of the soul an instance runs from. "All knowledge leaves souls" is a default integration choice, not a kernel prohibition. A relocated or unavailable store must produce an honest readiness outcome, not a fabricated replacement.

## Kernel contracts and capability behavior

The kernel supplies the common boundary; it must not hide one mandatory knowledge pipeline behind an interface.

| Kernel responsibilities | Knowledge capability responsibilities |
|---|---|
| Source, soul and instance identity | Knowledge organization and destination semantics |
| Configuration resolution and declared requirements | Storage, retrieval and reading context |
| Selected resources, exactly locked | Capture conventions and evidence selection |
| Lifecycle and invocation context, and provenance | Judgment, proposing and maintenance where used |
| Safe helper and job execution when required | Proposals, delivery, acceptance and recovery policies |
| Resource integrity and truthful outcomes | Its complete runtime instructions, skills and tools |

A knowledge capability is more than a storage adapter under a kernel-owned judge. The kernel does not require OKF, a node taxonomy, particular memory filenames, Git publication, a proposal flow or a maintainer. Alternative models must not weaken framework safety, repository governance, secret handling or declared authority, and a capability rejects incompatible requirements rather than quietly substituting another provider or destination. Messaging and tasks follow the same principle: common contracts, independently chosen implementations.

## How the default OKF capability works

`oats.okf` keeps accepted expertise as Markdown concepts with metadata, indexes and history in external knowledge bases. Its runtime owns bindings, consultation, the checks on a proposal and its delivery.

1. A working instance consults the accepted state of its soul's bases remotely with `oats okf bases`, `index`, `cat`, `ls`, `links` and `search`; no knowledge is copied into its home. It captures observations in its own instance knowledge without self-censoring against the promotion bar.
2. At each knowledge checkpoint, an instance with a duty to propose judges its own durable, non-duplicate claims (additions, merges, supersessions and exclusions) by the reference doctrine, and proposes them with `oats okf propose`. No worker is spawned and nobody waits for the proposal.
3. The capability checks the proposal's ownership, scope and screening before anything leaves the host, and delivers it only as a pull request on a Git base, with its provenance.
4. A `knowledge-maintainer` instance reviews that pull request and merges, amends, requests changes, closes, or escalates to a human.
5. Accepted learning becomes available to later consultation; it is not automatically in every instance's active context.

The reference doctrine's independent harvester ([judgment](knowledge-reference/harvester.md)) remains a pattern a capability may choose. `oats.okf` 6 chose differently: the instance proposes its own claims, and the maintainer's review of each pull request is where independence lives.

Directory bases use their own recoverable publication mechanism. Receipts state what actually happened: capture, judgment, delivery and acceptance are different facts, and directory publication does not prove human review. The [operational guide](knowledge.md) describes commands and constraints.

## Reusing working understanding: context handoffs and cloning

Proposing knowledge preserves individual lessons, not the combined working picture that makes a long-running instance effective. A handoff or clone carries selected references, verified observations and labeled provisional reasoning; that is not a knowledge store, and copying it promotes nothing.

Cloning exists as the official `oats.cloning` package ([souls and instances](souls-and-instances.md#cloning-an-instance)). A clone is a new instance of the source's soul with its own identity, credentials and ownership. What it carries is a curated brief written by a short-lived cloner for the new goal: what was re-verified, with its evidence; decisions and their reasons; working understanding marked provisional; open threads and who owns them; and where to look, with transcript turn ids as citations. The cloner leaves secrets out of the brief, a pattern-based redaction pass catches the common forms that slip through, and the brief is attached to the clone as a 0600 file, never placed in its task text. A clone does not carry the raw transcript, the source's `notes/`, the content of its work tree or its uncommitted changes (a worktree clone starts from the source's committed branch, the soul's default or a requested ref), or its commitments: those stay with the source unless the brief says they were handed over. Inherited material is not new evidence; the clone records it in its own notes only after re-verifying it.

## Implementation boundaries

The model's settled positions are those above: short- and long-running instances are both legitimate; the default is centralized, per-soul knowledge open to reviewed structural evolution; capabilities own their model and runtime behavior; the doctrine preserves expertise, not code descriptions or task residue; and structural change preserves provenance and running work. These are not CLI flags or configuration schemas.

The default OKF capability implements consultation, capture, the instance's own proposal and maintainer review; it does not provide automatic per-soul provisioning, a co-located profile, automatic speciation, redirects or context cloning. Context cloning is a separate package, `oats.cloning`, not part of the knowledge capability. Proving the kernel's flexibility needs a genuinely different organization and learning model, not only Git and directory storage within OKF. Updating this document does not migrate existing deployments.

## Related documentation

- [OATS overview](../README.md)
- [Souls and instances](souls-and-instances.md)
- [Knowledge operations](knowledge.md)
- [Knowledge reference model](knowledge-reference/model.md)
- [Layer contracts](layers.md)
- [Knowledge capability authoring](knowledge-capability-authoring.md)
- [Packages](packages.md)
