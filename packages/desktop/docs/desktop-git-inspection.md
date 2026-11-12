# Desktop instance Git inspection

The selected terminal's Developer tab (Git and GitHub) is a read-only consumer of the
installed OATS CLI's **instanceGitApi 1** contract. GitHub/PR/check/review data is
not part of K1: it uses the separate [forge Connections boundary](desktop-forge-connections.md).
K1 supplies routing metadata only, never forge facts. No Git command,
filesystem diff reader, kernel import, editor action, terminal mutation or
acquisition/trust operation is implemented in this view.

## Security-relevant retirement of the background reader

**Desktop Git reads = K1 route only.** The former roster collector's `gitState`
and its unused status/diff parsers are removed, not hardened or retained as a
fallback. That path ran Git against every instance's tree on every background
roster collection without disabling repository-configured helpers—the same
security defect class as the original K1 external-helper finding. It also
substituted healthy-looking `0/0` divergence and zero-change aggregates when reads
failed.

Local roster collection now explicitly sets `git: null`, overriding any stale
or forged `instance.json` aggregate. No renderer consumes the legacy aggregate;
unknown/unavailable Git is visibly unknown, never clean or zero. Remote legacy
projection stays inert for compatibility and is not promoted into a K1
observation. The installed-CLI route is on-demand, helper-free and
truthful about unavailable and unknown facts.

## Admission and execution

One route: **POST `/api/instance-git?ws=<workspace-id>`**. Exactly one nonempty
`ws`, no other query keys. The server-wide credential check and the loopback Host and POST Origin guards run
before parsing/lookup. Main's API proxy pins this instance-addressed route to an
advertised workspace. JSON must be an object, bounded to 64 KiB of UTF-8 bytes.

Observation body:

```json
{"action":"git","selector":{"instance":"dev-1","agent":"dev","agentsRoot":"/team/agents","server":null}}
```

Diff adds only `fileId`, `revision` and **`indexRevision`**, all required. The
file ID is the opaque 24-hex value reported by the CLI; a path is never accepted.
Selectors must match exactly one record in the named workspace's own cached
roster. Agent distinguishes same-root same-name homes; server distinguishes
hosts. Missing or duplicate matches refuse. An absent workspace snapshot does
not use the first workspace and does not synchronously collect Git.

The local deployment reader overwrites metadata-supplied instance name/home
with directory-derived values; the panel collector supplies the owning agents
root. Only this server record's home and the admitted server scope reach the
CLI. Renderer-supplied `home`, `cwd`, `worktree`, `repo`, `context`, `bin`, `env`,
`argv`, arbitrary query keys or diff paths are rejected, not normalized into
accepted authority.

Fixed argv:

```text
instance git  <resolved-name> --dir <server-scope> --home <resolved-home> --json
instance diff <resolved-name> --dir <server-scope> --home <resolved-home> \
  --file <opaque-id> --revision <revision> --index-revision <fingerprint> --json
```

The executable is the discovered accepted absolute CLI binary. `cwd` is the
server scope; execution uses `shell:false`, a 15-second timeout and 4 MiB output
bound. Success on a failed process exit is refused. Equal in-flight reads
coalesce by invoker, binary/version, workspace/scope, complete target, action,
file ID and revisions. At most four distinct reads run concurrently across the
boundary; excess reads report busy. Successes and failures release their flight.
There is **no persistent response cache** and no command polling from this view.

