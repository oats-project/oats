# @awebai/turn-record

The turn record: an append-only, content-addressed, replicated record of
turns, with the core tools over it — `capture` and `recall`. The normative
contract is [`docs/turn-record-sot.md`](docs/turn-record-sot.md) in this
package; the conformance vectors under `test/vectors/` pin the format
(`node test/vectors/validate.mjs`, dependency-free).

Turns in this append-only record are content-addressed. Native session turns
are not signed. Projected aweb mail and chat keep their original message
signatures verbatim.

After `turn-record setup` runs on a machine, this package gathers Claude Code,
Pi, and Codex transcripts plus aw client logs. It skips sources matched by the
local record's ignore list. The package keeps captured conversations durably
and finds them again. The experimental tools that select and synthesize over
the record (dress, spawn, segments, mind) live in `packages/experimental` of
the oats repo and run as `oats experimental <cmd>`. They are deliberately not
part of this package.

- **`lib/canonical.mjs`** — canonical JSON (integers only in the core),
  `t1:` content ids, did:key Ed25519 verification. Byte-compatible with awid
  message signing.
- **`lib/store.mjs`** — the store: `streams/<owner>~<source>/journal.jsonl`
  (owner-only append, torn-tail tolerant), `objects/sha256/` (immutable
  blobs), `index/` (derived, never replicated). Merge is prefix extension
  per stream + set union by id; non-prefix copies are quarantined, never
  silently merged. Tombstones hide, v1 authority = author or record owner.
- **`lib/project-aweb.mjs`** — projections of aweb messages (signed rows,
  legacy rows, client comm logs, interaction logs) into turns. Pure
  functions of the source: the same message projected on two machines gets
  the same id, so replicas dedupe by union.
- **`lib/capture-cc.mjs`** — session capture (Claude Code, pi, Codex via
  the format registry in `formats.mjs`). Every native transcript record
  becomes ONE turn holding the verbatim line (`body.line`), in a
  per-session stream `<owner>~<source>.<session-id>`; capture is
  incremental by source byte offset, so a growing session appends only its
  new events — storage is linear in conversation size by construction, and
  the original transcript is reconstructible by concatenating `body.line`.
  Reconciliation is the capture (hooks/watchers only decide when to run
  it).
- **`lib/capture-aw.mjs`** — aw client log capture into `<owner>~aw`.
- **`lib/index-db.mjs`** — derived SQLite FTS5 index (`node:sqlite`, no
  dependencies). `update()` is incremental; `rebuild()` is reset + update
  from zero (same code path). Session text is extracted per event with
  exact line provenance; tombstoned turns disappear.
- **`lib/segments.mjs`, `lib/tags.mjs`** — parsers for the note
  conventions (segments, spawn notes, tags, outfits) that experimental
  tools write into the record. They live here because the index reads
  every note in the record; the machinery that writes and uses these
  notes is experimental.

## Install and run

One shipped bin, `turn-record`, with three subcommands. From a checkout use
`node bin/turn-record.mjs ...`; from an npm install (the package has zero
dependencies and packs clean — `test/packaging.test.mjs` proves the tarball
runs standalone) just `turn-record ...`. Inside an oats install the same
commands are `oats capture|recall|setup`.

```bash
turn-record setup        # install Stop/SessionEnd hooks into every
                         # ~/.claude*/settings.json, install periodic capture
                         # (launchd on macOS, systemd user service + timer on
                         # Linux), then run the first capture pass.
                         # Idempotent; --dry-run previews; --owner overrides
                         # the machine name. --root selects the persisted store.

turn-record capture                  # one reconciliation pass, then index update
turn-record capture --watch          # pass now, on filesystem change, every 15 min
turn-record capture --status         # stream summary

turn-record recall "sqlite fts"                 # search mail + chat + sessions together
turn-record recall --kind mail --from acme/x q  # filters
turn-record recall --thread aweb:conv:<id>      # list a thread chronologically
turn-record recall --show t1:<hex>              # print one turn
turn-record recall --reindex                    # full rebuild of the derived index
```

