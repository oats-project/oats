---
name: okf-consultation
description: >-
  Consulting your soul's knowledge with the `oats okf` CLI: reading its
  external OKF bases remotely at the accepted commit (index, cat, ls, links,
  search, bases, and on a base with the subject layout subjects, subject,
  claims and verdicts) with no local copy, then citing what you relied on. Use when
  starting a task or resuming after compaction, when looking up a prior
  decision, lesson or concept, when asked "what do we know about X" or to
  "check the knowledge base", before re-deriving a design decision, when a
  question touches your domain, or when an `oats okf` receipt says STALE or a
  command errors. What to write in your own notes is the okf-instance-knowledge
  skill.
---

# Consulting your knowledge with `oats okf`

Your soul's accumulated judgment — decisions and their rationale, lessons,
rejected alternatives, limits — lives outside the soul, in external OKF
**bases**. You read it remotely; nothing is copied into your home. Consulting
it before you act is how you avoid re-deciding what was already decided.

## The model

- **Base / alias.** Each bound base has an alias (`oats okf bases` lists
  them). A base is one OKF bundle and one link namespace.
- **Node.** A subdirectory of a base with its own `index.md`. Your soul
  **owns** some nodes (you are responsible for them) and **reads** others
  (starting context). Neither is an access list: every bound base is readable.
- **Subject** (a base with the subject layout, oats.okf 6.0). Something the
  knowledge is about: a `system`, a `workstream` or a `project`, referenced
  as `<kind>/<slug>`. Each claim lists its subjects in `about:`, and each
  subject has a generated index of its claims by type. A soul with
  `okf.json` version 2 declares **subjects** (reading defaults) instead of
  nodes; the spawn brief lists them.
- **Accepted commit.** `oats okf` serves only a base's accepted state: the
  accepted branch of a Git base, the in-place files of a directory base. An
  open PR is not accepted knowledge until it is merged.
- **Host cache, no local copy.** A Git base is read from one host-wide cache
  that fetches file contents on first read. Your home has no `./knowledge/`
  and no view directory. A `./knowledge/` left by okf 2.x is stale; ignore it.
- **Receipts.** Every answer ends with `— alias@<short-oid> (fetched <age>)`.
  With `--json`, the result carries `receipt: {base, kind, commit|digest,
  fetchedAt, stale}`.

Run every command from your instance home.

## At the start of every task, and after compaction

1. `oats okf index` prints your owned then read nodes' indexes, each headed
   `## alias/node (owns|reads)`; for a soul that declares subjects, its
   subjects' generated indexes, each headed `## alias/<kind>/<slug> (subject)`.
2. Choose the entries relevant to *this* task by their one-line descriptions.
3. `oats okf cat --base ALIAS /node/path.md` for each of those, and follow
   their links only as far as the task needs (see Navigating).
4. Write down in STATE.md which concepts shaped your plan, with their
   citations.

For a soul that declares subjects, the walk is: index of your subjects →
subject pages (`oats okf subject <kind>/<slug>`: what it is, its legacy
nodes, the systems and projects in a workstream, claim counts) → claims
(`oats okf claims --about <kind>/<slug> --type Decision`) → bodies (`cat`).
Reach a neighbouring subject the same way when the task touches it;
`oats okf subjects` lists them all.

Do not skip this because the task looks small: prior decisions are cheapest
to find before you have written the code that contradicts them.

## Consult again while working

The start-of-task read is not enough. Consult again:

- **Before a design decision.** Search for the decision's subject, and read
  any prior decision on it before choosing.
- **Before re-deriving something.** If you are about to work out why
  something is the way it is, search first; the rationale may be recorded.
- **When a question touches your domain**, including a teammate's question.
- **Before saying "we decided…" or "we tried…"**: cite it, or don't claim it.
- **When something surprises you.** A lesson may already explain it.

## Commands

