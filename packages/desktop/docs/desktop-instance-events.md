# Selected-instance activity (K7 API 2)

Workspace › Machines (formerly the Deployments page, and the Active overview before that) reads **reported lifecycle activity** only after the user
selects an instance and presses **Load activity / Refresh activity**. Opening a
card, polling the roster, moving the camera or changing selection never runs an
events command. The shared shell CLI status enables the control; this view does
not probe, install or reconfigure OATS on its own.

## Boundary

- Both exact integer `eventsApi: 2` and `instance-events-2` are required at server
  admission and the actual CLI execution owner. API 1 and version-only guesses
  are insufficient.
- `POST /api/instance-events?ws=<advertised-id>` accepts a 16 KiB JSON object:
  `{action:"read", selector:{instance,agent,agentsRoot,server}, limit?}` (`server`
  is `null` for a local row).
  Limits are exactly 50, 100 or 200 (default 100; the overview uses 100).
- The server admits one current roster home and pins its recorded birth,
  workspace and CLI. The renderer cannot choose a home, cwd, log, environment,
  command, cursor or `--since`. Captured refusals have no classic fallback.
- Fixed no-shell argv: `instance events NAME --dir CONTEXT --home HOME --limit N
  --json`; a remote row's is `instance events NAME --server S --home HOME --limit
  N --json` ([remote rows](desktop-deployment-model.md#remote-rows)). CLI budget:
  15 seconds (45 for a remote read) / 4 MiB. Two process-wide read slots, identical
  reads coalesce before dispatch, no queue or settled server cache.
- Main normalizes route aliases before selecting the specialized proxy. Trusted
  mainFrame/navigation and copied backend base/epoch/workspace are checked on
  both outcomes. The 20-second proxy caps streaming bytes at 4 MiB before copying
  an over-budget chunk and reprojects the public response.

## Meaning of the observation

This is **address history**, not a report of what the model is doing now. The
current roster's runtime state remains separate and authoritative for its own
existing actions. Earlier-incarnation events remain visible as earlier; missing
incarnation is unknown. `instance.json.createdAt` supplies the incarnation tag.
A historical stopped/retired event never disables or launches an action.

The display preserves `integrity.unreadableRows`, `foreignRows`, and logical
`home`/`workspace` source statuses and byte counts. Bytes describe source size,
not bytes read. A refused source, corruption, foreign rows or truncation is
visibly incomplete, including an empty selected window. Counts describe the
bounded observed read, not all recorded history or a number of live instances.

Waiting is a producer-attributed claim for a known current incarnation. Cleared
claims remain visible per producer. `waitingOnYou: null` means **unknown**, never
“not waiting”. The producer computes claims before windowing; the consumer does
not reconstruct state from selected rows, transcripts, TASK/STATE prose or Git.
Unknown current incarnation cannot authorize current claims.

Only allowlisted scalar facts and target counts are shown. Text is plain,
bounded and credential/URL-redacted. Raw notes, task/environment/recipe/command
payloads and PID arrays are not forwarded. Paths and past plan revisions are
provenance text, not file links, terminal targets or executable confirmations.

`launch-prompt` rows are titled "Launch prompt" and expose the reported
`status`, prompt `class`, `action`, `consentSource` and `reason`, through the
same bounded, redacted scalar projection. A submitted answer is historical
input evidence, not readiness or permission to retry a key.

A row's facts follow the kernel that wrote it, and a log keeps its rows, so one
log can hold both generations:

| Fact | Label | Written by |
|---|---|---|
| `consentSource` | Consent source | 0.44 to 0.51 |
| `signatureId` | Recognised screen (the entry the screen equalled: the confirmation, or the notice of a start where Claude ignored the flag) | every kernel, on the rows of an answer; 0.52 also on a `flag-ignored` row |
| `claudeVersion` | Claude version (a version, or `unknown`) | 0.52 |
| `differed` | the group below | 0.52, on the row of a miss |

`claudeVersion`, `signatureId` and `differed` are read tolerantly (the
`tolerant` table of `instance-events-data.mjs`): a malformed value drops its own
fact and never the read. The two texts are shown through `displayLine`; the
row's older facts are shown as they always were, which is why the view's
`LINE_KINDS` does not list `launch-prompt`. The pane and PID identity,
`startId`, `key`, `signatureDigest` and `claudeVersionSource` are not read.

`differed` is what the screen of a blocked launch differed in from the
confirmation the kernel answers. It is read only on a row whose `status` is
`blocked`, through the outcome reader's decoder
(`packages/client/launch-prompt-outcome.mjs` `launchPromptDiffered`), and shown
under the row's facts by `launch-differed.mjs`: the Desktop's lead-in, then
"OATS expected:" and "The terminal showed:", each text one display line in the
quote treatment (`source-quote.mjs`), then the entry it was compared with and
the position. What the terminal showed is untrusted text: it is an attributed
quote, never part of a fact or of a Desktop sentence, and nothing is decided
from it. A side with no text reads "(no visible text)".

`worktree-added` rows (OATS 0.49.0, feature `worktree-event`: `oats worktree
add` made an extra tree) are titled "Worktree added", with the facts purpose,
path, branch, base and member, and **Setup**: one line per entry of the
`worktree` hooks' receipt (`data.hooks`), "<capability>: done" or
"<capability>: failed (continuing)", with the hook's `log` as a muted path line
beneath (none when `log` is `null`: a rolled-back spawn's log is removed). A
required failure never reaches an event, because the tree is removed then.
`spawned` rows gain the same **Setup** fact from `data.worktreeHooks`, present
only when the spawn ran `worktree` hooks. These keys are read tolerantly,
outside the listed keys that refuse a malformed read (`instance-events-data.mjs`:
the `tolerant` table and `hookReceipt`): a malformed value drops its own fact,
and a malformed receipt (the value, or any one entry) drops the whole Setup fact
rather than hide one hook; neither refuses the read. All of it is shown through
`displayLine`.

A claim may carry a `message`: 1 to 200 code points (not UTF-16 units), with
none of an exact refused set: control characters (C0, DEL, C1), U+2028/U+2029,
the bidi embeddings, overrides and isolates (U+202A–202E, U+2066–2069), the
zero-width space, word joiner and BOM (U+200B, U+2060, U+FEFF) and the tag
characters (U+E0000–E007F). Every other format character is text: ZWJ emoji,
ZWNJ, LRM, RLM and ALM are kept. It is optional:
a kernel without it omits the key, which reads as `null`. An invalid or empty message is `null` and the claim is kept. When
either `waitingOnYou` or the newest positive claim owns `message`, the raw values
must be equal (a missing key counts as `null`), as for producer, since and
reason. The summary shows it after the producer and time, as plain text.

The kernel also writes each claim change as a lifecycle event of kind `waiting`
(producer-attributed). The list titles it "Waiting claim", a neutral title,
because the activity view speaks in claims and a cleared row must not read as
waiting; the sidebar's operator-facing mark stays "Needs input". Its `waitingOnYou`
fact reads "claimed" or "cleared", with the reported reason and, on a claimed
row, the note (`message`, by the same rule, as plain text).

## Needs input on the sidebar roster

The roster shows the same kind of claim without a read: `oats status --json`
rows carry `waitingOnYou: {since, producer, reason, message} | null`, under
probe feature `waiting-on-you`. Desktop gates on that feature, never the
version. Without it, `observeDeployment` drops the field from every local row.
A remote row carries it only when the remote kernel reported it. Desktop
validates the field and never synthesizes it.

- **Validation** (`packages/client/waiting-on-you.mjs`, `waitingOnYouData`) never
  throws and never fails the roster. Only an invalid `since` or `producer`
  drops a claim, which then reads as `null` (unknown). A missing or malformed
  `reason` becomes `null`, because the raw reason is never rendered. A
  malformed `message` becomes `null`. So does a note the unsafe-text rule
  withholds (it holds a URL, or token-like text such as `token: …`), and a
  note with no character but white space: the row, the card and the tab then
  show the reason in words, never `[withheld]` or a blank line. An unknown
  reason reads "Needs input" (`waitingLabel`), the shared word the TUI's
  detail says too. The row and the tab already say "Needs input" before
  the detail, so they ask `waitingDetail`, which is null for such a claim,
  and say the words once: the row is its head alone, and the tab's note is
  "Needs input since 12:03". The card's Waiting fact has no tag before it,
  and reads "Needs input · 3 h". The activity view keeps that marker for the same
  note. `waitingMessage` is the validator both share: it returns the marker
  (`EVENTS_WITHHELD`, its one literal, in `packages/client/instance-events-contract.mjs`),
  and "not null" is the kernel's validity answer, which a test pins.
  `packages/client/deployment-data.mjs` and `remotePanel` both validate through it. The
  module is the claim contract only: the server imports it, so it imports
  contract modules and nothing else (a test pins its imports). The tree
  roll-up lives in `packages/client/instance-tree.mjs`.
- **One gate.** Every surface reads a claim through `waitingClaim(row,
  {stale})`. It returns the claim only when the row is running (`running ===
  true`, and `runtimeState` is `running` or not reported), the remote server
  answered this read (`serverUnreached` is not true), and the roster does not
  hold the row stale. A `runtimeState` that is `null` or absent means "not
  reported", never "not running"; any reported state other than `running`
  hides the claim.
  - A local row always carries the state Desktop's own liveness observed, so
    a tmux shell, a stopped, unreachable or unsupported session never shows
    it, whatever the kernel said.
  - A remote row has no Desktop liveness. The kernel's remote roster relays
    `runtimeState` as the host reported it, which is `null` on every row
    except an `unreachable` or `unsupported` one, so the row is gated on the
    `running` its host reported. The host's kernel is what tells a harness
    from a fallback shell there: it reports a claim only while a harness
    runs in the session
    ([the status row](../../../docs/desktop-cli-api.md#the-roster-oats-status---json)).
  - A last-known roster (an unreached server, a held-stale row) never shows
    it.
- **The mark** (the product owner, 2026-10-26). The row's dot is the
  needs-input mark (`.ctx-dot.waiting`: the `attention` icon, a `--warn` disc
  with the "!" cut out in `--surface`), whatever the liveness, never in the
  instance's colour. It is 10px, centred on the 8px dot's slot with the dot's
  2px ring in the row's fill, so the name and the tree guides do not move.
  Yellow means needs input only: unknown liveness is a `--muted` bullseye
  (`.ctx-dot.unknown`). The mark is also the one the terminal tab and the
  workspace list show, and its "!" shape says it without the colour. The row
  keeps its second line (soul and repository) and "New" beside the name. A
  visually hidden " Needs input" follows the name, so the row's accessible
  name says it as the pill it replaced did. A held home's state still wins
  its second line; its dot is the mark, and its description says the wait
  instead of its name. Rows are not reordered, keep their height, and nothing
  animates. This supersedes the earlier decision to keep the dot liveness
  while a pill took the second line.
- **The card** (hover or keyboard focus) adds `Waiting` (the reason in words,
  how long, and the local start time) and `Message`. A claim without a note
  (none, malformed or withheld) has no `Message` row: `Waiting` already says
  the reason. The age is computed when the card is shown. A row that has no card (an unavailable remote row) appends
  the message or label and the start time to its title and description. The
  start time (`waitingClock`) is "14:03" on the current local day, "Oct 2,
  14:03" on another day and "2025-10-02 14:03" in another year (an English
  month table, like the rest of the copy), judged against the show or paint
  time.
- **Collapsed parents.** A waiting row hidden by a collapse is counted on its
  nearest visible ancestor as "N below", a pill (the mark and text) that takes
  that row's second line in place of its soul and repository, which stay in
  the card (a row with no card says them in its title and description, before
  the wait); a visually hidden " need input" completes its accessible name. A
  parent that waits itself shows its own mark as its dot and the roll-up on
  its second line (`waitingRollup` in
  `packages/client/instance-tree.mjs`, beside `instanceVisibleInTree`, which it mirrors), following the parent relation only
  (never across a remote server), and never outside the deployment section the
  waiting row is painted in. A collapse hides only rows of its own section
  (`instanceVisibleInTree` with the same `section`), so a row whose parent name
  resolves to a collapsed instance in another section stays painted and shows its
  own mark. The card's `Below` fact names up to three of
  them. The roll-up is derived on every paint, so it goes as soon as the parent
  is expanded. Filtering collapses nothing, so it shows no roll-up. A root of
  its section with children starts collapsed (`collapsedRows` in
  `packages/desktop/renderer/roster-disclosure.mjs`), and its hidden waiting
  rows roll up onto it the same way.
- **The terminal tab.** An open terminal tab of that instance, in any editor
  group, follows every roster paint (`syncTabNeedsInput`, through the same
  gate and held-stale rule): an alert glyph in `--warn` takes the dot's slot
  without moving the label, the trigger's accessible name gains ", needs
  input", and its title the message or label and the start. Only the mark,
  name and title are mutated (focus, an open tab menu or a drag survive the
  poll); cleared, the tab gets back the dot, name and title it was drawn with.
  The tab is matched by its qualified key (`terminalKey`), never a bare name.
- **The waiting row** (#1502, `renderer/waiting-row.mjs`). The same pass
  draws a row over the tab's terminal, inside its pane, so each split
  group's shown tab carries its own. Its head is the pill and the age
  (`waitedText`, " · 12 min") on one line that never wraps. Under it is the
  message, set as text (`textContent`, `dir="auto"`) or, when it is null, the
  reason in words (`waitingLabel`, muted). The message wraps to at most 3
  lines, and the whole row stays within a quarter of the pane. It is cut with
  "…" (`-webkit-line-clamp` from `--waiting-lines`), and hidden when not one
  line fits. The row is hidden too when not even its head fits in the
  quarter, and the terminal keeps the pane. The pane turns into a column, and the terminal takes the rest of
  it. The row's height therefore changes only when the claim starts or clears,
  or its shown text changes. An age tick rewrites only the age, inside the
  head's one line, so it never refits the terminal. The clamp follows the
  pane's own height through one `ResizeObserver` on the pane, never a timer.
  The observation ends when the claim clears or the tab closes (`closeTab`).
  This departs on purpose from the TUI's row (#1502), where the age sits on
  the message's first line: Desktop's text is proportional, so an age there
  would reflow the message as it ticked.
- **Display only.** Nothing in Desktop acts on a claim.

The waited age is never painted into the row, so the roster signature changes
only when a claim appears, clears or changes.

## Renderer ownership and retention

Each explicit read mints a new event ticket, independent of roster/action
requests. Both success and rejection must still own the selected composite
address/birth, workspace generation, CLI observation, visible popup and ticket.
Close/dispose, hide→show ABA, blur→focus, same-address recreation and shared CLI
changes revoke pending work. The shell's existing broker invalidation signal also
covers backend replacement; its monotonic connection generation revokes reads
and clears retained evidence without another command or new IPC surface. A newer read can supersede a pending read; the
server coalesces identical commands.

The view lives in the Graph's **Recent events…** dialog (the node's menu; the
Machines canvas's popup until the Desktop UI rework's slice 6b), owned by that
dialog and the workspace it was opened in.
One observation, at most 4 MiB, is retained **only in the current popup** (below
the 32-target upper bound). There is no cross-selection/server cache,
persistence or reopening-by-name. A failed refresh keeps the actual older rows
with explicit stale labeling. Unrelated roster updates keep the visible popup
connected, preserving controls, focus, disclosure, scroll and native text ranges.
Hidden views cannot reclaim focus. Popup wheel and disclosure keys remain native
reading controls, not graph-pan/terminal commands. Expanding the disclosure
repositions the viewport-bounded popup without focusing or moving the camera.
No event completion selects a graph node or moves the camera.

## Qualification

Tests use injected CLI recorders, the shipped HTTP/main handler bodies, memory
streams and JSDOM. Stored producer receipts exercise private and public
projection without accessing receipt-named paths. Intended-assertion mutations
cover fences, budgets, both-path ownership, corruption visibility and renderer
selection/visibility races. Three-theme computed AA is not native GUI acceptance.

Producer corrections for descriptor-open races and unknown-current-incarnation
claims must be qualified on their named merged implementation before release;
Desktop must not compensate with a duplicate log scanner or optimistic old mode.