`recall --thread <thread> --json` lists a thread in capture sequence.
For a thread spanning aweb accounts, cross-account sequence under the service
is unspecified, and an ID window may contain turns from more than one account.
`--after <id>` excludes its boundary; `--until <id>` includes its boundary.
`--ids-only` uses the same window and reports IDs and output byte sizes. Later
appends do not reorder an existing window; existing tombstone visibility rules
still apply. Text thread listings without a query remain timestamp-sorted.

Store root: `--root`, else `$TURN_RECORD_ROOT`, else `~/.turn-record`.

`recall --show` refuses a turn hidden by its author's tombstone, including a
session event whose tombstone lives in another stream. It emits no turn payload
and exits with status 1, as it does for a missing turn.

**The `node` that `setup` writes down.** The hooks and the service's unit name
a `node` by its path, and only `setup` run again rewrites them. Which path
depends on how it is run:

- **`oats setup`** records a path that survives an upgrade of Node where there
  is one (on Homebrew the `opt` link, not the versioned keg), and warns when
  there is none. The kernel works it out and hands it in as `OATS_NODE_BIN`.
- **`turn-record setup`**, run alone, has no such rule. It records
  `OATS_NODE_BIN` when that is set to an absolute path, else the `node` it runs
  under (`process.execPath`). On Homebrew that is the versioned keg, which
  `brew upgrade node` removes: run `setup` again after an upgrade.

`--dry-run` prints the `node` it would record. The first capture pass always
runs under the `node` that runs `setup`.

Each path is written for what reads it: a shell word in the hook's command,
systemd's quoting in `ExecStart`, XML text in the launchd plist. A path of
plain characters stays bare in hook commands. A run finds the hooks of an earlier run by
their shape, quoted or not, and refreshes command, async and timeout fields; a command it cannot
read as its own is left alone and a new hook is added beside it.
Stream owner: `--owner`, else `$TURN_RECORD_OWNER`, else the short hostname.

