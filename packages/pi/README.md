# @awebai/oats-pi

Pi harness bridge for [OATS](https://github.com/awebai/oats).

The runtime-neutral kernel and universal `oats` CLI live in
`@awebai/oats`. Publishes in lockstep with the kernel (same version
from the same release tag). This bridge registers no operational tools. It only:

- exposes `oats-getting-started` before an OATS workspace exists (the
  acquisition funnel);
- contributes the instance-local `.agents/skills` set inside a spawned
  instance;
- holds an instance's opening task (`@TASK.md`) on pi's own path until no
  turn another extension started is active, so pi runs it exactly once,
  as its input processing made it, instead of refusing it. It never waits
  for the task's own run: pi 1.2 and later count that run as active from
  before its before_agent_start, and queue a message sent meanwhile into it,
  after the task. It never sends, re-sends or alters a message. The
  exception: an extension loaded behind the bridge that starts a turn (or
  awaits I/O while one starts) inside its own input handling of the opening
  prompt, or on a pi before 1.2 in its before_agent_start, can still make pi
  refuse it, because pi's interactive mode sends the initial message with no
  streamingBehavior. @awebai/pi has no such handler. A session that shuts
  down (a reload, say) releases the hold, and pi then runs or refuses the
  task by its own rules;
- reports a turn that ended in a provider error, once pi has stopped retrying
  and recovering (`agent_settled`, pi 0.80.4 and later): a waiting claim
  through `oats instance waiting`, producer `oats.pi`, cleared by the next run,
  so the instance shows as needing input instead of idling unseen;
- reports a dialog an extension opens (`ctx.ui.select`, `confirm`, `input`,
  `editor` and `custom`: a question tool's, say) for as long as it is open, in
  pi's terminal UI and in RPC mode alike (`ui_prompt_start` and
  `ui_prompt_end`, pi 0.84.4 and later): the same claim, producer `oats.pi`,
  with reason `question` and the dialog's title as its text, cut to fit, or no
  text for a dialog with no title. The instance shows as needing input, with
  the question, and a scheduled wake holds its Enter instead of answering the
  dialog. Closing the dialog clears the claim, and so does a session that ends
  with it open, which waits for that write. An open dialog is shown over a
  failed turn, which shows again once the dialog closes. Outside an OATS
  instance nothing is reported. A screen of pi's own (its project trust
  prompt, a picker a person opened) fires neither event and has no claim.
  The bridge that sets the claim, a dialog's or a failed turn's, records a
  mark while it stands, `<home>/.pi/oats-pi-claim.json` (`{pid, start, token,
  reason}`), and clears only the claim its own mark stands for: a second pi in
  the home (a nested one, a subagent's session) leaves a live pi's claim, and
  never replaces its question. A question left by a pi that died with its
  dialog open is cleared when the home's next pi starts; with no pi to start,
  clear it with `oats instance waiting clear --producer oats.pi --home <home>`
  ([whose claim it is](../../docs/capabilities.md#oatscore-needs-input));
- records each turn's start and end in `<home>/.oats/turn.json` (`{event:
  "turn-start" | "turn-end", at}`, replaced whole at every boundary): pi's
  `agent_start` and `agent_end`, an aborted or failed run's end included, and
  the opening task's run like any other. A kernel that lists `status-activity`
  reads it for a tmux home whose harness runs, counting only a boundary from
  the home's current start, and shows the row as `activity: "working"` or
  `"idle"` ([the row field](../../docs/desktop-cli-api.md#row-activity)). The
  file is kernel-private, and read on no session provider's home. Only the
  home's own pi writes it: a second pi in the home (a nested one, a
  subagent's or a workflow agent's process) would end its runs while the
  home's turn goes on, so the recording bridge marks its own process
  environment (`OATS_PI_TURN_WRITER`, this package's alone), and a pi started
  below it that finds the mark of a live process for this home writes
  nothing. Between two
  attempts of a retried turn the row reads idle, for the length of pi's
  backoff;
- journals compaction summaries and sends resume nudges when the active
  knowledge capability created `STATE.md`/`log.md`. A startup gets the nudge
  only when pi kept an earlier session of the home (pi files a session once
  it holds a message), so a fresh home's first turn is its opening task. What
  `STATE.md` says decides nothing, and the bridge writes nothing to tell.
  Knowledge ownership, read/capture instructions, judgment and delivery
  remain capability-owned.

Skill resolution itself is owned by the kernel: spawn materializes the exact
kernel + soul + active-capability set into each instance's `.agents/skills`
and launches pi with that directory as an explicit skill path. Ambient
skills (user-level, packages, work tree) coexist with the OATS-composed set.

```bash
npm install -g @awebai/oats
pi install npm:@awebai/oats-pi
```

OATS
publishes both packages from the same version tag. Reload pi after an adapter
install or upgrade.

**Which kernel the bridge loads.** The bridge imports the kernel's
`lib/core.mjs`, from the first of:

1. `OATS_PKG_ROOT`, the kernel's package directory (a checkout of
   awebai/oats, say), when it is one;
2. inside an OATS instance, the kernel that launched it: the home's own
   `oats` (`$OATS_INSTANCE_HOME/.oats/bin/oats`), a link the kernel writes at
   every launch. A home therefore needs no global install, whatever PATH pi
   runs with, when its kernel runs from a checkout or a local install;
3. the `oats` on PATH, when its real path lies in the kernel's package: the
   global install's, or a checkout's after `npm link`. An `oats` that is a
   script running the kernel from elsewhere names no package and is passed
   over;
4. `@awebai/oats` in npm's global folder (`npm root -g`).

Outside an instance with none of these, pi reports the extension as failing
to load, with "OATS kernel not found" and the three ways out:
`npm install -g @awebai/oats`, an `oats` on PATH that links to the kernel, or
`OATS_PKG_ROOT`.

All lifecycle/config/package operations use the shell-visible CLI: `oats
status`, `oats spawn`, `oats doctor`, `oats install`, `oats trust`, `oats use`, and
`oats retire`.

With [OKF v2](../../docs/knowledge.md), state/log/notes stay episodic while
accepted expertise lives in external bases exposed as immutable reader views.
The Pi bridge is not a knowledge store or a proposal path: an instance
proposes its knowledge with `oats okf propose`, whatever its harness, and
retirement does not rely on this adapter's presence. V0.23.1 integration is
[prepared, not yet a publication claim](../../docs/release-notes/v0.23.1.md).
