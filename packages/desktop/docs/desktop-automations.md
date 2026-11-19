# Desktop Schedules and Triggers (feature `automations`)

The Schedules and Triggers pages read and act through the installed CLI's
workspace automations contract (kernel 0.29.0: feature `automations`,
`automationsApi: 1`; `docs/desktop-cli-api.md` § "Workspace triggers and
schedules"). The Desktop never reads automation files, evaluates cron or
placement, or re-derives where something runs: `runsHere`, `reason`,
`enabledHere` and `nextDue` are the kernel's.

## Boundary

`POST /api/automations?ws=<id>` with `{ kind, action, key? }` (body ≤ 4 KiB,
exactly one `ws`, behind the server-wide credential check and loopback Origin guard):

| kind | actions | key |
|---|---|---|
| `trigger` | `list` | none |
| `trigger` | `status` | optional |
| `trigger` | `enable`, `disable` | required |
| `trigger` | `test` (optionally with `runSource: true`) | required |
| `schedule` | `list` | none |
| `schedule` | `enable`, `disable`, `test`, `run`, `reconcile` | required |
| `trigger`, `schedule` | `describe` (with `description`) | required, local |

`key` is the row's qualified id (`local/<id>`, `<member>/<id>`) or a bare local
id, never option-shaped. The server runs `oats <kind> <action> [key] --dir
<workspace scope> --json` (argv only, the accepted CLI binary; 30 s, 60 s for
`trigger test`) for a **local** workspace only.

`runSource` (feature `trigger-sources`) is the one key that lets the kernel
run a capability source's command for a test: `oats trigger test <key>
--run-source`. The server accepts it only as the strict boolean `true`, only
for a trigger's `test`, and only when the CLI declares `trigger-sources`;
anything else is `E_BAD_ARGS` before any CLI runs, in the server and again in
`cliAutomation`, which is told the probe's `features` by its caller (it never
probes) and refuses the key without the feature. The flag is spelled in one
place (`TRIGGER_RUN_SOURCE_FLAG` in `packages/client/cli-adapter.mjs`) and composed there from
the boolean: the renderer never passes argv. Without the flag the kernel executes nothing for a capability
source and answers `E_TRIGGER_SOURCE_RUN`. Only the confirm's **Run test**
sets the key ([Capability trigger sources](#capability-trigger-sources-feature-trigger-sources)).

`describe` (feature `automation-descriptions`, kernel 0.43) sets or clears a
local item's summary: `oats <kind> update <key> --description=<text> --dir …
--json`, the text as ONE `=` token so a `-`-led value never becomes a flag, and
`""` (exactly `--description=`) clears it. The server refuses before any call a
workspace key, `description` on any other action, and text outside the
kernel's rule (one line of 1 to 200 code points, no `\p{Cc}`, no U+2028 or
U+2029); without the feature it answers `E_DESCRIPTIONS_UNAVAILABLE`. The
kernel answers `{ schedule: <row> }` or `{ trigger: <row> }`.

The answer resolves; it never rejects:

`{ automationsViewApi: 1, status: "ok" | "unavailable", kind, action, result, reason }`

- `result` is the kernel's result verbatim; the renderer's `automation-rows`
  adapter projects it.
- A kernel refusal keeps its own code and bounded message
  (`E_AUTOMATION_NOT_HERE`, `E_AUTOMATION_WORKSPACE`, …).
- The Desktop's codes: `E_AUTOMATIONS_UNAVAILABLE` (no feature or API),
  `E_WORKSPACE_UNKNOWN`, `E_UNSUPPORTED_REMOTE`, `E_BAD_ARGS`, `E_CLI_PROTOCOL`
  (a document of the wrong shape).

The app proxy classifies `/api/automations` as its own route, pins the verified
workspace unless the server advertises the one asked, keeps duplicate `ws` for
the backend's refusal, and allows 90 s.

## Summaries and the detail page

The adapter (`renderer/automation-rows.mjs`) reads every fact a view shows
from the kernel row explicitly: what each run sends (a wake's `message` and
`home`, a command's `argv` and `cwd`, an `operation` and its `home`), a spawn's
`purpose`, `backend`, `yolo` and own `wake` (under `spawn` for a trigger), the
run state (`running`, `attempt`, `pendingWake`) and `createdAt`/`updatedAt`.
`raw` feeds only the local editor's draft.

- **The list row** shows the bare `name` beside its origin tag (the qualified
  id is the title and the accessible name). Under it, `summaryLine`: the
  `description` as text; else the first non-empty line of the task (spawn,
  trigger) or wake message, muted italic, titled "No summary set — first line
  of the prompt"; else "No summary". Nothing is ever derived from argv.
- **The detail page** shows the name with the qualified id under it, then the
  summary or "No summary". What it sends is shown whole, never summarized;
  Spawns (spawn schedules, triggers) adds the purpose, permissions, backend
  and the recurring wake. `runState` gives the Run state card. `running` is
  the job lock, a host slot, not proof of a launch: an attempt whose effects
  are unconfirmed keeps its lock. So unknown wins (an attempt with an error, an
  attempt without its lock, or a last run of outcome `unknown`), with its exit
  facts, whether it still holds the slot, *Check run state* and the
  `reconcileCommand` to paste (`oats schedule reconcile <qualified id>
  [--clear] --dir <scope>`); otherwise a held lock is "Running since"; and a
  wake waiting to be delivered. An Invalid or
  Unreadable item gets its own card (code, field, message); Comes from adds
  the package template's provenance and a local item's times.
- **Writes** need `automation-descriptions` (`automationDescriptionsSupported`;
  reading needs no gate, an older kernel sends null). *Edit summary* (the
  lede, the page bar and the row menu, local rows only) opens one modal
  sheet per view. Its save is a latest-intent operation: closing or disposing
  invalidates it, focus parks on the sheet's status line while it runs, and it
  returns to the opening control, or the same control by identity after the
  re-read. Both editors send the text as typed (the kernel keeps boundary
  spaces); only an empty value clears. Neither sets a native `maxlength`: it
  counts UTF-16 units and would cut a valid summary of emoji short, so the
  code-point rule (`descriptionValid`) alone limits the length, with its message. The schedule form's Summary field shows only with the feature;
  without it the form keeps the stored summary as it is.

## A trigger's status and test (kernel 0.49 fields)

`triggerStatus(json, id, { source })` and `testResult(json, kind, { source })`
project `oats trigger status` and `oats trigger test`; `source` is the list
row's `on.source` (status rows carry no `on`). Every 0.49 field is optional:
without it the page renders as before. Each kernel string (subjects, events,
instance names, error messages and codes, poll errors) goes through
`displayLine` and is set as text; `null` from it is absent. A malformed entry
is skipped.

- **Event labels** (`eventLabel(entry, source)`): the event's `subject` (a
  string), else its `number`, prefixed `#` only for a `github.pull_request`
  source; with neither, the event `key`. Used for waiting, live and fired
  events, the list row's last fire and the Test card. Never `#null`; a `null`
  repo omits the Repo fact.
- **Recent fires** shows, in order: *Last poll* (`<time>: <prs> pull
  request(s), <matching> matching`, or `<time> failed: <error>`; nothing when
  `lastPoll` is absent or malformed, and the counts must be non-negative safe
  integers); *Last error* (the message, then the code in mono); *Waiting*
  (`pending`, newest `observedAt` first, an unparseable time last, kernel
  order among ties; at most 10, then "and N more"); *Live now* (`live`);
  then the fires. Every event in these lists reads in one order: its label,
  its event, then its instance (`#1 · opened · dev-review-pr-1`; a waiting
  event has no instance). A schedule's runs lead with their outcome.
- **The Test card** lists each `wouldFire` entry as `<label> → <instance>`
  (the name the spawn would be asked to derive), "(held)" when held, and
  "name shortened to fit" with an `aria-description` (and title) when
  `nameCut`; with no `instance`, only the label.

## Capability trigger sources (feature `trigger-sources`)

A trigger may take its events from a source a capability declares
(`on.source: "<capability>:<source>"`) instead of `github.pull_request`
(`docs/desktop-cli-api.md` § "`oats trigger`", `docs/schedules.md` §
"Capability sources"). Everything here applies only when the CLI declares
`trigger-sources` (`triggerSourcesSupported`); without it the page is exactly
as before, whatever a row's `on.source` says. With it, a row is a
**capability-source row** when `on.source` is a string other than
`github.pull_request` (`capabilitySource(on)`). `github.pull_request` rows
keep their behaviour, and gain three highlighted prompt fields.

**Whose words are whose.** A source is a capability's own command, and a
workspace trigger is a file in Git: neither is the kernel or the Desktop. Text
from them is shown as data inside one quote treatment
(`renderer/source-quote.mjs`), never as a sentence of the Desktop's:

| Text | Lead-in |
|---|---|
| a skipped item's `why`, a refused event's `text`, a refusal's `source.code` and `source.message` | `<capability> · <name> says:` |
| `on.params` | `From the trigger file:` |
| a capability's declared `triggerSources` (the capability page) | `From the capability's manifest:` |

The group is `role="group"` labelled by its lead-in; each text is one
`displayLine` in a `blockquote` (mono, a rule at its side), set with
`textContent`. Nothing is ever made from such text: no markup, no link, no
button, no tooltip. A line may carry a `label` (a kernel-validated
identifier, such as an event's subject) and a `note` (the Desktop's or the
kernel's remark about it); neither is the quoted party's. Kernel text
(`lastError.message`, `invalid.message`, a test's `problems` and `warnings`)
stays plain. Every string goes through `displayLine` although the kernel caps
and cleans it: an older state file is not covered by that guarantee.

**The page of a capability-source row:**

- **List row**: `<capability> · <name>: <events>` (`onSummary(on, { sources:
  true })`), with no repository line.
- **On**: Source (named by the status row's `source` once read, else split
  from `on.source`), Events, Polls, then **Parameters**: `on.params` as
  `name = value` lines (`sourceParams`), at most 16 then "and N more".
  **Open capability** shows when the workspace's catalog lists exactly one
  capability of that name (one `POST /api/workspace-sync { action: "read" }`
  per page build); it hands the name to the shell (`ctx.openCapability`),
  which opens the capability's page in Workspace (`preselectCapability`).
- **Last poll**: `<time>: <events> events`, then the non-zero of filtered,
  skipped and refused. In `lastPoll` these are counts; in a test's `source`
  the same names are arrays. A failed poll reads `<time> failed: <cause in
  words>` (`causeWords`; an unknown cause shows its code), the kernel's error
  under it, and the source's own refusal quoted.
- **One failure, once.** After a failed poll the kernel's `lastError` is
  that same failure, and after a failed source check it repeats `invalid`.
  The "Last error" line is left out when its time and message equal theirs,
  and its code goes beside the kernel's text there.
- **Refused by OATS** (`invalidEvents`, each with its rule in words,
  `ruleWords`) and **Skipped by the source** (`skipped`, each subject with
  its `why` quoted), at most 10 each. They are the last *good* poll's: a
  failed poll leaves them, so the line over them says "At the last poll,
  `<time>`" or, after a failure, "From the last successful poll, before the
  failure above", with no time, because the row does not carry that poll's.
- **Source check failed**: an `invalid` with `at` is the source's meaning
  check failing at a poll (`sourceCheck`). It is a state of its own on the
  row (text and an icon) and a card (message, code, field, time). An
  `invalid` without `at` is a definition that no longer validates, as before.
  An invalid *event* is never called an invalid trigger.
- **Prompt**: `taskFields(on, { sources })` picks the highlighted fields:
  a pull request's `repo number url event headSha trigger subject key`, a
  capability source's `trigger source subject event key url` and any
  `fields.<name>`. The note under it says the fields are the source's data.

**Test is an informed second press.** `trigger test` of a capability source
runs the capability's command on this computer, whatever the host's trust and
the trigger's `runsOn` say: only the host tick is gated by those. So Test is
offered on every capability-source row, untrusted ones included, and is
never one click:

- Test opens a confirm, a card in the side column (no modal: the row's
  placement and parameters stay in view). From a row's menu, Test opens that
  trigger's page with the confirm showing.
- **Opening the confirm runs nothing.** It is built from the row on screen
  and waits for nothing: no test, no source command, no poll, no read to
  fill it. On a page that is already open it sends no request at all. From a
  row's menu the page opens first and reads its own status, as every page
  open does: recorded state, which executes nothing.
- The confirm says what runs and where, that an untrusted trigger stays
  untrusted, that the test runs here when another host runs the trigger, and
  the parameters the command receives. It offers **Cancel** and **Run test**,
  and nothing that trusts, enables, starts or schedules the trigger.
- **Run test sends exactly one request**, `{ kind: "trigger", action: "test",
  key, runSource: true }`, and nothing else: no retry, no re-read. It is the
  only code path that sets `runSource` (`runConfirmed` in
  `views/automations.mjs`), and it is guarded against a second entry, not
  only by its disabled buttons.
- A confirm belongs to the row it was opened on, as that row was: a refresh
  that changes the row, another page or a row that left the list closes it.
- A confirm is one identity (`confirmToken`), and its Cancel and Run test are
  bound to it: a control kept from a confirm that was cancelled, replaced or
  disposed does nothing, and the page's transport refuses to act for any
  workspace but the one the view was built for.
- A test answers for the source it was asked about. Each change of a row's
  `on.source` moves that row's generation (`sourceGens`); an answer or a
  failure that lands in another generation leaves no result, in the one-click
  path and the confirmed one, even when the source changed back. Leaving the
  page is not a change: that result is kept.
- Focus: the confirm's heading on open (not Run test, so a second Enter runs
  nothing), its status line while the test runs, the result card's heading on
  the answer, the Test button on Cancel, Escape and a failure. A test that
  answers after the operator left the page keeps its result and moves no
  focus. The page is rebuilt whole on each render, so these targets carry a
  `data-auto-focus` key and focus is found again by it.
- A one-click test carries no confirmation. When its row became a capability
  source's since the list was read, the kernel runs no capability code and
  answers one of two ways: `E_TRIGGER_SOURCE_RUN`, or its normal answer about
  the source (a check that failed before the gate). Neither is a failure of
  the trigger, and both are treated alike: a neutral notice of the Desktop's
  own says nothing ran (the kernel's message names a CLI command and is not
  shown), no result is kept, the list is read again once, and focus returns
  to Test unless the operator moved on. Test now opens the confirm, and Run
  test gives the source's answer.

**The Test result card** of a capability source (`testResult` adds `source`)
leads the side column and speaks of the source first: "The source answered:
N events" with the same counts and lists; or "The source check failed" with
the kernel's message, code and field; or "The poll failed: `<cause in
words>`" (the history's words for a failed poll) with the kernel's error and
the source's refusal quoted. A
confirmed test can itself come back with the check failed: a source whose
script is gone still declares well, so the kernel finds it only when it runs. Then
placement as the kernel reports it: "Would run here on its own" only when
`ok` is true and no problem remains; "Tested by hand" before the problems
otherwise. The kernel lists the source's failure among `problems` too: the
reader drops that one line, and when nothing else remains neither placement
line shows. What would fire, or "Nothing would fire now.", is said only for a
source that answered; an event's `url` is the source's and shows as text. A
test the CLI did not answer in time shows "The test did not answer in time.
Nothing was recorded." and no result. A test the kernel refuses as a whole (a
definition that no longer validates) shows the kernel's message and its code,
each through `displayLine`.

A row whose `on.source` changes gets its status read again and loses a kept
Test result: the kernel drops the old source's lists at once. A test still in
flight across that change leaves no result either (its generation is gone).

## Opening a definition

A row's file opens read-only in a tab from `origin.localPath` (this
deployment's own file, or the member's clone here) through the contained
`/api/file`; without one, the kernel's `origin.url` opens externally; else the
action is disabled with its reason.

## The local form

Local schedules are still created and edited by the form, through
`POST /api/schedules` (`add`, `update`, `remove`, `reconcile`, `host-*`). The
draft (`renderer/schedule-read-data.mjs`, `scheduleDraft`) is the stored local job exactly, or
nothing ("edit it with the CLI") when the form cannot keep a field.

## Tests

`test/automations-server.test.mjs` (captured argv, verbatim results, refusals,
gates, keys, the adapter over the real shapes), `automations-view.test.mjs`,
`automation-descriptions.test.mjs` (summaries, every detail card, Edit summary,
the gate, the form's Summary), `trigger-subject-rows.test.mjs` and
`trigger-subject-view.test.mjs` (the 0.49 status and test fields),
`trigger-sources-rows.test.mjs` (the readers over the captured answers),
`trigger-sources-view.test.mjs` (the page, attribution, the result card, an
older kernel), `trigger-sources-confirm.test.mjs` (the confirm, over the
real server boundary and CLI adapter with a recording exec: what the
transport saw, and the argv) and `trigger-sources-shell.test.mjs` (Open
capability through the shell's own `ctx.openCapability` and the real page),
`schedule-draft.test.mjs`,
`normalized-api-guards.test.mjs`; fixtures `test/fixtures/automations/kernel/`
and `test/fixtures/automation-descriptions/` (kernel captures,
`provenance.json`; the latter re-captured with `CAPTURE_COMMIT=<oid> node
capture-descriptions.mjs <kernel tree>`). `test/fixtures/trigger-sources/` holds
real `trigger` and `capabilities show` answers of a kernel that declares
`trigger-sources` (`node capture.mjs <kernel checkout>`; `provenance.json`
names each command and the head). The root suite's
`test/desktop-trigger-sources-kernel.test.mjs` runs the same answers live
through the Desktop's readers; it skips, naming the feature, on a kernel that
does not declare it.
