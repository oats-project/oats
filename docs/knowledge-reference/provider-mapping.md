# Mapping theory onto native custody

This is an authoring worksheet for capabilities adopting or adapting the
[reference model](model.md), not an OATS provider API or required kernel schema.
Fill it with observed behavior of the actual provider/version. “Unknown” is a
valid finding; an invented command or transaction guarantee is not.

## Three different things

- **Model:** consultation, capture, judgment, provenance, supersession.
- **Integration:** the capability's complete instructions and implementation.
- **Custody:** how proposed writes become durable, accepted, and reader-visible.

In the reference design a **base** is a named body of durable knowledge; a
**node** is an addressable owned portion; a **binding** maps a logical reference
to the selected capability's concrete location. These nouns need not appear in
another model. A soul may own nodes in several bases. `project/desktop-expert`
and `team/desktop-expert` are different nodes; leaf names are not identity.
Stable owner identity distinguishes same-named souls from different repositories.

Ownership assigns responsibility and proposal routing; `reads` selects initial
context. Neither is an ACL. Configured workspace/team bases are discoverable,
and native user accounts govern access. There is no new public/private system.
Access to a repository does not automatically bind it as a knowledge base.

## Resolve without guessing

Record an unambiguous resolved destination and owner before reads or proposals.
Do not derive custody from the source's cwd, feature branch, writable checkout,
work mode or the soul's location. Relative locators resolve from their declaring
scope with containment checks. For OKF specifically,
configuration uses one absolute `bindings-file`; paths in it resolve from that
file's directory, and `soul/okf.json` holds capability-owned declarations. That
is an implementation choice, not generic OATS YAML or a graph-provider schema.

Missing bindings, owner mismatches and access failures are visible errors.
Reads never scaffold missing nodes. Creation and ownership changes are explicit
writes. A planned proposal retains its frozen destination identity and binding
provenance; subsequent config edits must not reroute it. Provider migration is explicit.

## Native contract worksheet

| Concern | Evidence to collect and instructions to author |
|---|---|
| Resolve | Actual locator, stable base/node/owner identity, declaring scope, containment |
| Discover/read | Accepted-state entry point, selective retrieval, credentials source, freshness signal |
| Capture | Source identity, note versions/hashes, bounded record content and provenance |
| Propose | Checkpoint input, frozen destinations, write surface, content screen before anything leaves the host, a second delivery of the same proposal refused |
| Judge/write | Native read and author tools; allowed targets; supersession and duplicate prevention |
| Validate | Representation validator and semantic checks; whole-base/link namespace where relevant |
| Deliver and review | Durable proposal, the reviewer's accept/reject/amend, applied update, no-change, failure and uncertainty signals |
| Inspect/refresh | What readers see, accepted versus pending, retry/recovery and receipts |

## Concrete custody distinctions

| Store | Read baseline | Writer and acceptance |
|---|---|---|
| Embedded Git OKF | Accepted ref plus contained bundle root | Accepted-baseline clone apart from the feature branch; knowledge-only PR the reviewer merges |
| Dedicated Git OKF | Accepted ref of knowledge repository | Same PR-only rule; separate repository does not make it non-Git |
| Directory OKF | Configured directory's confirmed current contents | Staging, baseline checks, coordinated/crash-recoverable native publication; no review phase, so `oats.okf` 6 delivers no proposals to it |
| Native CLI graph | Verified native query and consistency behavior | Verified native authoring/confirmation; unknown until investigated |

For Git, a PR opened is delivered judgment, not merged knowledge. A failed PR
cannot fall back to a direct accepted-branch write. For non-Git, do not fabricate
branches, commits or PR receipts. A directory backend must actually work outside
Git. Initial cooperative single-host coordination is not a distributed lock.
For OKF, each base is one link namespace; nodes are nonoverlapping owned
subdirectories. A graph uses its own representation validator, not an OKF check.

Omnigraph is a motivating scenario, not a verified integration: obtain a graph
provider's actual command help and guarantees before proposing any command.

See [judgment and proposal](proposal.md) and [acceptance cases](acceptance.md)
for checkpoint execution and delivery/failure probes.
