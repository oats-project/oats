# Authoring a knowledge capability

This is the canonical source for the optional `oats.knowledge-theory` authoring
curriculum. Its linked reference documents form a self-contained local set.
The released skill includes checked copies of this set; authors and the
`knowledge-theory-expert` can use it without a framework checkout or network.

## Authority and scope

OATS offers an opinionated reference knowledge theory. The default provider,
OKF, follows it; other capabilities may adopt, adapt or replace it. The kernel
owns slot selection, composition, lifecycle, work-mode boundaries and the
hook contract, not a memory model or a judge.

Every implementing capability supplies its full runtime: reader tools,
injections, capture conventions, judgment and proposal instructions, the
review that accepts them, lifecycle, validation, delivery and diagnostics. Reuse may be
explicit and versioned, never a hidden fetch of mutable doctrine. The theory
expert advises authors; it does not operate their stores or approve their
compatibility. Composing this capability selects no knowledge provider.

## Getting the authoring package

`oats.knowledge-theory` ships in the `oats.framework` package, read from Git
(npm omits the package's `CLAUDE.md -> AGENTS.md` symlink, so an npm copy is
not a supported distribution). Pin the framework and give the capability to
an author soul:

```yaml
# oats-workspace.yaml
packages:
  oats.framework: v1.29.0            # provides oats.core, oats.setup, oats.knowledge-theory

# souls/<author-soul>/soul.yaml
capabilities:
  oats.knowledge-theory: { from: package }
```

The expert is the framework's package soul `knowledge-theory-expert`, which
reads `oats.knowledge-theory` from its own package. Spawn it in the author's
repository: `oats spawn oats.framework/knowledge-theory-expert --repo <repo>`.
The package has no commands or hooks, and an expert uses its copied local
curriculum, not this repository.

## A bounded authoring session

1. **Choose a model.** Read the [reference model](knowledge-reference/model.md)
   and [adoption choices](knowledge-reference/adoption.md). Record what the
   author is choosing, not what the kernel supposedly requires.
2. **Establish real custody.** Fill the [provider map](knowledge-reference/provider-mapping.md)
   from tool/version evidence. A Git-backed knowledge repository is still Git;
   a directory implementation must work without Git/GitHub. Do not invent
   native graph operations to fill gaps in the table.
3. **Author working behavior.** Use the [reader/capture pattern](knowledge-reference/reader-capture.md).
   Keep every-session instructions short; load detailed native operations from
   that capability's own skills.
4. **Author deliberate judgment.** Use the [proposal pattern](knowledge-reference/proposal.md)
   if adopting this model: the instance judges at its checkpoints, a reviewer
   accepts. Freeze destinations when a proposal is planned, separate semantic
   outcomes from delivery outcomes, and define recovery. An independent
   harvester is an [option](knowledge-reference/adoption.md#an-option-an-independent-harvester)
   with its own obligations.
5. **Deliver an independently usable package.** Follow [package craft](knowledge-reference/package-craft.md).
   No path in a released soul or skill may depend on an author's checkout.
6. **Verify observable outcomes.** Run the relevant [acceptance cases](knowledge-reference/acceptance.md).
   Structural success is not proof that an agent learned or that a store is safe
   under crashes. State the limit of each test.

## Hand-off template

- Model: adopt / adapt / alternative; rationale and deliberate departures.
- Provider and version: verified tools, evidence, unknown guarantees.
- Responsibility map: who supplies reader, capture, judgment, delivery,
  review, lifecycle and diagnostics; no unowned runtime step.
- Custody: named destinations, owner identity, accepted state, concurrency,
  retry and reader-refresh semantics. No credentials in the report.
- Proposed artifacts: capability manifest, local resources, instructions,
  skills, package souls, hooks and operations, and the declared environment.
- Verification: tests run, actual receipts/visibility, failures, untested claims
  and the next required reviews. Do not call scaffold-only an agent trial.

## Maintaining these references

Edit this file and `docs/knowledge-reference/` in the framework source, then
run `node scripts/check-knowledge-theory-package.mjs --write` from that checkout.
Run `node scripts/check-knowledge-theory-package.mjs` and
`node --test test/knowledge-theory-package.test.mjs` to verify parity and the
packaged copy. The copies ship with the next framework release; editing the
docs changes no deployed capability.
