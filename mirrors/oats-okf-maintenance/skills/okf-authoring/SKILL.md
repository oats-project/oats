---
name: okf-authoring
description: >-
  Open Knowledge Format (OKF) authoring craft for proposing instances and the
  knowledge maintainer:
  how to write, edit, move and validate concepts in an OKF bundle (markdown
  concepts with YAML frontmatter, per Google Cloud's OKF v0.1 spec), keep
  index.md and log.md honest, supersede instead of silently rewriting, and run
  the bundled validator. Use when staging or amending concepts in a knowledge
  base, fixing index/log entries, reviewing a knowledge PR's Markdown, or when
  asked to validate a bundle. Promotion judgment (what belongs in a base) is
  the knowledge-theory skill.
---

# OKF craft — author, maintain, consume

An OKF **bundle** is a directory tree of markdown files. Each non-reserved `.md`
file is **one concept**; links between files form the knowledge graph. No
database, no SDK — plain git-versionable text. Spec: OKF v0.1 (Google Cloud).
An external base is one bundle and link namespace. Owned nodes are
nonoverlapping subdirectories, not separate root-link namespaces. Instance
`notes/` files are task-local concepts; no knowledge lives in the soul.

## The format in one screen

- **Concept = one file.** Concept ID = path minus `.md`. Small and specific
  beats long and general — split rather than grow.
- **Frontmatter** (`---` delimited): only **`type`** is required (short,
  freeform — the spec ships no vocabulary. Fleet core: `Lesson`, `Decision`,
  `Playbook`, `Reference`; souls also grow role-specific types like
  `Area Guide` or `Roadmap` — see the knowledge-theory skill for routing).
  Recommended,
  in order: `title`, `description` (ONE sentence — it's what index listings
  and skimming agents see), `resource` (URI, only if a real asset backs the
  concept), `tags` (YAML list), `timestamp` (ISO date of last meaningful change).
- **Links** are ordinary markdown, keep the `.md`, prefer bundle-root-absolute:
  `[clearing playbook](/node/playbooks/clearing-fields.md)`. Links are untyped
  directed edges; the surrounding prose carries the relationship's meaning.
- **Reserved files** at any level: `index.md` (navigation) and `log.md`
  (history). They carry **no `type`**; only the bundle-root `index.md` may
  have frontmatter, and only `okf_version: "0.1"`.
- **Conventional headings** when applicable: `# Schema`, `# Examples`,
  `# Citations` (numbered external sources backing claims).

## Honesty rules (non-negotiable)

- **Never invent** a `resource`, `timestamp`, or `description` — leave a field
  out rather than guess it.
- Every claim you write down should be something you verified or observed;
  cite sources under `# Citations` when the claim came from outside.
- Never create a link to a concept you didn't create or verify exists —
  except deliberate not-yet-written knowledge, which is allowed by spec but
  should be rare and intentional.
- **Supersede, don't silently rewrite.** When a concept's meaning changes,
  update it AND log the change; when it's wrong, correct it and say so in
  log.md (`**Fix**: …`). History must stay reconstructible.

## Maintaining a bundle

**Adding a concept:**
1. Write the file in the right section dir with valid frontmatter.
2. Link it to/from related concepts (edit those files' bodies).
3. Add a line to the section's `index.md`: `* [Title](file.md) - description`.
4. Append to the bundle's `log.md` (see conventions below).

**Renaming/moving a concept:** update **every inbound link** — search the
whole bundle for the old path (`grep -rn "old-name.md" <bundle>`) — EXCEPT
links inside historical `log.md` entries: never rewrite log history; dangling
links there are expected.

**Removing:** delete the file, remove its index.md line, fix inbound links,
log a `**Removal**` or `**Deprecation**` entry saying why.

**log.md conventions** (newest first, `## YYYY-MM-DD` headings):
`* **Creation|Update|Removal|Fix|Deprecation|Harvest|Triage**: prose with
[links](/path.md).` One line per event; the bold word makes logs greppable.

**index.md discipline:** every concept reachable from an index; descriptions
in listings match the concept's frontmatter `description`. Indexes are
navigation, not content — keep them to listings.

## Consuming a bundle (answering from knowledge)

1. **Index-first, always.** Start at the root `index.md`; follow only links
   relevant to the question. Never bulk-read a bundle — progressive
   disclosure is the point of the format.
2. Frontmatter (`type`, `tags`, `description`) is the quick filter layer;
   open bodies only for concepts that survive the filter.
3. `log.md` answers "what changed recently" — check it when freshness matters.
4. Cite concepts by path when reporting answers.
5. Tolerate imperfect concepts: unknown types and stale links are
   never a reason to reject or ignore a bundle — that permissiveness is spec.

## Validating

Run the bundled validator (node, no deps) after non-trivial maintenance:

```bash
node <skill-dir>/scripts/okf-validate.mjs <bundle-dir>            # conformance
node <skill-dir>/scripts/okf-validate.mjs <bundle-dir> --strict   # + producer lints
```

- **Conformance errors** (must fix): unparseable/missing frontmatter, missing
  or empty `type`, reserved files carrying a `type`.
- **Producer lints** (`--strict`, should fix in bundles you produce): broken
  intra-bundle links (log.md exempt), links missing `.md`, concepts
  unreachable from any index.md, missing `title`/`description`.

Lints in a bundle you're *consuming* are noise — read on regardless.

## The subject layout (bridged bases, oats.okf 6.0)

A base whose `okf-base.json` lists the reserved nodes `claims`, `subjects`
and `verdicts` (each at its own path, owned by the sentinel
`00000000-0000-0000-0000-000000000000`) is read by subject. There, in
addition:

- **Every claim and document carries `about: [<kind>/<slug>, ...]`**, one or
  more subjects that have a file `subjects/<kind>/<slug>.md`; `kind:` where
  its type has kinds (`Lesson` → `lesson`, `Conclusion` → `finding`,
  `Limitation` → `constraint`, `Roadmap` → `direction`); and a stable
  `id:`. Ids are stamped by the knowledge maintainer at acceptance, never by
  a proposer; a claim under `claims/` without one does not validate, an
  old-node claim without one is a `--strict` warning. A claim that proposes
  again what a verdict rejected says so with `reconsiders: <id>`.
- **Subjects** are `subjects/<system|workstream|project>/<slug>.md` with
  `type: System | Workstream | Project`; `legacy-nodes: [...]` names the old
  per-soul nodes a subject absorbs. Workstreams are structure and change only
  on a person's cited acceptance.
- **Verdicts** are `verdicts/<id>.md`, `type: Verdict`, written only by the
  maintainer (fields in the README's "The subject layout").
- Frontmatter stays flat: scalars and flow lists `[a, "b"]`.
- **The indexes under `subjects/`, `verdicts/index.md` and the root
  `index.md`'s `## Subjects` section are generated.** Never edit them by
  hand: run the regenerator after any change, and commit what it writes.

```bash
node <skill-dir>/scripts/okf-reindex.mjs <bundle-dir>           # write the generated indexes
node <skill-dir>/scripts/okf-reindex.mjs <bundle-dir> --check   # exit 1 when stale
```

On such a base the validator also refuses a missing, empty or unknown
`about`, a misplaced or mistyped subject or verdict, a duplicate `id`, and
(with `--strict`) a generated index that differs from the regenerator's
output. A base on the accepted branch with a `--strict` warning is invalid for
every 6.0 reader, so regenerate and validate the whole base before a merge.

## Screening and publication

Structural validation is not a content screen. Before publishing, read
[publication safety](references/publication-safety.md) and use the bundled
`scripts/okf-publication.mjs` gate. It screens exact Git objects and outward
text bytes before push/comment/merge, with code-only exclusions and no bypass.
It is a bounded detector, not a universal privacy guarantee. Contextual review
still applies. A v2 amendment rebuilds a clean head from the accepted base,
uses an exact old-head lease, and requires a fresh head-bound verdict. Legacy
v1 removals close/delete the branch and route remaining exposure privately.

## Portable source and store declarations

When the portable binding interface is active (planned OATS >=0.24.0; not yet a
published provider baseline), treat the source declaration as policy and the
captured ProviderBinding as execution authority:

- In `oats.okf.locations@1`, `fixed` is source-owned, `default` is rebindable,
  and `inherit` requires an external binding such as `write.default`.
- Qualify every read and owned node by its declared store. A read grants no
  write authority. Never infer the sole readable store as a destination.
- Workspace store envelopes put concrete provider choices under
  `payload.bindings`. Workspace, adoption, and operator values remain separate
  inputs to the shared resolver; OKF does not select their precedence.
- Durable placement is explicit selected settings: physical absolute
  `bindings-file` and `state-dir`, plus optional `git-timeout` (seconds for
  remote Git operations, default 600). Never derive state from an instance
  home.
- Provider codecs run only after exact retained executable approval. Their
  populated binding is not proof of readiness, enrollment, credentials, privacy
  or publication authority. Respect typed non-ready results.
- oats.okf 6 keeps no source descriptors, captured custody or harvest
  workers, and no harvest soul: the instance proposes its knowledge at checkpoints with
  `oats okf propose`, which opens a reviewed PR. No source gets a scheduler
  job.
- Captured `setup`, `init`, `migrate`, and `unlock` are deliberate refusals.
  Provisioning/migration remains a separate explicit operator path.

The broker-owned `binding-normalize`, `binding-bind`, and `binding-check`
manifest commands are not manual recipes. Do not invoke them from a working
agent or copy a transient `OATS_BINDING_FILE` path. That private mode-0600
file exists only for one synchronous invocation.

## External bases and native tools

A proposing instance edits only its owned nodes and the base root
`index.md`, in the clone `oats okf propose --plan` made of the accepted base.
A maintainer amends a PR branch in its own checkout. Either way,
validate the WHOLE base with `--strict`, not an isolated node: absolute
Markdown links can cross node boundaries. Publish nothing that has errors or
producer warnings.
