# Adoption, adaptation and alternative theories

The [reference model](model.md) is OATS's recommendation, not mandatory kernel
policy. Choosing another model is a supported architectural choice.

| Choice | Author's obligation |
|---|---|
| Adopt | Implement and test the reference distinctions using the provider's real native tools |
| Adapt | Name which distinctions change, why, and what readers/writers can now rely on |
| Alternative | Describe the replacement model, its own learning/retention/consistency contract and tests |

A graph store can adopt the reference promotion bar without Markdown, YAML,
`index.md`, branches or a universal proposal API. A capability using continuous
retrieval without a separate judge might instead choose an alternative model.
Neither storage choice decides theory. Alternative capabilities still honor
framework work-mode, package containment, explicit configuration and executable
trust rules, plus applicable repository governance and credential safety.

## Responsibility boundary

OATS maintains canonical theory and authoring references, plus an optional
expert. The selected capability supplies *all* runtime behavior: complete
injections, skills, memory conventions, retrieval, capture, judgment if any,
lifecycle effects, scheduling, native persistence, validation and diagnostics.
There is no invisible shared theory layer underneath it. It must be usable
without the expert running or reference documentation fetched over the network.

The default OKF model chooses external bases/nodes, working instances that
capture and propose at checkpoints, a knowledge maintainer that reviews every
proposal, PR-only Git delivery and real non-Git custody. These are adoption choices, not new mandatory kernel
fields. OKF-specific files, schemas and validator calls stay in OKF. A
capability choosing another approach is not rejected for failing an OKF or
reference-doctrine test that does not apply to it.

## An option: an independent harvester

A capability may instead give judgment to an independent harvester: a separate
worker that judges a source's captured evidence, possibly after the source has
retired, and delivers the result. Earlier OATS knowledge capabilities worked
this way; `oats.okf` 6 replaced it with proposals at checkpoints. A capability
choosing it adapts the reference model and owns what proposals avoid: copying
bounded evidence out of the source's home before retirement, per-source jobs
that a reused name cannot consume, destinations frozen at capture, explicit
host scheduling, and recovery when work outlives its source. The judgment
procedure, the exclusions and the delivery states in
[judgment and proposal](proposal.md) still apply to it, and a reviewer of its
output is still the gate before acceptance.

## Record the choice

Write a short decision before implementing:

- Which model and whose future behavior it serves.
- What is memory, knowledge, evidence and accepted state in that model.
- Which reference distinctions are retained, changed or absent, and why.
- Who owns runtime instructions and changes to them.
- Native storage guarantees, known limitations and observable failure states.
- Behavioral tests for the chosen model plus generic package/lifecycle tests.

Do not label a broken implementation as a deliberate alternative after a test
fails. Conversely, do not force a genuine alternative to mimic files, PRs or a
judge it never promised. Evaluate the contract the author actually chose.

## Switching an existing deployment

Installing this authoring package performs no migration and selects no layer.
A storage or model change in an existing deployment is a separate explicit
migration: inventory source knowledge and pending evidence, preserve both,
verify the destination, define translation and exclusions, validate reader
behavior, then cut over with an observable result. Do not silently discard an
old soul bundle, let alias edits redirect pending evidence, or initialize an
empty substitute because a required base cannot be found.

For generic packaging and activation isolation see [package craft](package-craft.md).
For the reference-model migration and isolation tests see [acceptance](acceptance.md).
