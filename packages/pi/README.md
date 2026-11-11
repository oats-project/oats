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
