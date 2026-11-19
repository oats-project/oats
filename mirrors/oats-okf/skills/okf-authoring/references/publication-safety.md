# Publication safety gate

Run `node <okf-authoring skill dir>/scripts/okf-publication.mjs --help` for the
exact flags. This dependency-free helper is shared by the proposer (`oats okf
propose`, in oats.okf) and the maintainer (oats.okf-maintenance).
It is separate from `okf-validate.mjs`: that validator's interface and exit
codes are unchanged, and it checks structure, not content.

## What the gate promises

Every supported create, amendment and merge screens the exact outgoing Git
objects before publication. It checks every introduced commit (including its
headers), changed paths (including empty directory names) and blob versions, not just the final diff. Content
added in an intermediate commit and subsequently deleted still refuses.
The range starts at the **unique merge-base** of the head and the pinned current
accepted tip. The accepted branch may have advanced since the PR opened. Range
screening still checks the full introduced history; it is not permission to
submit a behind head for hosted merge. The fork must belong to accepted history;
unrelated or ambiguous histories refuse with `E_HISTORY`.
Files unchanged from that fork are not resubmitted for publication.

The helper pushes the screened **OID**, never a moving `HEAD`. PR bodies,
commit text and verdict files are read once as bounded regular files; `gh`
receives the screened bytes on stdin, not a path it could reread after a
change. Merge subject/body are fixed safe text, not GitHub's automatic
concatenation of earlier messages. Every maintainer comment/close/merge in the
supported procedure goes through this helper. No naked `git push`, `gh pr
comment`, `gh pr edit`, `gh pr close --comment`, or `gh pr merge` substitutes
for it.

Exit codes: **0** completed the named operation (a submitted merge is not a
verified merge); **1** content refused; **2** invalid, unreadable, unsupported
or incomplete input, changed preconditions, or an operational failure. Every
nonzero result stops publication. There is no ignore/force/skip option and no
environment override. Do not retry around a refusal. A failure after a remote
write can leave a branch, comment or PR: retain the home and exact safe JSON
result and inspect that outcome before any separately authorized recovery.

A refusal reports the rule ID, line and a file/commit location, **never the
matched value or a snippet**. Git blobs and potentially sensitive paths are
identified by commit/object OID and tree-entry ordinal rather than echoing a
filename. Outward files use role labels (`PR body`, `maintainer verdict`).
Git/gh stderr is not copied into reports or notifications.

Limits fail closed: 4 MiB per content object/file, 16 MiB per subprocess
response, 50,000 tree entries/introduced objects, 4,096 outgoing commits,
60 seconds per subprocess; UTF-8 text without NUL only. Shallow history,
grafts, symlinks/submodules newly introduced by the proposal, ambiguous
provenance and unknown options refuse. Native Git selectors are cleared;
replacement refs and grafts refuse, and hooks cannot alter the gate. Configured
Git push options are cleared, not transmitted outside the screened graph. The recorded origin
must match, with no pushurl or clone-local URL rewrite. Host-wide Git routing
continues to apply to the recorded locator. No credentials are copied.

## Uncertain push diagnostics

`E_PUSH_UNCERTAIN` and `E_DELETE_UNCERTAIN` (the branch deletion in
`close-unsafe`) include a `diagnostic` object. The error code, exit **2**,
retained artifacts and no-automatic-retry rule are unchanged. A deletion error
can occur after the PR has already closed; it is not permission to repeat the
close or delete.

```json
{"ok":false,"code":"E_PUSH_UNCERTAIN","diagnostic":{"phase":"push","exitCode":128,"signal":null,"timedOut":false,"elapsedMs":37,"cause":"auth-required"}}
```

The field set is the same in both helper copies:

- `phase`: `push` means the Git push child failed, including a delete push;
  `readback-failed` means the push or delete ran and the remote could not be
  read afterwards; `readback-absent` means a pushed ref was not found afterwards;
  `readback-other` means a pushed ref names an unexpected OID, or a deleted ref
  still exists. That OID is never included in the diagnostic.
- `exitCode`: the push child's integer exit status, or `null` if unavailable.
  A readback mismatch after a successful push reports `0`.
