# The launch state machine of a provider home

Status: design of record for the lifecycle of a home on a session provider
([execution-targets.md](../execution-targets.md#session-providers),
[capabilities.md](../capabilities.md#session-providers-sessionproviders)).
Decided 2026-11-20. The tests in `test/session-provider-lifecycle.test.mjs`
follow the tables below: one test per cell of "The verbs, by state", one per
crossing, and one per point between two writes at which the kernel can die
(it is killed there, by a seam, and the records it leaves are checked).

A provider runs the session; **OATS decides what state the home is in, from
its own records alone**. The provider is asked only what a record cannot say
(is the session there, is it running) and is told what to do. This page says
which records exist, which states they spell, what each verb does in each
state, in what order it writes, and what happens when two things cross.

## The records

| Record | Where | Who can write it | What it holds |
|---|---|---|---|
| **Receipt** | `<instances>/.oats-retirement/baselines/<hash of the home>.json`, `runtime` | the kernel; outside the home | the authority: `launched`, `backend`, `provider`, `endpoint`, `stoppedAt`, `launchSent` |
| **Record** | `<home>/instance.json` | the kernel; inside the home, so the agent can | a copy for readers: `launched`, `backend`, `session {provider, endpoint}`, `startId` |
| **Stop receipt** | `<home>/.oats-stop.json` | the kernel; inside the home | which stop the last one was, for the current `startId`: an operator's, or the host's (`resume: true, reason: "host-stop"`) |
| **Claim** | `<instances>/.oats-retirement/claims/<name>.lock` | the kernel; outside the home | which lifecycle verb acts on the home now, and its process |
| **Resume count** | `OATS_HOME_DIR/session-resume/provider-resumes/<hash>.json` | the kernel; outside the home | the resumes of the last hour, this boot |
| **Input in flight** | `<instances>/.oats-retirement/inputs/<name>/<pid>-<id>.json` | the kernel; outside the home | an input is being sent to the home now, and by which process |

The receipt decides. The record must agree with it
(`E_RUNTIME_AUTHORITY_MISMATCH` otherwise), **except while the receipt says a
launch is unsettled** (`launchSent`): then the record's `launched`,
`session.endpoint` and `startId` are not compared, because the launch that
would have written them may have ended at any point.

## The states

A state is what the receipt says. `E` is an endpoint, `t` an instant.

| State | Receipt `runtime` | Record | Meaning |
|---|---|---|---|
| **planned** | `{launched: false, backend, provider}` | `launched: false`, `session.endpoint: null` | never launched; no session exists |
| **sent** | `{launched: true, backend, provider, launchSent: t}` (no endpoint) | `launched: true` (not compared) | a first launch was sent; its outcome is not recorded |
| **running** | `{launched: true, …, endpoint: E, stoppedAt: null}` | `launched: true`, `session.endpoint: E`, `startId` | OATS started a session at `E` and has not stopped it |
| **stopped** | `{…, endpoint: E, stoppedAt: t}` | as running | OATS stopped it. The stop receipt says which stop: **operator** (stays down) or **host** (a resume brings it back) |
| **resent** | `{…, endpoint: E, stoppedAt: t or null, launchSent: t2}` | (not compared) | a launch was sent for a home launched before; its outcome is not recorded |

Two things are not states of the records:

- **lost**: the records say *running* and the provider says the session is
  gone. Only an inspect tells; nothing is written. A lost session is resumed
  through `input`, under the home's cap.
- **retiring**: any state, with the claim held by a retire. It ends with the
  home removed.

*sent* and *resent* are the **unsettled** states: a session may run that no
record names. A launch in progress and a launch whose command died look the
same to a read; the claim tells them apart for a verb (a live holder is busy;
a dead one is taken over).

**The older kernel.** A kernel from before session providers refuses every
verb on a home whose receipt says `launched: true` without a tmux endpoint,
a retire included, and would retire a `launched: false` home as never
launched. That is why *sent* says `launched: true` in the receipt and in the
record, though no session is known to exist.

## Settling

An unsettled home is settled by one procedure, used by every verb that acts
on it (stop, start, restart, retire), under that verb's claim:

1. Ask the provider: `stop {home, endpoint: null, launchSent: t}`: stop
   whatever session rooted at this home was created at or after `t`.
2. Not confirmed: `E_SESSION_STOP_FAILED`; the state is unchanged, and the
   next verb asks again. (A retire goes on all the same when no process works
   in the home, with a warning that names the provider's own tooling: it
   never strands a home on a provider that does not answer.)
3. Confirmed: no session of that launch runs. The record is rewritten to
   agree with what the receipt will say, then the receipt:
   - from *sent* → **planned** (record `launched: false`, `endpoint: null`);
   - from *resent* → **stopped** (record `launched: true`, `endpoint: E`;
     receipt `stoppedAt` set if it was null, `launchSent` removed; the stop
     receipt as an operator's, unless it already says the host's).

*resent* settles to *stopped*, never to *running*: a start asks the provider
to stop the session at `E` before it marks its launch (below), so once the
new launch's session is stopped too, nothing runs.

## A launch (spawn's, start's, restart's)

Always the same steps, under the home's claim (`start`; a spawn takes it
before its home can be acted on):

| # | Step | Record written | State after |
|---|---|---|---|
| 1 | What can refuse: the plan, the launch hooks, the provider's `check` with the planned launch. (Three checks run right before step 4: the home's roots, the kernel's shim, the host run's admission. One that refuses there leaves the home as it then is: stopped by step 3, or as before the verb) | none | unchanged |
| 2 | If unsettled: settle | see Settling | planned or stopped |
| 3 | If launched before: stop the session at `E`. A restart of *running* whose session is there records `stoppedAt` and the stop receipt first (the stop rule). A start or a restart of *stopped*, and of *running* whose session is gone, ask the provider's `stop {endpoint: E}` again and record nothing (so a stop that is not confirmed leaves a lost home lost, not stopped as by an operator); not confirmed is `E_SESSION_STOP_FAILED`, nothing started | receipt, stop receipt (a restart of a session that is there) | stopped, or running-and-gone with `E` stopped |
| 4 | **Mark**: receipt `launchSent: t` (and `launched: true` from planned), then the record's `launched: true` from planned | receipt, then record | sent or resent |
| 5 | The provider's `launch` | none | sent or resent |
| 6a | It answered `E'`: receipt `endpoint: E'`, `stoppedAt: null`, **`launchSent` kept**; then the record (`launched: true`, `endpoint: E'`, new `startId`); then the receipt's `launchSent` removed | receipt, record, receipt | running at `E'` |
| 6b | It refused (nothing was started): **unmark**: record, then receipt | record, then receipt | as before step 4 |
| 6c | Its answer was lost: settle | see Settling | planned or stopped; or unchanged when the stop is not confirmed |

A launch killed at any point after step 4 and before the last write of 6a
leaves an unsettled home: the next verb settles it. There is no point at
which the receipt names a session the record contradicts, or at which a
session runs that the receipt does not account for with either an endpoint
or `launchSent`.

A spawn that fails after step 4 undoes itself: 6b or 6c, then the home is
removed; when the stop of 6c is not confirmed the home is retained,
unsettled, with its rollback marker. A retire of a retained provider home
reads the launch from its receipt and record, never from the marker.

## The verbs, by state

`—` means the provider is not called.

| Verb (claim) | planned | sent | running | stopped | resent |
|---|---|---|---|---|---|
| **inspect**, **status** (none) | not launched; — | unknown (`E_SESSION_UNAVAILABLE`; row `unreachable`); — | the provider's `inspect`; unknown when it fails; gone reads *lost* | stopped; — | unknown; — |
| **input** (none) | `E_SESSION_NOT_RUNNING`; — | `E_SESSION_NOT_RUNNING`; — | `inspect`, then `input` (below) | `E_SESSION_NOT_RUNNING`; — | `E_SESSION_NOT_RUNNING` when `stoppedAt` is set, else `E_SESSION_INPUT_FAILED`; — |
| **stop** (`stop`) | nothing to stop | settle → planned; answers stopped | the stop rule → stopped | operator's: asks `stop {E}` again, and takes a host's stop as its own. Host's: nothing | as of *running* or of *stopped* by its `stoppedAt` (the stop rule, or `stop {E}` again), then settle → stopped; answers stopped |
| **start** (`start`) | launch | settle, launch | `inspect`: there → `E_SESSION_RUNNING` or `E_SESSION_UNKNOWN`; gone → launch | launch | settle, launch |
| **restart** (`start`) | launch | settle, launch | `inspect` (unknown refuses): there → the stop rule, launch; gone → launch | launch | settle, launch |
| **resume** (`resume`) | `E_RESUME_NOT_LOST` | `E_SESSION_UNKNOWN` | gone → count, then `input` (the notice); there → `E_SESSION_RUNNING` / `E_RESUME_NOT_LOST` | host's stop → `input` (the notice), then `stoppedAt` cleared, then the stop receipt removed → running; operator's → `E_RESUME_NOT_LOST` | `E_SESSION_UNKNOWN` |
| **retire** (`retire`) | remove | settle, scan, remove | the stop rule, scan, remove | `stop {E}` again, scan, remove | the stop rule, settle, scan, remove |

**The stop rule** (every OATS stop of a *running* home: stop, restart,
retire, the host's shutdown): receipt `stoppedAt: t` first, then the stop
receipt, then the provider's `stop {endpoint: E}`. Not confirmed is
`E_SESSION_STOP_FAILED` (a retire goes on when no process works in the home,
with a warning), and the home is *stopped* all the same: from the first
write on, input is refused whatever the provider does.

**Scan** (a retire): no process may work in the home after the provider's
stop, confirmed or not.

**A resume's notice that fails.** Refused by the provider (a prompt is open,
it was queued): nothing was sent; a lost session's count is given back, and a
home stopped with the host stays so, still to resume. Failed otherwise: the
provider may have restarted the session on it; a lost session's count stays,
and for a home stopped with the host, which stays stopped, the provider is
asked `stop {E}` again.

**Input to a running home**: `inspect`; gone is a lost session, whose input
is a resume (counted before the provider is called, refused at the cap);
then the record is read again, `input` is sent, and the record is read once
more (the crossing check, below).

## Crossings

**A verb arrives while another holds the claim.** Stop, start, restart,
resume and retire take the claim; a second one is refused as busy
(`E_LIFECYCLE_BUSY`, `E_SESSION_START_BUSY`, …) before any effect. A spawn
holds the claim from before its home is *planned* on disk until its launch
is recorded or undone, so the home is never acted on while it launches.
Reads (inspect, status, the plans) take no claim: they answer the state the
records spell at that instant, which during a launch is *sent* or *resent*,
that is, unknown.

**The holder died.** A claim names its holder by process id and that
process's start time. A holder is gone when no process has that id, or the
one that has it started at another time (the id was reused), or it is a
zombie; a holder whose liveness cannot be read is not gone, and the verb is
refused as busy. The next verb takes over a gone holder's claim. The records
are in one of the states above whatever the point of death, by the write
orders of "A launch" and of the stop rule, with one exception, a spawn that
dies before its home has a receipt (the row below):

| Died | State left | The next verb |
|---|---|---|
| before the mark (step 4) | as before the verb | acts on it |
| between the mark's two writes | sent, record `launched: false` (not compared) | settles |
| during the provider's launch, or after its answer and before the last write of 6a | sent or resent; a session may run | settles: the provider stops it by home and `launchSent` |
| during the stop rule, after `stoppedAt` | stopped (as an operator's until the stop receipt is written, then as the stop's own); the provider may not have been asked | a stop or a start asks `stop {E}` again |
| during a settle, after the provider confirmed | unsettled still, or settled | settles again (the provider's stop is idempotent), or acts |
| during a launch the provider refused, between the record and the receipt of its unmarking | sent | settles (there is nothing to stop) |
| during a spawn, between the planned record and the receipt | a directory home: planned (its early receipt names the provider). A worktree home: a planned record and **no receipt**, which is no state of the table: no verb runs on it but a retire | a retire takes it as never launched, after its scan: the mark of a launch is written to the receipt first, so a home with no receipt was never sent one. (A receipt that is there and cannot be used says nothing, and refuses) |
| during a resume of a home stopped with the host, after its notice | stopped with the host; its session may run again | the sweep sends the notice again; a stop or a start asks `stop {E}` |
| during that resume, after `stoppedAt` was cleared | running, with the host's stop receipt left | acts on a running home; a later loss of that start is a loss like any other, counted (a stop receipt says the host's stop only beside a receipt that says stopped) |

**An input in flight across a state change.** An input holds no claim and a
provider restarts a session on it, so the kernel checks after the send, with
one read of the home, whatever the provider answered (a refusal included):

| What the read says | What happened | What the kernel does |
|---|---|---|
| running, the same `startId` and endpoint | nothing | answers the provider's answer |
| stopped, or no session recorded | a stop landed, or a retire is waiting for this input (below) | `stop {E}` again; `E_SESSION_NOT_RUNNING`, not delivered |
| unsettled | a start is launching | `stop {E}` again; `E_SESSION_NOT_RUNNING`, not delivered |
| running, another `startId`, another endpoint | a restart landed | `stop {E}` again (the old one); `E_SESSION_NOT_RUNNING` |
| running, another `startId`, the same endpoint | a restart landed, and the provider reused the locator, which it must not (below) | nothing is stopped (that locator is the new session's); `E_SESSION_NOT_RUNNING`. The provider may have delivered the input to the new session all the same: the mail stays unread and is presented again, a duplicate, never a loss |

The same read before the send refuses without sending. A start's step 3
covers the input that finished between the start's inspect and its mark: the
session it restarted at `E` is stopped before the new one is launched.

A provider that hands a launch an endpoint it used before for the home
breaks the rule below. In the rows "stopped" and "unsettled" the `stop {E}`
then addresses whatever session holds that locator by then, which can be the
new one: the home is recorded running, its session is gone, it reads lost,
and the next input resumes it.

**A retire and an input in flight.** After a retire the input could not ask
for anything: the home, and the provider's commands with it, are gone. So an
input records that it is in flight, outside the home, before its read of the
home and until its answer; and a retire, after `stoppedAt` (from which a new
input is refused at that read) and its first `stop {E}`, waits for the
inputs in flight to end, at most an input's timeout and a margin, and asks
`stop {E}` once more. Then its scan, then the removal. An input still in
flight at the bound does not hold the retire: it goes on, with a warning
that names the input's process. A marker whose process is gone (judged as a
claim's holder is) is no input, and is removed.

**Resume count.** Taken under its own lock, before the provider's `input`,
and given back only when the provider itself refused the input.

## What a provider must do for this to hold

- `stop` is idempotent, and with `endpoint: null` stops whatever session
  rooted at the home was created at or after `launchSent`.
- `launch` either answers an endpoint for a session it started, or refuses
  having started nothing. **The endpoint it answers differs from every
  endpoint it answered before for that home**: an endpoint names one session,
  never a place that a later session takes over.
- `input` answers `submitted: true` only when it dispatched the input.
