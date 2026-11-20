# Starting an existing instance

An instance keeps its home, identity, work and notes when its harness stops.
The Desktop roster is the place to return to it:

- A running row opens its terminal.
- A stopped row offers **Start…**. Clicking the row opens the same dialog.
- A running row's action menu offers **Restart with…** to change harness or launch configuration in the same home.
- The hierarchy's action popover offers **Start…** for a stopped instance.
- An unknown status is shown as unknown, not as permission to launch another process.

The Start/Restart dialog names the existing instance, harness and host. Choose
a named launch configuration or keep the recorded launch. Without a selected
configuration, the harness can also be changed directly. A named configuration
fixes its harness; model and permission choices can override its defaults.

The Launch configuration list's second entry is **No launch configuration (the
harness as installed)**. It asks for the bare harness: the harness itself, with
no configuration's executable, arguments or environment, and without the
default configuration the host declares for that harness. The Harness list
stays usable with it. Alone, with "Keep recorded harness", it starts the
recorded harness bare; beside a picked harness, that one. It sends the word the
kernel reads as no configuration, `--launch-config none`, from one constant
(`LAUNCH_CONFIG_NONE`, `packages/client/launch-contract.mjs`) and never from a
row of the list: a row whose name is the word, or is not a string at all, is
not drawn as a configuration. Preview invocation sends the same choice.

The entry is offered only where the kernel that would answer the start is
known to read the word. The server says so in a key of its own on the list
answer of `POST /api/launch-configs`, `noneKnown`: `launchConfigNoneKnown`
(the same module) over the answering kernel's own feature list
(`answeringFeatures`, `packages/client/lifecycle-contract.mjs`). For an
instance on this computer that is this computer's kernel, which lists
`launch-config`. For an instance on a server it is the host's list, as the
roster relays it; a host that reports no list (before 0.49.0), or one this
computer's CLI does not relay, is unknown, and unknown is not offered. The
start route adds no refusal of its own for the word: this computer's kernel
asks the host at the call and sends nothing to one that does not list
`launch-config`. When the list is read again, the entry stays selected only
while it is still offered: a save selects the saved configuration, a remove
the recorded launch, and a read cut short by a start and repeated keeps the
entry, or falls back to the recorded launch when it is no longer offered.

