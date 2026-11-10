# Sessions

A **session** is the terminal in which an instance's harness runs. OATS
composes the instance home ([souls-and-instances.md](souls-and-instances.md)),
then launches the harness in a persistent terminal owned by a session backend.
Closing a viewer, or the Desktop, stops neither the agent nor its session.

All session commands run on the execution host, the machine that holds the
home. To run them on another machine, see [servers.md](servers.md).

## Harnesses

| Harness | `--harness` | Launched as |
|---|---|---|
| pi | `pi` (the default) | `pi --append-system-prompt <home>/AGENTS.md --approve --name <instance> [--model m] @TASK.md` |
| Claude Code | `claude` | `claude [--model m] -- '@TASK.md'` |
| Codex | `codex` | `codex --cd <home> [--model m] -- 'Read TASK.md in this directory first: it is your briefing and your task.'` |

Each harness starts in the instance home with its own native settings,
authentication and skill discovery. The command line also carries the
launch configuration's arguments and each capability's launch contribution.
`--runtime` is still read as `--harness`, with a deprecation warning; giving
both with different values is refused.

The harness, model, yolo choice and executable come from the spawn flags or a
named launch configuration (`--launch-config <name>`); see
[configuration.md](configuration.md#launch-configurations).
`--model @native-default` uses the harness's own default model.

The launch command sets `OATS_INSTANCE` and `OATS_INSTANCE_HOME`, plus the
environment that the launch configuration and capabilities contribute. No
`PI_AGENT_*` name is set, for any harness. The home's layout and what those
variables point at are described in
[souls-and-instances.md](souls-and-instances.md#instance-anatomy).

## Backends

tmux is the only session backend. `oats spawn --backend tmux` is accepted (it
is the default); `tmux` must be installed on the execution host. A launched
home keeps the session it recorded: `session start` and `restart` never
re-read the defaults. The session target is recorded twice: in
`instance.json` and in an independent lifecycle receipt. Every session command
checks that the two agree (`E_RUNTIME_AUTHORITY_MISMATCH` otherwise, with
`details.fields` naming what differs; see [Inspect, input and
attach](#inspect-input-and-attach)).

### tmux

Each instance is a window named after the instance in a tmux session: the
deployment's `session.tmuxSession`, else `OATS_TMUX_SESSION`, else
`PI_AGENTS_TMUX_SESSION` (the pre-0.31 variable), else `oats-agents`. Before
0.31 the default was `pi-agents`; a home launched then keeps the `pi-agents`
session it recorded, and `oats status` reads each home on its recorded tmux
socket and session, never the caller's `$TMUX` server: a caller outside the
agents' tmux (ssh, cron, a plain terminal) sees the same liveness as `session
inspect`. `running` means the harness is running, not merely that its window
exists. A fallback shell reads `running: false` with `runtimeState: "shell"`;
a retained dead pane also reads `false`. A wrapper shell with a live non-shell
descendant still reads `true`. tmux names the pane's foreground process group,
which is the launch's own shell while the harness runs as its child, so a
running instance is usually read through this process scan. `false` needs
positive evidence of the fallback prompt: the process table holds the pane's
own process as a shell and no non-shell process below it. A table that cannot
establish that (no pane process in it, as for a `ps` in another PID
namespace; a process in the pane with no command name; a line that is not a
process, when nothing non-shell was found) reads `running: null` with its
reason, and `session inspect` answers `E_SESSION_UNAVAILABLE`
([#1641](https://github.com/awebai/oats/issues/1641)). Status shares session inspection's pane rule,
with one batched pane read per socket/session and one lazy process scan across
all panes that need it. It reads the agent's pane alone, so a window with
another pane reads as one without it
([which pane is the agent's](#which-pane-is-the-agents)). A recorded server or
pane that cannot be read gives `running: null` with `runtimeState:
"unreachable"`, and so do a window where OATS cannot tell which pane is the
agent's and a session that holds two windows of the instance's name, each
with its reason as `runtimeError`. A local status read (0.69)
also records, in a kernel-private file of this machine beside the resume
sweep's per-boot note, what it saw of each home, for the sweep alone; it
never changes the answer, and a status routed with `--server` records nothing
here ([Which losses come back](#which-losses-come-back)). The environment variables are read when the spawn runs, and `oats
inspect --json` reports the session a new spawn would open in as `session`
(`{tmuxSession}`). A spawn refuses an instance name that is a live window in the
session it would open in, on the OATS tmux server (`E_INSTANCE_NAME_TAKEN`); a
live window of that name in another session, such as a `pi-agents` window
after the default moved, or on another tmux server, does not block it. Session
commands target each home's exact recorded window, so the two never mix. The
receipt records the session, window and socket. The spawn result prints the
attach command.

<a id="which-pane-is-the-agents"></a>
#### Which pane is the agent's

An agent's window can hold more than one pane: a person or a tool can split
it, as oats.setup's no-echo prompt does. Status and every session command act
on one pane of the window, the agent's.

- **The mark.** Whenever OATS creates or respawns the agent's pane (a spawn's
  window, a start's or restart's new window, a restart in place), it sets the
  tmux pane option `@oats-agent` on it, its value the instance name, which is
  the window's name. It is set in the launch's own tmux call, and a mark that
  cannot be set does not fail the launch. Pane options exist from tmux 3.0.
  The mark is internal: it is what OATS sets, not an interface for other
  tools.
- **The rule.** In a window with one pane, that pane is the agent's, marked or
  not. With several, it is the pane marked with the instance's name; when
  none is, the unmarked pane with the lowest pane id (`%N`, tmux's creation
  order: the window's own pane comes before any split of it). A pane marked
  with another instance's name is never the agent's.
- **A window launched by an earlier kernel** has no mark: it resolves to its
  lowest pane id until the next start or restart marks it.
- **When OATS cannot tell** (two or more panes marked with the instance's
  name, or several panes and none unmarked or marked with it), status reads
  `running: null` with `runtimeState: "unreachable"` and one of these
  sentences as `runtimeError`, and `session inspect`, `session input` (wakes
  included), `session attach`, stop and restart refuse with the same sentence:

  ```text
  the window has 2 panes marked as <name>'s agent pane (%3, %7); close all but the agent's with tmux kill-pane -t <id>, or close the window and start the instance
  the window has 2 panes and none is <name>'s agent pane (%2, %7); close the panes that aren't, or close the window and start the instance
  ```

- **Everything else is the agent's pane alone.** The fallback-shell,
  dead-pane and descendant rule judges it alone, and a `paneId` in an answer
  is its id; the
  other panes never make the instance unknown. Input and wakes paste into it
  even when the person's focus is in another pane. Stop signals only the
  processes under it, and a restart in place respawns it and marks it. The
  size inspect reports stays the window's. The viewer shows the whole window
  ([attach](#inspect-input-and-attach)).

<a id="the-oats-tmux-server"></a>
#### The OATS tmux server

OATS creates sessions on a tmux server of its own, named `oats`
(`tmux -L oats`), not on your default tmux server, where earlier kernels
created them. A tool that restyles the
default server (a theme switcher, a script that runs `tmux set -g …` or
`tmux kill-server`) therefore no longer reaches agent terminals.

- **Where it is.** The server's socket is
  `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/oats`. The instance records the absolute
  socket path it was created on, in `instance.json` and in the receipt, and
  every later command uses that recorded path, never the name. OATS does not
  compute the socket path and does not use `TMUX` to find a server: tmux
  resolves the name once, when the session is ensured, from the
  `TMUX_TMPDIR` of the process that runs OATS, which OATS passes on unchanged
  when it replaces the environment for that call.
- **Your configuration loads.** The server starts as any tmux server does, so
  your `~/.tmux.conf` (key bindings, status line, options) applies to it.
- **See what runs there:** `tmux -L oats ls`. Plain `tmux ls` and a bare
  `tmux attach` show your default server, so they do not show the sessions
  OATS creates now.
- **Attach:** `oats session attach --home <home>`. By hand, copy the
  `attach:` line that spawn prints: `tmux -S <socket> attach -t <session>`,
  with the recorded socket. `tmux -L oats attach -t <session>` is a
  convenience that holds only in an environment with the same `TMUX_TMPDIR`
  as the one that created the session.
- **`TMUX_TMPDIR`.** Two environments with different values (a login shell,
  and a process started by a service manager or launchd, a schedule runner or
  a GUI launch) each get their own `oats` server. Every instance stays
  reachable, because its absolute socket is recorded.
- **A limit.** A tool that runs inside a pane of the OATS server has `TMUX`
  pointing at that server and still reaches it.

**What OATS sets, and at which scope.** OATS sets nothing server-global on any
server when it creates a session or a window, and nothing at all on a server
other than the one the window is on.

| On | OATS sets | Scope |
|---|---|---|
| each agent window it creates | `window-style default`, `window-active-style default`, `cursor-colour default` | that window (`set-option -w`), by window id |
| each agent window, and the `hq` window of a session it creates | `window-size latest`, `aggressive-resize on` | that window |
| the pane of each window it launches a harness in, and a pane it respawns in place | no `COLORFGBG` or `OATS_HARNESS_EXECUTABLE` in the pane's environment, and none of the variables the launch removes ([a declared name is the provider's](capabilities.md#a-declared-name-is-the-providers)) | that pane's command |

So an agent pane takes the colours of the terminal that views it, whatever
the server's own defaults say, and on tmux 3.1 or later the window follows
the size of the viewer that used it last. A window that is restarted in place
keeps the options it has. A session OATS did not create, and the server's global
options and environment, are left exactly as they were.

- `pane-colours` (the palette) is not reset: a local reset did not neutralise
  inherited array entries, so OATS leaves the palette alone. A configuration
  that sets `pane-colours` globally therefore reaches agent panes. It comes
  from your own tmux configuration, which OATS loads on purpose: remove the
  setting there, or unset it on the running server with `tmux -L oats
  set-option -gu pane-colours`.
- The oldest supported tmux stays 3.0. On tmux 3.0 and 3.0a `window-size
  latest` is not available and is skipped, as before this change;
  `cursor-colour` is skipped below 3.3; no error in either case. On 3.0 and
  3.0a the window therefore keeps the sizing that server gives it, not the
  latest viewer's.
- The two sizing commands are each attempted on their own, and a refused one
  is ignored: the launch goes on. Nothing else is tolerated: a refused
  `window-style` or `window-active-style` is a launch failure (the spawn is
  rolled back and fails; a start fails with `E_SESSION_START_FAILED`). An
  earlier kernel failed a start whose recorded tmux server could not be
  reached when a sizing command was refused; this one does not.

<a id="a-server-started-from-inside-a-systemd-service"></a>
#### Where sessions run: the server's scope and each agent's

A tmux server lives in the cgroup of the process that started it, and its
panes with it. On a systemd host that cgroup can end, and take every agent
with it: a service's cgroup ends when the service stops (the schedule tick's
oneshot service ends after each tick, a Desktop run as a user service restarts
at each upgrade), and systemd-oomd, under memory pressure, kills a whole cgroup
of the user manager's: a client application's `app-*.scope` (OATS Desktop or
`oats tui` launched from a desktop session) with everything started from it.
So, on Linux, on the unified cgroup hierarchy, OATS keeps the server out of
its creator's unit, and each agent's harness out of the server's cgroup.

**The server.** When OATS starts the `oats` server (no server answered) from
inside a unit of the user manager, or from a system service, it starts it in
a transient scope of its own:

```text
systemd-run --user --scope --collect --quiet --unit oats-tmux-<hash>-<random> -- env -u INVOCATION_ID tmux -u -L oats new-session -d …
```

- **Only what changes.** The tmux command, its arguments and the environment
  the server starts with are the same as without the scope, less any
  `INVOCATION_ID`. `systemd-run` exports the scope's own `INVOCATION_ID` to
  what it runs, and the system's `env -u INVOCATION_ID` removes it, so
  neither the server nor its panes get it. It also removes a service's own
  `INVOCATION_ID` that the start's environment would otherwise carry (when the
  login environment cannot be read and the creator's is used). There is one
  scope per start that starts the server: `<hash>` is the first 12 hex digits
  of the SHA-256 of the server's address, and `<random>` 8 random hex digits.
  `systemd-run` and `env` are the system's own (`/usr/bin`, `/bin`), never
  ones found on `PATH`.
- **The server outlives its creator's unit.** It is a sibling of that unit,
  not part of it: the service can end, stop or restart, and the client can
  quit or be killed, and the server and its agents go on. The scope ends when
  its last process does, and `--collect` removes it then. That is usually the
  server. On a tmux without systemd support the panes are in the scope too
  (each agent's harness is not: below), so a process that outlives the server
  (one an agent's shell started in the background) keeps the scope until it
  exits. On a tmux with systemd support each pane has a scope of its own, but
  the dead server's scope still stays listed (`loaded inactive dead`) while a
  process from one of its panes lives. Either way, a later start never reuses
  that scope: it gets one of its own.
- **When the creator is inside a unit:** `/proc/self/cgroup` is the unified
  hierarchy (one `0::<path>` line), and the path's last component ends in
  `.service` (any service, system or user), or ends in `.scope` and the path
  runs through the user manager (`…/user@<uid>.service/…`): a desktop
  application's `app-*.scope`, a terminal's `vte-spawn-*.scope`, an agent's
  own `oats-agent-*.scope` (an agent that spawns), the manager's `init.scope`.
  A login session's scope (`/user.slice/user-<uid>.slice/session-N.scope`, an
  ssh or tty login) sits beside the user manager, not in it, and starts the
  server as before, as macOS does. So does a Linux host not booted with
  systemd (a container's own init, another init system): its cgroup paths
  name no unit of a user manager. A server that already answers is used as
  it is: one started before this rule keeps the cgroup it has.
- **The limits.**
  - Only the unified cgroup hierarchy is judged. On the old or hybrid
    hierarchy the server starts as before. When `INVOCATION_ID` shows the
    creator is a systemd service, the answer warns that the server lives in
    that service.
  - The scope needs the user's systemd manager and its bus
    (`XDG_RUNTIME_DIR`), and `systemd-run` and `env` in `/usr/bin` or `/bin`:
    a host without them gets the warning below at every start from a unit.
    A system service (one outside the user's manager) is wrapped the same
    way, and without a user bus it gets the warning below.
  - When `systemd-run` is missing or fails, and no other creator's server
    answers in the meantime, the server starts as before. The answer's
    `warnings` (spawn, session start and restart), and the schedule tick's
    record of that run, then say `the OATS tmux server was started inside
    <unit>: it ends when that unit stops; start the OATS tmux server from
    your own shell, or enable the user systemd bus (<reason>)`.
  - macOS is not wrapped: launchd lets the server, which leaves the job's
    process group, outlive the job.

**Each agent's harness.** Every launch of a harness (spawn, session start and
restart, and so a resume) runs it in a transient scope of its own, in the
user manager's default slice, wherever the server is:

```text
… PATH=<home>/.oats/bin:… systemd-run --user --scope --collect --quiet --unit oats-agent-<hash>-<random> -- env -u INVOCATION_ID /bin/sh -c '<record the start> && exec <harness> …'
```

- **One agent per kill.** systemd-oomd ends one cgroup at a time: with a scope
  per agent, memory pressure that selects an agent ends that agent, never the
  server or the other agents. `<hash>` is the first 12 hex digits of the
  SHA-256 of the home's canonical path, and `<random>` 8 random hex digits
  per launch: a scope ends with its last process, so a later launch never
  reuses its name. `systemd-run` and `env` are the system's own.
- **Nothing else changes.** Each step execs the next, so the harness keeps the
  process `systemd-run` began as: it is the pane's direct child, its exit
  status is the pane shell's, and stop, status and the launch-prompt check see
  the pane as without the scope. `INVOCATION_ID` is removed as for the server.
  The scope is decided at each launch and is never recorded: the home's
  `command`, its launch recipe, the start's receipt and the retirement baseline
  are as before, and `oats spawn --preview` does not show it.
- **The conditions.** Linux booted with systemd (`/run/systemd/system` is a
  directory, as `sd_booted` reads it), and the launching process on the
  unified cgroup hierarchy, whatever unit it is in. Before it wraps, the launch checks that a
  scope can be created: it runs `systemd-run --user --scope --collect --quiet
  -- true` with the pane's own `XDG_RUNTIME_DIR` and
  `DBUS_SESSION_BUS_ADDRESS`: what the launch's command sets (a launch
  configuration or a capability), else the session's, else the server's. It
  is bounded to 5 seconds. One OATS command
  checks once for each `systemd-run` and pair of values, so a start of many
  agents checks once.
- **When it cannot.** On a systemd host, when the check fails, `systemd-run`,
  `env` or `true` is not in `/usr/bin` or `/bin`, or the pane's environment
  cannot be read, the harness is launched exactly as before, and the answer's
  `warnings` (spawn, session start and restart), and a `launch-warning`
  event once the launch is recorded (a launch refused after the check leaves
  none), say once `the agent's harness runs in the OATS tmux server's cgroup,
  not a scope of its own: <reason>`. The sweep (`oats session resume`) says
  it once in its own `warnings`, not in each row. A pane whose server has no
  `XDG_RUNTIME_DIR` or bus (a server started where none was set, a user
  without lingering) fails the check. Off Linux, on a Linux host not booted
  with systemd (a container's own init, another init system: no user manager
  and no systemd-oomd), and on the old or hybrid hierarchy, nothing changes
  and nothing is said.
- **What is left.** `systemd-run` could still fail between the check and the
  pane. The pane's shell then reads exit status 1, an ordinary exit that is
  never taken for a harness to bring back.
- **See it:** `systemctl --user status 'oats-agent-<hash>-*.scope'` (one home),
  `systemctl --user list-units 'oats-agent-*'` (every agent), or
  `systemd-cgls --user`.

<a id="the-servers-start-environment"></a>
#### The environment of the server and its panes

A tmux server keeps the environment of the process that started it, as its
global environment. A pane gets its session's environment over that (the
variables tmux's `update-environment` names, taken from whoever created the
session, and anything set on the session with `set-environment -t`), plus
what the launch command sets (`OATS_INSTANCE`, `OATS_INSTANCE_HOME`, the
capabilities' and the launch configuration's variables), less what the
launch removes: a variable one of its capabilities declares and its hooks
leave out is not inherited from the session or the server
([a declared name is the provider's](capabilities.md#a-declared-name-is-the-providers)).
**A pane's
environment is its session's, `PATH` included, whoever creates its window**:
an instance, the Desktop or an operator's shell. The tmux client that creates
the window (or respawns the pane, in a restart in place) runs with only
`LANG`, `LC_ALL` and `LC_CTYPE`, and tmux takes a client's `PATH` only when
the client has one. The launch command then puts the home's own `oats` shim
first. So:

- A pane's `PATH` is its session's `PATH` when the session has one, otherwise
  the server's global `PATH`. It no longer follows the process that runs each
  spawn or start (it did before 0.42.0).
- A `PATH` and the variables that interpret it (a version manager's
  bookkeeping, such as mise's `__MISE_DIFF`, or nvm's) therefore come from
  one environment. OATS no longer overlays a creator's `PATH` onto another
  environment's companion state. It does not make an existing or external
  server's environment, a session override or a launch configuration's
  `PATH` coherent: it uses them as they are.
- The rest of the ambient environment follows the server's first creator,
  and a server that already runs keeps what it started with. Creating a
  session or a window on it changes nothing global.
- No window inherits another instance's launch environment through the
  session or the server: OATS creates a session with no `-e` and sets no
  instance's variables on it, and each window carries its instance's
  variables on its own command. A value that reached the server's or a
  session's environment some other way (a server started from inside an
  instance's pane, a `set-environment`) stays there, and reaches a launch
  only when none of that launch's capabilities declares the name.

**The harness is looked up where its pane looks it up.** A launch whose
executable is a bare name (the harness's own, or a launch configuration's
`executable` without a `/`) looks it up on the `PATH` the pane will run it
with, by this precedence:

1. a declared absolute `executable` is used as it is, with no lookup (a
   relative one is resolved against the deployment directory, as before);
2. a `PATH` set in the launch configuration's `env` (a literal, or a
   `fromEnv` reference resolved on this host) is what the pane's command
   line applies, so the lookup uses it;
3. otherwise the session's or the server's `PATH`, read with the strict
   reader below.

The lookup happens twice. Before anything is created, against the `PATH` the
pane is expected to have: for a start that reuses the home's recorded pane
(running, or left as a shell), that pane's own session on its recorded
server, whatever the OATS server holds and whether one runs; otherwise the
session's or the server's when the server runs, otherwise the `PATH` of the
environment the server is created with. And again
on the session OATS actually gets, whoever created it and with whatever
environment (another creator that won the race to create the server, a
session whose environment overrides `PATH`): found elsewhere, the launch runs
and records that executable; not there, the spawn is refused and rolled back
as any failed launch is, and a start is refused before it launches anything.
For a start the first check comes before a restart stops its harness; the
second, on the session OATS gets, comes after that session (and, when none
ran, the server) was created, and for a restart whose window went away
during its stop, after that stop. A session a refused start created is left
in place. A start under a new selection with no server running reads the
environment the server will be created with (your login environment, or its
fallback, below) for its first check, never this process's `PATH`. A recorded executable (a start that reuses the home's launch) is
kept as it is: it then runs with its pane's environment, but it is not looked
up again. A `--no-launch` spawn, and a preview with no server running, look
the harness up on the process's own `PATH`, as before, and the harness
packages such a spawn records (`composition.materialized.harnessPackages`)
are the ones found from the calling process; a preview says so
([below](#no-prediction)).

A session's `PATH` can be in four states, and the lookup tells them apart:
no entry (the server's `PATH` is used), a value, even an empty one (used as
it is), an explicit clear (`unset PATH;` in `show-environment -s`: tmux gives
the pane no `PATH` at all), or a value the strict reader leaves out. The last
two, and a server with no `PATH` or one that cannot be read, are refused: OATS
never substitutes the server's `PATH`, the caller's or a default for them.

A harness that is not on that `PATH` is refused with `E_HARNESS_UNAVAILABLE`
(a configuration's declared bare name with `E_LAUNCH_EXECUTABLE`). The message
names where it looked (`the PATH of tmux session <name>`, `the global PATH of
the OATS tmux server (<socket>)`, or the launch configuration's) and the
remedies: declare the executable's absolute path in the launch configuration,
set `PATH` in the launch configuration, or start the server from your own
shell. It never prints a `PATH`'s contents.

<a id="the-checks-read-the-pane"></a>
**Every check of a launch reads the environment its pane will have.** The
lookup above is one of them. The others read the account the harness will
run with: the folder-trust check (the file that harness reads its trusted
folders from), the harness package check
([capabilities.md](capabilities.md#manifest), the probe and the command
its refusal names), the `harness-trust` item of `oats readiness`, a
preview's items, and `oats harness trust`. They read five names, each by
the same precedence and each with where it was read from: `PATH`, `HOME`,
and the variable that moves a harness's folder (`CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, `PI_CODING_AGENT_DIR`), called its selector here.

1. The launch configuration's `env`: a literal, or a `fromEnv` reference,
   which is resolved on this host from the process that runs the command, by
   design. The pane's command line applies it, so nothing of tmux is read
   for that name.
2. A selector the launch removes: one of its capabilities declares it and
   their hooks leave it out
   ([a declared name is the provider's](capabilities.md#a-declared-name-is-the-providers)).
   It reads as not set, whatever the session or the server holds. This is
   known once the hooks have answered: the checks of a start, a spawn's
   checks on the session it gets, its folder-trust check, and readiness.
3. When a server runs: the session's entry, and the server's global one only
   when the session has no entry for that name. Both are read with the
   strict reader below, in one `show-environment` each for all five names,
   and only when a check needs a name that rows 1 and 2 do not decide.
4. When this spawn or start starts the server: the environment the server is
   created with (your login environment, or its fallback, below).

None of them reads the calling process's value in place of the pane's. The
folder-trust check and the package check once read the process's own `HOME`
and selector, so a spawn from a shell or an instance with another account
than the server's checked one account and launched with another
([#993](https://github.com/awebai/oats/issues/993)).

- **"Not set" is an answer for a selector.** No entry in the session or the
  server, or a session that clears it (`unset NAME;`, and the server's is
  then not used, as tmux does), means the harness reads its default folder
  under the pane's `HOME`: the checks read that file, and the package
  check's command starts with no selector. An empty selector counts as not
  set. A relative one read from tmux is read against the home, the pane's
  working directory. For `PATH` and `HOME`, no entry anywhere and a clear
  are problems, as for the lookup.
- **A name that cannot be read is never replaced.** The read failed, the
  strict reader left the value out (it holds a `$`, a line break or a
  character tmux prints encoded), or `PATH` or `HOME` is cleared or
  missing. Two behaviours:
  - **The package check refuses** with `E_RUNTIME_ENDPOINT_UNKNOWN`, before
    it probes anything: `cannot verify the harness packages this <harness>
    launch requires: <which name, read from where, and why not>. The probe
    runs with the <NAME> the launch's pane will have, never with this
    process's in its place; nothing was probed. To make it readable: set
    <NAME> in the launch configuration (env), or <what would make it
    readable in tmux>`. It needs `PATH`, `HOME` and the launching
    harness's selector; a selector of another harness refuses nothing. It
    reads nothing, and so refuses nothing, when no requirement applies to
    the launch. A lookup that already refused a `PATH` is the one refusal
    of that read: the package check does not refuse it again.
    The probe runs the executable the lookup selected, by its full path,
    never the harness's name looked up a second time: the command runs in
    its own directory, not the pane's. For the same reason the probe is
    given the pane's `PATH` as the pane reads it, a relative entry (and an
    empty one) resolved against the pane's working directory, the home.
    The command a refusal names keeps the harness's name as declared.
    The Claude probe (`claude plugin list --json`) sets `DISABLE_TELEMETRY=1`
    for its own run, so Claude skips its telemetry flush at exit: that selects
    no account and changes no answer, and no launch, install step or other
    probe gets it.
  - **The folder-trust check only warns**: `<harness> folder trust: the
    configuration file this launch will read could not be established
    (<why, and what would make it readable>); nothing is said about its
    trust`. A codex launch then does not trust its home from a file nobody
    read (a codex launch under `yolo` trusts its home whatever a file says,
    and is not affected).
- **A spawn judges again on the session it gets.** Like the lookup, the
  package check and the folder-trust check run before anything is created,
  on the pane the spawn expects, and again once the session exists (another
  creator may have won the race to create the server, with another
  account). The package check probes again only when `PATH`, `HOME` or
  the selector differ from what it judged, or the lookup found the harness
  at another path there; a requirement that does not hold
  there refuses the spawn, which is rolled back as any failed launch is. The
  folder-trust warning and the codex trust of the home follow the session
  the spawn got. A start that creates its session makes the first check
  only; a start that reuses its recorded pane reads that pane.
- **A warning names where the file comes from** when the pane's environment
  is established: `claude folder trust is not established in <file> (the
  CLAUDE_CONFIG_DIR of tmux session <name>): oats harness trust --dir
  <deployment>`, or `(under the global HOME of the OATS tmux server
  (<socket>))`, or the launch configuration's.
- **Through `oats spawn` the refusal's code is `E_RUNTIME_ENDPOINT_UNKNOWN`**,
  with the same message, as at `oats session start` and `restart` (feature
  `spawn-kernel-codes`, [#1047](https://github.com/awebai/oats/issues/1047));
  a kernel without the feature answers `E_SPAWN_FAILED`.
- **One limit.** A spawn's package check runs before the spawn hooks, so it
  does not know a selector a capability's hook sets for the launch
  ([#1041](https://github.com/awebai/oats/issues/1041)); a start's does.
  For the same reason it does not know which declared selector the launch
  will remove (row 2), and reads the pane's in its place; the spawn's check
  on the session it gets does. The folder-trust check does not read the
  capabilities' variables.

<a id="no-prediction"></a>
**When no pane can be predicted, the check says what it read instead.** No
server runs and the command only reads (a preview, `oats readiness`, `oats
harness trust`: none of them starts your login shell to find out); the
command has no tmux on its `PATH` to ask with; a preview could not read the
server; a start's session was refused; the spawn launches nothing
(`--no-launch`). The checks then read the launch
configuration's value when it sets one, else the calling process's, and say
so, for `PATH` too:

```
the pane's environment is not established until a spawn starts the OATS tmux server (none runs); read instead: this process's PATH
```

- **A command that writes does not take a failed read for "none runs".**
  When tmux is there and could not say whether the server runs (its
  `list-sessions` refused or cut off), a preview and
  `oats readiness` answer as above, with `the pane's environment is not
  established: this process could not read the OATS tmux server; read
  instead: …`. `oats harness trust` refuses instead
  (`E_RUNTIME_ENDPOINT_UNKNOWN`, nothing written): a server may run under
  another account, and the command would write the wrong file
  ([harness-trust.md](harness-trust.md)). A command with no tmux on its
  `PATH` makes no read at all: no prediction, for the writer as for the
  others, with `the pane's environment is not established: this process has
  no tmux on its PATH to read the OATS tmux server with; read instead: …`.
- A preview carries that sentence in the `executable` item's `detail`, in
  the `harness-packages` item's when a requirement was probed, and a spawn
  preview in `warnings`, in one line that names the checks (`the harness
  lookup: …`, `the harness lookup, the harness package check: …`). The
  package check does not refuse on that alone.
- The `harness-trust` item of `oats readiness` is then `unknown`, with
  the sentence in `reason`: in the warning, in place of where the file comes
  from, when the calling process's file does not establish trust; and when it
  does, `<harness> folder trust is established in <file>; that file is this
  process's, not known to be the one a launch will read: <the sentence>`. The item is optional,
  as before, and `ready` does not change with it. A launch configuration
  that sets the selector is read as before (`pass` or `fail`). When the
  server runs and the read fails, the item is `unknown` with the "could not
  be established" sentence above, and `file` is null.
- **A spawn that launches nothing says it only where it already says
  something.** Its checks read the calling process by design, and the start
  that follows checks again on its own session. When its checks pass it says
  nothing. A folder-trust warning says whose file it read, where an
  established one says where the file comes from: `claude folder trust is
  not established in <file> (the pane's environment is not established: this
  spawn launches nothing (--no-launch), and a start reads its own session's;
  read instead: this process's CLAUDE_CONFIG_DIR (not set), this process's
  HOME): oats harness trust --dir <deployment>`. A refusal for a missing
  package ends with `The account this probe read is not known to be the
  launch's: <the same sentence, naming PATH, HOME and the selector>`; a
  preview's refusal with no server running does too.

Who starts the `oats` server, after an install, a reboot or its last session
ending, decides that ambient environment.

**When OATS starts the server, it gives it your login environment.** The
`new-session` that creates an agents' session is the only OATS call that
starts the server. When no server answered before it, whoever runs it (a spawn
or a start from an instance, the Desktop, an operator's shell, a schedule
runner or a trigger), OATS reads the environment your own login shell sets up
and starts the server with that:

- **Only in your own session.** The login shell is run only for a process
  whose `HOME` is your home directory in the password database. A process
  that set another `HOME` (a sandbox, a test fixture, an account switch that
  kept the caller's environment) is not taken to run in your login session:
  its reading fails and the fallback below applies.
- **The shell** is your login shell from the password database (not the
  creator's `SHELL`): bash, zsh or fish, run as `-l -i -c` from your home
  directory, so your profile and rc files run as they do in a terminal (a
  version manager's activation, an agent socket an rc exports).
- **It starts from a fixed seed**, nothing else of the creator: `HOME`,
  `USER`, `LOGNAME` and `SHELL` from the password database, `PATH` as
  `/usr/bin:/bin:/usr/sbin:/sbin`, `TERM=dumb`, the creator's `LANG`,
  `LC_ALL` and `LC_CTYPE`, and the session variables `SSH_AUTH_SOCK`,
  `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR` and
  `DBUS_SESSION_BUS_ADDRESS`. Each of those comes from the first source that
  has it, an empty value counting as present: the creator, when it is not an
  instance; for an instance, the global environment of the server its home
  records; then your user session, read as data (`systemctl --user
  show-environment` on Linux, decoding systemd's `$'…'` values; `launchctl
  getenv` on macOS). A user session that cannot be read leaves those names to
  your login shell, and OATS says so on stderr, without values. On macOS the
  agent socket launchd gives the apps and terminals you open is not a
  `launchctl` variable (it is the `SSH_AUTH_SOCK` key of the
  `com.openssh.ssh-agent` job), so `launchctl getenv` usually has none: a
  server OATS starts there has your agent socket when the process that starts
  it has one (the Desktop opened from the Finder or the Dock, a terminal), or
  when your login shell sets it. The tool runs
  from `/usr/bin:/bin:/usr/sbin:/sbin` with your own `HOME`, `USER`,
  `LOGNAME` and, on Linux, your runtime directory (`/run/user/<uid>`), never
  with the creator's environment. No `OATS_`,
  `AWEB_`, harness or credential variable of the creator is in the seed.
- **What your setup produces wins**: the shell's answer is final, including
  what its rc files set, except the functions bash exports
  (`BASH_FUNC_<name>%%`, from a profile's `export -f`): they are code every
  bash in a pane would import, and OATS drops them. OATS then removes the
  kernel's names and the instance-identity names, as below, and keeps your
  OATS configuration as the creator has it: every `OATS_` and `PI_AGENTS_`
  variable that is not a kernel name (`OATS_HOME_DIR`, `OATS_TMUX_SESSION`,
  `OATS_PACKAGE_CATALOG`, …) is the creator's, over what your rc files set;
  for an instance, the one the server its home records has, never its own. The server is still reached with the
  creator's `TMUX_TMPDIR`.
- **The answer is one frame on the shell's stdout**: a small emitter run by
  the shell writes the environment as JSON between a start and an end
  delimiter that carry a random value made for this reading only. Exactly one
  complete frame of that reading, start before end, is the answer; anything
  else the shell prints (a banner, a prompt, text that looks like an
  assignment, like JSON or like a frame of another reading) is discarded, and
  a missing, cut, repeated or misordered frame is no answer. The shell's
  errors are not read, and no value is written to a file, an argument or a
  log. It is accepted only whole: exit status 0, at most 1 MiB for all the
  shell printed, one JSON object whose values are all text, plain
  identifiers as names, `HOME` and `PATH` present. Nothing in it is
  evaluated. Not a descriptor of its own: bash 5.3, started `-l -i`, marks
  the descriptors it inherits from 3 to 19 close-on-exec, so an answer there
  never reaches the emitter. The random value keeps accidental output apart;
  it does not guard against your own start-up files, which can also send the
  shell's stdout elsewhere (then there is no answer, and the fallback
  below applies).
- **It is bounded at 5 s.** The shell runs in its own process group; at the
  deadline that group, and only it, is killed, and the read ends even when a
  descendant still holds the shell's stdout. A descendant that put itself in its own
  session or group (a daemon an rc starts) is outside that group, and OATS
  does not promise to end it.
- **When it cannot be read** (a process whose `HOME` is not yours, a timeout, a non-zero exit, a partial,
  oversized or malformed answer, no `HOME` or `PATH`, a shell that is not
  bash, zsh or fish or cannot run), OATS prints one line on stderr saying
  why and what it used instead, never a value, and `--json` output stays one
  valid envelope. A creator outside every instance falls back to its own
  environment without the kernel's names (the behaviour before 0.42.0); an
  instance falls back to a copy of the server its home records, as below, or
  is refused, never to its own environment. A fallback is degraded: it is
  neither a login environment nor proof of a working agent socket, and it
  passes on whatever the creator's environment holds. A creator whose `PATH`
  names a version manager's directories without the variables that interpret
  them (a process started by a service manager, an agent's shell) gives the
  server that same mismatch, and a version-manager wrapper can then resolve
  its own name again and loop, as in #616. OATS prevents that only when it
  reads your login environment.

A server OATS did not start keeps what its starter gave it:

| Started by | The server's environment |
|---|---|
| OATS (any creator; see above) | your login environment, or the creator's fallback |
| you, from your own shell (`tmux -L oats new-session …`) | that shell's |
| a service manager (`systemd-run`, a unit, launchd) | only that manager's environment |

OATS uses an existing server as it is and does not certify its environment.
The first creator that succeeds determines it; when two start it at the same
moment, tmux starts one server and nothing says which of the two it is. A
server that exits between OATS's lookup and its `new-session` is started as
any server OATS starts: with your login environment, or its fallback.

**What OATS removes, for every creator.** The names the kernel itself sets
never go into the environment OATS creates an agents' session or window
with: `COLORFGBG`, `TMUX`, `TMUX_PANE`; the launch identity and roots
(`OATS_INSTANCE`, `OATS_INSTANCE_HOME`, `OATS_HOME`, `OATS_AGENT`,
`OATS_SOUL`, `OATS_SOUL_ID`, `OATS_ROOT`, `OATS_CONTEXT`, `OATS_WORKSPACE`,
`OATS_EVENT`, `OATS_SETTINGS`, `OATS_SETTINGS_ORIGINS`, `OATS_CLI_BIN`,
`OATS_NODE_BIN` (the node a hook writes into anything that outlives it),
`PI_AGENT_INSTANCE`, `PI_AGENT_HOME`, `PI_AGENTS_ROOT`); what a hook, an
operation, a retire or a trigger is given (`OATS_CAPABILITY`, `OATS_LAYER`,
`OATS_LEVEL`, `OATS_META`, `OATS_DEPLOYMENT`, `OATS_RESOLUTION`,
`OATS_OPERATION`, `OATS_REPO`, `OATS_BRANCH`, `OATS_WORK`, `OATS_KIND`,
`OATS_TASK`, `OATS_HARNESS`, `OATS_HARNESS_EXECUTABLE`,
`OATS_PREVIOUS_HARNESS`, `OATS_RUNTIME`,
`OATS_PREVIOUS_RUNTIME`, `OATS_LAUNCH_PREVIEW`, `OATS_RETIRE_INTENT`,
`OATS_TRIGGER_EVENT_FILE`, `OATS_TEST_LOGIN_SHELL` (a test seam that replaces
the login shell, honoured only for a process whose `HOME` is not your home
directory; a launch configuration cannot set it),
`OATS_TEST_WORKTREE_HOOK_TIMEOUT_MS`, `OATS_TEST_WORKTREE_FETCH_TIMEOUT_MS`,
`OATS_TEST_PROCESS_START_PS` (below), `OATS_TEST_CGROUP`,
`OATS_TEST_SYSTEMD_BOOTED` and `OATS_TEST_SYSTEM_TOOL_DIRS` (test seams of the server's and the agents'
[own scopes](#where-sessions-run-the-servers-scope-and-each-agents)), a `worktree` hook's tree
(`OATS_TREE`, `OATS_TREE_CLONE`, `OATS_TREE_REMOTE`, `OATS_TREE_MEMBER`,
`OATS_TREE_BASE`, `OATS_TREE_BASE_OID`, `OATS_PURPOSE`, `OATS_TREE_ORIGIN`), `OATS_TEAM_NAME`, `OATS_TEAM_SCOPE`,
`OATS_TEAM_ID`, `OATS_TEAM_LABEL`, `OATS_TEAM_LABELS`, `OATS_TEAMS`,
`OATS_TEAMS_SOURCE`, `OATS_DEFAULT_TEAM`, `OATS_DEFAULT_TEAM_ID`,
`OATS_DEFAULT_TEAM_FROM`, `OATS_WORKSPACE_NAME`, `OATS_WORKSPACE_KEY`); and
every launch reference (`OATS_LAUNCH_REF_<NAME>`) with the `<NAME>` it stands
for. Other `OATS_` variables you export (`OATS_HOME_DIR`,
`OATS_TMUX_SESSION`) are yours and stay, also when OATS starts the server
with your login environment (above). An agent's plain `oats` finds its
deployment from its home.

`OATS_TEST_WORKTREE_HOOK_TIMEOUT_MS` is another test seam, not a setting: a
positive whole number of milliseconds replaces the fixed 30-minute timeout of
[`worktree` hooks](capabilities.md#the-worktree-event), so the kernel's own
tests can reach it. `OATS_TEST_WORKTREE_FETCH_TIMEOUT_MS` does the same for the
10-minute fetch of `oats worktree add`. `OATS_TEST_PROCESS_START_PS=1` makes
the kernel read a process's start time with `ps`, as on a host without
`/proc` (macOS), on a host that has it; an absolute path instead runs that
file as `ps`, directly and in the same fixed environment; any other value
reads no start at all. That `ps` is asked for the start and the state in one
call (`-o lstart= -o stat= -p <pid>`); a file that answers the start alone
is read as a process that is not a zombie, never as an error. A launch configuration cannot set any of them. Do not set them in a deployment.

**An instance creates an agents' session or window without its own
environment.** Nothing of an instance's environment reaches a server or a
pane through the calls that create an agents' session or window. A harness
puts its own variables, credentials and identity into the environment of
what it runs. A process is inside an instance when `OATS_INSTANCE_HOME` names an instance
home, or its working directory is inside one. That covers an agent that
spawns or starts another instance, a capability hook that spawns or starts
(a hook runs with its instance's identity, also when a person ran the command
that triggered it), and `oats schedule run-now` typed inside an instance.

- When such a process has to create the tmux session on a server that runs,
  or its login environment could not be read, OATS reads the global
  environment of the server its home records (`tmux -S <recorded socket>
  show-environment -g -s`, the endpoint of the home's receipt, checked
  against `instance.json` as every session command checks it) and creates
  the session with that. What the new session gets is a reduction of that
  environment, not an exact copy. It is read strictly and never run by a
  shell; text that cannot be read to its end is a failed read. Not carried
  from the recorded server:
  - a hidden or removed variable;
  - a variable whose value holds a line break;
  - a variable whose value holds a `$`: tmux versions print it differently,
    so OATS does not guess what the value was;
  - on tmux 3.4 and 3.5, a variable whose value holds a control character or
    a byte that is not UTF-8, which those versions print encoded. Other
    versions print the line as it is: there a control character other than
    a line break is carried exactly, and a byte that is not UTF-8 fails the
    read.

  Such a variable is absent in the panes of the new server unless the pane's
  own shell start-up files set it; it is never filled in from the instance's
  own environment. When the variable left out is one that decides which
  configuration a tmux server loads or which programs it runs (`HOME`,
  `XDG_CONFIG_HOME`, `PATH`, `SHELL`), the creation is refused instead, with
  the same remedy as below.
- When it creates a window in a session that exists, the tmux client that
  creates it runs with `LANG`, `LC_ALL` and `LC_CTYPE` only, which that client
  needs to start on a host whose only UTF-8 locale is the one they name, as
  every creator's does. tmux hands a pane none of them: the pane, the session
  and the server keep the values they had, and the pane's `PATH` is the
  session's or the server's. Nothing of the instance travels, its `PATH`
  included. A restart that reuses the pane the home already has runs its tmux
  client with the same environment; where and whether the pane is reused does
  not change.
- **It is refused** (`E_RUNTIME_ENDPOINT_UNKNOWN`, by `oats spawn` too, with
  the same message; before 0.56.0 a spawn reported it as `E_SPAWN_FAILED`)
  when the session does not exist on the `oats` server, its login
  environment is not what the server gets
  (the server runs, or the login environment could not be read), and there is
  no source to read: the home records no
  tmux server (it was never launched), its receipt cannot be used, or its
  recorded server cannot be reached or read. A process that carries an
  instance's identity (`OATS_INSTANCE`, `OATS_INSTANCE_HOME`, `OATS_HOME`,
  `PI_AGENT_INSTANCE` or `PI_AGENT_HOME`) with no home to be found is refused
  the same way. Nothing falls back to the caller's environment, to another
  server or to a built-in list.
- **When the refusal comes.** In `oats spawn`: before any scaffold, work
  tree, identity or hook. In `oats session start`: after the start's
  preflights and its planning, and before the real run of preview-aware
  launch hooks, a stop and any write of the home's launch state (its record,
  its receipt, a pending start). A launch hook that does not declare
  `launchPreview` has already run by then, and a warning it returned is
  already a `launch-warning` event of the home, as before any other late
  refusal of a start (`E_SESSION_RUNNING`, `E_LAUNCH_ENV_MISSING`,
  `E_LAUNCH_ENV_CHANGED`). Nothing
  undoes what that hook did, and there is nothing to clean up: a launch hook
  may do idempotent provider registration on a real start and no more
  ([capabilities.md](capabilities.md)), so the next start repeats it
  harmlessly. Both launch hooks OATS ships are preview-aware. If the
  session disappears between that check and the creation, the refusal comes
  at the creation, and the spawn is rolled back as any failed launch is.
- **The remedy** is to create the session from your own shell, outside every
  instance home, as below. The session name matters: it must be the
  deployment's (the refusal names it); another deployment's session on the
  same server does not help. Once the session exists, the instance spawns
  and starts there without reading anything.
- The recorded server's environment is an existing baseline, chosen because
  it is what a window that instance opened on that server got. It is not
  proof that it holds no old identity or credential, and this is not a
  promise that secrets are isolated between instances that run as the same
  user on one tmux server.
- A server that already runs keeps its baseline. OATS creates sessions and
  windows on it and does not certify where that baseline came from or that
  it is clean: someone who started a server named `oats` by other means
  decided it.
- These rules are about the calls that create an agents' session or window,
  nothing wider. `oats session attach` creates a temporary viewer session on
  the server the home records, with the attaching process's own environment
  ([#623](https://github.com/awebai/oats/issues/623)): tmux imports the
  `update-environment` names into that temporary session, and if that
  server exits between the viewer's check and its creation, the attaching
  process is the one that starts it.
- Which server is reached is decided by the process that creates, never by
  the environment it passes: its own `tmux`, its own `TMUX_TMPDIR`, and the
  socket the lookup returned when the server runs. Its own `tmux` is the one
  its own `PATH` finds, and the session is created by that program's full
  path, as is every window client (it has no `PATH` to look one up with). A
  process whose `PATH` holds no tmux cannot read the server at all:
  it is refused (`E_RUNTIME_ENDPOINT_UNKNOWN`) whether or not the session
  exists, and told to run the command with a `PATH` that holds tmux. A
  process whose `PATH` is not set has no tmux to run by its full path: it
  cannot create a session, nor open or respawn a window (the window is
  refused). Only finding a session that is already there is not refused. What the server process
  gets (`HOME` and so which configuration loads, `PATH`, everything else)
  comes from the passed environment alone. The global environment of the
  server the session is created on is never read for this and never changed;
  the one that is read is the recorded server's, as above.

A process that neither sign identifies as an instance is treated as any
other creator: when it starts the server, your login environment (above);
otherwise, and as the fallback, its environment without the names above.

By hand (`<session>` is the deployment's session name: `oats-agents` unless
`session.tmuxSession` or `OATS_TMUX_SESSION` says otherwise):

```sh
tmux -L oats new-session -d -s <session> -n hq   # start it yourself: it keeps your shell's environment
tmux -L oats show-environment -g                 # what environment the server has
tmux -L oats show-environment -g LANG            # one variable
tmux -L oats set-environment -g LANG "$LANG"     # repair a running server: windows created from now on inherit it
tmux -L oats kill-server                         # replace it: ends EVERY session on that server
```

- There is no manual step: when OATS starts the server, it gives it your
  login environment. A server you start yourself keeps your shell's
  environment, and one a service manager starts gets only that manager's.
  OATS finds a session you created and uses it: it looks the session up by
  its exact name and assumes nothing about its `hq` window.
- `set-environment -g` is how a running server is repaired: it ends nothing,
  and panes that already run keep the environment they have. Windows created
  from now on take it, `PATH` included (with no session override of it), and
  their harness is looked up on that `PATH`.
- `kill-server` ends every session on that server, every running agent
  included. It is for before agents are started, not for repairing a running
  host. The next start gives the new server your login environment when OATS
  starts it, or the environment of whoever else does.
- `-L oats` reaches the server of the environment you type it in
  (`TMUX_TMPDIR`). For the server an instance is on, use the socket from its
  row in `oats status --json`: `tmux -S <socket> …`.
- <a id="missing-socket"></a>A tmux server whose socket file is missing
  (`error connecting to <socket> (No such file or directory)`) is not proof
  that it exited: a server outlives its removed socket file (a
  temporary-files cleaner, a removed socket directory), and tmux gives the
  same words after a reboot, when the server is gone. So OATS reads it as
  stopped only when no process works in the instance's home
  ([the process scan](souls-and-instances.md#the-process-scan)): the row is
  not running and a start creates the window again, as after a reboot. When
  a process works there, or the scan cannot run, the state is not
  established: `oats status` shows the row `running: null` with
  `runtimeState: "unreachable"` and a `runtimeError` that names the
  processes (pid and program, at most five) or the scan's error;
  `oats session start` and `restart` refuse with `E_SESSION_UNKNOWN` and
  create no server at that path; `oats instance stop` refuses with
  `E_SESSION_UNAVAILABLE`, never "already idle". tmux recreates a removed
  socket file when its server process receives `SIGUSR1`
  (`kill -USR1 <pid of that tmux server>`); OATS names that and never sends
  it. Any process working in the
  home counts, a shell left in that directory included, as for retire: the
  message names its pid and program, so end it or leave the directory. A
  socket file no server listens on (`no server running on <socket>`) is
  definitive: stopped, with no scan
  ([#624](https://github.com/awebai/oats/issues/624)). This holds for every
  tmux server OATS reads, not only the `oats` server, and for a home that
  records no socket and reads your default server. A home that records
  neither a socket nor a launch (`--no-launch`) reads as not running
  whatever works in it.

<a id="existing-instances"></a>
#### Existing instances

Upgrading moves nothing. An instance launched by an earlier kernel stays on the server
it recorded (usually your default one), and status, inspect, input, attach,
stop and retire keep acting on that recorded socket. While a deployment has
both, look at both servers: `tmux ls` and `tmux -L oats ls`.

- A restart in place stays on the recorded server: a live harness that is
  restarted, a fallback shell or a dead pane is reused where it is, and the
  record does not change.
- **Changed:** a start that has to create the window again, because the
  recorded window is gone or the recorded server cannot be reached, creates
  it on the OATS server. Earlier kernels recreated it on the recorded socket.
  The start records the new socket in `instance.json` and the receipt, and
  says so: one line in its `warnings`, naming the instance, the old socket
  and the new one, and the same text as a `launch-warning` instance event.
- A home that was never launched (`--no-launch`) starts on the OATS server,
  with no warning.

To move a running instance deliberately:

```sh
oats instance stop <instance> --plan     # then run the `apply with:` line it prints
tmux -S <recorded socket> kill-window -t '=<session>:=<instance>'
oats session start --home <home>
```

The socket and the session are the `tmux.socket` and `tmux.session` of the
instance's row in `oats status --json`. The stop leaves a fallback shell in the
window, which a start would reuse in place; closing the window is what makes
the start create a new one.

Do not end the agents' session by hand (`tmux kill-session`): that ends every
other instance whose window is in that session, not only the one you are
moving. And a window that a viewer still links would live on in that viewer,
so the next start would create a second window for the same home.

### Herdr (removed in 0.31.0)

OATS no longer supports Herdr. Everything that meets it refuses with
`E_HERDR_REMOVED`, whose message starts `Herdr is no longer supported by OATS
(removed in 0.31.0); tmux is the only session backend.` and says what to do:

- `oats spawn --backend herdr` or `--herdr-socket`, local or routed with
  `--server` (refused before the server is contacted), and `oats server add
  --herdr`: remove the flag, or use tmux.
- A schedule's `backend: herdr` or a trigger's `spawn.backend: herdr`: the
  message names the file and key; remove it, or use tmux. A stored local job
  that names it is reported invalid and never runs.
- `session inspect`, `attach`, `input`, `start`, `restart` and `instance stop`
  on a home a Herdr-era kernel recorded (its `instance.json` records a
  `sessionTarget` or `backend: "herdr"`, or its receipt records a session
  target): retire it and spawn a new instance, which opens in tmux.
- `oats retire` of such a home needs no Herdr: when no process works in the
  home it proceeds as for an absent session; when one does, it refuses and
  names the pids, so stop its Herdr pane first (for example `herdr --session
  oats server stop`).

`oats status` lists such a home with `running: null`, `runtimeState:
"unsupported"` and the refusal as `runtimeError`. A server registration or
saved route that records `herdrPath` still loads; the field is ignored.

## Lifecycle

| Command | Effect |
|---|---|
| `oats spawn <soul> [--no-launch]` | Creates the home and launches the harness. `--no-launch` creates the home only. |
| `oats session start --home <abs>` | Starts a stopped or never-launched instance again in its existing home. |
| `oats session start --resume --home <abs>` | Starts an instance whose session was lost again, in its own last conversation ([Resume after a shutdown](#resume-after-a-shutdown)). |
| `oats session resume [--deployment <dir>] [--plan]` | Resumes every lost session of this machine's deployments ([Resume after a shutdown](#resume-after-a-shutdown)). |
| `oats session restart --home <abs>` | Stops the running harness and starts it again in place. |
| `oats instance stop <instance> --plan` / `--apply` | Stops the harness and keeps home, work and launch recipe. |
| `oats retire <instance>` | Ends the session and retires the instance ([souls-and-instances.md](souls-and-instances.md#retire)). |

### Start and restart

`session start` keeps the instance's identity, work tree and notes. It runs no
spawn hooks and creates no new home. It runs the recorded launch recipe in the
recorded tmux session. A window that is still there is reused on its recorded
server; a window that has to be created, a `--no-launch` home's first one
included, opens on [the OATS tmux server](#the-oats-tmux-server).

- `--model`, `--launch-config <name>|none`, `--harness` and `--yolo` /
  `--no-yolo` re-resolve the recipe against the home's recorded context and
  run every check before anything starts. `--model` replaces the recorded model
  for this and later starts.
- A live harness is refused (`E_SESSION_RUNNING`). A fallback shell or a dead
  pane is reused in place: the agent's pane is respawned and marked, and the
  window's other panes are left as they are
  ([which pane is the agent's](#which-pane-is-the-agents)). A missing window, or one whose tmux server cannot
  be reached, is created again on the OATS tmux server, and the start warns when that is
  not the server the home recorded ([Existing instances](#existing-instances)).
  A server whose socket file is missing counts as gone only when no process
  works in the home ([missing socket file](#missing-socket)).
- A state that cannot be established is refused (`E_SESSION_UNKNOWN`). Two
  starts of one home serialize (`E_SESSION_START_BUSY`). A home being retired
  is refused (`E_INSTANCE_RETIRING`).
- Every start and restart, a scheduled start included, holds the home's
  lifecycle claim for the whole start (#1602), the claim a retire, a stop and
  an upgrade hold: none of them runs beside it, and it starts nothing beside
  one of them. Beside a stop or an upgrade it is refused `E_LIFECYCLE_BUSY`,
  before anything is stopped or started; a retire, a stop or an upgrade that
  arrives while it runs is refused `E_LIFECYCLE_BUSY`, `details.action:
  "start"` ([Commands that meet on one home](desktop-cli-api.md#lifecycle-pairs)).
  A start that dies leaves a holder that is gone, which the next command takes
  over. A spawn's own first launch takes no claim, and neither does a path with
  no `instance.json` it can read, which writes nothing beside it.

`session restart` takes the same flags. It sends SIGTERM to the harness and
its children, the processes under the agent's pane, waits `--stop-grace <seconds>` (default 20, at most 300), then
starts in place. It never escalates: a harness still running is reported
(`E_SESSION_STOP_FAILED`) and nothing is launched. It holds one lifecycle
claim from before its stop to after its launch, so no retire runs between the
two.

### Launch prompt outcomes

When a spawn, start or restart launches Claude with
`--dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace`
([configuration](configuration.md#the-development-channel-confirmation)), the
launcher observes only the process created by that invocation. A new window
supplies the exact pane identity. Reusing a pane requires a changed numeric
process ID and fresh visible bytes differing from the pre-respawn screen, at the
pane's original size: a resize could reflow the old prompt into a match. An
already-running process, stale screen or scrollback grants no input authority.
Home, socket, pane and PID are rechecked before the key, and the screen is
captured twice, identical, around the durable intent.

Observation is bounded to 30 seconds with 100 ms intervals. A blank screen, or
one that keeps changing (a prompt still being painted), keeps observing. Only a
screen whose normalized text equals a tolerance entry can be answered, once,
with one Enter. A screen with a notice block (a maximal run of rows that begin
with `▎`, each row's `▎` dropped, then the same normalization) that equals a
`flag-ignored` entry, on a screen with no question marker, means Claude ignored
the flag and shows no confirmation: the start ends `flag-ignored`, reason `channels-unavailable`, with no key, and
succeeds. An unknown screen that holds still for the settle window (`SETTLE`,
2 s; a transient frame Claude paints while starting is waited out) permanently
closes authority with `blocked: unexpected prompt`. The last unknown screen when
the bound is reached, still changing, closes it with `blocked: observation
timeout` (with `differed` and that screen as evidence; no prompt was
established). When either screen starts with Claude's
running-session banner (`Claude Code v<semver>`, after only the logo's block
elements U+2580–U+259F and spaces), the result carries
`claudeSessionShown: true`. A screen blank for the whole bound also reports
`blocked: observation timeout`. Folder-trust and API-key prompts
are unexpected and block; no multi-prompt sequence is authorized. The controller
never resizes the pane. Uncertain submission is never retried. Ordinary
`session input` and wake delivery do not enter this controller. A launch with any
other argv records `launchPrompts: {status: "not-engaged", startId, at}` and
captures nothing.

Both spawn and start return `E_SPAWN_INCOMPLETE` for retained prompt failures.
With `launchPrompts.status` set to `blocked`, the home, actual terminal target,
provider effects and committed parent lineage are retained. Only a launch that
engages the confirmation commits a new parent link before dispatch; other launches
keep their post-launch lineage commit and compensate a failed anchor write. That
preserves timing, not overwrite behavior: every parent spawn refuses an
anchor edited or removed since the original pre-hook snapshot, instead of
replacing concurrent changes with stale metadata. `launchPrompts` records `status`,
`answers`, `reason` and event `receipt`, and a blocked result `differed`; unknown
prompts use `blocked: unexpected prompt`. Status `incomplete` means the audit could
not be completed, including a possible key followed by an audit failure or failure
to retain completion evidence. No complete clean `SETTLE` window (2 s) within the
bound after the Enter is `blocked: observation timeout`, with the one Enter in the
answers. It is
not proof that no input was sent. Both outcomes record `launched:false` while
retaining the real process/endpoint for inspection: this is never permission
to allocate another harness.

If metadata or pending-receipt recording fails after controller completion,
the API escalates to `incomplete` and appends a checked `launch-prompt` incomplete
event, retaining prior answers and receipts. Failed audit writes remain
`incomplete`; they never authorize another key or retry.

A replaced or unverifiable launch home is the explicit auditing exception.
There is no new home or deployment row: resolving either log through current
home metadata could address the replacement incarnation. The API reports
`launch home identity changed; metadata retained at original home`, preserves
prior evidence, and adds `{ok:false, results:[]}` to the receipt array. That
entry means zero audit destinations were attempted, not a successful write.
No audit or metadata write is directed into the replacement home.

A blocked result can follow a successfully submitted Enter: a question marker
after it, or the confirmation coming back, leaves the pane active while reporting
a retained block. Inspect `answers` and the event receipts; never infer that
nothing started or nothing was answered. See the
[completion rule](launch-prompt-completion.md).

### Private unmatched launch evidence

This section also covers mandatory completion evidence.

The screen of a miss (`blocked: unexpected prompt`, before or after the Enter, or
`blocked: repeated or unsupported prompt`) is retained locally at
`<home>/.oats/launch-prompt-evidence/<sha256(startId)>/frame.txt`, with
`receipt.json` published last. This is the exact UTF-8 text already compared by
the controller, including whitespace and final newline, not a later recapture.
It is bounded to 64 KiB, with one row per pane row at the pane's own size. There
is no new input, observation, retry, geometry change or readiness claim. Evidence
is also mandatory when the post-answer [completion rule](launch-prompt-completion.md)
reports completion. No frame is saved for unrelated blocked reasons (ownership,
timeouts, capture failures).

Find the invocation's existing `launch-prompt` event in the home's
`.oats-events.jsonl` (or the checked event rows in `launchPrompts.receipt`). Its
`data.startId` supplies the string to hash with SHA-256, UTF-8, yielding the
lowercase hexadecimal directory name. Match the event's home, socket, window,
pane, PID and `signatureDigest`; do not assume a top-level spawn-result `startId`.
Spawn and same-home start/restart use this same controller and event path.

New evidence directories are owner-only 0700 and files 0600. The writer checks
canonical directory identities, ownership, modes and symlinks, refuses ACLs on
evidence directories/files (including macOS ACLs hidden by xattrs), refuses an
existing invocation directory, and publishes bounded files without overwrite.
The private receipt binds the start, target, original home identity, dimensions,
frame inode, byte count and SHA-256. `retainedAt` is write time; `captureTime:null`
means no independent capture timestamp was recorded. It does not substitute an
event timestamp for capture time. Same-uid concurrent mutation between checks is
not excluded.

Private receipt version 2 uses `kind:"launch-prompt-frame"`. This kernel writes
only `outcome:"blocked", recognition:"unmatched"`,
`outcome:"completed", recognition:"stable-screen"` or
`outcome:"flag-ignored", recognition:"notice-block"`; readers also accept
`outcome:"completed", recognition:"structural"`, written by kernels 0.47–0.51 for
completion recognized by Claude's footer structure. These fields describe the
recognition whose frame was saved, not the final public launch result: a later
audit or cleanup failure can still report `incomplete`. Historical version 1
receipts with `kind:"launch-prompt-unmatched"` describe blocked/unmatched
evidence. Readers must reject unknown versions, kinds or crossed pairs rather
than infer completion from an artifact's presence.

Before collecting a frame, verify its original `frameIdentity`, byte count,
digest and dimensions against the receipt, and bind the receipt's `startId`,
home and target to the checked launch event. A copied file has a different
inode: preserve the original identity as provenance instead of comparing the
copy's inode with it. Missing, partial, mismatched or failed-save evidence, or
an incomplete public launch result, must not be reported as a successful
completed observation. Collection never recaptures the pane or retries input.

Verify both files, receipt/identity/digest and the corresponding checked event
before treating the save as complete. A frame alone is partial evidence. Failed
publication, fsync, readback or temporary-file cleanup leaves the launch blocked
and adds only `; private launch evidence retention failed` to its diagnostic
reason. Already published files may remain, including a receipt if a later
verification fails; their presence alone is not a success claim. The submitted
answer is preserved. Existing event-audit failures still report `incomplete`.
A completion save failure instead reports checked `incomplete` with
`private launch evidence retention failed`, preserving the submitted answer and
retained target. It never retries publication or input. An audit failure remains
incomplete even if private evidence was saved. No public result or event contains
the raw screen or private receipt; a miss's `differed` carries at most 40
characters of the normalized screen at its first difference.

The frame can contain private task or account text. It stays on this host with
no automatic transmission or expiry. Preserve needed evidence privately before
retirement; it follows the home's ordinary conservative recovery behavior, with
no integrity-neutral exclusion or new cleanup policy. A saved frame is evidence
for review, never automatic permission to activate a new matcher.

Retiring a blocked or incomplete spawned home can preserve a recovery copy
labelled `changed instance-home bytes`, even without authored changes: the
kernel changed metadata from `launched:true` to `false` after its baseline.
This conservative recovery is intentional. The independent runtime receipt
still controls the endpoint, and a mismatched metadata endpoint is refused.

Inspect the retained home with `oats session inspect --home <home>` and attach
if needed. A later `oats session start --home <home>` uses the ordinary running
process checks; it cannot answer into a still-running retained launch. Repeating
spawn, including the same idempotency key, does not replay prompt answers or
create a duplicate home. A genuinely new process in a later launch gets its own
bounded authority. A prompt receipt does not assert receive readiness.

### Stop

`oats instance stop <instance> --plan` reports the session state, recorded
children and uncommitted work, with a `planRevision`. `--apply --plan-revision
<rev> --idempotency-key <key>` stops the instance and its recorded children
first (`--no-recursive` stops only the instance), with the same bounded
SIGTERM, sent only to the processes under the agent's pane
([which pane is the agent's](#which-pane-is-the-agents)). Restart the instance later with `oats session start` or
`oats session restart`. An instance whose recorded tmux socket file is
missing while a process works in its home, or the process scan cannot run,
is not reported idle: its result is `E_SESSION_UNAVAILABLE` and nothing is
stopped ([missing socket file](#missing-socket)). A stop apply holds the
claim of every instance it stops, the one a retire holds (OATS 0.52.0): one
that meets a retire of any of them answers `E_INSTANCE_RETIRING`, one that
meets another stop `E_LIFECYCLE_BUSY`, before anything is stopped
([the table](desktop-cli-api.md#lifecycle-pairs)).

**Stop an instance with OATS to keep it stopped** (Desktop's Stop, `oats
instance stop`): the stop's record names the start it ended, and a resume
never brings that start back. A stop of an instance that already reads
`lost` signals nothing and records the stop all the same, so the instance
stays stopped (on a full disk it cannot, and it stays `lost`). A tmux window
killed by hand, or a harness killed by a signal, leaves no such record and
reads as lost ([Resume after a shutdown](#resume-after-a-shutdown)).

### Resume after a shutdown

After a shutdown, a reboot or a crash (OATS 0.69, #1559), `oats session
resume` brings back every instance session that OATS saw alive and then lost
([Which losses come back](#which-losses-come-back)), on every deployment in
this computer's list
([workspaces.md](workspaces.md#this-computers-deployments)), each in its own
harness conversation, with the launch it recorded. OATS Desktop and `oats
tui` run it once when they open. Running instances are left alone; instances
stopped with OATS, or whose harness ended by itself, stay stopped. Stopping an
instance with OATS is the only way to keep it down: nothing opts a deployment
or an instance out of the sweep.

**A home OATS is stopping, upgrading or retiring, or whose retire did not
finish, is never resumed** (OATS 0.69.2). A resume holds the home's lifecycle
claim for its whole start, the claim a retire, a stop, an upgrade and every
other start hold, so it never runs beside one of them, and it reads under that claim whether the
home owes a retire and whether its session is still lost. The sweep reports
such a home `skipped`, `lifecycle-busy`, and starts nothing; what OATS was
doing decides what the home is next. A retire records the stop of the session
it ends, before it ends it, so a home it was retiring reads `stopped`, never
`lost`, even when the retire fails afterwards. The one exception is when the
stop record itself cannot be written (a full disk) and the retire then fails
as well: that home reads `lost`, as it did before 0.69.2.

`oats session restart` records the stop of the session it replaces the same
way, before it asks the harness to end (#1601): a restart whose relaunch
fails, or that dies between the stop and the relaunch, leaves a home that
reads `stopped`, so no resume starts again the launch it was replacing. The
relaunch records a new start, which that record does not name. A restart
whose stop is refused (`E_SESSION_STOP_FAILED`, the harness still there after
the grace) keeps its record: should that harness die later, the home reads
`stopped`, not `lost`. A restart of a home that does not run stops nothing and
records nothing, so it keeps its reading.

#### How a session's end is read

A launched home that does not run reads one of three ends, `sessionEnd` on
its status row ([desktop-cli-api.md](desktop-cli-api.md#row-session-end)),
for its current start (`startId` in `instance.json`):

| What the home holds for its current start | `sessionEnd` | Resumed |
|---|---|---|
| a stop's record that names it (or, a record from before 0.69, written after the start) | `stopped` | no |
| an exit marker that names it with an exit status below 128 (`/exit`, Ctrl-C handled by the harness, its own error), or the marker of a kernel before 0.69 | `exited` | no: the row offers Start, as before |
| an exit marker that names it with a signal's status (128 and up: the harness alone was killed, an out-of-memory kill for example) | `lost` | when the sweep can vouch for the loss ([below](#which-losses-come-back)) |
| neither (the host went down, or the tmux server died under the live harness) | `lost` | when the sweep can vouch for the loss |

In text, `oats status`, `oats status --server <id>` and `oats server roster`
print a `lost` row as `LOST`, where a `stopped` or `exited` row, or one
without `sessionEnd`, prints `idle`, with one line under it naming the way
back: `oats session start --resume --home <home>`, or the next sweep (`oats
session resume`, which OATS Desktop and `oats tui` run when they open) when
it can vouch for the loss. Both act on this machine's homes only, so a row
of another host names the host to run them on.

The window a spawn or a start makes writes the exit marker,
`.oats-start-exited`, when the harness exits; `oats instance stop` writes its
record, `.oats-stop.json`, and so do a retire, before it ends the window
(0.69.2), and `oats session restart`, before it stops the harness (#1601). Both are kernel-private files of the home, not a
contract: read `sessionEnd`. A shutdown kills the window's shell with the
harness, so a lost session leaves no marker. A home spawned before 0.69 and
never restarted since names no start: it reads `stopped` only after a stop,
and otherwise `lost`, also when its harness ended by itself. It comes back only
when OATS saw it running since the upgrade, so one that ended before the
upgrade stays down, and one that ends by itself after it comes back once
(stop it with OATS to keep it down). Its next start records the markers.

#### What a resume runs

`oats session start --resume --home <abs>` runs the recorded recipe as an
ordinary start does: the same locks and checks, the same harness, model,
launch configuration, environment and yolo, and the launch hooks again under
the settings captured at spawn (which is how a messaging capability's
delivery comes back). It refuses a home that did not lose its session
(`E_RESUME_NOT_LOST`) and a launch choice (`E_BAD_ARGS`). Two things differ:

- **The conversation.** The newest transcript whose recorded cwd is the home
  itself, written since the home was created, in the locations its
  native-record receipts name: Claude gets `--resume <id>`, pi `--session
  <id>`. "Since the home was created" keeps an earlier instance of the same
  name, at the same path, out. Only the window runs the selector:
  `instance.json`, the pending receipt and the recipe keep the ordinary
  launch, so a later Start opens a fresh conversation.
- **The prompt.** In place of the task prompt the harness gets one line:
  "OATS resumed this session after it was lost (the host restarted or its
  terminal server ended). Continue from where you were." A harness cut off
  mid-turn would otherwise wait for someone to type.

No conversation found (never filed, deleted, or no receipt names where it
went): the ordinary fresh start on `TASK.md`, answered `resumed: false` with
the reason. **Codex is never resumed yet:** a Codex home takes that fresh
start, reason `resume-unproven`, until a Codex resume is proven end to end on
a signed-in host.

#### The launch environment a resume runs under

A resume starts only under the `{fromEnv: SRC}` values the start it brings
back ran with. Every start that renders a recipe, the spawn's own launch
included, records them. A resume compares them, after the check that every
reference is set (`E_LAUNCH_ENV_MISSING`, which comes first):

- **A changed value** refuses the resume before anything is launched:
  `E_LAUNCH_ENV_CHANGED`, "this home's launch environment changed since its
  last start (`<NAMES>`); nothing was started: start it yourself to use the
  new values". Only the names are given, sorted, never a value. The sweep
  reports it like any refused start (`refused`, `start-refused`, the code).
  An ordinary Start or Restart never compares: it starts under the values it
  finds and records them.
- **No record to compare with.** A home last started by an earlier kernel,
  or one whose record does not read, is resumed with one warning: "`<instance>`'s
  launch environment could not be verified this once (it was last started
  before OATS recorded it); its next start records it". That start records
  it, so the warning is given once.
- **The environment is the one the resume runs in.** OATS Desktop runs with
  the desktop session's environment, not your shell's: a `fromEnv` variable
  exported only in a shell profile is not set there, so the Desktop's sweep
  refuses that home (`E_LAUNCH_ENV_MISSING`) while `oats tui` run from that
  shell resumes it. Put the variable in the session's environment, or use a
  literal in the launch configuration.
- **A command you typed into the window is not resumed.** A resume runs the
  instance's OATS launch, with the launch configuration, model and yolo its
  last start chose. Put a custom command in a launch configuration.

The record is two kernel-private files in the home, not a contract:
`.oats-start-env.json` holds, for one start, a keyed one-way digest
(HMAC-SHA256) of each referenced value, and `.oats-start-env.key` (mode 0600)
holds the key. A value, which may be a credential, is never written, and the
key never leaves the home: a retire's recovery copy of the home leaves both
files out. Writing the record never fails a start. A start
that could not write it leaves its resume to the warning above.

#### Prompts a resume meets

A resume answers no prompt that an ordinary start does not:

- A development-channel confirmation stops a resume as it stops a start
  ([Launch prompt outcomes](#launch-prompt-outcomes)): the session is kept and
  the sweep reports it `blocked`. The approved channel route shows no prompt.
- **Claude's resume-cost dialog.** On some plans Claude can ask, on the first
  message after resuming a long, inactive conversation, whether to resume it
  from a summary or in full. Nothing documented turns it off or answers it,
  and the choice is the person's: **OATS sends no key.** After a resumed
  Claude launch the kernel watches the pane for at most 20 seconds, and stops
  earlier once the session shows itself working. When it recognises the dialog
  the start still succeeds, answers `waiting: "resume-confirmation"`, and the
  client says the instance is waiting for its person to choose: open its
  terminal. The dialog is recognised by its option labels, taken from Claude
  Code's strings and documentation (`lib/launch-prompt-fixtures/README.md`);
  a screen it does not recognise is not a block.

#### Which losses come back

The sweep resumes a lost home only when OATS can vouch for the loss, from
what its own reads of that home saw (`oats status`, OATS Desktop and `oats
tui` reading it, and the sweep's own read). All four must hold:

1. OATS saw the home running for its current start.
2. No earlier sweep answered this loss. A sweep answers each lost home once,
   whatever it did with it (resumed, started fresh, blocked, refused or
   skipped), except a home it skipped because OATS was stopping, upgrading
   or retiring it. A status read never uses a loss up, and `--plan` answers
   none.
3. OATS first saw it not running less than 24 hours ago.
4. Within one boot, OATS first saw it not running less than 24 hours after it
   last saw it running. Across a reboot this one does not apply.

Any other lost home is reported `skipped`, `not-seen-recently`, with the
reason, and nothing is started; its status row still reads `sessionEnd:
lost`, and `oats session start --resume --home <abs>` run by hand still
resumes it. So:

- a harness killed by an out-of-memory kill at 02:00 and seen by a status at
  02:01 comes back at a 09:00 sweep;
- a computer off for two weeks brings back what ran when it went down, at the
  first client that opens;
- a tmux server that crashed overnight brings its instances back at the
  morning's first client;
- **an agent killed outside OATS (closed from tmux, or killed by a signal)
  comes back within 24 hours: only `oats instance stop` keeps it down;**
- a loss first seen a day ago or more, or a session that died before any read
  of OATS saw it run, stays down.

Three limits follow from reading only what OATS saw:

- **After upgrading to 0.69**, open OATS Desktop or `oats tui`, or run `oats
  status`, once before you restart the computer, or nothing from before the
  upgrade comes back.
- A whole boot with no OATS read leaves that boot unknown: what ran in it and
  was lost there is not resumed.
- Clause 4 does not reach across a reboot. On a computer where nothing read
  OATS for more than a day before a restart (every agent already down, no
  client open), the first sweep after the restart can bring back a session
  that was lost during that quiet spell.

Without a boot id (neither Linux nor macOS: both have one), clause 4 applies
to every loss and the 3-resumes-per-boot guard (below) is off.

**Status records what it sees.** Every local listing of a deployment's
instances (`oats status`, and every command that lists them) records, per
home, its current start, when it was last seen running, when it was first
seen not running, the boot of each, and whether a sweep answered the loss. It
goes in a kernel-private file, one per deployment,
`session-resume/seen/<16 hex>.json` under `~/.oats` (`$OATS_HOME_DIR` when
set), beside the sweep's per-boot note; it is not a contract. Writing it never
changes what status answers, prints nothing, and is skipped when nothing
changed: a running home's last look is rewritten at most every 10 minutes in
a boot. A record that cannot be read counts as empty, which resumes nothing,
and is rewritten whole; one that cannot be written is left as it is. A status
routed to another machine with `--server` records nothing on this one.
`oats session resume --plan` records what its own read sees, as any status
read does, and answers no loss. The three figures are constants of the
kernel (`lib/session-seen.mjs`).

#### The sweep

`oats session resume` reads this computer's list of deployments and never
writes it, and skips a deployment `oats deployments remove` took out of it;
`--deployment <dir>` sweeps one directory, listed or not. It starts each lost
home it can vouch for with `--resume` in that home's own deployment scope, at
most 4 at once. What it answers a lost home, the first that applies: OATS
is stopping, upgrading or retiring it, or its retire is owed
(`lifecycle-busy`); not seen recently; refused this boot; keeps getting lost;
started. The first is read from the home's status row, and the start's own
claim decides when the row read missed it: a start that meets a retire, a
stop, an upgrade or another resume is reported `lifecycle-busy` too, never
refused. A home removed between the read and its start is reported
`not-lost`.
`--plan` says what it would do and starts nothing. Its answer is in
[desktop-cli-api.md](desktop-cli-api.md#the-machine-sweep-oats-session-resume).

- One sweep runs per machine: a second one answers `E_RESUME_BUSY`. A lock
  left by a process that is gone, or by another boot, is taken over.
- A loss is answered once: whatever a sweep did with it (resumed, refused,
  skipped or blocked), no later sweep starts it again, in this boot or after
  a reboot; a later sweep reports it `not-seen-recently`. A `lifecycle-busy`
  skip is the one that answers nothing: the next sweep reads the home again. A refused resume is
  never retried automatically: it is also noted for the boot, and reported
  `refused-this-boot` should that answer be lost.
- A home is started by sweeps at most 3 times in a boot. A home lost again
  after each resume (a harness that crashes the host or its terminal server,
  say) is then reported `keeps-getting-lost`, and that loss is answered: no
  sweep starts it again, after a reboot either. Start it by hand: its next
  loss is a new one, with a new count in each boot. Every sweep start that launched
  something counts (resumed, fresh or blocked), by home, as soon as that start
  has answered, so a sweep killed while other starts run has counted it; a
  refused, skipped or busy one does not. `oats session start --resume` run by hand is neither
  bounded nor counted.
- The boot is the boot time on macOS and the kernel's boot id
  (`/proc/sys/kernel/random/boot_id`) on a Linux host. Elsewhere there
  is no boot: nothing is noted or counted, and every sweep tries again.
- **Inside a container a boot is one run of the container.** A container
  shares its host's kernel, so the kernel's boot id stays the same when the
  container is stopped and started, restarted or made again, while every
  process in it, its terminal server and its sessions included, is gone. The
  boot there is the kernel's boot id together with the start time of the
  container's PID 1 (field 22 of `/proc/1/stat`, clock ticks after the
  kernel's boot): PID 1 starts once per run and its end ends the run, so the
  identity is the same for every `oats` process of one run and another one
  in the next, and the boot id keeps it apart from a run after the host's
  restart. Each run has its own count of 3 starts per home, takes over a lock
  the run before left, and clause 4 does not reach from one run into the
  next. Both values are read without privileges and nothing is written for
  them.
  - OATS does not ask whether it is in a container: it reads when PID 1
    started. On a host PID 1 is the machine's init, which the kernel starts
    with itself (in its first 10 seconds, 1000 clock ticks), and the boot is
    the boot id alone. A PID 1 that started later is a container's.
  - When PID 1's start cannot be read (a `/proc` mounted with `hidepid`, say)
    the boot is the boot id alone, as on a host. In a container that makes
    every run on one host boot the same boot: the count runs across them and
    clause 4 applies across them, so a sweep starts fewer homes, never more.
  - A container that shares its host's PID namespace (`--pid=host`) reads the
    host's PID 1, so its boot is the host's.
  - Any process in a PID namespace of its own reads that namespace's PID 1: an
    `oats status` or a sweep run inside a sandbox that makes one (bubblewrap's
    `--unshare-pid`, `unshare --pid`) records a boot of its own, on a host
    too. Run the sweep outside such a sandbox.
- The lock, the per-boot note and the record of what status saw live in
  `session-resume/` under `~/.oats` (`$OATS_HOME_DIR` when set). All three
  are kernel-private, not a contract.
- Local only: a client does not resume a server's instances. A server runs
  `oats session resume` itself.

### Inspect, input and attach

```sh
oats session inspect --home /abs/home --json
oats session input --home /abs/home --text-file message.txt --json
oats session attach --home /abs/home
oats session attach --home /abs/home --detach-key 'C-\'
```

- **inspect** reports `backend`, `present` and `state`: `unknown` for a live
  harness, `shell` for a fallback shell,
  `stopped` for an absent or dead terminal, or `not-launched`. An unavailable
  backend is an error (`E_SESSION_UNAVAILABLE`), never a stopped result.
  When the window is there, it also reports `paneId`, the tmux id (`%N`) of
  the agent's pane ([which pane is the agent's](#which-pane-is-the-agents)),
  a retained dead pane included.
  With feature `session-inspect-size` in `oats version --json`, a present
  terminal also reports `size: { cols, rows }`: positive integer window width
  and height in cells. The kernel reads tmux's `window_width` and
  `window_height` in the same call as the pane identity, so a viewer can open
  its PTY at the window's current size without constructing a tmux target.
  A window with several panes still reports the window's size; one where
  OATS cannot tell which pane is the agent's is refused
  ([which pane is the agent's](#which-pane-is-the-agents)). `size` is absent when `present` is false,
  including a retained dead pane. Malformed dimensions are an
  `E_SESSION_UNAVAILABLE` error containing `invalid tmux pane response`.
  `session inspect --server <id> --home <home> --json` relays the execution
  host's size; check that host's feature list before relying on it. This is a
  snapshot: inspect again to observe a resize.
  A home without its session receipt is refused with
  `E_RUNTIME_ENDPOINT_UNKNOWN`, naming the receipt path it looked for (and, for a
  spelling that differs from the on-disk one, the path a kernel before 0.49.0
  used for that spelling); what
  to do is in [souls and instances](souls-and-instances.md#retire).
  Beside `state`, `waitingOnYou` (feature `waiting-on-you`) is a producer's
  live claim that the instance needs input from a human, `{since, producer,
  reason, message}`, or `null`; it is non-null only for a running harness
  (docs/desktop-cli-api.md, "Waiting on you").
  With feature `session-inspect-running`, every successful result also
  carries `running`, a boolean read from the same pane observation by the
  same rule `oats status --json` uses for a row's `running`: `true` for a live
  non-shell process in the agent pane (`state: unknown`), a harness behind a
  wrapper shell included; `false` for a fallback shell (`state: shell`, where
  `present` stays `true`), an absent or dead pane or a missing home
  (`stopped`) and a home that never launched (`not-launched`). It costs no
  second observation: at most one process-table read, only for a pane whose
  command is a shell, empty or the literal `unset`. An empty or `unset` label
  uses the pane PID's own process name from that same scan to establish a shell
  before checking descendants; an unreadable or non-shell own process stays
  `unknown` (`running: true`). `running` is activity at the authorized
  endpoint. It does not say the agent is generating, idle, healthy or ready
  for input, nor that it consumed a wake, and it does not prove which
  executable runs if a process inside the pane was replaced. When the backend
  cannot be read, a required process-table read for an explicitly labelled
  shell fails or cannot establish a fallback shell (above), the pane answer is
  malformed, or OATS cannot tell which of the window's panes is the agent's,
  inspect is an error as before, never `running: false`.
  That includes a tmux server that is gone (`no server running on` its
  socket, as after a reboot): status reads that row as `running: false`, and
  inspect answers `E_SESSION_UNAVAILABLE`. Wherever inspect answers, its
  `running` is the one status reports.
  A consumer that sees no `running` (an older kernel or an older remote host)
  may read `state: unknown` on a successful result as running; a failed
  inspect is unknown, never stopped.
  `session inspect --server <id> --home <home> --json` relays the execution
  host's `running`, or its absence, as the host answered.
  With feature `wake-hold`, every successful result also carries `wakeHold`, a
  stopped, never-launched or missing home included. It reads the home's record
  ([`dialogClaims`](capabilities.md#commands-and-hooks)): `on-claims` when any
  capability answered `reported` (this home's dialogs become the claims a wake
  holds on); otherwise `not-exposed` when any answered `none` (a capability
  vouches that this harness has no dialog an Enter can answer); otherwise
  `unknown`, which covers no record and an unreadable one, and which a waiter
  treats as not covered. Its scope is the kernel's wake delivery only: the aweb
  host wake broker types on its own path, joined teams included, so `on-claims`
  doesn't cover mail. The value is `on-claims`, not "protected", because a
  dialog can still take the Enter ([What a hold leaves
  open](schedules.md#what-a-hold-leaves-open)). The hold itself never reads this
  field: it reads claims, always. Remote inspect relays the host's field, or its
  absence, as the host answered.
  A home whose `instance.json` disagrees with its session receipt is refused
  with `E_RUNTIME_AUTHORITY_MISMATCH` before any pane or process is read; the
  same refusal from any other session command, or in the answer of
  `oats retire`, carries the same details (the record a deferred
  `retire --self` leaves keeps only the code and message). Its `details.fields` names the differing fields, in this order, from this
  vocabulary only: `launched`, `tmux.session`, `tmux.window`, `tmux.socket`
  (the socket compared resolved, so a relative spelling of the same socket
  agrees). It carries no paths, values or receipt content. `launched` is
  listed unless a blocked or incomplete launch prompt explains
  `launched: false`; such a retained prompt is still allowed while its
  endpoint agrees, and only the endpoint fields that differ are named
  otherwise. A missing or invalid receipt stays `E_RUNTIME_ENDPOINT_UNKNOWN`
  and malformed metadata keeps its own refusal; neither carries
  `details.fields`.
- **input** sends UTF-8 text (stdin or `--text-file`, at most 256 KiB, no
  NUL) as exactly one bracketed paste followed by exactly one Enter. The text
  is never run by a shell. Existing endpoint authority, fallback-shell and
  stopped-session checks, and a window where OATS cannot tell which pane is
  the agent's, still refuse before input. The text goes to the agent's pane
  (`paneId`), even when the person's focus is in another pane of the window.

  Input takes no hold: it types whether or not a claim is set, and its Enter
  can answer an open dialog, so don't run it from a script or an agent at a
  session that may show one ([A held wake](schedules.md#a-held-wake) is the
  scheduled path's).

  Before Enter, a size-based floor (200 ms plus 3 ms per KiB) and read-only
  settling polls share one **monotonic 2-second observation budget**, starting
  immediately after the paste command returns, before buffer cleanup. Sleeps
  and capture timeouts are clipped to the remaining budget; a failed capture
  or exhausted budget ends settling and proceeds to the single Enter. After
  Enter, at most two read-only looks share a separate 1-second observation
  budget. These deadlines do not bound the original paste/key commands, buffer
  cleanup or OS scheduling. They authorize no further keys.

  Successful terminal commands return `submitted: true` and `verified`, with
  no `reason`. `verified: true` means only that the bounded display comparison
  saw a changed look; `false` means unchanged, unreadable or exhausted
  observation. The comparison retains its whitespace and resize/reflow
  handling. Display movement can be unrelated output, a spinner or a dialog;
  an unchanged display is not proof that no effects occurred or that a draft
  is pending. **Neither value authorizes retry or proves model acceptance.**

  A failed paste or key command remains `E_SESSION_INPUT_FAILED`; an
  observational failure does not turn successful terminal operations into a
  refusal. Command errors may themselves be uncertain after partial effects.
  This transport offers no exactly-once guarantee and does not guarantee that
  a busy pane accepts the input. Wake schedules retain their existing rule:
  any nonthrowing input answer is recorded as delivered, meaning terminal
  operations, not model processing. Broker delivery/ack policy and harness
  acceptance evidence remain separate contracts.
- **attach** is interactive and takes no `--json`. It opens a temporary tmux
  session linked to the agent's window alone. The viewer shows the whole
  window, every pane. When the window has more than one pane, the viewer
  selects the agent's pane before its client attaches, so typing goes to the
  agent. The viewer has no key or click that moves to another pane: a pane
  split off while a viewer is open is the active one, and takes its keys,
  until it closes. A window where OATS cannot tell
  which pane is the agent's is refused
  ([which pane is the agent's](#which-pane-is-the-agents)).
  Closing the viewer leaves the agent running. When the agent's window ends
  (for example, the instance is stopped or retired), the viewer ends too: it
  sets tmux's `detach-on-destroy on` for its own session, so a server
  configured with `detach-on-destroy off` never moves the viewer's client to
  another session, another agent's terminal. Your own sessions keep your
  setting.

  **An attach that dies without detaching leaves nothing behind.** A
  cgroup-wide `systemctl kill`, a stop timeout, oomd or a killed ssh can end
  `oats` and its tmux client together. `oats` itself then removes nothing, so
  the tmux server does. Once its client has attached, the viewer's client
  sets a `client-detached` hook on the viewer session alone: when a client
  leaves and none is left, the hook kills the viewer session. It is set after
  the attach, so a viewer whose client never attached is removed by `oats`
  or by the next attach's sweep. From then on, the server removes the viewer
  when its last client's connection drops without a word from the client:
  `oats` and its client SIGKILLed together (oomd, a stop timeout). A client
  that ends any other way (a hang-up, a termination, a `detach-client` from
  another client) is not seen by that hook: `oats` removes the viewer as it
  ends, or, if `oats` has died, the next attach's sweep does. The viewer never uses
  `destroy-unattached`: on tmux 3.4 it crashes the agents' server when another
  client detaches the viewer. A viewer's key tables (below) belong to the
  server, not to the session, and its `client-detached` hook unbinds them as
  it kills the session. For a viewer session that ends another way (its
  agent's window ends, a `kill-session`), every viewer sets one global hook
  entry on the agents' server, `session-closed[900]`: when a session whose
  name is a viewer's closes, the entry unbinds the key table of that name
  and its `C-b` table, `<name>-prefix`. It is the only global hook entry
  OATS owns there.
  Every viewer sets the same entry again, which leaves it unchanged,
  and no other index is touched. Keep your own `session-closed` hooks
  (`set-hook -g` in `~/.tmux.conf`) at other indexes: an entry of yours at
  900 is replaced. A global `client-detached` hook of yours does not run
  for a viewer's client whose connection dropped: the viewer session's own
  hook takes its place there. The entry needs `run-shell -C`, which tmux has from 3.2.
  Before 3.2 it does nothing, and the next attach's sweep removes the table.

  Every attach also sweeps the server before it opens its viewer. It removes:

  - a viewer session (`oatsview-<pid>-<8 hex>`) with no client attached,
    whose attaching process, the pid in its name, no longer exists;
  - a viewer key table whose session no longer exists, a viewer's `C-b`
    table (`<name>-prefix`) included.

  The sweep keeps a viewer whose attach is alive, even with no client: its
  client may not have attached yet. It also never removes an attached
  viewer, or anything not named as a viewer, such as the server-wide
  `oatsview-locked` and `oatsview-locked-prefix` tables of an earlier
  kernel. When it removed something, the
  attach prints one line on stderr before the viewer opens:
  `oats: removed <n> leftover viewer session(s) and <m> key table(s) of
  earlier attaches`. A failed sweep is not the attach's failure; the next
  attach sweeps again.

  On tmux 3.2 and later the viewer's tmux client asks for synchronized
  output (`tmux -T sync`, for that client alone): tmux wraps each redraw in
  DEC mode 2026, so a terminal that receives a redraw in two pieces does not
  paint the half-drawn state, such as a cursor flickering while you type. A
  terminal without the mode ignores it. Before 3.2, or when `tmux -V` gives
  no version it can read, the client starts as before. A routed attach
  (`--server`) runs the same viewer on the host, so the host's tmux decides.

  **Scrolling back.** Every viewer, with or without a detach key, has the
  mouse on in its own session (the agents' session and the operator's tmux
  settings are untouched). The wheel then puts the agent's pane in tmux's
  copy mode and scrolls it. An agent that has asked for mouse reports, as
  Claude Code's fullscreen mode does, gets the wheel instead, and scrolls
  its own screen. `Shift+PageUp` (tmux's `S-PageUp`) puts the agent's
  pane in tmux's copy mode, a page up, in every viewer, with or without a
  detach key, even when the agent has taken the mouse (Claude Code does, and
  then the wheel goes to it). In copy mode tmux's own copy-mode keys apply:
  `PageUp` and `PageDown` move a page, and `q` leaves it. The agent never
  receives `Shift+PageUp` while a viewer is attached.

  **`C-b [` in a viewer without a detach key**
  ([#1502](https://github.com/awebai/oats/issues/1502)) also enters copy mode, as a tmux prefix does, for a keyboard that has no
  PageUp. It is the viewer's only `C-b` key:
  - every other key after `C-b` reaches the agent as both keys, in order:
    `C-b n`, `C-b c` and `C-b C-b` arrive as typed;
  - the wheel, a drag and `Shift+PageUp` after `C-b` send the `C-b`, then do
    what they do alone;
  - a mouse report after `C-b` reaches an agent that asked for one.
  `C-b` waits for the next key with no timeout: tmux holds the client in the
  viewer's `C-b` table for that one key.

  **Every viewer's tables are its own.** A viewer reads a key table named
  as its session (`oatsview-<pid>-<8 hex>`), and a viewer without a detach
  key has its `C-b` table beside it, `<session>-prefix`. Both are bound
  once, when the viewer is made and before a client reads them, and are
  removed with the session: by the viewer's cleanup, its `client-detached`
  hook, the `session-closed[900]` entry and the next attach's sweep. No
  other viewer's opening touches them, and a key a `tmux.conf` or another
  program binds in some other table is never run. A server-wide
  `oatsview-locked` or `oatsview-locked-prefix` that an earlier kernel left
  is not a viewer's: it is left as it is, and no viewer reads it. A keyed
  viewer has no `C-b` key; its caller chooses its keys.

  **A tmux limitation: a `C-b` pressed as another viewer opens is lost.**
  Setting any session's `key-table` option returns every client of the
  server to its default table. tmux does this in `options.c` (the
  `key-table` case runs `server_client_set_key_table(loop, NULL)` for every
  client: tmux 3.3, 3.4 and 3.8 alike), and every new viewer sets its own.
  So a `C-b` pressed in the instant another viewer of the same server opens
  is dropped, and the key after it reaches the agent alone. A test pins
  this as known behaviour (`test/session-attach-detach-key.test.mjs`,
  "KNOWN tmux LIMITATION").

  **Only on tmux 3.3 and later** (`VIEWER_PREFIX_MIN_TMUX`). The forwarding
  below needs a `send-keys` that names no key to send the key it is bound
  to, which tmux has from 3.3 (its CHANGES, "3.2a to 3.3": "Make send-keys
  without arguments send the key it is bound to (if bound to a key)"). On
  tmux 3.0 to 3.2a such a `send-keys` sends nothing, and the key after `C-b`
  would be lost. There the viewer has no `C-b` key: `C-b` reaches the agent
  as any key does, and the wheel and `Shift+PageUp` scroll back. The viewer
  asks `tmux -V` once, before it binds anything. A release `tmux X.Y` is
  read as X.Y, and a development build `tmux next-X.Y` as X.Y too. Anything
  else (`tmux master`, no answer) means no `C-b` key. Checked on tmux 3.8.

  How a key after `C-b` is forwarded, exactly (for a client that builds its
  own viewer, as the Desktop's local one does: `lib/session-viewer.mjs`
  exports the tables as data, `VIEWER_BINDINGS`, `PREFIX_KEY`,
  `PREFIX_TABLE_SUFFIX` and `LOCKED_PREFIX_BINDINGS`):
  - The viewer's table binds `C-b` to `switch-client -T <session>-prefix`.
  - That table binds `[` to `copy-mode`. It binds `WheelUpPane`,
    `MouseDrag1Pane` and `S-PageUp` to `send-keys C-b ;` followed by the
    viewer table's own command for that key.
  - It binds `Any`, which tmux runs for every key with no binding of its
    own, to
    `send-keys C-b ; if-shell -F '#{!=:#{mouse_x},}' 'send-keys -M' 'send-keys'`.
    The `C-b` goes to the agent first. A mouse event, the only key that sets
    `mouse_x`, then goes as one with `-M`. Any other key goes through a
    `send-keys` that names no key, which sends the key the command is bound
    to. tmux(1) (3.8), `send-keys`: "If no keys are given and the command is
    bound to a key, then that key is used."

  **The status line.** A viewer without a detach key shows one line under
  the agent, `Shift+PgUp or C-b [ to scroll back` (`Shift+PgUp to scroll
  back` where it has no `C-b` key), so the person reading the agent can see
  how to scroll back: nobody guesses a key. It takes the
  client's last row. `--no-status-line` (feature
  `session-attach-no-status-line`) drops it, for a caller that shows
  the keys itself (`oats tui`); the keys stay. A routed attach sends
  `--no-status-line` as it is: a host without
  `session-attach-no-status-line` ignores it and shows the line. A keyed
  viewer has no status line.

  **Copy mode is the pane's, not the viewer's.** It is a mode of the agent's
  pane on the agents' tmux server. While one viewer is scrolled back, every
  other viewer of that agent (the Desktop, a second `oats tui`, another
  `oats session attach`) shows the same frozen screen, and keys typed in any
  of them go to copy mode until it is left (`q`, or scrolling back to the
  bottom).

  **Leaving the viewer.** Without `--detach-key` there is no keyboard exit:
  every other key goes to the agent, the tmux prefix included (after `C-b`,
  as both keys). Close the terminal.
  With `--detach-key <key>` (`--detach-key=<key>` is the same; feature
  `session-attach-detach-key`, OATS 0.51.0), pressing `<key>` detaches that
  viewer's client. The agent's window and every other viewer are untouched.
  The key is taken from the agent's input: the agent never receives it while
  this viewer is attached. A keyed viewer reads a tmux key table of its own,
  named as its temporary session and removed with it, so the key is bound
  for that viewer alone. The key's binding also removes the viewer session's
  `client-detached` hook before it detaches: the session outlives its client
  until `oats` has read that the key was used, and `oats` then removes it.
  Check the feature in `oats version --json` before passing the flag: a
  kernel without it ignores the flag and opens a viewer with no exit.

  The key is one of these, spelled exactly (case-sensitive):

  ```
  key      = control / meta / function
  control  = "C-" ( "a"-"g" / "j"-"l" / "n"-"z" / "\" / "]" / "^" / "_" )
  meta     = "M-" ( "a"-"z" / "0"-"9" )
  function = [ "C-" / "M-" / "S-" ] "F" ( "1" … "12" )
  ```

  Anything else is `E_BAD_ARGS`, before any tmux or ssh call: a missing
  value, a plain character, `C-i` and `C-m` (Tab and Enter on tmux before
  3.5), `C-h` (the byte, 0x08, that many terminals send for Ctrl+Backspace
  and some for Backspace, so the name is not one key everywhere), `C-[`
  (Escape), `M-[`, `M-]`, `M-\`, `M-O` and the other ESC + C1 introducers (a
  terminal reply can arrive as that key), `Any`, mouse key names, two keys,
  upper case, and anything with a space, `;` or a control character. The
  kernel does not judge whether a harness reads the key: that is the
  caller's choice.

  **While the pane is scrolled back.** The viewer's wheel, drag and
  `Shift+PageUp` bindings put the pane in tmux's copy mode, and there copy mode's key table is read
  before the viewer's. A detach key that copy mode binds acts in copy mode
  and does not detach; it detaches once the mode is left (`q`, or scrolling
  back to the bottom). The grammar does not exclude those keys. The
  copy-mode tables are the tmux server's, shared by every session and
  changed by the operator's `~/.tmux.conf`, so no grammar can promise a key
  is free there, and the kernel never binds a detach key in a table other
  sessions read. With tmux's default tables (3.7c), 35 of the 111 keys are
  taken in emacs or vi copy mode (for example `C-e`, `C-c`, `M-w`, `C-u`);
  `C-\` and `F12` are bound in neither and detach from copy mode. Detaching
  while scrolled back leaves the agent's pane in copy mode for the next
  viewer, as closing a viewer mid-scroll does.

  **The suggested key is `C-\`**, written `--detach-key 'C-\'` (quoted: an
  unquoted trailing backslash continues the line). The kernel fixes no key.
  What was checked:

  - It has no default binding in Claude Code 2.1.288 (which refuses to let
    a user bind it: "terminal quit signal"), Codex CLI 0.160.0 or pi 1.0.2.
    It is unbound in bash 5.3 (`bind -p`) and in zsh's and fish's documented
    defaults. It is the default detach key of dtach and abduco.
  - A viewer with this key gives up: in a fallback shell, the tty's QUIT (no
    SIGQUIT from the keyboard); in vim and nvim, the `C-\ C-n` prefix; in
    nano, Replace (also on `M-r`).
  - On a layout where `\` needs AltGr, use `F12`: it has no default binding
    in the same three harnesses, bash, nvim or less. Some terminals and
    laptops keep F12 for themselves.
  - `C-]`, `C-_`, `C-g`, `C-t` and `C-b` are each bound by all three
    harnesses.

  **Exit status.**

  | How the command ended | Status |
  |---|---|
  | Left by the detach key (the agent keeps running) | 20 |
  | The viewer ended without the key: the agent's window ended, or `oats` itself was stopped by SIGHUP, SIGTERM or SIGINT and closed the viewer | 0 |
  | A refusal (bad arguments, not launched, session gone), or tmux failing under the viewer (its server exited) | 1 |

  20 is answered only when the key's own binding ran, and only by a kernel
  with the feature. No status an existing caller sees changes meaning. 20 is
  nonzero, so `set -e`, an `&&` chain and tmux's `remain-on-exit failed`
  treat a leave by the key as a failure. The routed form (`--server`) relays
  these statuses and adds ssh's own 255 ([servers.md](servers.md#run-there)).

  With `--detach-key`, `oats` handles SIGQUIT. `C-\` is also the terminal's
  QUIT character: pressed before the viewer has the terminal, or again once
  the viewer has given it back, it would otherwise end `oats` with status 131
  and leave the viewer's session and key table on the tmux server. A QUIT
  that arrives before the key was used stops the attach, with status 1;
  after a leave by the key it changes nothing, and the status is 20.

### Attachments

`oats session upload --file <local> --home <abs>` copies a file into
`<home>/.oats-attachments/` (directory mode 0700, file mode 0600, `name-2` on
collision, at most 64 MiB) and answers `{path, bytes, sha256}`. The caller
gives `path` to the agent; nothing is typed into the session. Attachments are
removed with the home.

## The task prompt

Spawn writes `TASK.md` in the home: the instance's name, soul, home and work
tree, followed by the `--task` or `--task-file` text, or a note to await
instructions when no task is given. Every launch, `session start` and
`restart` included, opens a fresh harness conversation on `TASK.md`, **except a
resume** ([Resume after a shutdown](#resume-after-a-shutdown)), which continues
the instance's own last conversation with a one-line resume notice. This
replaces the earlier rule that every start, without exception, opened a new
conversation (OATS 0.69, #1559). In a fresh conversation the instance resumes
its work from its own state files, as its knowledge capability prescribes.

The task's text never travels on a command line, where any local user could
read it in the process list:

- pi and Claude Code get `@TASK.md`, which each harness reads as the file.
  pi sends it as the session's first prompt and refuses it if another
  extension's turn (the @awebai/pi welcome) is running or starts while it is
  being sent. The pi bridge (`@awebai/oats-pi`) holds it on pi's own path
  until no turn is active, so it runs exactly once, unaltered; a pi
  deployment without the bridge can sit idle with no task. The exception is
  in the bridge's [README](../packages/pi/README.md).
- Codex gets a fixed pointer to the file and reads it with a tool.
- A home whose recorded command still hands over `"$(cat TASK.md)"` starts
  with its harness's safe prompt instead, and the command is saved that way.

The home is created `0700` and `TASK.md` `0600`. `oats doctor` reports an
instance home that other users can read (`home-readable`), with the exact
`chmod`; it never changes a home's mode itself.

## Permissions (yolo)

Yolo is chosen per launch: `--yolo` / `--no-yolo` on `oats spawn`,
`oats session start` and `oats session restart`, or the `yolo` field of a
named launch configuration. The flag overrides the configuration. A soul never
carries it. With no choice, a spawn keeps the harness's native policy, and a
start keeps what the home recorded.

When yolo is true, OATS adds `--dangerously-skip-permissions` for Claude Code,
and `--yolo` plus trust for the instance home for Codex. pi takes no flag.
`--no-yolo` removes only those added flags; native settings stay in force.
Unattended execution never implies yolo.

### Explicit deployment trust

Use `oats harness trust --dir <deployment> --harness claude|codex|all --plan`,
then the same command without `--plan`, on the execution host. It covers the ambient
configuration file (the one a launch with no launch configuration reads,
[by the pane's environment](#the-checks-read-the-pane)) and each launch
configuration's `CLAUDE_CONFIG_DIR` / `CODEX_HOME`; launch-time checks read
the file the launch's own environment selects. This is the explicit
operator-only native-config write path; spawn/start/retire remain read-only with
respect to native trust. See [native trust](harness-trust.md) for qualified formats,
Git-boundary limits, audit evidence and partial-failure recovery. Root trust does
not establish channel/account/model readiness or enable launch-prompt consent.