- `signal`: a fixed allowlisted signal name, or `null` when absent/unrecognized.
  The list is `SIGABRT`, `SIGALRM`, `SIGBREAK`, `SIGBUS`, `SIGFPE`, `SIGHUP`,
  `SIGILL`, `SIGINT`, `SIGKILL`, `SIGPIPE`, `SIGQUIT`, `SIGSEGV`, `SIGSYS`,
  `SIGTERM`, `SIGTRAP`, `SIGUSR1`, `SIGUSR2`, `SIGXCPU`, `SIGXFSZ`.
- `timedOut`: whether the push child reported `ETIMEDOUT`.
- `elapsedMs`: nonnegative integer milliseconds spent in the push child, not
  the whole operation or subsequent readback. No process outcome is invented
  when the OS supplied none.
- `cause` (optional): only one constant from the table below, matched
  case-insensitively on failed Git client-side stderr lines. No match means
  the field is absent. Successful-push readback mismatches have no cause.

| Fixed client phrase | `cause` |
| --- | --- |
| `terminal prompts disabled` or `could not read Username` | `auth-required` |
| `Authentication failed` or `Permission denied (publickey)` | `auth-denied` |
| `Could not resolve host` | `host-unresolved` |
| `connection refused` or `connection timed out` | `connection-failed` |

The first matching table row wins. Lines starting with `remote:` or
`fatal: remote error:` are excluded (including leading whitespace and case
variants). Git can also quote remote text in `error: remote unpack failed:`,
remote-status warnings, `unable to parse remote unpack status:` and
`protocol error:` diagnostics. The entire stderr tail starting with these
remote/protocol diagnostics is excluded: their payloads can contain unprefixed
continuation lines or control characters. Stdout is never an input to `cause`.
Push children run under
`LC_ALL=C`; the caller's locale is not changed. Raw stderr/stdout, snippets,
URLs, paths, configuration, identities, tokens and arbitrary error/signal
strings never enter this field. There is no debug or bypass flag.

A cause identifies only a recognized client phrase, not a guaranteed root
cause, successful authentication, absence of transferred objects, or permission
for recovery. Retain and inspect the exact state before a separately authorized
attempt. A public repository can be read anonymously; successful reads do not
establish how credentials reach a push or whether its receive phase will pass.

## Rules, exclusions and limits of detection

Rules live in `scripts/okf-content-screen.mjs`; `RULE_IDS` is the authoritative
inventory. They detect bounded credential/token/private-key shapes,
credential-bearing URLs/assignments, contact emails and phone-shaped numbers.
A name alone, an identifying paraphrase, an arbitrary/encoded credential or
an unanticipated format can evade these rules. Contextual review under the
shared personal-data exclusion remains required. Do not strip ordinary
published-author citations or team decision attribution by inventing a
universal name rule.

Exclusions are reviewed **package code**, never command-line or environment
configuration. Only reserved placeholders (RFC 2606/6761 example domains and
RFC 5737 documentation IPs where relevant), plus noreply addresses in commit
trailers, qualify. A lookalike suffix or a normal contact address does not.
Phone rules must not confuse dates/timestamps, versions, ports, PR/issue
numbers, Git hashes or run IDs with a telephone number.

Before release, run the same screen read-only on the current accepted trees
of the affected bases with `screen-tree`, and report hits per rule as counts
only. Investigate every hit before the tag: fix an overbroad rule or use a
permitted documented code exclusion, not an operator bypass. Real prohibited
accepted content is an exposure incident, not a false positive to allow.

This is a gate on these supported paths, **not a guarantee that every secret
or person's detail is recognized, nor a sandbox**: an agent still has native
credentials and could bypass instructions. CI can repeat the same read-only
screen, but CI runs after a push and cannot prevent the first exposure.

## Read-only checks

Use full commit OIDs, never symbolic refs, for `--base` and `--head`:

```sh
node <skill-dir>/scripts/okf-publication.mjs screen-text --text-file <outward-text-file>
node <skill-dir>/scripts/okf-publication.mjs screen \
  --repo <checkout> --base <accepted-oid> --head <candidate-oid> \
  --text-file <outward-text-file>
node <skill-dir>/scripts/okf-publication.mjs screen-tree \
  --repo <checkout> --head <accepted-oid> --root <bundle-root>
```