Ordinary/source-selected capture, explicit retry and foreground watch ticks use
the fixed supervised worker. Partial passes exit zero with pending work;
operational failures exit nonzero. `--no-index` never opens or mutates the
derived search index and supplies no fresh all-stage success. Quiet does not
imply a hook trigger. Explicit `--hook` launches a detached supervisor and reports
only “capture launched”, not initialization or completion. Owned Stop/SessionEnd
settings run the hook entry `bin/capture-hook.mjs` (the same launch as
`--quiet --hook`, under a file a rolled-back release cannot load, so it can
never return Claude's blocking exit two), `async:false` and `timeout:10`: the harness waits
for the launcher, while capture runs detached without its output pipes. Setup
refreshes these fields even when the owned command already matches, preserving
foreign hooks and unrelated fields. Hook errors, including usage, exit one,
never Claude's Stop-blocking exit two. Existing ordinary quiet argv remain
manual. Setup's first pass awaits the fixed supervisor with explicit `setup`
attribution and all sources/indexing enabled; `--no-service` still runs it,
while `--dry-run` starts no pass. Partial and overlap exit zero without claiming
completion; operational failures remain nonzero. Setup preflights named service
files, manager state and hook edits before mutation, then converts supported
legacy watchers to periodic capture, from the next release after 0.61.0;
0.56.0–0.61.0 shipped without it.
See [command routing and receipts](docs/capture-service.md#ordinary-cli-and-foreground-watch).
See [detached hook launch limits](docs/capture-service.md#detached-hook-launcher).
The [service migration gate](docs/capture-service.md#setup-service-migration)
refuses foreign, disabled or masked definitions unless the operator explicitly
chooses `--replace-service`; `--no-service` bypasses service inspection and
actions while still installing requested hooks and running the first pass.
Refusals print that choice as the user-facing command with the selected
owner/root: `oats setup …` when the kernel environment handed in a node
(`OATS_NODE_BIN`, also set in instance shells), otherwise `turn-record setup …`.
Unknown/read errors always refuse, as does a macOS registration of the capture
label from another plist path, even with `--replace-service`. A refusal
changes nothing. A service failure after preflight still writes the hooks and
runs the first pass, then exits 1 with the
[setup summary](docs/capture-service.md#setup-service-migration) of what changed;
setup's private pending-activation marker (`<root>/capture-service-pending.json`)
lets a plain rerun finish its own activation, and `capture --health` reports it
as `capture-service-pending`.
Replacement saves nonoverwriting backups under the selected root and rechecks
file identity. `--dry-run` writes nothing and invokes no manager, so it reports
manager state as unexamined.
Healthy unchanged schedules preserve an active pass; successful setup reports
verified periodic scheduling, not a permanent PID. Real-manager lifecycle
and full service qualification remain separate gates.

Transcript capture reads 64 KiB chunks and frames complete native records,
including UTF-8 characters split across chunks. It flushes before adding a
record that would exceed an 8 MiB source batch and checkpoints after each batch.
Public synchronous capture can still process a larger individual record, with
memory proportional to that record; its resource contract is unchanged. The
supervised worker separately applies the fixed service policy beyond what is
already captured: it captures the complete records before a new record over
8 MiB, then sets the input aside at that record's start. Records captured
earlier, of any size, are proved on recovery by streamed digests, not refused. Later records stay pending until the source is edited or the
whole input is ignored; `--retry-set-aside` cannot pass the oversized record
([operator recovery](docs/capture-service.md#operator-recovery)).
Final, attributed and protected Pi capture stage the descriptor's snapshot on
private scratch under `<root>/.capture-tmp` before the first append, preserving
attribution and custody checks without retaining the source in process memory.
Exact `--file` capture and receipt claims databases use the same record-root
volume, which may itself be memory-backed. Ordinary success/failure cleans each
caller's allocation; lock-held cleanup reclaims only proven dead local owners.
See [scratch ownership and upgrade costs](docs/capture-service.md#resource-model)
for preserved uncertain leftovers and the unresolved synchronous first-pass cost.
Explicit final proofs may read the full snapshot; their output inventories
remain proportional to the issues and sessions the receipt must return.

The search index checkpoints byte positions and turn counts in the same
transaction as its indexed rows, at most 2,000 journal lines or 8 MiB plus
the last record per transaction. Known journal history is qualified by a
durable file-version checkpoint (device, inode, size and nanosecond modification
and change timestamps). Owner appends preserve its epoch after fsync; an
unknown write, replacement or shrink requires bounded journal validation and
invalidates dependent index cursors. Interrupted validation and indexing resume
from their last committed batch. Initial/recovery validation reads historical
content; unchanged normal passes do not.

## Ignoring sessions and paths (privacy)

`<root>/ignore` is a plain text file of glob patterns, one per line (blank
lines and `#` comments skipped). Any capture source file that matches is
**never captured at all** — it is skipped before being opened, so no turn
is appended and the offset cache never learns about it.
This is a capture-time control, stronger than not indexing: the bytes never
enter the record.

```
# never capture this session (any format), by session id
7fe2a1b4-9c3d-4e21-b0aa-1f2e3d4c5b6a

# never capture anything from this project's transcripts
**/-Users-juanre-private-project/**

# never capture one aw account's comm log
acme-secret
```

Matching rules (deliberately minimal; no negation, no escapes):

- a pattern containing `/` matches against the source file's absolute path;
- a pattern without `/` matches against the file's basename and against its
  session id (transcripts) or account name (aw comm logs);
- `*` matches within a path segment, `**` across segments, `?` one
  character; the whole candidate must match.

Name-only patterns apply across every capture source: a short or generic
pattern meant for one aw account can also catch a session file's basename
or id in any format. Prefer path patterns for anything short or generic.

Ignored inputs are accounted for in worker run counts; exact synchronous
receipts retain their ignored counts. `capture --status` shows the active
pattern count. Ordinary text output summarizes confirmed appended turns and
outcome; `capture --health` exposes active refusals and remedies.
The file is per record root and is local policy, not record truth — the
sync guidance below replicates only `streams/` and `objects/`, so each
machine decides what its own capture refuses to read; sync the `ignore`
file yourself if you want one policy everywhere. Two honest limits: an
ignore file that exists but cannot be read fails the pass loudly (a privacy
control must not fail open), and ignoring is **forward-looking only** —
turns already captured stay in the record; hide those with a tombstone.

`turn-record capture --health [--json]` reads offline installation,
receipt freshness/failure and current issue evidence without capture, repair,
root creation or manager calls. Warnings exit zero; unavailable readers fail.
A recent receipt or definition file does not certify enabled scheduling.
See [health diagnosis](docs/capture-service.md#offline-installation-and-run-diagnosis)
for exact installation candidates, nullable history, reader bounds and the
asleep/off-host caveat. Deployment `oats doctor` delegates once to package health
with a finite command timeout/output bound and maps its rows into warnings.
Command, reader or invalid-response failures yield `capture-health-unavailable`;
`--soul` remains composition-only. Kernel remedies say `oats`; standalone package
remedies say `turn-record`, without rewriting user paths or receipt data.

## Multi-machine

Replicate `streams/` and `objects/` with any dumb file sync (syncthing,
rsync, git); never sync `index/`. Owner-only append means concurrent sync
cannot conflict; identical projections dedupe by id; a machine that sees a
non-prefix copy of a stream quarantines it loudly.

## Durability and concurrency

Appends and merges run under a per-stream lockfile (`streams/<id>/.lock`),
because the torn-tail repair is a read-truncate-write sequence and hooks,
watchers and manual passes can fire concurrently for the same owner.

The lock carries an **owner token** — the holder's pid, its hostname, a
random nonce, and the boot it was taken in and the holder's process start
(`bootId`, `processStart`) — written by hard-linking a fully-written temp
file into place, so a lock that exists is always readable in full. Two
guarantees rest on that token:

- **A live holder is never stolen from, at any age.** Staleness is proven
  from the holder's liveness, not from how long ago the lock was created.
  A contender that finds the holder running (its pid alive with the
  recorded start, in this boot) waits, and fails with a timeout naming the
  holder — it does not reclaim, whatever host the token names. A holder
  whose start cannot be read is waited for too. (The
  earlier design judged a lock stale by age while the waiter's timeout
  started when the contender arrived; a contender arriving late therefore
  reclaimed a lock whose holder was still inside its critical section, and
  both ran at once.)
- **A holder releases only its own lock.** Release unlinks `.lock` only
  while it still carries the releaser's nonce, so a holder whose lock was
  reclaimed cannot delete the replacement lock out from under its new
  owner.

**Crash recovery is immediate, not timed**: a lock whose holder is gone is
provably stale and is reclaimed at once, without waiting out any threshold.
A holder is gone when its pid is gone, when its pid runs with another start
than the recorded one (the pid went to another process), or when the lock
was taken in another boot. A run of a container counts as a boot, so a lock
left on a volume by a container that was stopped is reclaimed by the next
one, whatever its hostname and whichever process holds the pid there. The
kernel judges its own claims by the same rule, with the same code
(`lib/process-identity.mjs`).

A token that names neither boot nor start, as an earlier version writes
it, is judged as that version judges it: by its pid alone when it names
this host, and by the lock's age (`lockStaleMs`) when it names another.

A lock that cannot be read at all (anything but "not there" — a permission
error, a directory in its place) is not retried: acquisition fails at once
with the underlying error code and the lock's path, because retrying cannot
clear such a condition. Everything else that fails to acquire — including a
lock judged stale whose removal keeps failing — is bounded by
`lockTimeoutMs` and reports why on timeout.

`lockStaleMs` (30 s by default) is the fallback for the two cases where
liveness cannot be checked here: a lock that names neither boot nor start
and was created on **another host** (file sync can copy one in) and a lock
with **no readable token** (written by an
older version of this package, or by hand). Those are still reclaimed by
age. `lockTimeoutMs` (10 s) is how long a contender waits; the two
thresholds are independent, and neither ordering of them is required or
assumed.

Honest limits:

- **Pid reuse, for a token that names neither boot nor start.** Such a
  lock, left by a process whose pid was
  later reused by an unrelated live process, reads as held forever, and
  contenders on that stream time out until it is deleted by hand. The
  timeout message names the lock path and the recorded holder. This is the
  chosen direction of failure: refusing to write is recoverable, writing
  concurrently with a live holder is not.
- **Reclaim is not perfectly atomic.** A contender re-checks the lock's
  identity (inode and mtime) immediately before removing it. That recheck
  **detects** a replacement that landed while the old lock was being proven
  stale — the common cascade, one contender reclaiming from whoever
  reclaimed first — and the contender gives up and retries. It is a
  detection, not an exclusion: a replacement landing in the window between
  the recheck and the unlink is not seen and is removed. Nothing here
  defends against that window.
- **One machine at a time writes a record root.** A record root must not
  be shared by two machines. A boot is one machine's:
  a lock taken on another machine was taken in another boot and is
  reclaimed at once, while its holder may be running there. The stream lock
  and the capture lock serialize the processes of one machine (or one
  container run), never two machines that write one directory (NFS).
- **Sync tools may copy a `.lock` file.** That cannot corrupt data: a
  synced-in lock from another machine is reclaimed at once, or, when it
  names neither boot nor start, judged by age, so it can delay a local
  `mergeStreamCopy` on that stream by up to 30 s — excluding `.lock` from
  sync patterns remains the right configuration.

Journal writes fsync; note that on macOS `fsync(2)` does not guarantee media
durability (that would need `F_FULLFSYNC`, which Node's fs API does not
expose) — the guarantee is OS-crash-level, not power-loss-level.

**One capture pass at a time.** A pass takes the record root's
`.capture.lock` directory, whose `owner.json` records the pid, a nonce, the
start time, the host, and the boot the lock was taken in and the holder's
process start (`bootId`, `processStart`). A pass that finds the lock held
skips and says so, naming the holder (the next pass catches up). A pass
that is killed (a hook or caller timeout, a container stop) runs no
cleanup, so the next pass reclaims a lock whose recorded owner is dead, and
its registered worker too:

- An owner, a worker or a reclaimer is dead when its pid is gone, when its
  pid runs with another start than the recorded one (the pid went to
  another process), or when its record was taken in another boot. A run of
  a container counts as a boot: a lock left on a volume by a container that
  was stopped is reclaimed by the first pass of the next one, whatever its
  hostname and whichever process holds the pid there. The host a record
  names does not enter this judgement. One whose start cannot be read is
  unknowable, and never dead.
- A record that names neither boot nor start, as an earlier version writes
  it, is judged as that version judges it: dead only when it names this
  host (or no host, below) and its pid is gone.
- Reclaimers are serialized by a guard, `.capture.lock.reclaim`, taken by
  exclusive create. Under it the record is read again and removed only if it
  still belongs to that dead owner.
- A live or unknowable owner, an owner-less (initializing) lock and another
  host's lock that names neither boot nor start are never touched.
- A guard left by a reclaimer that died is never removed. It is named, with
  the exact recovery.
- Records that name no host predate host recording and live under this
  user's home, so they count as this host's: a dead owner's lock is
  reclaimed too. On a home shared across machines (NFS, or a synced
  directory), such a record may belong to another host, whose pid means
  nothing here; check that no capture runs on the other machines before the
  first pass after upgrading.

## Upgrading

The derived index self-heals across schema changes by wiping and
rebuilding (it is cache; there is no in-place migration). After upgrading
this package, restart any long-running `capture --watch` process — a
daemon holding the old database file open would otherwise keep indexing
into an orphaned inode until it restarts.

## Memory

Content processing uses fixed read chunks, bounded batches and SQLite caches,
plus memory proportional to the largest processable native record. Journals,
transcript tails and comm logs are streamed; persistent ID lookup avoids keeping
history IDs or a changed log's candidate IDs in memory. Per-input offsets live
in derived database rows rather than a rewritten global JSON map. Initial
capture, recovery validation and explicit final proofs may read all applicable
content; ordinary unchanged and suffix-growth passes use only new content and
bounded checkpoint probes. The streaming and work-count tests pin these distinct
paths; the small-heap regression remains supplementary evidence.

Filesystem discovery is a separate cost: root/path metadata inventories may grow
with file and profile counts. Native roots and each directory retain their
existing `localeCompare` sorting and depth-first traversal, including stable ties.
Aweb account logs retain code-unit sorted basename order. Public
list APIs return full arrays. Metadata enumeration, sorting and per-input probes
still run on unchanged passes; this is not a constant-memory or new-byte-only
claim for the whole pass. Explicit receipts likewise retain the issue/session
inventories their public contract returns. Background capture suppresses those
output inventories without suppressing error counts.

Verified snapshots and prefix comparisons use private record-root scratch, which
can expand with source size; journal and derived-index disk space also grow with
captured content. Public per-call staging is cleaned on success and failure;
internal command recovery can retain explicitly owned jobs across workers, as
described in the [resource model](docs/capture-service.md#resource-model). No new heap, record
size, elapsed-time or service policy limit is imposed by these algorithms.

## Known costs, accepted for v1

- Deletion via tombstone is eventual: an offline replica retains bytes until
  it reconnects. The SOT says this plainly; so do we.

## Per-home source authority

`capture --home <dir>` defaults to the kernel's independent managed-launch
record-location history, retained beside the home under `.oats-native-record/`.
It does not re-resolve old `fromEnv` references using the capturing process.
Missing history (legacy/standalone), pending launches, and missing historical
roots fail closed instead of certifying empty observer storage. Runtime switches
and resumed starts retain earlier roots. A managed scaffold with no starts has
an empty managed-launch inventory; executing a saved recipe by hand is not a
managed start.

For a deliberately observer-time inventory, explicitly pass `--current-roots`.
The JSON labels this `sourceRoots: "current-env"`, rather than `"launch-history"`;
completion then applies only to the chosen current inventory, not historical
source custody. The library alternative is `sessionsForHome(home, { roots })`:
unspecified formats are excluded, and missing supplied roots fail. Synthetic
standalone tests must choose one of these explicitly, not masquerade as a
managed native launch. Background capture without `--home` is unchanged.

## One session file: `capture --file`

```text
capture --file <path> --format cc|pi|codex --home <instance home> [--owner <name>] [--json]
```

Captures ONE session file, for example an archived session that the
`--home` sweep can no longer find, exactly as `--home` capture of that
instance would capture it. It runs under the capture lock, as a final pass,
with the ignore rules applied. The stream is `<owner>~<source>.<session id>`,
the same identity `--home` capture writes. So the same session captured
either way, or again with `--file`, appends nothing.

- **The owner is explicit.** It is `--owner` or `TURN_RECORD_OWNER`; the
  hostname is never assumed. `--home` must be an OATS instance home (an
  `instance.json` naming an instance). It is recorded in the receipt, not
  checked against the file's recorded cwd.
- **The format is stated, never sniffed.** The file must carry that format's
  session header somewhere in it:
  - `cc`: a record with a `cwd`, and no other format's session header anywhere
    in the file (a cc transcript never holds one);
  - `pi`: the `session` record;
  - `codex`: `session_meta`.
- **The session id comes from the file name**, as for live capture: the cc
  basename, the part of a pi name after its last `_`, or a codex name's
  trailing uuid. A renamed file lands in another stream.
- **One regular file, read once.** It is opened with `O_NOFOLLOW` and
  `O_NONBLOCK` and fstat'ed. A symlink, FIFO, socket, device or directory is
  refused. The bytes read from that descriptor are the ones captured and
  hashed.

`--json` prints the receipt:
`{home, owner, file, format, instance, thread, stream, sessionId, turns,
firstTurnId, lastTurnId, appended, skipped, held, incomplete, failed, ignored,
status, complete, sha256, issues?}`. `sha256` is of the bytes captured;
`issues` (`[{source, path, reason, offset}]`, present when the result is
incomplete or held) says why. As for
`--home`, `complete` is true only with no hold, no incomplete tail and no
failure. A lock skip, a hold (no timestamp yet) and an incomplete tail (torn
or invalid UTF-8) exit 0 with `complete: false`. Without `--json`, the output
is one line.

Anything that binds nothing is an error,
`{status: "failed", complete: false, code, error}`:

| code | exit | when |
|---|---|---|
| `E_USAGE` | 2 | a missing or invalid flag, a non-instance `--home`, no explicit owner, a second `--file`, another mode |
| `E_FILE_UNREADABLE` | 1 | the file cannot be opened or read |
| `E_NOT_REGULAR_FILE` | 1 | a symlink, FIFO, socket, device or directory |
| `E_IGNORED` | 1 | a capture ignore rule excludes the file; nothing was opened, read or written |
| `E_NO_TURNS` | 1 | no records: an empty file, or only blank lines |
| `E_FORMAT` | 1 | records, but no session header of the stated format; the message names the format whose header it does carry |
| `E_CAPTURE_FAILED` | 1 | the pass failed (`appended: null`: part of the file may be in the record) |

See [capture algorithms and recovery](docs/capture-service.md) for the shared
append-only input assumption, reset/retry commands, bounded status inventory,
resource accounting and v0.53.0 downgrade/re-upgrade contract.
