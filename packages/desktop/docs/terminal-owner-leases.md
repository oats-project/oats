# Terminal owner leases (Desktop wire2)

The terminal is still a viewer of the exact existing tmux or remote source.
This boundary protects Desktop-owned PTY resources, not every general HTTP/API
operation as a per-window sandbox. Kernel lifecycle stays with the compatible
installed CLI. Workspace-v2/catalog/editor/detach changes are not part of this fix.

## Authority and hot path

Main registers app-created webContents **before load/terminal IPC**, installing
navigation, crash and destruction hooks. The principal is the registered object,
its current admitted main frame, exact renderer URL, and main-issued document
epoch. Electron43 `did-start-navigation` details (`isMainFrame`,
`isSameDocument`) revoke synchronously on main-document replacement, including a
same-URL reload. Genuine same-document navigation retains the epoch. Detached
frames, child frames with the same URL, foreign/unregistered senders and destroyed
frame accessors fail closed. Loading a new document cannot revive old promises.

A handle is a copied immutable `{id, lease}`; the lease is random256-bit main-owned
material. It is **not bearer authority**: every operation also checks the sender
and document. There is no numeric compatibility lane or preload id→latest-lease
map. A tab retains its original handle across every await and cleanup callback.

`terminal-owner.mjs` uses **one `Map<lease,record>.get` on each write**, then direct
resource-ID/webContents/epoch comparisons and state checks. Principal checks use
private registered-owner object metadata and a membership Set, not a nested
owner/target Map. No hashing, target serialization or dedup-index lookup is on the
keystroke path. The test records1000 writes →1000 lease gets and0 target-index gets;
this is an algorithmic-shape measurement, not a native latency benchmark.

## Resources and effects

- Dedupe is per canonical backend target and owner document. `reused` does not
  grant a second renderer tab an acquisition; closing its refused placeholder
  cannot detach the existing tab.
- **MAX_TERMINALS=200 is process-wide**, not200 per owner/backend. Reserve before
  any await. Pending/revoked inspection, awaiting-ready, closing, active attachment
  work and uncertain partial creation remain counted until settlement/confirmation.
  No unbounded queue, fulfilled preparation cache, eviction or conflicting overwrite.
- Remote preparation uses bounded cached CLI metadata read from main's own
  backend (`backendFetch`, over its private socket), the installed
  CLI's positive remote capability advertisement and fixed inspect/attach argv.
  It checks backend context/CLI identity before creation and both completion paths.
  Metadata reads are≤1MiB/5s, inspection≤1MiB/20s, overall preparation30s.
  Aborting does **not** release an unsettled process reservation. The owned command
  runner waits for both its result callback and child `close`, since AbortError can
  precede actual exit. No stronger/additional signal policy is introduced.
- Established direct viewers survive app-backend replacement; dependent pending
  preparation is invalidated. No fallback target resolution or alternate source.
- tmux component validation/anchors, saved socket, linked-window-only viewer,
  source-death isolation and the provisioned locked key table (wheel scrollback,
  drag-to-select and Shift+PgUp) are unchanged.
  Each viewer has key tables of its own (#1502, `viewerTables` in
  `tmux-target.mjs`), named after its session: its locked table, and, on tmux
  3.3 and later, its C-b table, both bound once as it is made. Closing it kills
  the session, then empties both tables. A viewer that dies another way (with its
  source window, or with a crashed app) leaves them to the orphan sweep, which
  runs at startup, at quit and on every terminal open. The sweep lists the tables
  before the sessions and empties each viewer table whose session is gone. It
  never touches another app's tables, or the shared `oatsdesk-locked` table an
  older Desktop may still use. Nothing is set with `-g`.