`screen` accepts repeated `--text-file`. `screen-tree` checks the whole
selected tree, including navigation/metadata, for accepted-corpus measurement.
Neither writes remote state. `--root` defaults to `.`. A missing root refuses.

`screen-text`, `screen`, `screen-tree`, `commit` and `create` accept an
optional `--terms-file` (oats.okf 6.0: the host setting `screen-terms-file`,
which `oats okf propose` passes): one term per line, matched
case-insensitively in every screened text, file name and ref, reported as rule
`host-term` with its location only. Terms only add refusals; an unreadable
or malformed file is `E_CONTENT_INPUT`, never "no terms".

## The credential the gate uses

By default the helper's `git` and `gh` children use the caller's native
credentials. With `--token-file <absolute path>` (oats.okf 6.2; `oats okf
propose` passes the host's `github-token-file` setting) they are given the
GitHub token in that file: ambient credential helpers are cleared,
inherited token variables and `gh`'s stored login are not consulted, the
host's askpass (`core.askPass`) is switched off, and SSH, `git://` and
plain HTTP are refused (a local repository stays readable). A file that
yields no token is an authentication failure, never another credential. The helper does not isolate Git
from the host's own configuration: a netrc entry for github.com, an
authorization header (`http.extraHeader`) or a URL rewrite (`insteadOf`,
`pushInsteadOf`) in the system or user Git configuration answers before any
credential helper is asked. With a token file, `preflight`, `create`,
`rewrite`, `amend-legacy`, `merge`, `close` and `close-unsafe` therefore look
at the host when they start and refuse `E_HOST_CREDENTIAL` (exit 2,
`diagnostic: { phase: "host", routes, unread }`, fixed kinds and never a
value) when one exists or the system or user Git configuration cannot be
read; nothing was sent by that command. The helper also resets
`http.extraHeader`, unscoped and for `https://github.com/`, for its own Git
children. A host that uses a token file keeps none of
them for github.com. The `preflight` check runs no Git: with a token file
it judges that file's token (`gh` is handed it; the installation route
reads it from the file and does not ask `gh auth token`). The token is read at each use, goes
to `git` through the helper's own `git-credential` mode for
`https://github.com` only and to `gh` in that child's environment, and never
appears in an argument or a result. A missing or malformed file is
`E_CREDENTIAL` with `diagnostic.reason` (`missing`, `unreadable`,
`not-a-file`, `empty`, `malformed`, `path`; `helper-path` when the Node
binary's or this script's own path contains a single quote), exit 2. The
file is checked when a command starts, before anything is sent, and read
again at each use: when it turns unusable later, `create` reports
`published` after its push, and on `rewrite`, `merge` and `close` an
`E_CREDENTIAL` can follow a push or a posted comment.
The gate is still not a sandbox: it does not hide the file from the caller.

## Create