| Command | What it answers |
| --- | --- |
| `oats okf bases [--fresh]` | aliases, accepted commit, freshness, validity, your owns/reads |
| `oats okf index [--base A] [NODE \| A/NODE]` | one node's `index.md`; no args: all your nodes; `--base A` alone: the base root index |
| `oats okf cat --base A PATH [--from P]` | one Markdown file, in full |
| `oats okf ls --base A [DIR]` | directory entries, each concept's `type` / `title` / `description` |
| `oats okf links --base A PATH` | the file's outgoing links, resolved, `ok` / `MISSING` / `REFUSED` / `external` |
| `oats okf search [--base A \| --all] [--node N] [--regex] [--case-sensitive] TEXT` | matching lines `{base, path, line, snippet}` |
| `oats okf subjects [--kind K]` | the subjects of a base with the subject layout, one line each |
| `oats okf subject KIND/SLUG` | the subject's file, legacy nodes, workstreams or members, claim counts by type |
| `oats okf claims --about KIND/SLUG [--type T] [--kind K]` | the subject's claims, path, type, title and description each |
| `oats okf index KIND/SLUG` | one subject's generated index |
| `oats okf verdicts --check FILE` | before proposing a claim: a rejected id refuses (`E_VERDICT`); an exact title-hash hit is a candidate |

All take `--json`. The subject verbs read one committed generated index
each and answer `E_USAGE: base <alias> has no subject layout` on a plain
base; with several bound bases pass `--base`. A `W_INDEX_STALE` warning
means the base's generated indexes lag its claims: the answer is the
committed index as it is; say so when it matters (the maintainer
regenerates). `read` (the okf 2.x spelling of `cat`) is removed in 4.0.0
(`E_REMOVED`): use `cat`.

## Navigating

Paths resolve like OKF links, **from the base root, not the filesystem**:

- `/node/decisions/x.md` is base-root absolute (the usual form in indexes'
  absolute links and in citations);
- a relative link (`../lessons/y.md`, `decisions/x.md`) is relative to the file
  it appeared in: pass that file as `--from`;
- a bare `node/x.md` without `--from` resolves from the root.

Worked example (a lesson linked from a decision):

```sh
oats okf index expert
oats okf cat --base project /expert/decisions/retry-policy.md
oats okf links --base project /expert/decisions/retry-policy.md
oats okf cat --base project ../lessons/storm.md --from /expert/decisions/retry-policy.md
```

`links` shows every target already resolved, so you can `cat` the resolved
path directly. `ls` is for choosing what to read from its descriptions, not
for reading everything.

## Searching

`oats okf search TEXT` searches your nodes' bases (fixed string,
case-insensitive, Markdown only), capped at 50 hits with "and N more". Narrow
with `--node`, a longer phrase or `--base`; widen with `--all`. Search finds
words, not meaning: when it finds nothing, try a synonym, then navigate from
the index. A hit is a pointer: `cat` the concept before relying on it.

## Citing

Cite what you relied on as `alias/node/concept.md@<short-oid>`, using the oid
from the receipt line (a directory base cites `alias@dir:<digest>`). The subject layout changes no citation: a claim keeps its path. Cite in
STATE.md, notes/, PR descriptions and answers, so a reader knows which
accepted state you saw.

## Freshness

Reads use the cached accepted commit while it is younger than the
`consult-max-age` setting (default 300 s); after that the accepted branch is
refetched first. `--fresh` refetches now (for example right after a PR
merged). If a fetch fails, the last fetched accepted commit is still served,
marked `stale: true` / `STALE:` with the reason: say so when it matters. With
nothing cached and no network, the command fails with `E_BASE_UNAVAILABLE`:
report it, and do not answer from memory or from an old `./knowledge/`.

## Gotchas

- Links resolve from the base root. `/node/x.md` is never a filesystem path,
  and filesystem paths, `..` escapes, URLs, hidden paths and symlinks are
  refused (`E_PATH`).
- Never bulk-`cat` a whole node or loop `cat` over `ls` output. Index first,
  then follow the few relevant links.
- Don't edit knowledge: accepted knowledge changes only through a reviewed
  PR. Write insights to notes/ (the okf-instance-knowledge skill), not into a
  base.
- `oats okf refresh` and `read` are gone (`E_REMOVED`): every read already sees the
  accepted state.
- `cat` reads `.md` files only (`E_NOT_MARKDOWN` otherwise); `E_NOT_FOUND`
  lists the nearest directory's entries to try instead.

Read [references/consult.md](references/consult.md) for more search examples,
the error table and freshness edge cases.