- In a window of more than one pane (#1569), a local open selects the agent's
  pane (`select-pane -t %N`) after the preflight and before the viewer exists,
  as the kernel's own viewer does. The viewer links the whole window, and keys
  go to its active pane, which may be a no-echo prompt OATS's setup split off.
  The pane is resolved on this computer's tmux with the client's copy of the
  kernel's rule (`agentPane` in `packages/client/tmux-status.mjs`, pinned to
  `resolveAgentPane` by `test/desktop-tmux-status.test.mjs`). A local open
  carries no home to ask the kernel with, and widening its admission for one
  is not worth a CLI run on every open. One pane, a target with no window, a
  window the rule can't tell, or a tmux call that fails: nothing is selected
  and the open goes on as before. Remote opens use the kernel's own viewer,
  which selects the pane itself.
  Each viewer is created with its own `detach-on-destroy on` (`-t <viewer>`,
  never `-g`): when the source window dies, tmux detaches the client and the
  PTY exits ("session ended"), instead of moving it to another session (often
  another tab's viewer) under an operator's global `detach-on-destroy off`
  (#1237). The operator's global option and own sessions are untouched.
  Cleanup targets only the exact owned viewer, never the durable source.
- PTY exit and confirmed viewer cleanup are both necessary to release a slot.
  A successful exact-name inventory can confirm an already-absent viewer;
  inaccessible/failed inventory is uncertainty, not absence. Partial-creation
  failures carry a private cleanup receipt rather than silently orphaning a slot.
- Viewer cleanup is asynchronous with the same fixed tmux argv/socket. Close
  returns `E_TERM_CLOSE_PENDING` after2s while the slot stays quarantined. An
  explicit retry or a late confirmation can settle it; the PTY detach signal is
  not repeated. Main quit revokes synchronously and allows a bounded2s cleanup
  grace, then follows the existing server-stop/quit path. Timeout never fabricates
  resource release; the existing scoped dead-owner sweep remains recovery.

## Private IPC and renderer lifecycle

Invocations return `{terminalApi:2, ok:true, status, ...}` or a stable static
`E_TERM_*` refusal (or `E_HERDR_REMOVED` from `term:open`). Raw native/CLI/filesystem errors are not forwarded. Write and
resize remain one-way, zero-effect/no-throw on invalid, foreign or stale requests;
there is no synchronous IPC or awaited keystroke round trip.

- `term:open(spec)` admits exactly one existing backend shape, a tmux session or
  remote, not owner/bin/env/command authority. A spec carrying `sessionTarget`
  (a Herdr target) is refused at admission with `E_HERDR_REMOVED` and the
  kernel's stem, before any preparation or PTY. A remote target whose `session
  inspect` reports a Herdr session (an older kernel) or refuses with
  `E_HERDR_REMOVED` (0.31) is refused with that code at preflight, before any
  attach. `term:close(handle)` is invoke, not an unleased send path.
- `term:ready(handle)` acknowledges **after renderer data/exit listeners exist**.
  Early output is FIFO-buffered≤64KiB for≤5s inside the global slot budget; early
  exit also waits for this acknowledgment. Overflow/expiry rolls back only the
  viewer, with an explicit failure rather than a healthy truncated terminal.
- Output goes through the current admitted main frame on `term:data:<lease>` /
  `term:exit:<lease>`. Exit receipts distinguish pending from confirmed cleanup.
  Native callbacks consult the current resource record, not a captured old window.
- Caller write≤1MiB is validated before any send. UTF-8 chunks≤64KiB do not split
  code points or alter control bytes. Local refusal is visible, not silent paste
  truncation. Geometry is finite integer1–1000, retaining existing opener defaults
  and minima. Shift+Enter/raw Ctrl policy and local copy selection remain intact.
- All subscriptions/observers are created inside lifecycle onReady, before its
  settlement signal. Close during open skips late setup and detaches the original
  handle when it arrives. Close during ready waits for setup before disposal.
- The shell keeps an unconfirmed-close tab, key and split destination visible:
  **closing… not yet confirmed**. A ready timeout remains an explicit failed view:
  **terminal did not become ready; closed**. Neither is a healthy terminal or
  silently removed tab. Only confirmed explicit close disposes a pending view.
  Late completion must not steal a newer workspace/stage/selection or focus.
- A retired instance's tabs close on roster evidence (#1237). A tab is keyed
  by home + incarnation `createdAt`; the pure rule is
  `renderer/retired-tabs.mjs` `retiredTabs(tabs, panel)`. Retired means a
  successful, current read of the deployment lists the same home with another
  incarnation, or its reached host no longer lists it (a remote row the kernel
  marks gone), or no longer lists it at all. An unreachable server, a
  kept/stale read or a filtered read that did not ask that server is never
  evidence, not even for the facts its held rows were last read with. A stopped instance keeps its tab. Every
  matching tab closes in every group of the workspace through the normal
  close (next tab, else previous; empty groups stay); focus follows only if
  it was in a closed tab. A hidden workspace is reconciled on its next roster
  read, and a respawn under the same name opens a new tab.

## Remote reconnect (renderer)

A remote tab reconnects in the renderer; the broker, bridge and event set are
unchanged. `renderer/terminal-tab.mjs` keeps one state (connected, waiting,
attempting, stopped) and one timer. A `term:exit` for a remote lease with
`exitCode === 255`, no `reason` and no user close is a lost link. The tab keeps
its xterm, sets `disableStdin`, and waits (1, 2, 4, 8, 15 s, then 30 s,
against a wall-clock due time, so after a sleep one overdue attempt runs, not a
burst). The next lease opens only after the old one is forgotten, that is on
its confirmed (`cleanupPending: false`) exit. `term-lifecycle.mjs` `reopen`
then acquires it through the same `desk.termOpen` path. It waits for any
acquisition in flight and never runs after a close request, and a close during
it detaches the late handle as `start` does. Per-lease data/exit listeners are
replaced on each lease; the xterm wiring is installed once, and input and
resize go to the current lease only.

`E_TERM_REMOTE_UNREACHABLE` and `E_TERM_PREPARE_TIMEOUT` retry without limit.
`E_TERM_REMOTE_NO_ANSWER` retries `NO_ANSWER_RETRIES` (3) times in a row, and
the next one stops. An `E_TERM_REMOTE_UNREACHABLE` answer or a successful attach
resets that count; a timeout neither resets nor counts. Any other refusal stops
with its message and "Close this tab". So does a non-255 exit ("session ended")
or a ready failure. `packages/client/session-attach.mjs` `prepareRemoteTerm`
codes the prepare's failures:

- an `E_SSH` envelope whose `details.sshStarted` is `false` (ssh could not be
  run on this computer) → `E_TERM_REMOTE_NO_SSH`, final: nothing reached the
  host, so a retry cannot help;
- any other `E_SSH` envelope (the CLI's wrapping of ssh's own failure) →
  `E_TERM_REMOTE_UNREACHABLE`;
- the inspect killed at its 20 s exec deadline → `E_TERM_PREPARE_TIMEOUT`: a
  stalled link outlives ssh's keepalives (about 45 s);
- a nonzero exit (255 included) or a death by the CLI's own signal, with no
  refusal envelope → `E_TERM_REMOTE_NO_ANSWER`. ssh's own failures arrive as `E_SSH`, so this is
  more likely the local CLI failing than the link;
- `ok: true` with `present !== true` → `E_TERM_REMOTE_GONE`;
- any other refusal keeps the host's code, which the broker reports as
  `E_TERM_OPEN_FAILED` unless the contract has it.

The captured answers are in `test/fixtures/remote-inspect/`. The strip overlays
the pane's top rows, so geometry never changes. The countdown is outside the
pane's visually hidden `role="status"` region, which is written only on a state
change. While the strip shows, the tab's key handler leaves Tab and Shift+Tab to
the browser (xterm would otherwise keep them): Tab moves focus from the inert
terminal to Reconnect now, and Shift+Tab leaves the pane backwards. Connected,
Tab goes to the agent as before.

The main-only `rekey(resource,newOwner)` primitive rotates lease/index/output
custody atomically and is exercised only by tests. **No escrow/staging, transfer
IPC, extra window, detach UI, automatic return, screen/scrollback transfer or
independent-viewer mode is introduced.** Those need the later approved transaction.

## Attachments

Preserve16 files/25MiB per batch, with4 batches process-wide and one per lease.
Native File paths are obtained in preload. Main copies/adopts the original
handle/target and revalidates before/after async validation and before each
mkdir/write/upload. Remote upload uses only fixed CLI argv and fresh compatible
CLI identity; reownership is blocked during a batch. Already-started effects can
exist after interruption: report unknown effects and insert no filenames, never
claim undo or delete a user/remote file. Renderer success AND rejection check the
original handle/operation, with focus gated by current explicit intent.

## Evidence boundaries

Tests use real shared broker/handler/bridge/adapter/renderer code with inert owners,
PTYs, clocks, CLI/FS recorders and DOM. The main composition/window-registration
and quit wiring are source-exercised under injected effects. These tests do not
need Electron/CDP/tmux/SSH sessions, native signals, live models or an operator
backend. The mixed root `test/desktop-tmux-target.test.mjs` contains live native
cases and must not be loaded for inert Desktop qualification: a test-name filter
is not an isolation boundary. Computed style/DOM tests and incidental native test
passes are not native acceptance. Native Electron and exact tmux before/after
remain the maintainer's separate acceptance gate.