`oats okf propose --apply` runs the exact create sequence. Its local-only `commit`
step snapshots screened commit text (from 6.1 it ends in the proposer's
trailers: `Proposed-by`, and where the home recorded them `Proposer-identity`
and `Attributed-human`), fixes author and committer explicitly
(overriding more-specific Git settings after clearing inherited selectors),
checks the staged tree, and updates only the current new branch with a local
old-head compare-and-swap. No raw commit summary is printed. `create` preserves its
fresh `okf-proposal/<date>-<UUID>` key (a 5.x `okf-harvest/` key with a
version 2 block is still accepted through 6.x), empty expected-old lease and new-ref
confirmation. It never updates an existing ref, even an identical one. The
helper verifies the recorded accepted branch tip before and after screening.
Before its push, `create` makes read-only `gh` calls (first `gh api --hostname github.com
repos/<repo> --jq .permissions.push`; the `preflight --github OWNER/REPO`
command runs the check alone). An explicit `true` passes at once. A missing `gh`, a
failed call or unstated permission, or a credential that may not push
refuses `E_GH_UNAVAILABLE` with a fixed `preflight` diagnostic (`gh-absent`,
`gh-failed`, `no-write-permission`): nothing was pushed. One other route
passes: a GitHub App installation token, for which GitHub reports those
permissions all false or not at all. When the answer is not `true` and `gh
api installation/repositories` succeeds (only an installation token may call
it), the helper puts the write question to GitHub: with gh's token for
github.com (`gh auth token`, read on a pipe) a child with an empty
environment requests the repository's push advertisement
(`info/refs?service=git-receive-pack`), where GitHub authorizes a push.
Nothing is sent and Git takes no part, so no Git configuration, URL rewrite,
netrc, SSH key or other login answers for the installation. The
advertisement passes, a 401, 403 or 404 is `installation-cannot-push`, and a
timeout, an unreachable github.com, a redirect, no token from gh or any
other answer is `installation-check-failed`; the request uses no proxy. Not
yet run with a real installation token. Every call of the check names
github.com (`--hostname`), so `GH_HOST` cannot split it across two
credentials. On both routes it is gh's credential that is judged (the
token file's, when one is named), not the one Git uses for the base's remote. For an installation it proves contents
write only, not the pull-requests and issues write the PR and its label
need. It cannot tell
whether a narrowly scoped token may open a PR. A failure after the confirmed
push carries `published: { branch, head }`.

A base that moved before the push is recovered inside `create`, at most three
times: it fetches the accepted branch (writing no local ref but the CAS
below), requires a fast-forward, reconciles the PR's delta onto the new tip
as `rewrite` does, commits it with the original message, moves the local
branch by compare-and-swap and screens the new range again before pushing.
The result names `base` (the tip the PR is parented on) and `recovered`.
Exhausted retries, a conflict, a non-fast-forward tip, nothing left to
publish or a failed fetch refuse `E_BASE_MOVED` with a fixed `recover`
diagnostic. An independent remote base can still move after the last check,
so this is not an atomic lock of the whole forge. The helper rechecks
after label creation and reads back the new PR's identity/head before reporting
success. GitHub create/close have no atomic head predicate: movement detected
after a write is `E_PR_UNCERTAIN`, not success or a promise of zero effects.
Read-check-write cannot prevent every independent writer race; inspect partial
outcomes instead of replaying them.

## Amend, then review the new head

For provenance **v3** (an `okf-proposal` PR) and **v2** (a 5.x `okf-harvest`
PR), stage your sanitized PR changes in the old PR checkout,
run whole-base structural validation, and use `rewrite` with `--head` equal to
the exact old PR head and `--base` equal to the fetched current accepted tip.
The helper derives the PR's delta from its unique fork and reconciles that delta
with the **current accepted tree** in a private index. Independent accepted
additions, edits and deletions survive; an old full checkout is never simply
reparented on a newer accepted commit. Three-way text merging uses Git's
longstanding `merge-file` plumbing, not new Git version-dependent flags. This
constructs an explicit replacement for review, not a prediction of hosted merge
semantics (attributes, rename handling and algorithms can differ). The
maintainer's working tree/index entries stay unchanged. The replacement PR body
(`--body-file`) keeps the PR's own provenance version: a v3 PR keeps its
`okf-proposal` block, a v2 PR its `okf-harvest` block; the other version
refuses `E_PROVENANCE`.

The reconciled tree becomes **one new commit parented on the current accepted
tip**, not the old PR head. The gate screens its actual bytes before replacing
the branch with an exact old-head lease. Conflicting edits, add/add or
modify/delete cases and file/directory collisions refuse with
`E_REWRITE_CONFLICT`, before publication; explicit empty-subtree deltas also
refuse instead of being silently dropped by the private index. There is no
force-resolution flag.
Review/drop the conflicting change, or close for re-proposal against the
current base when the original delta cannot be reconciled safely. It never
merges as part of rewriting. It returns the new OID; fetch/check out that OID,
verify the remote ref and parent, validate the
reconciled whole base, repeat the review against current accepted knowledge,
and compare the sanitized delta with the previously reviewed head using
`git range-diff <old-fork>..<old-head> <current-accepted-tip>..<new-head>`.
Keep that comparison local; never republish its rejected lines in a verdict.
Write a new `okf-review` verdict naming the returned new head SHA. An earlier verdict never
carries to a rewrite. A new clone of that branch must not reach removed
branch-only objects. Do not create backup refs for rejected content.

