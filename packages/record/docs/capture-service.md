# Capture algorithms and recovery

The record package owns source cursors, journal validation, indexing and capture
status. Ordinary/source-selected capture and explicit retry use the fixed
supervised worker. Explicit hooks launch a detached supervisor. Setup migrates
supported service definitions through the preflight/apply gate described below;
the package also owns offline installation/receipt/issue diagnosis. Root
registration and real-manager qualification remain separate. Deployment doctor
delegates to the package diagnosis through the bounded command boundary below.

The integration described below is service A, which ships in the next release
after 0.61.0; source and fake manager fixtures do not establish real manager
qualification. OATS 0.56.0 through 0.61.0 shipped without the bounded periodic
service. See
[capture service release order](../../../docs/upgrading.md#capture-service-release-order)
for the distinction between upgrading those releases and a future setup
conversion after installing a release that ships service A.

## Input contract

Input logs are append-only: capture reads added content, rereads on replacement,
shrink or checkpoint mismatch, cannot see arbitrary edits to an already-read
prefix that leave those checks intact, and `capture --reset-cursors` is the
remedy. This assumption applies to aweb logs and cc/pi/codex transcripts. It
relies on the native writers appending to existing transcript files.

The background cursor qualifies file identity, size, modification/change times
and a SHA-256 witness of at most 4 KiB before its byte boundary. An unchanged
version needs no historical content scan. Growth with the same identity and
witness resumes from the boundary. The witness does **not** prove that the
unobserved prefix is untouched. Explicit `captureCommLog` and
`captureInteractionLog` library calls retain their full-reprojection default.

A complete aweb entry refused by projection is counted when encountered and
consumed; later unchanged passes do not retry it. Use
`capture --reset-cursors --source aw` to request another projection attempt.
Malformed complete lines are similarly skipped once per scan. Unfinished final
lines keep their boundary for later growth; source read errors and failed durable
appends do not become successful consumed checkpoints.

Detected changes have two outcomes:

- Aweb logs reproject from the beginning. Persistent journal IDs suppress
  already captured turns; changed projected content adds a different turn once.
  Replay does not retract an earlier turn.
- Native transcripts compare their captured positional prefix against a private
  staged snapshot before any append from that input. Equal content, including
  under a new file identity, resumes at the captured boundary. A conflict sets
  the input aside with source, path, line, byte offset and reason. Other inputs
  can continue. This preserves rollback: older writers recover their offsets
  from the physical last transcript turn, so appending a revised earlier line
  would make those writers duplicate the remaining history.

Protected command prefix-conflict diagnostics name the refused input, conflicting stream
and native line/source byte position. They say "establishing source path
unavailable": the journal records native session and line, not that path.
Current discovery and derived cursors cannot supply missing provenance, and a
prefix mismatch does not itself prove that a second source exists. Native stream
identity and traversal precedence remain unchanged.
Ordinary supervised passes report confirmed appended counts and the worker
outcome; `capture --health` supplies active set-aside locations and remedies.

## Operator recovery

`turn-record capture --reset-cursors [--source aw|cc|pi|codex]` uses the selected
`--root` and `--owner` (or their existing environment defaults). Omit `--source`
to select all four. It takes the capture lock nonblockingly, atomically commits
source reset generations, then exits **without a capture pass**. The next pass
reprocesses those sources, including when a source cursor was lost. Sources,
journals, journal-ID lookup, journal-validation checkpoints, the search index,
ignore rules, tombstones and active set-aside entries are preserved. Held or
unknown locks, invalid arguments and failed writes refuse success.

For a conflicting native prefix, either:

1. Restore the captured prefix and run `turn-record capture --retry-set-aside`.
   Retry rechecks the prefix; it never authorizes a changed one.
2. Add the source path or session ID to `<root>/ignore`. **Later turns from that
   session will not be captured.** Reconciliation applies ignore before opening
   the source, including missing or unreadable sources, and removes the ignored
   input from active set-aside entries. Removing the ignore rule later does not
   authorize the conflict.

**Oversized records.** The 8 MiB raw-record limit applies to capture beyond
the captured prefix. The supervised worker never allocates, captures or
modifies a new raw source record larger than 8 MiB. It appends and checkpoints
the complete records before that record through the normal unit commit, then
sets the input aside (`record-too-large`) at the oversized record's start
offset. Records after it stay pending until the operator edits the source or
adds the whole input to `<root>/ignore`, which, as above, also stops later
turns from that session. `--retry-set-aside` revalidates the input, appending
no captured record twice, but the oversized record still blocks it.

Records already captured (by a release without this limit) are not refused.
Staged recovery (after cache loss, a reset, a retry or a rewritten source)
copies the source in chunks without joining lines, and proves the captured
prefix by a SHA-256 digest of each staged line streamed over those chunks,
compared with the journal's line; a captured line of any size is compared
without being held whole, and a changed byte refuses the prefix as usual. The
journal side of that proof, like exact-version journal validation, still reads
each journal record whole: the largest captured journal record bounds recovery
memory, which the large-frame qualification measures in this recovery shape.
An AW comm log has no prefix proof: when its cursor stops qualifying (a new
journal epoch, a reset, a retry, or an older release's cursor), the rescan keeps
the cursor's byte offset as a captured frontier, provided the cursor names the
same file and its boundary witness still matches. Records before that frontier
are read without the limit, journal-id dedupe keeps them from being appended
twice, and the limit applies at and beyond it. While a rescan is below its
frontier, the cursor it writes carries the frontier and that offset's own
witness, so a second invalidation between the rescan's units keeps the larger
of the two proofs. A replaced or rewritten log has no frontier. That is the
price of never refusing a captured record: an already-captured AW record too
large for the worker's 256 MiB heap fails the worker on every rescan
(`capture-pass-failed`), and that stream does not advance.
One native case still captures nothing before an oversized record: an
oversized line before the session's first timestamped line, which the
unstamped lines before it need.
`--health` gives each listed `record-too-large` entry this remedy (edit the
source, then retry; or ignore the whole input, discarding it whole), never the
prefix-restoration remedy above.

Retry takes the same nonblocking capture lock, prepares current entries for
revalidation in durable bounded pages, then performs supervised reconciliation
while retaining the lock across replacement workers. An interruption after
marking leaves the warning active. The run-bound preparation cursor prevents
repeating committed retry generations. Resetting cursors does not replace retry
or clear a refusal. Public synchronous retry/reset APIs keep their contracts.

`capture --status` keeps its existing store summary. `capture --health [--json]`
reads current active set-aside rows from `index/capture.db`, without capturing,
rebuilding, creating an absent root/database, or contacting a service manager.
The shared `capture-status.json` is the atomic **last command snapshot**: direct
synchronous library calls update active issues but do not rewrite that snapshot
or acquire an implicit root capture lock. Health gets historical run fields from
the snapshot and never advances them from current issues. A database with no
snapshot still exposes its active issues.

A supervised pass that finds the snapshot unreadable, malformed or future-dated
treats it as absent: under the root lock and before any worker, it moves the
file aside, never overwriting it, to `capture-status.json.invalid-<UTC stamp>`
(the root directory synced after the rename). A foreground, setup, watch or
service pass names that path on stderr; a hook pass, whose output is detached,
leaves only the moved-aside file. A system error reading the snapshot
(permission, I/O) fails the pass and leaves the file in place.
The pass then publishes a new snapshot with no history: no success is carried
over or invented. One moved-aside copy is kept; a newer one replaces it. An
older moved-aside copy that is a directory is not removed: each later
move-aside reports it, and an operator removes it. A move that fails leaves the
file in place and fails the pass.

### Stopping capture and the lock owner record

SIGTERM and SIGINT stop a supervised pass (manual, watch, hook, setup, service
and retry) cooperatively. They are observed from before the root lock is taken
until after it is released. The first one ends admission: no further worker,
continuation or finalization starts. A worker not yet started is killed at
once. A started worker is asked to stop through its own lock owner record,
which it already rereads between bounded units, so it stops at its next unit
boundary and writes its own `failed`/`interrupted` receipt with the counts it
committed; prior `lastSuccess` is kept. A worker that has already sent its
result keeps it. The worker catches TERM/INT itself as well, so a signal sent
to the caller's whole process group (a terminal's Ctrl-C, `timeout`, a service
manager's control group) does not kill it mid-unit; it too ends the worker as
interrupted at its next check. Either way the worker gets one grace of 5 seconds, capped by
the pass's absolute deadline, and a worker still running then is killed and
reaped; later signals neither shorten nor extend the grace. A killed worker
leaves its unfinished `running` receipt, never a finished one, and the next
pass records it as `lastFailure` `interrupted` and continues from the durable
checkpoints. The command exits 1. An earlier failure cause observed in the
same pass is reported instead of the interruption. SIGKILL, or any death that
runs no cleanup, leaves the lock to the next pass's reclaim of a dead owner
(see below); there is no cleanup guarantee for it.

The exact commands, `--home`, `--file` and `--reset-cursors`, run in the
calling process, and their work is synchronous. They observe SIGTERM and SIGINT
only at safe points: before taking the lock, after taking it, before each
format's batch of exact files, before the index update, and once the work
under the lock (and the receipt summaries) is done, before any answer. Discovery, a whole
format's batch, the index update and the receipt summaries cannot be
preempted, so a signal waits for the segment it arrived in. No response time is
promised, and these commands have no deadline. An interruption at a safe point
releases the lock and answers the command's existing receipt, `failed` with the
error `capture interrupted by SIGTERM` (or SIGINT) and exit 1. `appended`
counts only the batches that completed, so it is confirmed; an interruption
observed after all of them says `after every batch completed`, and one after a
cursor reset says `after the cursor reset was committed`. These commands
write no run receipt, so a killed exact command leaves no `running` run behind:
the next pass reclaims its lock and records only `reclaimedLock`.

The lock's `owner.json` holds the owner's `pid`, a per-acquisition `nonce`,
`startedAt` and `host`, and, while a supervised pass runs, its `worker`'s pid,
nonce, start and host. A lock taken by this release also says who took it:
`command` (`pass`, `retry`, `home`, `file` or `reset-cursors`), `caller`
(`entry`, the program: `oats`, `turn-record`, `hook-runner` or
`service-runner`, left out when the command runs in another program; `trigger`,
from `manual`, `watch`, `hook`, `setup` and `service`) and `ppid`, the owner's immediate parent process. A cooperative stop
adds `stop: true`. These are fixed labels and process facts. No argv,
environment or shell text is recorded, and nothing names an external caller or
why it stopped the command. The fields are diagnostic only: liveness, release
and reclaim read only the pid, nonce, start, host and worker, so records from
earlier releases, without them, are read and reclaimed exactly as before.

### Offline installation and run diagnosis

The package owns `captureHealth` and `turn-record capture --health [--json]`.
Its existing `schemaVersion: 1` health envelope remains separate from the
[status file schema](capture-status.schema.json): `rows` contains `{code,message}`,
`lastRun`/`lastSuccess`/`lastFailure` retain historical receipt values, and
`backlog` is the current issue projection. A warning diagnosis exits zero;
an installation/issue reader failure exits nonzero, without an empty successful
projection. No store is constructed on the health CLI branch.

Capture CLI terminal branches return from a single command dispatch and retain
their exit code while Node drains stdout and stderr naturally. Health cannot
fall through into capture, including on reader failure. The same boundary
applies to usage/help, recovery, hook launch reporting, explicit-file receipts,
install hints, status and ordinary errors; exact-home receipts already finish
naturally. It adds no stream closure or timed delay. Privacy failures print once
and stop dispatch before admission; a later watch privacy failure closes future
watch scheduling. Lock cleanup and admitted-child ownership remain with their
existing owners; hook launch still unrefs its detached child, and foreground
watch retains its signal lifecycle. Output delivery is distinct from diagnosis
and durably confirmed processing counts.

Installation evidence means service definitions, hooks or setup's pending marker, any of:

- On macOS, `~/Library/LaunchAgents/ai.aweb.turn-record-capture.plist` parses as
  a supported owned periodic or legacy definition. On Linux, the candidates
  are `~/.config/systemd/user/turn-record-capture.service` and
  `turn-record-capture.timer`. Health shares setup's strict template/argv
  ownership reader; a basename, marker or mention alone is insufficient.
- A `settings.json` in a top-level `~/.claude*` directory or directory symlink
  has a recognized command in a Stop or SessionEnd hook group. Health shares
  setup's unchanged tokenizer: script in the second word ending in
  `/capture-hook.mjs` (this release's hook entry) or `/capture.mjs` (earlier
  releases' forms), whole `--owner` and `--quiet` words, supported plain/single
  quoted words, and no shell expansion, operator or second command.
- Setup's pending-activation marker, `capture-service-pending.json`, is in the
  selected root. Only setup writes it, so a setup that failed after writing it
  is diagnosed (the marker's row) even with no definition or hook.

A record root alone is not an installation: one `oats recall` or one manual
capture creates it (with `index/`), and such a host has never set capture up.
The selected root (`--root`, then `TURN_RECORD_ROOT`, then `~/.turn-record`)
still has to be a directory when it exists. Readable foreign service files alone do not establish installation. No evidence
means `ok`, no warnings and no root creation. That includes a host that runs
capture by other means, or was set up with `--no-hooks --no-service`: health
reads `ok` and withholds its history and backlog, even when a status file or
set-aside inputs exist. Unreadable candidates, dangling
links, malformed hook settings, observed changes or exceeded reader limits are
unknown and fail diagnosis, even if another candidate establishes installation.
Only named files and the top level of the caller home are inspected; source
roots, journal content, network and managers are never visited. Definition bytes
show installation evidence, **not** registered/enabled scheduling. Even an `ok`
receipt diagnosis does not certify a manager schedule or a permanent service PID.

Installation reads accept regular files up to 1 MiB each, with 16 MiB total,
64 hook candidates, 4,096 home entries and 256 path components. These are private
fail-closed reader guards, not capture policy or truncation-based absence proof.
The reader uses a 15-second cooperative monotonic deadline between operations;
the isolated issue reader retains its hard 10-second child deadline. Synchronous
filesystem calls still depend on the host filesystem returning. Deployment
doctor supplies the separate finite command timeout described below; it does
not turn the synchronous library's cooperative deadline into a hard one.

Installed but absent status produces `capture-status-missing` with a setup
remedy; malformed, unsupported, unreadable or future-dated status produces
`capture-status-invalid` until the next supervised pass moves it aside and
writes a new status, as the setup remedy's pass does. Valid older nullable
receipts remain valid absence of run evidence. `capture-success-stale` means no recorded success or one **older
than** 3,600 seconds, not exactly that age. It names the last success and committed
progress, with an asleep/off-host caveat. Recent progress is not full success.
A failure newer than success and current unresolved stream failures produce
`capture-pass-failed` independently of current set-asides. An unfinished run
beyond its recorded deadline also warns, without inventing its termination cause.
Before that deadline, death evidence requires an unchanged local lock registration
whose worker PID matches the receipt and whose acquisition predates the run,
with both supervisor and worker positively dead (each judged by the boot and
process start its record names). Missing/off-host/hostless,
changed or uncertain registration and live PIDs supply no death proof.
The receipt is reread before accepting that observation; health never repairs,
reclaims, signals termination, writes counters or invents a finished receipt.
Owned legacy watcher definitions additionally produce `capture-setup-required`,
as does an owned capture hook whose entry is not this release's
`bin/capture-hook.mjs` (the `capture.mjs` forms earlier releases' setup wrote),
hooks-only installations included; the row names the settings files.
Until setup converts it, the hook line from before this release,
`<node> <package>/bin/capture.mjs --owner <owner> --quiet` run asynchronously
with a 120-second timeout, still works against this release: it is one
ordinary quiet foreground pass under the root lock, attributed `manual`, up to
its 300-second deadline. A harness that stops it at 120 seconds with SIGTERM or
SIGINT stops it cooperatively: the worker ends at its next unit boundary, or is
killed after a 5-second grace, the pass ends as interrupted and the lock is
released ([stopping capture](#stopping-capture-and-the-lock-owner-record)).
With SIGKILL the supervisor dies holding the lock, which the next pass reclaims
as a dead owner. Either way the next pass continues from the durable
checkpoints.
Setup's pending-activation marker (`<root>/capture-service-pending.json`, see
[setup service migration](#setup-service-migration)) produces
`capture-service-pending` from file evidence only: beside setup's own marked
definitions it says the periodic schedule's activation was not verified (hooks
may be installed, the schedule is not confirmed), and with no such definition
it names the marker as stale. Both say "not verified", never "not running": a
crash after a verified activation can leave the marker until the next setup
clears it. The remedy is a setup rerun; health never removes the marker. It is
a warning and hides no other row.
Standalone remedies name `turn-record`; the private doctor entry, and
`capture --health` when the kernel runs it (`oats capture --health`) or a node
was handed in (`OATS_NODE_BIN`, as for setup), select `oats` when constructing
authored remedy literals, before interpolating paths/errors or receipt data. It never replaces substrings in completed messages. All diagnosis
is local observed evidence, not full service qualification.

### Kernel doctor delegation

Deployment `oats doctor` (text or JSON) starts exactly one fixed package health
entry with `process.execPath`. `--soul` stays composition-only and starts none.
The kernel maps validated package `{code,message}` rows into its existing
`warnings` list; it does not read status, open the database, probe managers or
reimplement installation/freshness/issue rules. The package validates its
existing `schemaVersion: 1` envelope and reuses receipt/backlog validation.
Nullable historical values remain absence of evidence. No doctor schema field
or public capture option is added.

The child keeps the caller cwd and HOME selection; `TURN_RECORD_ROOT` selects
the root, otherwise `~/.turn-record` applies. A relative root is relative to the
calling process cwd, not doctor's deployment positional argument. Only the
reader's home/temp/cache/root environment and an explicit experimental SQLite
Node flag are forwarded; no inherited Node options, worker/executable override
or shell dispatch. The private entry constructs no store and exits naturally,
so queued JSON output can drain.

Transport uses a 20-second command timeout, SIGKILL on timeout/overflow and a
1 MiB output cap. These are private fail-closed guards, not a response-time
measurement or public tuning policy. The synchronous child transport waits for
its direct child to terminate. The package's isolated SQLite reader retains its
own 10-second timeout; if the outer reader is killed while that child is active,
its existing finite lifetime still applies. OS scheduling/filesystem response
and process termination remain host dependencies; no real-manager or storage
qualification follows from these source guards.

Timeout, launch/transport/reader failure, excessive output or invalid JSON/envelope
produces `capture-health-unavailable`, never an empty successful diagnosis or
rows reconstructed from partial output. Doctor retains its warning exit/output
contract; standalone package reader failures remain nonzero. Valid package
warnings are forwarded as diagnosis, not command failure. Text output applies
the kernel's terminal escaping; JSON retains literal values. Even no warnings
does not establish enabled/registered scheduling or a permanent service PID.

Both command snapshots and health use the same transactional count/sample
projection. Source set-asides have `setAsideCount`, at most 100 deterministic
`setAside` entries and `truncated`. Operational failures independently have
`failedCount`, at most 100 `failed` entries and `failedTruncated`; neither category
borrows the other's sample allowance. Text output has the same bounds (at most
200 combined entries) and explains both source remedies. Absent state on a
never-installed root is not a warning or a reason to create files. A missing
current database cannot erase a known nonempty command snapshot. Malformed or
unreadable status is reported as `capture-status-invalid`; an unavailable current
issue reader fails the command rather than returning successful stale/empty
health JSON.

An operational failure entry contains `stream`, `offset`, `reason`, `attempts`
and `nextRetryAt`. The offset is the journal byte offset where the durably
admitted failed **single-stream unit starts**, never an exact inner-frame claim.
Text says "unit starting at byte X" and "failing frame unknown". An interrupted
multi-stream group supplies run failure evidence, not guessed rows for every
member. Private journal generation and admission evidence stay out of this
projection. Active entries produce `capture-pass-failed`, including during
backoff; they do not become source set-asides or advance a processing cursor.

The fixed retry schedule is 2, 4, 8, then 16 capture intervals (30, 60, 120, then
240 minutes, capped there). Only an actual failed attempt increments `attempts`
and sets a new date. Skipping a deferred unit does neither. Time passing, source
growth, cursor reset and `--retry-set-aside` do not resolve these failures or
override their schedule. Resolution requires committed progress past the failed
unit or validated reconciliation that it no longer needs work. A cooperative
stop that makes durable progress is ordinary partial work, not automatically a
failure. Old snapshots without these fields contain no recorded operational
failure evidence; their absence does not establish a successful pass.

An interrupted multi-stream group defers its members without assigning each a
failure. On the next due attempt, its members enter the normal queue singly,
after healthy work. A member's own failed admission then supplies its failure
row; successful members advance. There is no in-pass group retry or diagnostic
execution mode. Unknown attribution remains a run failure, with deferred work
keeping the backlog pending even when no member has an attributable failure row.

Reading an existing database requires Node's read-only SQLite support: 22.12+
on the 22.x line (22.13+ avoids needing `--experimental-sqlite`), 23.2+ on 23.x,
or a newer major. Normal capture retains its declared runtime floor. Missing
SQLite support, unsupported schemas, lock/recovery errors, and WAL databases
fail health without migration or repair. Supported `capture.db` writers retain
rollback journaling. The health reader rejects WAL from its fixed header before
opening SQLite; it never creates WAL sidecars, switches mode, recovers a hot
journal or uses immutable/no-lock shortcuts. This does not protect against an
external actor racing a mode change or file replacement.

Header validation and the read-only transaction run in one private child using
the current Node executable, only the explicit SQLite runtime flag, and a clean
environment. It has a ten-second deadline, a 1 MiB output cap and no retries.
This costs one short process per health read and keeps a raw descriptor close
from releasing POSIX locks belonging to another SQLite connection in the caller.
Command snapshots reuse their owned connection for the shared projection.

The shared schema is [capture-status.schema.json](capture-status.schema.json).
Existing algorithm-phase snapshots retain null `policy`, `lastRun`,
`lastSuccess`, `lastFailure` and `lastProgressAt`: evidence has not been supplied.
They never mean a completed pass or prove service activation. The same version-1
schema accepts the fixed service policy and evidenced worker run/history fields;
no second status file is used. Run identities name their trigger, worker PID and
start; a running receipt has no finish/reason. Complete, partial and failed
receipts have a finish, and failure has an explicit reason. Success/failure
summaries retain run identity, finish, per-run counts and sampled peak RSS;
failure additionally has a safe message and optional path/offset. Future-dated,
malformed or unsupported evidence is invalid, not a freshness conclusion.

Failed/interrupted-run counters report only durably confirmed unit-accounting
results, not an exhaustive count of physical journal writes during that run.
A zero `turnsAppended` does not prove that no append reached disk: journal fsync
can precede a lost derived checkpoint/accounting commit. The failure message
states this qualification. Confirmed healthy-unit counts within the same failed
pass remain visible, without erasing the earlier interruption. Recovery dedupes
against journal truth; it neither attributes later journal growth retroactively
to the failed run nor counts recovered existing turns as newly appended.
Explicit `--file`/`--home` receipt semantics are unchanged.

`capture-status.mjs` validates this shared format and atomically replaces a
private same-directory temporary file after its fsync. Publication failure is
reported; the prior snapshot is not replaced by an invented success. Exact
receipt commands refresh backlog while preserving all prior service history,
without claiming their own unbounded operation was a bounded pass. Snapshot
format support alone does not produce run evidence: the admitted command worker
must supply committed facts.

The private `CaptureRun` helper publishes a running identity before initializing
its derived counter row. Counter changes join the processing transaction after
journal fsync or index commit; rolled-back work cannot publish progress. A
continuing worker combines those committed counters with the published sampled
RSS peak. Sampling alone never advances `lastProgressAt`. An unfinished run
whose counter cache is lost retains interruption evidence rather than becoming
a successful empty pass. A finished file receipt takes precedence over a stale
running counter row, and finalization needs one atomic file publication, not a
second derived-state commit. Supervisor failure evidence is bound explicitly to
the current run ID, including a child lost before any running receipt exists.
It is distinct from failure of an older abandoned run: only failure in the
current pass prevents that pass from succeeding after healthy work. Partial
work preserves previous success and failure history. These are private
accounting mechanics, not evidence that command integration has run a pass.

Source-stage fixtures use the private retained recovery cleanup unit described
below. A due retry may need it even for a tiny source after an interrupted
append. Cleanup failure is a failure in the current pass and preserves
confirmed work; it cannot be ignored to make a later receipt successful.
The private worker dispatcher also routes these units; fixture coverage is
separate from ordinary-command and installed-service qualification.

## Resource model

Source and journal reads use 64 KiB chunks. Batches commit at 2,000 records or
8 MiB of accumulated raw bytes. Admission flushes the prior batch before adding
a record that would exceed that byte target. Its checkpoint excludes the next
record's bytes and timestamp, even when the parser has already scanned that
line. A single larger record remains supported by public library calls and can
exceed the batch target. SQLite connections use a 2 MiB page-cache target
and disk-backed temporary tables. Metadata query pages hold at most 128 rows;
keyset queries support the declared Node 22.5 SQLite API without rescanning
prior pages. Content-processing memory therefore depends on fixed buffers,
bounded batches/caches and the largest processable individual record, rather
than total source bytes or all historical IDs. These
are algorithm settings, **not** a memory/deadline policy or record-size limit.

Native root and path discovery retain in-memory metadata inventories, sorted by
the existing per-directory `localeCompare` order with stable ties and depth-first
traversal. Aweb account discovery retains code-unit sorted basenames. Public synchronous
`captureAwLogs` keeps sorted whole-file traversal. Cross-account append order
in `owner~aw` under the service is unspecified; per-account order is preserved.
Bounded command work may rotate between account files, serially under the same
stream lock. IDs, projection, dedupe and journal-generation checks are unchanged.
[`recall --thread --json`](../README.md) exposes the resulting durable sequence,
including mixed-account ID windows; it does not regroup or sort journal history.
Discovery metadata memory grows with file/profile counts, separately from streamed
content processing; metadata enumeration and sorting still run on unchanged
passes. Public list APIs retain their full sorted-array output. Per-input
cursors in `index/capture.db` replace whole-map JSON loads and rewrites. The
background caller requests capture counts without collecting a receipt inventory;
it does not run the explicit full-index count query merely to print progress.
Explicit API and receipt defaults retain complete issue/source/session
inventories, so their metadata memory may grow with the output they must return.
They do not retain whole source contents or journals to compute counts and
first/last visible IDs; receipt summaries use file-backed tombstone claims.

Final/attributed/Pi-custody capture and changed-transcript comparison can require
a complete verified snapshot before mutation. Those paths stream the source to
a private temporary file under `<root>/.capture-tmp`, hash it while reading,
and append from the same pinned bytes. Receipt claims databases use that same
record-root scratch area. Staging costs one source-sized temporary copy and is
removed on ordinary success or failure. These files are colocated on the record
root volume, not the system temp volume; the chosen record volume may itself
be memory-backed. Full receipt verification and recovery may read historical bytes;
this necessary proof work is distinct from unchanged/small-growth accounting.

Journal IDs and validation checkpoints are accelerators, never authority.
A validation checkpoint qualifies an exact device/inode/size/mtime/ctime version
under the stream lock. Unknown replacement, shrink or mutation forces bounded
validation before append. Journal fsync precedes the derived commit, so an
interruption leaves an old checkpoint that triggers validation. Validation
commits bounded progress; search rows and byte/count cursors commit together in
bounded transactions. Ordinary passes seek new journal bytes without parsing
consumed prefixes. Inconsistent identities or cursors invalidate derived state;
recovery can cost a historical scan. No journal format or turn ID changes.

The synchronous index update (`RecordIndex.update`, run by `capture --home`,
`--file` and `recall --reindex`) uses one `capture.db` connection for the pass.
It first takes a census without locks. A stream is current, and is skipped
without a stream lock or validation, only when all of the following hold:

- its complete validation checkpoint names the journal's exact current version;
- the search index's byte cursor and epoch match that checkpoint;
- both count tables agree with it.

Every other stream is a candidate. That includes a stream whose evidence is
missing, partial or disagreeing, backlog left by `--no-index` passes, and
streams that other writers changed. Each candidate is validated again under its
stream lock before any write.

A candidate that proves the union stale resets it atomically, and selection
restarts against the empty index. Stale means the journal is missing or
replaced, a new epoch, an invalid cursor, or a legacy count disagreement. A
journal that changes between that check and catch-up refuses the pass with the
existing retry error. A skipped stream's cursor is read again when its turn
comes, so a reset by another index connection is caught up, not skipped. The
pass refuses if `capture.db` was replaced or removed while it held the
connection.

The census is not an atomic snapshot of concurrent writers. A change made after
a stream was observed is indexed by a later pass. A missing checkpoint still
costs one historical validation of the stream, and the reset it implies then
reindexes the union.

Search-index reset remains one atomic transaction. Ordinary tables use SQLite's
truncate clear; the content-storing FTS table is dropped and recreated using the
owning schema instead of deleting text rows individually. Readers retain the
existing old-union/empty-union semantics, including already-open connections.
An interrupted transaction rolls back the entire reset. Successful timing alone
does not establish remaining deadline budget; the operator-only
[reset benchmark](../../../scripts/benchmark-record-reset.md) measures the full
commit separately from sampled reader blocking on a disposable SQLite backup.

The [operator's real-index qualification](https://github.com/awebai/oats/issues/1108#issuecomment-6165193608)
used benchmark commit `16c62e39aaa43c2bb510cc446c7528359a9a4bd2` on two fresh
online backups with identical counts: 4.82 GB, 2,286,985 turns and 1,313 streams.
On macOS ARM/APFS internal SSD, Node 26.11.1/SQLite 3.54.0 with DELETE/FULL,
the original reset took 45,291 ms and atomic drop/recreate took 824 ms, including
COMMIT. Longest sampled reader-busy spans were 44,453 ms and 463 ms; 10 ms
sampling with gaps up to 56 ms does not measure exact reader-exclusion time.
Sampled rollback-journal peaks (2.39 GB and 4.9 MB) are lower bounds. These
results qualify the isolated atomic reset on that storage, not the subsequent
2.3-million-turn reconstruction, full-pass deadline or Linux service performance.

Ordinary scratch directories are private per synchronous caller (0700 directories,
0600 owner/payload files), with a same-host PID and nonce marker. Those per-call
allocations never transfer ownership or open descriptors to a subprocess. A command holding
the capture lock removes recognized allocations only after positively proving
the local allocator dead and rechecking directory and marker identity. Public
synchronous callers still do not acquire an implicit capture lock; their live
allocations are preserved by command cleanup. Live/reused PIDs, unknown or foreign
owners, permission failures, links, special files and incomplete/missing markers
are preserved. A kill before ownership publication can leave an unowned directory.
For such leftovers, stop all capture/library users, establish that no caller is
using the specific allocation, and remove only that confirmed orphan; do not
blanket-delete the scratch area while callers may be active. No age-only cleanup.

Command recovery uses separately recognized `recovery-*` allocations. Ordinary
dead-owner scavenging preserves them: allocator death alone cannot erase a job
that must resume. The registered root-lock worker requires a durable job
reference, stable allocation nonce and exact directory/payload identities before
opening one. Adoption requires positive death proof of the previous local owner
and rechecks the job, marker and registered worker before publication. A
self-identified owner publication names the prior committed marker stamp, so a
crash after publication but before its DB checkpoint can be recovered without
accepting a copied/replaced owner file. No descriptor transfers between workers.
Lost references, unknown owners and unpublished allocations cannot become proof
or cleanup authority by pathname. They retain the conservative orphan procedure
above. A committed deletion mark precedes allocation-specific removal; reference
finalization can be batched after removal, and interruption is repeatable.

`capture-cleanup-work.mjs` supplies that lifecycle as a private work unit.
`captureCleanupPage` reads at most 128 allocation references by key, including
active jobs, and returns only deleting jobs. It never scans indefinitely to
find a match. The caller saves its returned key and resumes another page;
reaching the end of a page sequence is enumeration evidence, not a completed
capture pass. Selection does not depend on a source remaining ready, so a
finished or refused source's deleting reference is still discoverable after
a worker dies. Active allocations are not selected for deletion.

`cleanupCaptureRecovery` binds a selected job to its allocation nonce and
stream, commits verified adoption, removes the allocation outside a database
transaction, then divides one bounded hash-row allowance between recovery
chunks and transcript prefix rows under the stream lock. Both tables must be
finished before it removes the allocation and staging references. A partial
unit, cooperative stop after removal, or failed final metadata commit retains
the deleting reference; the next registered worker revalidates it and resumes.
The source's committed cursor and journal bytes are not rewritten or recounted.
The caller still owns fair selection, operational failure handling, budgeting
and final receipt publication; this unit adds no separate retry policy. Its
optional commit callback joins admission retirement and confirmed progress to
the final stream-locked metadata transaction. Callback failure rolls back those
facts and metadata deletion together, even if the directory is already absent.

`CaptureCleanupQueue` supplies private worker scheduling for deleting claims.
Healthy and retry enumeration have independent durable keyset cursors; each
turn inspects at most one page of 128 references past its cursor and processes
at most one allocation under the shared hash-row allowance. When that page ends
the list without a job, the turn inspects one more page from the start, so an
unfinished allocation the cursor has passed continues in the same pass; with
no job there either, the cursor wraps for later work. A cleanup unit that
commits no metadata progress is not selected again in its pass; the next pass
tries it again. A scan endpoint describes enumeration only: partial jobs or
newly added earlier keys can still need work on the next rotation.

Before filesystem work, the queue commits an allocation-bound admission and
the next cursor. The cleanup unit must still acquire the stream lock, prove
ownership and commit adoption; queued identities never grant pathname authority.
Its final metadata transaction retires admission and records actual metadata
progress without inventing source/index counts. Cooperative deadline/RSS stop
retires only admission, preserving the deleting claim for continuation. Other
throws or worker death retain admission until the registered replacement
reconciles it after predecessor death.

Reconciliation records a pass-bound failure and allocation-specific backoff
using the fixed 30/60/120/240-minute schedule. It does not diagnose a journal
frame, create a public failed-stream row, or change source/index retry evidence.
Skipped work does not increment attempts or move the retry date. A failed
allocation cannot retry in the same pass; a due partial unit retains its retry
until complete and admits at most once in a pass. Successful deletion clears
only that allocation's retry. Historical run failure remains history; current
pass failure survives independent healthy processing. Final completion still
requires the owning runner's all-stage audit, not an empty cleanup page.

`capture-recovery-snapshot.mjs` copies the fixed source end in 64 KiB chunks under
the stream group. Payload fsync precedes committed copy offsets and chunk hashes.
An uncommitted suffix is truncated only inside the adopted allocation, followed
by bounded verification of all committed chunk hashes before continuing. Lost
chunk metadata or mismatched bytes revoke the staged proof. Copying checks the
raw-record limit incrementally, before allocating a whole oversized record.
After copying, consumers read only that staged descriptor and verify its version;
the mutable source remains an observation/custody check, not a replacement data
source. Append growth uses the shared append-only assumption and bounded source
boundary witness; replacement, shrink, same-size edits or witness mismatch revoke
the job. The scheduler's durable reset/retry generation also invalidates a staged
snapshot; it stays fixed across partial workers so retry cannot restart forever.
This source qualification is separate from exact journal-generation
validation. A journal change between workers retires the old fixed-end snapshot
before comparing a possibly longer captured prefix, including after public or
outgoing-release writes. Later source growth alone is work for a later snapshot.
The native command unit may carry a completed proof into its own next journal
generation only after its fsynced append under the same stream lock, committing
the source cursor and staged job's new journal version together. An interrupted
commit instead leaves the old generation and forces revalidation.

Small command recovery snapshots have a private optimization when their **total
fixed end** is at most 8 MiB. Each worker streams a new private copy and full
SHA-256 in 64 KiB chunks before trusting saved comparison progress. Complete
digest plus size identifies the proven bytes; source identity/observation,
reset/retry generation and exact journal generation must also qualify. The
comparison consumes that worker's verified snapshot, never a later source-path
reopen. Same-content replacement takes the normal validation path. Matching
snapshots preserve comparison progress; a changed digest or other qualification
restarts proof before append. Ordinary unchanged/growth capture does not use
this recovery optimization.

These small copies are disposable per-call allocations, with no payload or
ownership-handoff fsync. Their loss never loses a proven source checkpoint:
the next worker must copy/hash again. Repeated source/stage bytes are recovery
work and are counted separately from probes and ordinary incremental work.
If restaging exhausts the unit before required work can advance, the processing
commit selects retained resumable copying for subsequent admissions. A killed
unit cannot publish an in-memory fallback decision; its durable failed-admission
retry selects the retained path. The fixed source end is preserved by committed
observation metadata, which alone never authorizes prefix proof. SQLite commits,
journal syncs, root-lock publication and retained fallback syncs remain separate
costs; avoiding disposable-copy fsync is not a claim that first-upgrade storage
cost or the complete service has been qualified.

Staging consumes source-sized private space plus bounded-per-chunk hash metadata.
Revalidating staged bytes after interruption is recovery work, reported separately
from mutable-source reads and boundary probes. Completed or invalidated jobs
reclaim hashes in bounded units; a hash-cache entry never authorizes deletion of
a filesystem path. These are private worker primitives; their tests do not by
themselves qualify the complete command scheduler, run receipts or service limits.

The private `NativeCaptureDiscovery` walker checkpoints only its active
per-directory stack, directory identities and exact last basenames. A resumed
walker loads that stack directly rather than revisiting completed sibling
subtrees. Within a worker it retains only the sorted arrays for active
ancestors; completion, close and errors release those arrays. Selection and
stable `localeCompare` ordering match the public cc/pi/codex inventories,
including Claude's restricted subagent layout and existing link distinctions.
A replaced active directory invalidates its position. An absent fresh default
can be empty; disappearance of an already selected directory is an error.

Each discovery unit accounts for visited metadata entries, including irrelevant
ones, and returns a bounded file page plus the next checkpoint. The scheduling
caller must commit that page and checkpoint together. Directory reads/sorts
can recur on restart and their arrays still grow with directory size; this is
not a constant-memory metadata claim or new-byte-only work. Newly inserted
names before the saved position belong to a later sweep. A missing anchor
conservatively replays its collation equivalence class, requiring idempotent
inventory insertion. This walker does not itself select roots, schedule
capture/index work or certify that a complete command sweep occurred.

## Internal transaction groups

The package-private `capture-context.mjs` helper can group synchronous work over
at most 128 streams. It acquires every stream lock in canonical order before
starting a shared `capture.db` transaction. Helpers reuse that connection and
use savepoints for nested failure isolation; journal appends still fsync before
the group commits derived offsets/IDs. No additional stream may be acquired
inside the transaction. This preserves public writers' stream-before-database
lock order. Group acquisition accepts an internal stop check and unwinds partial
acquisitions on failure. Callers must select bounded work before entering a group;
the helper alone does not turn a full reconciliation into a bounded pass.

Command groups can supply a bounded admission manifest. After acquiring all
member locks, the helper rechecks each exact journal generation and commits the
manifest plus the next fairness position in a separate transaction, before any
processing. That position is queue progress, not a processing cursor. The same
intent transaction also retains each stage's last position independently;
intervening index work cannot reset source rotation. This adds one state-row
write per admission, not another transaction or a per-record sync. Completed
checkpoints and removal of the active manifest then share the processing commit.
A crash or thrown error leaves the manifest and fairness position intact, while
only journal bytes already fsynced survive a rolled-back processing transaction.
The scheduler must reconcile an unfinished manifest before admitting another;
the helper refuses to overwrite it or guess per-member failure rows. A normal
changed group therefore adds one intent commit, regardless of its record count.
No-op groups without admission add no intent transaction. These counts describe
explicit SQLite transactions, not filesystem sync calls or storage latency.

`capture-retry.mjs` reconciles an interrupted manifest after the previous worker
has exited. One transaction stores retry membership, run failure evidence and
any attributable single-stream failure, then removes the manifest. A failed
commit leaves the manifest available for retry; completed reconciliation is
idempotent. Neither reconciliation nor admission advances processing cursors.
Deferred membership is separate from public failure rows. Admission itself
requires a due, single-stream retry and rejects a second attempt in the same
run. A separate durable retry position rotates incomplete members across runs;
bounded keyset enumeration avoids retaining all deferred members in memory.
The scheduler supplies a finite, fair healthy sweep before deferred selection.
Enumeration still costs metadata work and is not a new-content-only operation.

Resolution joins the processing checkpoint transaction. An unchanged journal
must be processed through the failed snapshot's end, or the stage must validate
that the unit no longer needs work. A checkpoint inside that snapshot, a changed
generation, expiration of the retry date or a process restart cannot by itself
clear the warning. The stage remains responsible for proving reconciliation;
these private queue helpers do not implement the full source/index scheduler.

Journal recovery exposes an internal work-unit interface: obsolete-ID deletion
has a persisted phase, and validation commits its byte/count cursor after each
bounded batch. A changed exact journal version invalidates that progress. A
partial checkpoint never authorizes append. Source framing accepts an internal
record limit and checks it before joining an oversized line; public callers keep
their unlimited framing default. These primitives require a scheduling caller to
provide budgets and continuation; they do not bound public library operations.

`advanceTranscriptPrefix` is the internal resumable comparison for a verified
immutable source snapshot. Its durable phases clear obsolete hashes, consume
the journal from a byte checkpoint, then compare source lines from a byte/line
checkpoint. Hashes and phase progress share the surrounding stream group's
transaction. A snapshot identity or exact journal generation change revokes
the proof; losing the hash table or its epoch cannot qualify old checkpoints.
Only the ready phase authorizes the caller to append. A late disagreement
reports the conflicting source line/offset without appending any suffix.
Cleanup revokes the proof before deleting bounded batches of hashes. Journal
processing retains the historical-single-record qualification; the raw source
record policy is not a serialized-journal size limit. This comparison helper
does not own snapshot staging, transfer its ownership or read the mutable source.

`capture-native-unit.mjs` combines these private primitives for one native input.
It performs bounded journal validation before any append, resumes verified
snapshot/prefix work when a source cursor is unqualified, and admits one bounded
batch from the verified bytes. Ordinary known growth uses the source cursor and
bounded witness without staging historical content. The fixed end survives
partial units; later growth is a later sweep. A separately checkpointed search
frontier finds the first timestamp across units, then carries it backward while
capturing the unstamped prefix. An unchanged unstamped or torn tail stays pending
without repeatedly scanning it. A record over the raw-record limit commits the
unit's complete records before it, then sets the input aside at its start
offset ([operator recovery](#operator-recovery)). Explicit retry generations
persist separately from active issue rows, so clearing a resolved issue cannot
restart its proof.
Ignore is applied before source/custody access; retry still compares the complete
captured prefix. The scheduler must account for pending/failed work and perform
allocation cleanup after its deletion mark commits. These are unit interfaces,
not a resource promise for public synchronous capture or exact receipts.

`capture-aw-unit.mjs` similarly processes one fixed-end log unit. Every scanned
raw line consumes its work allowance, including blank lines, malformed complete
lines and projection refusals. Cursor publication follows the pending batch's
durable append. A valid final object without its newline retains its starting
offset and keeps the command pending; an unchanged snapshot does not repeatedly
project that fragment. Replacement or explicit source reset reprojects through
persistent journal-ID deduplication. Raw oversized input uses the same set-aside
store, prefix capture and retry/ignore rules as native inputs
([operator recovery](#operator-recovery)); a projection refusal itself is
consumed evidence and does not create a second issue mechanism.

Public synchronous library calls do not implicitly enter this context or acquire
a root capture lock. Healthy derived-state opens do not run a schema write
transaction, and identical state values do not produce redundant row updates.

The private supervisor transport admits one child at a time under the root lock. The child
announces its nonce and stays idle until the supervisor durably publishes its
identity in that lock, with the boot and the child's process start, and sends
permission to start. A worker that runs, or whose liveness is unknown,
prevents reclamation after supervisor death; one whose PID is gone or runs with
another start, or whose record is of another boot, does not. Release occurs only
after the owned child exits; signals target the spawned child handle, never a
PID inferred from an abandoned lock or a process group. Continuation retains the
same root lock: it replaces only the exact previously registered worker identity
after positive death proof. A worker of uncertain liveness prevents replacement.
Workers check their parent and lock identity between work units; the same read
carries the supervisor's cooperative stop request, which the supervisor
publishes into that owner record exactly as it publishes a worker. The supervisor never writes status
on behalf of a crashed worker. A shared monotonic deadline includes process
startup and lock publication, with a separate cooperative drain boundary.
Launch arguments fix the heap policy and exclude inherited Node flags and
preloads. This transport requires a reconciliation entry that supplies bounded
units and persists run facts; it does not itself implement a complete pass.

`capture-pass.mjs` supplies serial child continuation under that same absolute
deadline. Startup, publication, checkpoint finalization and reaping consume the
pass budget; child replacement cannot renew it. Normal work has internal drain,
finalization and forced-stop boundaries, and is admitted only with its full
allowance. A reserved start and time allowance let a final worker reconcile an
interrupted predecessor and persist run facts. All starts, including spawn
failures and finalization, count against the fixed internal ceiling. The parent
can report its observed process failure, but only a worker can reconcile durable
admission and attribute it. There is no in-pass diagnostic retry mode. The
reconciliation entry must select independent ready work before deferred failed
work; transport tests alone do not establish that scheduling or recovery rule.

Bounded index groups reuse the already acquired stream group and capture-state
connection. Validation precedes the index write transaction; completed index
rows and byte/count cursors commit together once per group. A cooperative stop
commits completed work, while an exception rolls back that index group. Each
selected stream receives a share of the record/byte budget, so a large journal
does not consume every selected stream's allowance. The scheduler must visit
both live streams and indexed streams whose journals disappeared, and restart
its index sweep after an atomic union reset. The group helper never declares
the entire root complete. It defaults to returning `resetRequired` without
mutating index rows when reset is needed. The scheduler must reserve a fresh
full worker allowance for that atomic operation; the detection unit and the
finalization reserve cannot implicitly start it. Explicit reset permission is
an internal seam, not a public policy override. A no-op group performs no index write transaction;
its capture-state transaction remains separate from the index commit. A failure
between the two commits is recovered through journal version/epoch validation,
not by assuming a cross-database atomic transaction.

`capture-index-work.mjs` joins a selected index group to durable admission,
per-stage scheduling position and run accounting. Its caller supplies a finite,
fairly ordered union of live and indexed streams; this bridge neither builds
that inventory nor certifies sweep completion. Failure attribution starts at
the saved validation boundary when recovery is unfinished, otherwise at the
qualified index cursor. Changed journal generations start validation at zero.
Only the locked group validates and consumes those cursors.

Index rows commit before their confirmed `turnsIndexed` count joins the
capture-state commit. If that later transaction fails, the durable admission
remains for reconciliation while the index rows can survive. Resuming an
already indexed unit does not reconstruct its lost run count. Validation or
indexed-byte advancement can update progress; a no-op visit does not. Due
index retries are single-stream admissions; only completion of the current
validated journal resolves them. Partial validation/indexing and reset requests
retain failure evidence, and other-stage retries return to the scheduler.
Reset detection always defers: the owning scheduler must reserve a fresh full
worker allowance for reset and restart the union sweep afterward. Source,
discovery, cleanup and final receipt routing remain separate responsibilities.

The private `CaptureIndexInventory` builds the union of indexed stream names
and live journal stream names in `capture.db`. Indexed names are enumerated
first, including names whose journal disappeared; they remain in the inventory
so locked index validation can detect changes to cross-stream tombstone
authority. Each discovery call inspects at most 128 index rows or directory
entries, including irrelevant names. Inserting that page and advancing its
checkpoint share one transaction. Names shared by both sources occur once.
The inventory never reads journal content, changes index rows or grants reset
permission.

A scheduler-owned sweep identity resumes discovery across connection/worker
restarts. Live discovery retains a sorted directory-name array only within the
worker and resumes by a binary name key when reopened, even if that anchor was
removed. The selected streams directory's identity must remain unchanged.
Directory listing/sorting is still metadata work proportional to directory
size, and can recur after restart; it is not a bounded-memory metadata claim.
New names before the saved position belong to a later sweep. A fresh absent
directory can be empty; disappearance/replacement after selection is an error.

Ordered reads use bounded database pages and rotate after the durable index
admission position, visiting the discovered union once per iterator. Inventory
rows are not removed on an apparent index completion: membership is not cursor
or generation proof. The `complete` flag only means enumeration finished, never
that indexing or a pass succeeded. The scheduler still owns index outcomes,
new streams created by interleaved capture, reset admission and a fresh union
sweep after reset. Replacing a sweep retires its exact scope; indexed cleanup
deletes at most 128 obsolete rows per unit and refuses the active scope. Losing
this private table restarts enumeration without clearing retries, journal
checkpoints or the index. These primitives alone are not the full command runner.

`CaptureIndexOutcomes` records processing phases separately from membership in
that private inventory. The index-work bridge publishes outcomes inside the
admitted stream group's capture-state transaction, after the index commit and
run accounting. A failure in outcome publication rolls back its marks and run
counters together, leaving the admission for reconciliation even when index
rows survived. A later no-op can qualify those existing rows without guessing
the lost earlier run count.

A stored complete phase is only cached evidence. Before skipping that stream,
the outcome reader compares the current journal file version, completed
validation epoch/byte/count checkpoint and index count/byte/epoch cursors with
the recorded evidence. Growth, replacement, validation loss, outgoing count
writes or an index reset revoke mismatching evidence. This is metadata
requalification, not a historical content scan or new integrity mechanism;
locked validation/index work still owns processing authority. Outstanding
retries keep the stream pending. Ordinary inventory enumeration retains all
names, while outcome-aware selection skips only still-qualified completions.

The scheduler requalifies each stream once per worker pass. A stream found
qualified, or recorded complete by an index group, is not compared again by
later steps of that pass, and a walk that finds every stream qualified leaves
the index stage with no candidates. Each write the pass makes to a stream
revokes that: a capture unit other than an unchanged one, or an index outcome
other than complete. So does a new inventory member. A new worker, and so
every pass, requalifies every stream once; due retries, the completion audit
and other outcome reads always compare the evidence.

The source-work bridge can join an active index inventory to its processing
commit. It inserts every processed stream, including replay with no new append,
so streams created after directory discovery are not omitted. Duplicate
membership does not alter a prior outcome; subsequent outcome reads requalify
that evidence against the changed journal. A failed source transaction rolls
back membership with its source checkpoint and counters, while the durable
admission remains available to reconcile surviving journal bytes.

Reset-required outcomes remain durable and block further outcome-aware index
work in that sweep. Neither detection nor the outcome scheduler executes reset.
The owning scheduler must admit the separate atomic operation and replace the
inventory sweep afterward. Outcome audit pages inspect at most 128 names and
report how many still need work; their end-of-page `complete` flag is only audit
enumeration completion. The caller must also account for unfinished discovery,
new captures, retries, reset and other stages, and recheck after writes before
finalizing a pass. These outcome/source connections supply evidence to the
separate mixed-stage audit and owning command entry described below.

The private `CaptureIndexReset` bridge persists a union-reset request only
after an inventory outcome requires reset. The detecting worker publishes the
request and yields; a transient `resetRequired` continuation asks the pass
transport for a fresh normal worker allowance. Finalization never receives
that allowance. The reset bridge refuses the detecting worker, a normal worker
without reset admission, or an unreconciled stream admission. The owning entry
must dispatch reset before ordinary processing in that fresh worker. A restart
that lost the transient continuation can request another fresh worker from the
durable request; it cannot silently reset during ordinary processing.

Union-reset admission is separate from stream admissions. The reset transaction
uses the same atomic table mutations as public reset and commits a private token
in the existing index metadata table. It does not change schema version, owner,
journals, stream retry/failure rows or reader visibility. Only after that index
commit does a capture-state transaction publish a new, empty, pending inventory
scope, retire the old scope for bounded cleanup, record progress and remove the
request. These two commits are not a cross-database atomic transaction.

If sweep publication fails after the reset commits, a replacement worker uses
the index token to finish the bounded metadata publication without resetting
again. Index writes performed after the completed reset survive that recovery;
their counts are not reconstructed into the run receipt. If the reset itself
rolls back, the old index and request remain. The next registered worker, after
the predecessor has ended, reconciles the private admission into a pass-bound
failure and the fixed 30/60/120/240-minute retry delay. An attempted reset cannot
repeat in the same pass. A union failure does not identify a failing stream or
frame, so it creates no guessed stream-failure row and erases no stream retry.
The run writer must carry that returned failure into its actual pass receipt.
Completed-token recovery may finish metadata in a finalization worker; that
does not grant permission to execute another index reset there.

Reset completion starts index discovery/processing again; it is never indexing
completion or pass success. These reset and transport helpers still require
the owning mixed-stage entry to route reconciliation, healthy independent work,
deferred resets and final receipts. Transaction/reopen fixtures model this
handoff separately from actual worker-death and hosted manager qualification.

## First-upgrade cost

The first capture after upgrade must reconcile existing journals and rebuild the
search index. Capture and index groups amortize connections and transactions
over their member streams ([internal transaction groups](#internal-transaction-groups)):
a changed index group of several streams commits once per database, and an
unchanged one begins no index transaction. The bounded service must separately
qualify first-upgrade and unchanged passes beside actual v0.53.0 on a Linux
runner, including filesystem/runtime details, connection/transaction/sync
counts, resumable prefix proof and deadline progress.

## Downgrade and re-upgrade

The supported path is v0.53.0 → this version → v0.53.0 → this version, including
appends in each phase. Known legacy `index/capture-offsets.json` and
`index/capture-aw-seen.json` maps are invalidated before appends can make them
unsafe; invalidation failure refuses the append. Unknown root files are left
alone. Old capture rebuilds its offsets and IDs from the unchanged journals.
The separate new byte-cursor table leaves the old search-index count schema and
old named-column writes compatible. Old appends invalidate exact journal
versions and mismatched index counts on re-upgrade, requiring derived rebuilds.
Deleting the derived caches has the same recovery cost. No journal-byte migration
or rollback is required. Native-prefix set-aside is essential to that guarantee;
it does not rewrite history or append a sentinel or duplicate terminal turn.


## Private source inventory

`capture-source-queue.mjs` stores command discovery pages in the derived
`capture_sources` table. At most 128 input descriptors and the walk checkpoint
join one transaction. Replayed discovery preserves original ordinal positions
and completed outcomes. A new selection or a finished visit sweep creates a
new private scope; superseded scope rows are deleted by indexed 128-row units,
without scanning or resetting another owner's current inventory. Losing the
inventory table invalidates its discovery checkpoints and re-enumerates; it
never changes journals, source cursors, IDs or prefix-proof authority.

Ready-input reads use bounded database pages. Admission advances the persisted
source position before processing; source outcome changes commit alongside the
owning capture helper's source checkpoint. Rollback therefore retains the old
processing state while allowing another independent ready input its turn.
Native paths sharing a stream retain discovery precedence until the earlier
input reaches its fixed end, pending state or refusal. AW files may rotate
between bounded units in their shared stream; the existing retry selector still
applies stream-scoped backoff and admits no concurrent writer. The queue does
not clear failure rows or treat a finished inventory containing pending,
set-aside or failed inputs as a successful pass. Directory metadata work and
queue metadata work remain separate from source/journal content work.

`capture-source-discovery.mjs` connects an explicit ordered list of ordinary
`{ source, path }` roots to that queue. A persisted plan identity rejects a
changed root list within an unfinished sweep. Discovery rotates among cc, pi,
codex and AW, retaining caller root order within each format. Native traversal
uses the existing format layouts and stable `localeCompare` order; AW uses
code-unit sorted basenames. Each unit visits at most 128 metadata entries,
including irrelevant names, and inserts its selected files with the updated
walk position in one capture-state transaction. Its `added` count describes
the selected page, including any idempotent replay, not newly captured files
or processing progress. A failed commit discards volatile walkers so the next
unit reloads the durable checkpoint.

Directory-name arrays remain proportional to the selected directories and may
be rebuilt after worker replacement. Native walkers cache only active directory
stacks; AW caches one directory per current root. These are metadata costs, not
a bounded metadata-memory guarantee. Selected directory identities are checked
on reopening and before each page, including cached native ancestors. A fresh
missing optional root can enumerate as empty; a selected root cannot disappear
or be replaced silently. AW resumes by basename even when its anchor vanishes;
native traversal retains its conservative replay rule. Earlier arrivals can
belong to a later sweep. Closing or failing the bridge releases its caches.

The owning caller still supplies the queue's selection identity and either
explicit roots or a stable default-root plan. `capture-default-roots.mjs`
constructs the latter without filesystem work: explicit caller home/cwd,
selected formats, and only the native location environment keys. It does not
forward unrelated environment, credentials or Node runtime options. The
existing format selectors retain their configured-root refusal, relative-path,
Pi tilde/override precedence and Claude profile order. AW retains its home-based
log directory rather than inheriting XDG selection. The public synchronous
selectors and capture library are unchanged.

Default-root resolution is a separate owned discovery unit before file pages.
Its durable attempt binds the same sweep/plan/run/worker and unresolved format
group before the selector performs stat/readdir/sort. The private attempt's
`roots` phase identifies selection, and its path is the caller home context,
not an attributed journal or a claimed selected source path. Success commits
the format's ordered root list and directory identities with attempt retirement;
replacement reuses that list rather than rerunning selection. A new profile
appearing afterward belongs to a later sweep. Changed caller configuration
within an unfinished plan is refused. Excluded formats require no selector
I/O. A default-root plan cannot resolve without owning-run/worker context;
direct explicit-root readers retain their existing defaults.

Caught resolution errors and killed attempts use the existing format rotation,
pending failure/backoff and replacement reconciliation. An unresolved format
keeps its original selection inputs, not an invented partial root list. A due
resolution retry reruns that selector; successfully publishing the selection
resolves that operation's private retry, not the later file enumeration or
processing. The failed pass's failure evidence is retained. Publication rollback
keeps the unresolved attempt recoverable. Shared storage errors still propagate.
Once roots are published, their directory witnesses are carried into the first
reader and checked on later pages: deletion or replacement cannot become an
empty default merely because enumeration had not started. A fresh absent AW
default remains optional. No selection result itself grants completion.

Default-root selection may materialize and sort the home directory and retain
a list of matching profiles; this is proportional metadata cost, not a bounded
memory claim or transcript parsing. Each selected format adds one admission and
one publication transaction before its file pages; retries/reconciliation and
directory identity stats add work as well. All belong in hosted allowance and
storage/synchronization qualification. The ordinary CLI uses this plan, including
append-only `--no-index`. Protected exact-home/file operations retain their
separate synchronous path. Foreground watch may also enumerate roots in the
parent for advisory notification hints; those hints cannot change this plan.

Descriptors do not authorize access to protected captured history: existing
path guards apply, and this ordinary-root bridge accepts no custody-proof
fields. Protected exact-home/file frontdoors retain their own proof contracts.
Discovery completion means only enumeration ended; queued source processing,
newly created streams, retries, cleanup and final index validation remain
separate obligations.

When the owning session supplies its run and registered worker identity, each
selected discovery unit first commits an attempt bound to that worker, run,
sweep, plan, format/root and original checkpoint. This intent is not enumeration
or processing progress. Reader work runs outside that transaction. Successful
page/checkpoint publication retires the exact attempt in the same transaction;
publication rollback preserves both the original checkpoint and the attempt.
Before scheduling or opening run accounting, the registered replacement
reconciles an ended predecessor's attempt into private pending root failure and
backoff. The original run owns that failure; an observed current-pass process
failure cannot be assigned to an older admission. Same-worker reconciliation
and changed scope/plan/checkpoint are refused. This relies on the owning
bootstrap ending the predecessor before registering its replacement.

A caught reader refusal likewise commits private root-failure evidence and
format rotation while retiring its attempt before propagating the error.
The refused root keeps its exact checkpoint and stays incomplete. Its format
cannot advance to later roots, but a replacement worker can discover other
formats and process independent queued capture, index and cleanup work. The
failure remains bound to the failed pass; later healthy work cannot clear it
or invent a failed journal stream. Direct readers without owning-run context
continue to throw without publishing failure state.

Failed roots use the fixed 30/60/120/240-minute schedule and exclude the pass
that attempted them. Due discovery follows independent healthy work and
eligible stream/cleanup retries. One partial retry page per pass preserves its
attempt/date and marks that pass attempted; only completing the refused root
retires its pending failure. Restoring a selected directory permits recovery;
a different directory never inherits its checkpoint. A deferred root keeps
enumeration pending without blocking unrelated due work. These guarantees
require functioning shared capture state: failure-evidence publication and
page/checkpoint storage errors propagate, and cannot promise independent
progress. An unfinished attempt can be reconciled only once the shared state
is usable again. Owned discovery adds one admission transaction per selected
page; page publication and retirement share the existing page transaction
(with its nested queue savepoint). Final storage accounting must include these
commits, retry/reconciliation transactions and actual synchronization cost;
no lower fsync-cost claim follows from connection reuse.

`capture-source-work.mjs` joins one selected source group to those queue
checkpoints and `CaptureRun` accounting. Locks precede the admission commit and
processing transaction. Each input/category contributes to its run's counters
once even when recovery spans workers; the visit flags live in derived database
rows, not a process-wide file map. No-op visits do not count as processing
progress. One AW account per shared-stream admission preserves serialized
appends while the queue position allows other accounts their turn. A due retry
is a single-stream admission, and an incomplete proof cannot clear its failure.
Other-stage retry work returns to the scheduler rather than being mistaken for
capture work. Allocation cleanup remains a separate committed-lifecycle step.

These private primitives do not themselves hold a root lock or implement the
complete command runner. Their caller must own that lock, enforce the common
budget, reconcile unfinished admissions, and publish the actual run outcome.

## Private worker dispatch

`CaptureWorkSession` joins source/index processing, reset handoff and run
accounting inside an already registered supervisor worker. Its bootstrap caller
must own the root lock and have ended the predecessor before construction. The
index-enabled session shares one capture-state connection and one search-index connection,
reconciles durable stream, cleanup and union-reset admissions, then opens current run
accounting. A recorded failure is bound to its run identity: an observed failure
in the new pass cannot diagnose an older abandoned admission. Prior history
remains distinct from failure in the current pass, including a child that died
before publishing any receipt. Persisted reconciliation facts survive a second
interruption before run publication.

With an explicit root plan, each dispatch step advances at most one bounded
source-discovery page, one index-discovery page, one source or index group and
one healthy cleanup turn after a selected group. Without a root plan, the
caller supplies source pages as before. The last durable admission's stage
determines which processing stage goes first next, including after a rolled-back
group; no extra per-record or per-unit routing transaction is added. Source groups register new
streams in the current index inventory as part of their processing commit.
Cleanup uses its own allocation admission and cursor transactions; it does not
replace the durable source/index stage position or claim lower sync cost.

Healthy selection in both processing stages suppresses retries. Only after both
healthy stages and eligible discovery are exhausted does the session route a
due retry through its own stage as a single-stream admission. Retry filtering retains
unavailable capture inputs and other-stage work without changing their attempt
or retry date, so they do not hide eligible source/index retries. Selection
checks cooperative stop between bounded metadata pages/rows. Stage helpers keep
their earlier default retry behavior when used without this dispatcher.

When no healthy group is selected, the session advances healthy cleanup pages
before due work. Due cleanup follows healthy source/index work, eligible source
and index discovery, and source/index retries. Cleanup can progress without a
ready source. A cleanup exception leaves the already-committed group counts
intact; replacement reconciliation applies backoff while independent healthy
work remains eligible. A completed page or idle selection does not prove that
every deleting reference has finished, especially across cursor wraparound.

A native input with its exact `stream:path` recovery claim in deleting phase
depends on that allocation's cleanup. Selection rechecks the durable claim and
excludes that input from both healthy capture and due capture retry until the
claim retires, even if its directory is already absent. The source stays ready;
neither its completion nor retry resolution is invented. Independent source and
index work can drain before due allocation cleanup, after which the next
selection can resume the native input. This avoids repeated cleanup-only source
admissions starving the allocation's own backoff queue. Unrelated paths/streams
and existing stream retry evidence retain their normal scheduling rules.

A fresh reset worker dispatches the union operation before ordinary work. A
committed reset reopens the published pending inventory; an interrupted one is
reconciled before processing. Detection requests a new worker rather than
resetting in place. Deferred reset leaves independent source work eligible while
index processing is blocked. Finalization can recover a committed reset's
bounded metadata publication, but performs no discovery, source/index group,
cleanup deletion or new reset.

Yielding publishes pending run facts. `finish()` is a conservative stop receipt,
including for a finalization-only worker; it does not infer success from idle
selection. The owning normal worker calls `complete()` for the separate final
decision. `capture-completion.mjs` verifies source enumeration and outcomes,
discovery/root failures, stream/cleanup/reset/discovery admissions, retries,
retained allocations/stages, issue rows and obsolete inventory cleanup. Only
complete or ignored source outcomes can contribute to success. Every current
index outcome is checked against its journal generation, validation and index
cursor evidence again. A fresh index-name/live-name union check adds missing
members as ready work, including journals arriving before an earlier discovery
cursor; they require processing before a later audit can succeed. Neither idle,
reset publication nor a completed enumeration is a completion certificate.

The audit uses SQL pages of at most 128 rows and cooperative checks between
metadata entries. Sorted live directory names retain the existing metadata-array
cost qualification. Capture-state then index write reservations prevent supported
database writers from changing the checked state during the audit. It acquires
no stream locks and reads no journal content while holding those reservations.
Journal evidence retains its per-stream metadata qualification; this is not a
root-wide instantaneous filesystem snapshot or a new historical integrity proof
against arbitrary raw file edits. Directory identity replacement is refused;
observed directory changes or newly discovered members leave pending work.

Audit progress is worker-local: an interruption or deadline cannot turn a saved
partial scan into later completion authority. A replacement verifies afresh.
Source/content/index recovery and discovery retain their resumable checkpoints.
The final metadata audit must fit one admitted normal worker; its lock duration,
directory metadata memory and 1,300/thousands-stream completion time remain
explicit hosted Linux/storage qualification gates. No measured bound or final
service qualification follows from this private implementation. Each audit adds
one capture-state transaction and an index reservation released without index
mutation. Missing memberships or a retirement intent can add capture-state
writes; include their real synchronization cost in storage accounting.

Terminal source visits can request retirement even when a torn, set-aside or
failed input makes the receipt partial. The intent is bound to the source scope
and run. It takes effect only on a later normal construction that sees that run's
published final receipt; death before publication preserves the same source
scope and confirmed counters. The next source sweep also renews index discovery.
Old source/index inventories retire in bounded pages after healthy work, without
manufacturing capture/index progress or counts. Pending inputs are thus revisited
on a later sweep without being treated as successful in the earlier one.

An empty healthy audit may publish complete. Current-pass failure still overrides
healthy work and complete audit evidence; an older failure remains history and
does not poison a later success. Confirmed counts come only from their existing
processing commits, never audit scans or reconstruction. Ordinary CLI dispatch
uses this session. Protected exact-home/file operations retain their existing
path; explicit hooks use a detached caller of the same session. Installed
periodic service migration uses the setup gate below.

### Append-only worker mode

The private session's `indexEnabled: false` option implements the supervised
ordinary-command path for `--no-index`. The default remains enabled.
A disabled session never constructs or opens `RecordIndex`, including during
replacement or finalization. It does not create `turns.db`, register new stream
membership, instantiate/rebuild index inventory, dispatch/reconcile union reset,
retire index inventory or modify its source binding. Existing index/reset
requests, retries and outcome evidence remain for a later enabled pass. Common
stream-admission reconciliation still records an abandoned index group in
capture state; its deferred index retry is not processed or erased by capture.

Source/default-root discovery, source capture, retained-allocation cleanup and
their eligible retries keep their admission, dependency, backoff and fairness
rules. Index/reset work cannot block independent healthy capture. Housekeeping
collects only obsolete source scopes, leaving index garbage and inventory intact.
Source-sweep renewal does not invalidate that retained index evidence; an
enabled session subsequently reconciles its source binding and discovers all
live/indexed names before claiming completion.

Append-only `complete()` performs a fresh source-only retirement audit, never
the all-stage/index audit. It checks terminal visits and source discovery,
refuses retirement while source/stream, cleanup or discovery admission remains,
and publishes an intent bound to the source scope and run with no index scope.
An unfinished or failed discovery group prevents this intent. As with full
audits, terminal unsuccessful input visits may be renewed only after a final
receipt, and interruption before that receipt retains the same scope/counters.
This audit adds one capture-state transaction, paged source-row inspection and
an optional retirement write, with no index reservation. A stopped scan provides
no reusable proof. Its normal-worker allowance, reservation duration and actual
synchronization costs remain hosted storage-qualification obligations.

Even an empty or fully visited append-only sweep remains pending/partial, or
failed for a current-pass failure: it supplies no fresh index/all-stage proof.
Prior success/failure history and confirmed counts remain distinct from that
decision. The ordinary CLI uses this mode without changing public synchronous
APIs or protected exact-home/file receipts. Explicit hooks can select this mode;
installed service integration and hosted qualification remain separate obligations.

### Fixed private command entry and issue preparation

`runCaptureCommand(root, options)` fixes the package worker entry and existing
supervisor policy. Its private options require an owner, caller-bound default
root plan, index-enabled boolean, explicit trigger and explicit retry boolean.
Unknown options cannot supply a different worker path, executable, Node flags
or timing/resource policy. Relative record roots resolve against the supplied
caller cwd; source selectors still run only after worker admission. Triggers
are manual, watch, hook, setup or service, never inferred from quiet output.
The fixed worker requires the existing IPC/registered-lock bootstrap; direct
invocation does not authorize capture.

The operation constructs the owning session, dispatches its bounded units,
yields for fresh reset/continuation allowance and requests the actual final
audit on idle. Only the worker publishes run facts. A finalized matching
receipt supplies the private IPC appended/pending projection while the
supervisor still holds the root lock; the caller neither reconstructs missing
counts nor reads another pass's later status as its own. Operational failures
leave admissions and unfinished receipts for replacement, while cooperative
stops retain the existing pending continuation behavior. Transport failure may
return without that receipt projection and must not become a zero-count success.

Before source enumeration/processing, the command session prepares issue rows
in keyset pages of at most 128. Each page commits issue changes, any existing
queued set-aside rows made ready, and its resume key together. The checkpoint
binds owner, source sweep, run, selected formats and retry request. Replacement
resumes committed pages; rollback keeps both the cursor and issue generations
unchanged. Preparation supplies no capture/index counts or progress.

Ordinary preparation retains the synchronous native reconciliation rule:
selected-owner, selected-format ignored issues can be removed without opening
their source, even if the default directory disappeared. Other owners/formats
remain untouched by that exclusion. Explicit all-input retry requires the full
format selection and marks the root's unresolved issues as the existing public
retry operation does, including other owners' retry intent without capturing
under another owner. The run identity is the stable private retry generation;
once prepared, a refusal in the same run is not marked for retry again.
Existing source/index/cleanup failure backoff is separate and never cleared.
Public synchronous `retrySetAside` and `resetSourceCursors` are unchanged.

Preparation finishes before content dispatch so newly refused inputs cannot
re-enter its initial scan. Stop/finalization cannot start a page. Both completion
audits refuse success/retirement while preparation is unfinished. This adds one
capture-state transaction per page, including its checkpoint and per-issue
generation updates; ignore loading/matching and total metadata scan/lock/sync
costs remain hosted qualification obligations. Pages resume across workers,
but preparation is not source enumeration or all-stage completion.

### Ordinary CLI and foreground watch

Ordinary capture, `--sessions-only`, `--aw-only`, `--no-index` and
`--retry-set-aside` await the fixed private entry. The CLI copies home, cwd and
the selected native location environment into its plan. Quiet controls output,
never trigger identity: ordinary and explicit retry use `manual`; the first
foreground watch pass and later ticks use `watch`. Legacy quiet hook argv
remains manual; the setup first pass explicitly uses `setup`. Quiet
never invents hook attribution or a timeout cause. `--reset-cursors` remains reset-only;
exact-home/file proofs and public synchronous libraries keep their paths.

Ordinary `--json` remains a usage error. Retry JSON retains exactly
`{appended, pending}` from the matching worker projection. No caller reads a
later status snapshot to fill a missing projection. Operational failure exits
nonzero; a missing projection explicitly says the appended count is unknown.
An `io` failure line (`capture worker failed (io): <message>`) carries the first
failing worker's one-line diagnostic, bounded to 512 characters with control
characters removed and parser errors reduced to their class; it reaches stderr
only, never the published status, whose failure message stays fixed.
A dead lock owner whose recorded start is missing, malformed or in the future
is still reclaimed and reported on stderr, but published as `reclaimedLock: null`.
Partial work exits zero without claiming completion. Ordinary lock overlap
exits zero and preserves the existing receipt; recovery overlap instead reports
that recovery was not performed and exits one. Lock reclamation, uncertain
holders, initialization and release failures retain operator diagnostics.
Nonquiet progress reports confirmed new turns and outcome; `index: updated`
is emitted only for an enabled, fully completed pass, never a partial one.

Foreground watch retains its two-second debounce and fifteen-minute fallback.
Its parent may enumerate selected default directories to install best-effort
filesystem notification hints. This metadata work is proportional to profile
inventory and is not a worker memory/allowance claim. Neither a hint nor its
absence selects capture inputs or grants custody; only the admitted saved plan
does that. Enumeration/installation errors leave periodic reconciliation active.
Notifications coalesce while a pass runs; at most one pass is active, with one
pending rerun. Stop cancels timers and future work, closes watchers, and leaves
an active supervisor responsible for child termination/reaping and lock release.
A failed later tick reports the error and retains a nonzero eventual exit status
while periodic scheduling continues. It cannot strand the queue as busy.

The small-heap algorithm fixture invokes synchronous capture/index libraries
directly: lowering the CLI parent's heap cannot lower its fixed-policy worker
heap. Actual CLI fixtures separately cover worker routing, selected capture,
append-only catch-up, recovery receipts, overlap and foreground scheduling.
Package health and [kernel doctor delegation](#kernel-doctor-delegation) are
implemented; health/doctor runtime qualification, fresh-audit/parent
metadata/storage/synchronization and full hosted manager and rollback
qualification are still required before service acceptance.

### Detached hook launcher

`capture --hook` copies owner, home/cwd, selected native location environment,
source selection and index mode into the fixed package supervisor's argument.
It performs argument validation and OS spawn only: no capture lock, status
read/write, network, default-directory resolution or source scan. Root selection
still belongs to the admitted worker. Caller options cannot replace the Node
executable, package entry, worker or resource policy. The supervisor starts in
its own session/process group with all three standard streams ignored and a
filtered environment; it does not retain harness pipes or Node preload options.
The launcher unrefs it after the spawn event and exits. Killing the launcher
after spawn does not terminate that detached child.

Exit zero means **capture launched**, not supervisor initialization, admission
or capture completion. Nonquiet acknowledgement says so; quiet suppresses it.
Spawn or argument failure prints one stderr line and exits one. Hook mode never
uses exit two, including usage errors, because Claude interprets that status as
Stop-blocking/model feedback. Ordinary usage errors outside hook mode retain
their existing status. Proof, recovery, JSON, health, watch and reporting modes
cannot be combined with `--hook`. Sessions-only/AW-only and append-only flags
are copied explicitly, without resolving inputs in the launcher.

The detached supervisor owns the usual root lock, registered workers, failure
handling, child reaping and lock release. Admitted worker receipts use trigger
`hook`; overlapping launches do not create another pass or overwrite history.
The launcher writes no receipt. Failure after OS spawn but before a worker can
publish status may leave absent or older status, and ignored stderr cannot
report that failure back to the completed harness call. Launch acknowledgement
is therefore not a health check: use `capture --health` or deployment doctor.
Hosted lifecycle qualification remains a separate gate. No numeric launch
latency is established by this implementation.

Setup refreshes recognized owned Stop/SessionEnd entries to the hook entry,
`<node> <package>/bin/capture-hook.mjs --owner <owner> --quiet --root <root>`
(the same launch as `capture --quiet --hook`), with `async:false` and
`timeout:10`, even when their command already matches. The hook runs its own
entry because 0.61.0 and earlier releases do not have that file: after a
rollback the persisted line fails to load with exit 1, which does not block
Stop or SessionEnd, where an older `capture.mjs` would reject `--hook` with
exit 2. Setup recognizes the `capture.mjs` forms earlier releases wrote and
replaces them in place. The
harness waits for the short launcher so its spawn result is ordered before
harness shutdown; capture itself remains detached. The timeout applies to that
launcher, not to the detached supervisor or its fixed worker allowance. The
existing ownership recognition, duplicate groups, foreign commands and other
fields are preserved; dry-run does not write settings. The same user
`settings.json` (the person's `~/.claude`, or the Claude config a launch uses)
has a second writer, oats.setup's `/oats-agent-permissions`, which merges only
`permissions` and the `autoMode` block after keeping a `.before-oats` copy;
setup touches only the capture `hooks` entries, so the two do not conflict. The install hint uses
the same scheduling fields while retaining `--sessions-only --no-index`.
This changes persisted settings from `async:true`/`timeout:120`; installing a
CLI alone does not rewrite those settings. No release from 0.56.0 through 0.61.0
shipped this hook migration. Periodic service conversion uses
the separate setup gate below.

### Setup first pass

After its requested installation steps, non-dry setup awaits the same fixed
private supervisor as ordinary capture, with explicit `setup` trigger,
all sources and indexing enabled. It copies caller home/cwd and native location
environment; the admitted worker resolves source directories. The first pass
uses the running `process.execPath`, not the stable Node pathname being written
into future hooks or manager definitions. `--no-service` skips only manager
files and manager inspection/actions; it does not skip this pass. `--dry-run` starts no worker and
creates no capture store, lock or status.

Setup retains the foreground privacy-file preflight before lock acquisition.
Shared foreground presentation uses only the matching worker projection for
counts and pending state. Complete and partial return zero with their actual
outcome; overlap returns zero with the holder/recovery and skip message without
rewriting the holder's receipt. Operational failures and missing projections
return nonzero; absent counts are unknown, never fabricated zero. Initialization,
reclamation and release diagnostics retain their existing recovery guidance.
The supervisor owns signal handling, child reaping and lock release; setup is
not another status writer. Ordinary/retry text and JSON, protected exact-home/file
receipts and public synchronous APIs retain their contracts.

First-pass routing follows the service migration gate when service installation
is requested. It does not provide health/doctor acceptance or hosted
Linux/manager/rollback qualification. The shared presentation
adds no status transaction or counter reconstruction; existing source/audit
allowance, reservation and actual storage/synchronization costs remain gates.

### Finite service entry and periodic definitions

The private `capture-service-runner.mjs` entry takes one serialized request with
explicit record root, owner and default-root plan. Relative record roots resolve
against the copied caller cwd. Home, cwd and the four native location values
come from that plan rather than the service process's ambient source selection.
It requires all formats and fixes indexing enabled, retry preparation off and
trigger `service`; the request cannot select an executable, worker or resource
policy. After validation it reads the privacy policy before acquiring a lock,
then uses the fixed supervisor and shared foreground presentation. Complete,
partial, overlap, operational failure and absent receipt retain the setup/manual
meanings above. There is no second status writer, repeated pass loop or manager
operation in this entry.

`capture-service-definition.mjs` constructs definitions without filesystem or
manager access. Both formats carry `oats-turn-record-service:1`. The recorded
absolute Node runs the fixed package entry with the explicit request as one
argument, with XML/systemd-specific escaping and refusal of values the selected
manager cannot represent safely. No shell evaluates the request. XML preserves
literal carriage returns through character references; systemd arguments escape
both specifier and environment expansion syntax. Unsupported executable quote
or backslash spellings are refused for systemd rather than silently rewritten.

The macOS definition names `ai.aweb.turn-record-capture`, uses `RunAtLoad` and
`StartInterval` 900, and has no `KeepAlive` or watch argument. Linux pairs a finite
`turn-record-capture.service` (`Type=exec`, `MemoryMax=2G`, `RuntimeMaxSec=300`, no
restart loop) with `turn-record-capture.timer` (`OnBootSec=1min`,
`OnUnitActiveSec=15min`). A timer/schedule is not a permanent worker PID.

Setup uses these definitions through the migration gate below. Constructing a
definition alone proves neither installation nor enabled/registered scheduling.
Source-only argument-decoding fixtures do not replace hosted manager tests;
this entry introduces no additional capture-state transactions beyond the
existing fixed command path.

### Setup service migration

`setup --root <dir> --owner <name>` persists the resolved root and owner in
hooks and the service request, alongside explicit caller home/cwd/native
location selection. The recorded stable Node is used for future launches;
the first pass still uses the running Node. These are user-manager definitions,
not deployment automation timers. No external wrapper is removed.

The setup coordinator prepares hook edits in memory, then
`capture-service-install.mjs` uses `capture-setup-write.mjs` to snapshot every
named service target and inspects applicable manager state before any
service/file/hook/capture mutation. The shared module owns checked setup
publication independently of manager policy; the service module retains its
snapshot/recheck/write exports for existing callers.
Snapshots retain regular-file bytes and identity or the symlink's own identity
and target, plus ancestor identities and explicit missing-ancestor records. Reads are limited to 1 MiB per target;
unknown reads, nonregular targets and unsupported manager output refuse.
`capture-service-ownership.mjs` parses only supported marked templates and
the actual unmarked direct-Node `capture.mjs --watch --owner` templates with
their known structure. Paths may name a moved or missing install; recognition
does not execute them. A basename, shell mention, wrapper, unsupported marker,
malformed file or extra directive is not ownership.

Foreign files or registered identities produce `E_CAPTURE_SERVICE_FOREIGN`;
installed disabled/masked state produces `E_CAPTURE_SERVICE_DISABLED`, whose
message states the manager state observed. It does not claim the operator
disabled the unit: a timer that setup wrote but failed to enable reads as
disabled too. Both refuse before mutation and print quoted recovery commands
in the user-facing form preserving the selected owner/root: `oats setup …`
when a node was handed in through the kernel environment (`OATS_NODE_BIN`,
which `oats setup` sets and instance shells also carry), otherwise
`turn-record setup …`; both commands work and record the same node: explicitly choose
`--replace-service`, or `--no-service` to preserve the manager configuration.
Other setup failures print the same form of retry command; none names the
running Node or the package-internal setup script. New absent definitions
are not disabled. A macOS `launchctl print-disabled` entry for the label is the
exception: launchd keeps that override after the plist is gone and setup never
writes one, so it is operator state and refuses even when the named plist is
absent. Setup reads only the disabled-services block of that output, accepting
both `true`/`false` and `disabled`/`enabled` values; any other entry refuses. Replacement intent never waives unknown state, read errors,
unsupported drop-ins, backup failure or identity changes. On macOS, a
registration of `ai.aweb.turn-record-capture` loaded from any plist other than
the named one is foreign and is refused naming that path, even with
`--replace-service`; setup never unlinks or boots out that file. `--no-service`
bypasses service target reads and manager calls entirely. `--dry-run` reads
target files but writes nothing and calls no manager; unloaded/disabled state
is explicitly unexamined; a dry run also names a present pending-activation
marker and whether a run would retry it or remove it as stale.

Apply rechecks file/ancestor identities and manager ownership/enablement.
Replaced bytes or symlinks are saved nonoverwriting in a reported datable
`<root>/service-backups/<date>-<unique-id>/` directory. Symlink backups
preserve the link instead of reading or removing an external wrapper target.
Backup bytes and directory/symlink entries are not fsynced and cannot be relied
on as power-loss-safe recovery. Durability of a replacement does not establish
backup durability; this is tracked separately in
[backup durability follow-up #1410](https://github.com/awebai/oats/issues/1410).

An ancestor absent at preflight must remain absent until this apply creates it.
Creation proceeds one directory at a time without recursive adoption of an
existing path; each created non-link directory's identity is retained in a
per-apply map shared by subsequent service and hook writes. Newly introduced
directories or links are not accepted as extra ancestry. Existing ancestor
identities and observed symlink targets remain binding. The extra metadata
checks and directory creation do not establish an atomic filesystem operation.
Each setup hook, service definition and pending-marker write uses the same
checked publisher. It creates an exclusive 0600 temporary file, checks its
open descriptor against the pathname, writes the complete contents and fsyncs
the file before rename. After rechecking the saved target, temporary file and
ancestors, it renames and fsyncs the containing directory through a checked
directory descriptor. Newly created ancestor entries are synced in their
containing directories, from the first missing parent toward the target,
before creating the next child. A directory whose entry sync/open/close failed
is not authorized for reuse by a subsequent write through the per-apply map.
Required directory fsync failures, including an unsupported operation, refuse;
there is no fallback that reports durability without the required sync.

A failure reports the target and stage, retains the primary cause and any
scratch/descriptor cleanup failure, and exits nonzero. Before publication,
the writer preserves the old target and removes only scratch whose saved
identity and unchanged ancestry still prove ownership. Changed ancestry or a
substituted temporary file revokes pathname cleanup; an interrupted/refused
write can leave its original temporary file. After rename, a failed sync,
close or identity recheck reports that publication may have occurred and
durability was not established. It neither unlinks the new target nor claims
rollback. A refused rename whose original target cannot be re-established is
reported with the same uncertainty.

These are ordered filesystem durability operations, subject to the filesystem
and storage device honoring fsync. Recording and injected I/O-fault fixtures
check process-visible bytes, identities, permissions, failures and ordering;
they do not reproduce or prove survival of a physical power loss. This setup
publisher does not change ordinary capture transaction sync policy or the
pending marker's activation/removal lifecycle.
An expected manager unmask can remove only the saved named `/dev/null` link;
other observed replacements refuse. These checks detect observed races, not
an OS-wide atomic transaction over files and managers.

On macOS, changed/legacy registered jobs are booted out before replacement;
missing registration is bootstrapped. An unchanged enabled registered periodic
job receives no restart. On Linux, conversion stops the timer before the
service, disables the legacy service's boot activation, writes the finite
service and timer, reloads and enables/starts the timer. Explicit replacement
can unmask only the named units. An unchanged enabled active timer preserves
an in-flight pass; an inactive finite service between ticks is normal.
Setup verifies registration/enablement and expected definitions before saying
“periodic capture scheduled (every 15 minutes)”. It does not promise a permanent
PID or infer worker completion. Manager and setup first passes can overlap;
the capture root lock admits one.

Manager commands have finite time/output limits; completed mutation commands
and definition writes are reported before subsequent steps. Failure reports the action,
reason and recovery without inventing scheduling or capture results. Apply
can leave backups, stopped jobs or written definitions before a later failure;
there is no global atomic rollback. Inspect the reported state and rerun.

**Pending activation.** Before its first replacement backup, manager change or
definition write, setup writes a private (0600) pending-activation marker,
`<root>/capture-service-pending.json`, the way it writes every setup target:
against what preflight saw, refusing a marker or record root that was replaced,
linked or created since (`setup target changed since preflight` / `setup target
parent changed since preflight`; re-run setup). It removes the marker only once
activation is verified (`service: activation verified; pending-activation marker removed`).
A failure in between leaves it. On a rerun, a loaded, unmasked disabled unit
beside setup's own marked definitions and a live marker is setup's own
unverified activation (on Linux, the timer a failed `enable --now` left): it is
retried with no flag. Without the marker, the same state is an operator's
disable and is refused with `E_CAPTURE_SERVICE_DISABLED` and both remedies. A
marker with no unit, or beside a unit without setup's mark, is stale: setup
removes it and names it, and it authorizes nothing. A verified activation,
including an explicit `--replace-service`, removes the marker. The package has
no service uninstall command. On macOS an unfinished activation leaves the
plist unregistered, which a plain rerun already bootstraps; a launchd disable
entry is always an operator's. `capture --health` reports a present marker as
`capture-service-pending` ([offline diagnosis](#offline-installation-and-run-diagnosis)).

**Service failure.** Preflight refusals (foreign, operator-disabled,
indeterminate state) change nothing. When apply fails after preflight passed,
setup still writes the hooks and runs the bounded first pass, then exits 1:
capture is never skipped for a service failure, and the failure is never
hidden in the exit status. Capture receipts retain their own failure and
partial meanings. A rerun after the remedy changes nothing that is already
right; it only completes the activation.

**Setup summary.** Once setup starts changing things (every run but
`--dry-run` and preflight refusals), it ends with one setup summary on stdout:
fixed labels, one item per line, in this order on every run. With a nonzero
exit it is the setup failure summary.

```
setup summary:
  status: complete | incomplete (exit 1)
  hooks written: <settings path>        (one line per file written, or "none")
  first capture pass: appended <n>, pending yes|no | skipped: another pass holds the record root | failed: <reason> | not run
  service: scheduled | failed: <reason> | skipped (--no-service) | no service template for <platform> | not changed
  service changed: <change>             (after a service failure: one line per change it had already made)
  remedy: none | rerun <oats|turn-record> setup --owner <owner> --root <root> [flags] | inspect <oats|turn-record> capture --health --json, then rerun …
```

A caller reads a nonzero exit with this block as "these changes were made",
never as "nothing happened". After a service failure, `service changed` lines
name, in order, what the failed apply had already changed: the replacement
backup directory, each manager action completed (units stopped, disabled or
unmasked, a job booted out), each definition written, and the pending-activation
marker written or a stale one removed. A failed publication also retains any
created-parent evidence and names a possibly published target and its failed
stage in these lines. A hook published before a later durability failure is
listed under `hooks written` with the same uncertainty and stage, rather than
reported as `none`. These annotations describe possible changes, not successful
durability or rollback. Setup has no `--json` mode.

Fake-manager and isolated CLI fixtures exercise this ordering and refusal
contract. Real-manager cases live in `test/capture-service-real-darwin.test.mjs`
(launchd) and `test/capture-service-real-linux.test.mjs` (systemd --user). They
run only when `GITHUB_EVENT_NAME` is `workflow_dispatch`, `GITHUB_WORKFLOW`
names their own workflow ("macOS tests" or "Linux tests") and the platform
matches, and skip with that reason everywhere else, pull-request CI and any
developer machine included; a skip is not evidence. They cover the real
`print-disabled` output against setup's parser (first), first install,
conversion from an owned legacy watcher with no surviving watcher, an
unchanged rerun preserving an active pass, a changed definition taking effect,
the #1099 failed-enable rerun, unloaded recovery, the next idle trigger, the
effective `MemoryMax`/`RuntimeMaxSec`, and missing, failing or signalled
managers. The idle-trigger case uses the definition's internal interval seam
(default and production value 900 seconds; no CLI or setting reaches it).
The qualification harness (`test/capture-qualify-*-linux.test.mjs`, helpers in
`test/fixtures/qualify*.mjs`) runs under the same guard on the dispatched
"Linux tests" runner only. It measures, and reports as JSON lines and tables,
first upgrade and no-op at 1,300 and 3,000 synthetic streams (scaled against
a population of about 1,300 streams and 8.4 GB of journals by a stated factor), an
operator-shaped first upgrade at both counts with most bytes in sessions over
8 MiB on the retained path, caps-off
memory scaling, the outgoing 0.61.0 and 0.53.0 releases side by side,
8/16/22.3 MB journal frames and near-limit records under the capped worker,
Codex in-prefix recovery, old-new-old-new rollback with released 0.61.0, the
rollback of the hooks and the periodic service to 0.61.0 (the hook entry exits
1, a service start fails, and 0.61.0's setup restores its watcher and hooks),
and hook launcher latency. It runs the production operation under the real
supervisor through the existing worker seam with the test counting patches;
its assertions are structural, and its numbers are evidence only from an
executed run.
Quoting qualification remains a hosted obligation.
Health/doctor runtime qualification, final schema delivery and full service
acceptance remain separate; audit allowance/reservation/storage/synchronization
gates are unchanged.