The CLI floor is released **0.24.7** within Desktop's accepted compatibility
band. A version floor does not substitute for DTO negotiation: responses must
validate as `instanceGitApi: 1`. Missing/unknown commands, unsupported captured
selectors, invalid envelopes and command failures remain unavailable. A remote
row's Git and diff are read on its own machine (`instance git|diff NAME --server
S --home H`), never from a local path; remote rows follow
[desktop-deployment-model.md](desktop-deployment-model.md#remote-rows).

## Response and refusal semantics

The Desktop wrapper has `instanceGitApi:1`, `minimumVersion`, a server-derived
`target` (including workspace/name/agent/root/home/server), `status`, `data` and
`reason`. `status` is `available`, `unavailable` or `stale`. Unavailable/stale
responses have null data and a stable code/message. An unresolved target is
null and cannot authorize a read. Successful Git envelopes also carry an opaque
`observationKey` for the separate forge read. Raw `remote.url` is never included
in renderer data; a presence-gated private projection supplies forge routing.

The boundary verifies the observation's home/name/agent, revision/fingerprint,
nullable comparisons, file kinds/IDs and counts. Diff verifies ID, both revisions,
captured-OID `against` (or `empty` for untracked), byte limits and the producer's
`readOnly:{helpers:"disabled",optionalLocks:"off",objectsWritten:0}` declaration.
This is a contract statement, not a new trust/signature badge. The renderer also
checks target, worktree and selected file/path identity before painting.

Important codes include `E_BAD_ARGS`, `E_WORKSPACE_UNKNOWN`,
`E_SESSION_UNKNOWN`, `E_AMBIGUOUS_INSTANCE`, `E_HOME_MISMATCH`,
`E_NO_WORKTREE`, `cli-unavailable`, `cli-no-instance-git`,
`unsupported-remote-operation`, `unsupported-action`, `E_GIT_BUSY`,
`E_CLI_TIMEOUT`, `E_CLI_OUTPUT_LIMIT`, `E_CLI_PROTOCOL` and
`E_STALE_OBSERVATION`. Raw stderr, stacks, arbitrary child messages and unknown
error details are never sent to the view. Only a validated current observation
from a stale refusal is preserved; it is diagnostic, not a replacement patch.

The view renders `E_NO_WORKTREE` as the calm "No Git for this instance" state
only when the roster's work mode is `directory` or `workspace` (no work tree by
design); its sentence names that mode. For any other mode (a worktree, checkout
or attached instance whose tree is gone, or an unknown mode) it is a failure
like every other refusal: red, with the kernel's message, its code behind
**Details** and Refresh.

The branch card's subline carries the two comparisons, labelled apart so they
cannot be confused: the base distance (`↑6 from main`, `up to date with main`)
and, when the kernel reports an upstream, the upstream one (`↑2 unpushed`,
`↓1 behind upstream`, `pushed` at an observed 0/0). An unknown upstream shows
nothing. A healthy read shows no **Details**; of the kernel's `notes` (plain
strings, no codes) only "no upstream configured…" is hidden, matched on its
prefix, because it is true of every agent branch. The others stay as muted lines:
"line counts unavailable…" under Changes, the rest (e.g. "no default branch
found…") under the branch card.

Stale diff selection clears the patch and starts a newly owned observation.
The user must select again. Neither an old patch nor an automatically rebound
file selection may be rendered. Null upstream/base comparisons stay unknown;
zero means observed zero only. The UI never derives PRs, commit/check status,
line totals, file authorship or lifecycle state from the patch.

## Ownership and verification

The controller is active only for the foreground terminal's visible Developer tab.
Context epoch, global workspace generation and separate observation/file tickets
guard success and rejection. Collapse, focus mode, stage cover, selection change
and disposal revoke old controls. Identical roster updates preserve DOM/focus
without another command. Projection-owned focus recovery cannot compete with a
new terminal-open intent; actual pointer/keyboard entry still can.

Tests use inert DTOs, fake `execFile`, source-extracted real HTTP/shell callbacks
and DOM/CSSOM. They cover scope/selector forgery, Host/Origin, byte limits,
coalescing/cap, degraded CLI states, stale races (mutation-checked), literal
hostile paths/patches and three-theme computed-token contrast. No GUI, operator
backend, live model, real terminal or native renderer acceptance is implied.

## Per-file line counts

Each status `files[]` entry keeps the kernel's `additions` and `deletions`
(non-negative integers, or `null` for unknown: binary, untracked and submodule
entries) and `binary` (boolean or `null`). `null` is unknown, never zero. The
keys are absent on older kernels, and a malformed count refuses the observation.
The diff selection keeps its identity fields only.