Common write flags are `--repo <checkout> --remote <recorded-clone-locator>
--github <owner/repo> --base <accepted-oid> --base-branch <accepted-branch>
--head <reviewed-old-oid> --pr <number>`. `rewrite` additionally requires
`--commit-file <safe-message-file> --body-file <safe-PR-body-file>`.

For **v1/4.x**, the ancestry promise remains. `amend-legacy` takes the same
flags but permits only additions; it parents the new commit on the delivered
head. If content must be removed, **close and delete the PR branch** using
`close-unsafe`, never an append-only sanitization or rewrite. Even a safe
textual deletion refuses in `amend-legacy`; close/re-propose instead. If the
current accepted tip is not an ancestor of a legacy PR head, both `merge` and
`amend-legacy` refuse with `E_REWRITE_REQUIRED`. Close it for re-proposal (a v3 PR);
never reparent or append a catch-up commit to bypass the legacy ancestry rule.

## Verdict and settlement

`merge`, `close`, and `close-unsafe` take the common write flags plus
`--verdict-file <file>`. The file must contain one `okf-review` block naming
that exact head and the appropriate verdict (`merge`/`amend+merge`, or
`close`). `merge` verifies the pinned current accepted tip and requires it to
be an ancestor of the reviewed head. A behind/divergent PR refuses with
`E_REWRITE_REQUIRED` (operational exit 2) before comment or merge. For v3 or v2, use
`rewrite` against the current tip, review the actual returned replacement tree,
and bind a fresh verdict to that head; legacy closes for re-proposal. Never
reuse a stale base OID or an earlier verdict to bypass the refusal.

Only then does `merge` screen the live PR title/body and introduced history,
recheck the accepted tip and the exact screened head tree, post the screened
verdict, and submit a squash merge with `--match-head-commit`. An accepted tip
that advances after rewrite refuses again with `E_REWRITE_REQUIRED`; there is
no automatic recompose/retry. The ancestor condition means the squash result
tree equals the screened head tree, rather than a new divergent composition.
The checked ancestry avoids relying on an approximate local three-way tree as
the screen for a different hosted squash. The helper
is not certifying hosted merge semantics, and the accepted-tip check is not
atomic with the hosted merge. Serialize accepted-branch merges for each base
through one maintainer; do not run concurrent merge writers. This is an
operational requirement, not a lock enforced by the helper: an out-of-band
writer can still enter the residual window after the final check. A base that
moves during an operation requires a fresh read/review, not an automatic retry.
The helper supplies its own safe merge text. Read back the PR's merged state
before reporting acceptance; a queue/submission is not a merge.

`close` publishes only the screened close verdict and closes without merging.
`close-unsafe` also deletes only the reviewed branch, with an explicit old-head
lease and a remote absence check. Another writer moving that branch causes a
refusal, never an unconditional delete. An already-unsafe existing ref name is
validated as a cleanup target without treating it as permission to publish a
new ref; its bytes are not echoed. Close reads back state/head before reporting
success (or deleting). This detects some races but is not an atomic head-bound
GitHub close. Cross-repository/fork PRs refuse these
write helpers; route them to the repository owner.

**Branch cleanup does not erase exposure.** GitHub's `refs/pull/N/head`, old
review diffs, caches, forks and clones can retain prior content. For real
exposure, privately give the authorized maintainer locations only; route
credential rotation and, when warranted, GitHub Support's cached/ref removal.
Never paste the data into the verdict, issue, message or task note. Failure
notifications use screened safe diagnostics and opaque artifact roles, not
absolute home/artifact paths; arbitrary notifier stdout/stderr is discarded. If rejected
content already belongs to accepted history, this PR rewrite cannot remove
that ancestor; stop and route it instead of claiming erasure. No automatic
accepted-history rewrite, credential change or platform cleanup is authorized.