Enter a model or leave the field blank to use the selected launch's default.
An old harness's model is not carried to a different harness. Available local model
suggestions are advisory; a model ID can also be typed. Start opens a fresh
harness conversation on the saved briefing and state. The one exception is a
resume after a shutdown, a reboot or a crash, which continues the instance's
own last conversation ([Resume after a shutdown](execution-targets.md#resume-after-a-shutdown));
it replaces the earlier rule that no start resumes a conversation (OATS 0.69).
A Start or Restart from this dialog is never a resume. Once the kernel accepts the start or restart, the
dialog closes and Desktop opens the instance's terminal as soon as its row is
running with a terminal session, so whatever the harness shows first (a
confirmation such as Claude Code's development-channels prompt, an error, the
session) is visible there. If the terminal is not ready within the wait, a
notice says so and the instance's row opens it later. A refused launch keeps
the dialog open with the kernel's error.

A start or restart that stops at a launch prompt is not a refusal: the kernel
keeps the session and answers `E_SPAWN_INCOMPLETE` with the outcome it
observed, as for a spawn. The dialog then says, in Desktop's words, that OATS
could not confirm the instance finished starting, with the kernel's reason and
whether input was sent, that its session was kept, and what to do: refresh
status, then open its terminal to read what it shows, and not start it again
before that. Under that sentence it shows what the screen differed in from the
confirmation OATS answers, when the kernel reported it ("OATS expected:" and
"The terminal showed:", the terminal's text as an attributed quote), and the
kernel's own message under "OATS says:". It never says the start failed, and
never that the instance started. An outcome the Desktop cannot read shows the
kernel's message, as before.

A start or restart can work while Claude Code ignores the development-channel
option: the instance runs, and mail and chat will not wake it. From 0.52 the
kernel's successful answer says so (`launchPrompts.status: "flag-ignored"`).
That start worked, so the dialog closes and the terminal opens as for any
start. A notice then says that the instance started and that Claude Code
ignored the channel option, so mail and chat will not wake it; with the reason
`channels-unavailable` it adds that Claude Code reported channels are not
available. Behind the notice's Details: "OATS says:" and the warnings of that
answer, whole and in the order given, each as one display line. It shows at
most 16 warnings, and at most 4096 characters of them: lines are taken in
order while both bounds hold, and no line is cut inside. With more, a last
line says how many are left out ("3 more not shown."). The cut is by
position. No warning is picked, matched or dropped by its words: the kernel's
own sentence is one string among them, and Desktop does not look for it. The
kernel puts that sentence last, so warnings that fill the bound before it
leave it out: the headline still says what happened, a person then does not
see OATS's own advice on what to check, and the last line says that something
was left out. The notice is also shown when the dialog was closed while the
start ran, as long as the workspace it was started from is still on screen.

The reader is `launchFlagIgnored` (`packages/client/launch-prompt-outcome.mjs`).
It takes an answer's `launchPrompts` and `warnings` and gives the fact
`{reason, warnings, omitted}`: the lines it keeps, bounded by
`FLAG_IGNORED_WARNINGS` lines and `FLAG_IGNORED_UNITS` UTF-16 units in total,
and how many lines the cut left out. It knows nothing of the act that was
answered. `flagIgnoredNotice` makes the headline and the
detail from that fact, and from nothing else. Both are tolerant: an answer the
reader cannot read, or any other status, gives no fact and no notice, and the
start reads as any start that worked. The start dialog calls them for a
start's and a restart's answer. A launched spawn's answer goes through the same
reader into its creation receipt, and the notice is the same
(`packages/desktop/docs/desktop-spawn-preview.md`, A spawn where Claude Code
ignored the channel option).

When OATS refuses a start or a restart with `E_LAUNCH_CONFIG_AMBIGUOUS` (the
start names a harness and no configuration, several configurations are declared
for that harness, and none is the default), the dialog says it in its own
words. Its status reads: "More than one launch configuration is declared for
the chosen harness, and none is the default. Choose one under Launch
configuration, or choose "No launch configuration" to run the harness as
installed." Under it stands OATS's message as one line, "OATS says:
`<message>`", through the display filter: whole, or "[withheld]" with no
name before it when the message is withheld, and no line when there is no
message (`kernelLines`, `packages/client/kernel-lines.mjs`). The message
quoted is the answer's own (`answered`, set by the page's transport in
`packages/desktop/renderer/views/common.mjs`), never the transport's stand-in
for an answer without one, such as "HTTP 409". The
sentence is chosen by the code alone (`startRefusalSentence`,
`packages/client/start-messages.mjs`); no part of OATS's message is read to
choose it. It names the dialog's two controls and no machine, so it is the
same for an instance on this computer and on a server. A **Preview
invocation** refused with that code reads the same sentence, then "Preview
only. No agent was started or stopped.", with OATS's line under it. Every
other refusal of a start, a restart or a preview reads as before: the answer's
message as the status.

If an ordinary Start dialog finds the instance already running, its action becomes
**Open terminal**. A failed or timed-out start requires **Refresh status** before
another attempt, because the launch may have succeeded before the reply was
lost. Changing workspaces dismisses the dialog and prevents a delayed launch
reply, or a terminal that becomes ready later, from opening in the wrong
workspace.

**Restart with…** is explicit: after validating the new configuration, the
kernel stops the current harness and starts the selected one. It does not
retire the instance, rerun identity creation or replace its worktree. A stop
that cannot be confirmed does not authorize another launch. Save in-progress
work before restarting; the old harness conversation is not transferred to
another harness.

Restart requests termination and waits for the current process to stop before
launching its replacement. If stopping times out, it leaves the instance for
inspection instead of forcing a kill or launching a second harness. OATS
preserves the home and work; it cannot guarantee that a harness or custom
wrapper saves all of its in-flight conversation state. Wrappers should
`exec` the harness or forward termination signals correctly.

**Preview invocation** asks the execution host for the resolved command and
displays it as text, with environment values redacted. It never launches an
agent. **Manage launch configurations** in the dialog creates or updates named
configurations in the deployment's `oats-local.yaml`, including executable/wrapper, a JSON
argument list, environment references, model and permissions. Saving a
configuration changes its definition; applying it to an existing home requires
an explicit Start or Restart. When editing redacted environment values, keep
**Preserve the saved environment** selected or enter a complete replacement.
Use the server's workspace to manage configurations defined on that server.

Desktop sends `POST /api/start/<instance>?ws=…&home=…` (and `server=…` for a
remote instance). The backend resolves that exact roster identity and calls
`oats session start --home <absolute-home> [--server <id>] [--model <model>] --json`.
Launch choices add `--launch-config` (a configuration's name, or `none` for
the bare harness), `--harness` or `--yolo`/`--no-yolo`.
Restart uses `POST /api/restart/<instance>?ws=…&home=…` and the single kernel
command `oats session restart` with the same selectors and choices.
Configuration inspection and editing use `POST /api/launch-configs?ws=…`,
routed through `oats launch-config list/set/remove/preview`. A refusal on that
route answers its code and the first 300 characters of its message; for
`E_LAUNCH_CONFIG_AMBIGUOUS` alone it answers the display filter's line over
OATS's message as it came (`displayLine`, `packages/client/display-text.mjs`):
withheld whole, or folded and bounded at `MAX_DISPLAY_LINE`, so the line the
dialog shows under its sentence is not cut short and nothing withheld survives
a cut. It answers an empty message when OATS gave none, never the stand-in text
a refusal without a message is given. These features
require the CLI's `launch-config` and `session-restart` capabilities; old
clients/hosts receive an update explanation instead of unsupported arguments.
The installed CLI must advertise `session-start`; remote starting also needs
the remote operation. The execution host checks the actual saved session
before launch. Desktop does not scaffold a home or execute a launcher itself.

The start rule is decided once, in the shared home
(`packages/client/session-start.mjs`), and the dialog and the route decide
through the same gate, so the dialog never sends a start it has refused. The
route reads the row again and checks the home, which the dialog cannot, so it
may still refuse one the dialog sent. The gate is a module of its own
(`start-gate.mjs`, re-exported by `session-start.mjs`) because the dialog's
page loads no Node builtin. `startGate` gives the first rule that
refuses a row, in this order, each with its code and sentence: the row is no
longer in the roster (`not-in-roster`); it is running and this is not a restart
(`already-running`: the dialog offers Open terminal instead); its state is not
known stopped and this is not a restart of a running row (`state-unknown`:
unknown is not stopped); a server's row the kernel does not report addressable
(`E_SNAPSHOT_UNKNOWN`); no accepted CLI or no `session-start`
(`cli-unavailable`, `unsupported-start-option`; a server's row:
`unsupported-remote-operation`); a restart without `session-restart`; a
launch choice (a configuration, the bare harness's `none` among them, a
harness or yolo) without `launch-config` (a server's row: also on the host).
`verifiedLocalHome` is the home check of a row on this computer: the exact
home its deployment's kernel reported for it, canonicalizing to
`…/instances/<name>` inside that deployment's canonical directory. `startInstance` runs the gate, the
home check (`E_HOME_UNVERIFIED`), then the CLI call (`cliStart`, with its wait),
and says whether the CLI ran. A failed start is `refused`, nothing was
started: every refusal of the gate and the home check, the kernel's
`E_SESSION_START_BUSY`, `E_SESSION_START_LOCK_STUCK` (an earlier OATS's start
lock in the home, which a person removes: its sentence says so, and the
kernel's message under it names the path) and `E_SESSION_RUNNING`
(`STARTED_NOTHING_CODES`), and
its `E_LIFECYCLE_BUSY` and `E_INSTANCE_RETIRING` when the answering kernel
lists `lifecycle-claim-start` (`CLAIM_STARTED_NOTHING_CODES`: a stop, an upgrade
or a retire holds the home, or a retirement or a failed spawn left cleanup to
finish, and a restart refused this way stopped nothing either);
or `uncertain`: anything else, `E_START_UNCONFIRMED` included, those two codes
from a kernel without the feature or a host whose features aren't known, and
`E_CLI_FAILED` when the call to the CLI fails on its way. The answering kernel
is this computer's for a local row and the host's for a server's row, through
its roster group (`answeringFeatures`). Either way the
dialog reads the row again before it offers another start. A second client
takes the rule from the stable surface (`test/client-boundary.test.mjs`); the
CLI call is not on it.

A start that worked answers the kernel's result, whole. A refusal before the
CLI ran answers `{error, code}`: the rule's sentence and its code. A failed
start answers `{error, code}`: the kernel's message through the display filter
(`displayLine`), and its code. A start refused for one of those two codes
also carries `startedNothing`, the rule's sentence for it: the dialog shows
that as its status, with the kernel's message under it, and `E_LIFECYCLE_BUSY`
reads by `details.holder`, so only a holder that runs is offered waiting. When
the code is `E_SPAWN_INCOMPLETE` and its details hold a launch-prompt outcome
for the instance the route resolved, the answer also carries `incomplete`: the
details decoded by `retainedSpawnDetails`
(`packages/client/launch-prompt-outcome.mjs`), the same projection a spawn's
retained result uses. It is decoded again on the way to the dialog by the two
places that list the keys an error carries (`apiJson` and `httpError` in
`renderer/views/common.mjs`), and kept only beside that code.

In the app, main's `api` proxy waits 70 seconds for a start or a restart (the
route class `instance-start` of `api-url.mjs`, answered for exactly the paths
the server routes as one), where an ordinary read has 20. The kernel may watch
a launch prompt for 30 seconds before it answers what it kept, and the route
waits 60 seconds for the CLI call (`cliStart`): the proxy must outlast that
wait, and a test holds the two together, so the dialog shows the kernel's
outcome, or the end of the wait, and never the proxy's.

A client never ends a start. The CLI call runs in a process session of its own
with no deadline. When the route's wait ends first, it answers
`E_START_UNCONFIRMED`, and the dialog says, in the Desktop's own words: "OATS
didn't confirm the start. It may still be running: check the roster before you
start it again." The start goes on, and the roster shows its result. When the
proxy gives up, or a window closes, the call runs to its own end.

Status collection reads each instance's recorded tmux socket and session,
with one query per socket per collection. A launcher shell with a harness
child remains running; a fallback shell or dead pane is stopped. Errors that
prevent a reliable observation remain unknown. A row that records a Herdr
target (Herdr was removed in 0.31.0) is never observed: it shows the kernel's
`E_HERDR_REMOVED` text, and Open and Start are disabled.

## When Desktop opens

After a shutdown, a reboot or a crash, the instances that were running have
lost their sessions. OATS Desktop asks the kernel to resume them: it runs
`oats session resume --json`
([Resume after a shutdown](execution-targets.md#resume-after-a-shutdown)), and
the kernel does the rest. The kernel looks
at every deployment on this computer's list (local deployments only, never a
server's) and resumes each lost session as it decides. What the kernel does to
a session, when it starts one fresh from its briefing instead, and when it
stops trying for one that keeps losing its session, is the kernel's rule,
written beside the command. A session lost long ago is not resumed
automatically, and Desktop says nothing about it; `oats session start
--resume` still brings it back by hand. Desktop owns no session: it runs the
command and shows nothing of its answer. There is no switch to turn it off.

**When it runs.** Once when Desktop opens, after Desktop has imported its
saved workspaces into this computer's deployments list, because the sweep
reads that list. After that, whenever Desktop reads a roster that shows an
instance of a local deployment, as the roster names its deployments, whose
session was lost and that is not running, and only then:

- at most one sweep at a time, and at least 30 seconds after the last one
  started (the one at launch counts);
- after a sweep that a status read started, every instance it was started
  for waits until it changes (it runs, or it is no longer lost); so does an
  instance any sweep could not resume, found was not lost, or left because it
  was lost long ago. Such an instance does not set off another sweep until a
  later roster shows it running or no longer lost, or a sweep resumes it;
- never for another machine's instances.

There is no timer and no queue: a read that comes too soon starts nothing,
and the next read asks again. A new window, a workspace switch, a restarted
backend or Desktop coming to the front start nothing on their own. The rule
is shared with the TUI (`packages/client/session-resume-trigger.mjs`), and
the kernel's machine lock and its record of this boot make running it from
several clients safe. It runs only when the installed OATS CLI advertises the
`session-resume` feature. Without it, nothing runs and nothing is said.

**Nothing is shown.** Desktop says nothing about a sweep: no notice, whatever
it resumed, started fresh, left waiting for you or could not resume (the
product owner, 2026-10-27). A resumed instance shows running in the roster
once a read sees it running. A sweep that fails writes one line with its code
to Desktop's log. `oats tui` says nothing about a sweep either
([Resuming lost sessions](tui.md#resuming-lost-sessions)).

**Quitting does not stop a sweep.** The sweep runs in a process session of its
own, and writes its answer to files rather than to Desktop. Quitting Desktop,
or Desktop crashing, while it runs leaves it to finish.

How the clients run the command and read its answer is in
[desktop-cli-api.md](desktop-cli-api.md#how-the-clients-run-the-sweep).
