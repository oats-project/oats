# Servers: running instances on another machine

A **server** is another machine with its own OATS and deployment, reached
over OpenSSH. `--server <id>` runs a command on that machine's OATS with the
same flags and JSON envelope as a local call. The server's kernel does the
work ([execution-targets.md](execution-targets.md)); this machine routes and
keeps a saved route per remote instance.

## Register

```bash
oats server add build --ssh build-host --workspace /srv/team --oats /usr/local/bin/oats
oats server check build      # ssh reachability, remote version, workspace roster and Git readability
oats server list [--workspace-ref <ref>]
oats server remove build
```

To put a workspace on a machine that has no deployment yet, use
[`oats server connect`](#connect-a-machine) instead of `server add`.

`server add` and `server connect` also accept `--operator-ssh <alias>`.
It records the optional operator route separately in
`~/.oats/server-operator-routes.json`:

```json
{ "build": { "operatorSshHost": "build-operator" } }
```

`server list` (text and JSON) and connect's `registration` join that route
with the server registration. The alias follows the same rules as `--ssh`:
letters, digits, dot, underscore and dash, beginning with a letter or digit;
no `user@host`, spaces or SSH options. Put the user and forced-command key in
OpenSSH configuration under that alias. Registrations without it remain valid.
Older kernels never read this separate file; `servers.json` retains the field
set they accept.

The operator alias is reserved for credential provisioning. Registering it
runs no operator command: every existing remote operation continues to use
`sshHost`, and saved instance targets contain no operator route. To change an
existing registration, pass `--replace`; connect keeps an existing value
without it. With `--replace`, the operator route is kept unless you give
`--operator-ssh <alias>` to change it or `--no-operator-ssh` to clear it.
The two flags cannot be combined. `server remove` deletes the operator route
too. Both files are changed under the same `~/.oats/servers.lock`.
A fresh add or connect starts with no operator route unless `--operator-ssh`
is given; a route left behind by an older kernel is discarded for that new
registration.
For example:

```bash
oats server add build --ssh build-host --operator-ssh build-operator --workspace /srv/team
```

- `--ssh` is an OpenSSH host alias or host name, never `user@host` or an
  option. Users, keys and host verification belong in `~/.ssh/config`.
  Connections are non-interactive (`BatchMode=yes`): a prompt fails fast.
- `--workspace` is the absolute path of the deployment directory on the
  server: the directory that holds its `oats-local.yaml`
  ([configuration.md](configuration.md)). Routed commands run there as
  `--dir <workspace>`.
- `--oats` is the remote executable (default: `oats` on the remote PATH).
- `--path` prepends directories to the minimal remote PATH of every routed
  command (`~/.local/bin:/opt/pi/bin`), where the remote spawn looks for the
  harness binary.
- `--herdr` is refused (`E_HERDR_REMOVED`): Herdr was removed in 0.31.0. A
  registration or saved route that still records `herdrPath` loads; the field
  is ignored, never written or printed.
- `--label` sets a display name. `--replace` overwrites an existing id.
- Registrations live in `~/.oats/servers.json` on this machine, never in a
  repository. Every change to the file (add, remove, a learned workspace key,
  connect) is a short read-modify-write of the file as it is then, under the
  lock `~/.oats/servers.lock`, so concurrent commands never lose each
  other's registrations. The lock is a file that names the process holding it.
  One left by a command that was killed is taken over by the next command. One
  whose holder is still running after 5 s is refused with `E_SERVERS_BUSY`. So
  are a lock file whose record is unreadable, a holder that cannot be told to
  be running or gone, and a lock directory written by an earlier kernel: the
  message says which it found and names the path to remove once no oats
  process is changing the registry.

**Which workspace a server serves.** A registration records `workspaceKey`:
the canonical key of the workspace its host deployment realizes, as the
host's own `oats status --json` reports it (`workspace.key`). It is learned,
never typed:

- `server add` asks the host after writing the registration. A host that does
  not answer one (unreachable, no deployment at `--workspace`, a kernel before
  0.38) is registered without it, with a warning.
- `server check` records it when the registration has none, and `server
  connect` writes it.
- A key is recorded only on the registration that was asked: if the
  registration is removed or pointed elsewhere while the host is being asked,
  the answer is dropped (`server add` warns), never written onto the new
  entry or used to bring a removed one back. The add result reports no
  workspace key when the registration changed during the request.
- A host reporting a different key than the recorded one is
  `E_SERVER_WORKSPACE_MISMATCH` (`details: {recorded, reported}`) and the
  registration is not rewritten. If the host now serves another workspace,
  register it again with `server add <id> --replace`.
- `server list --workspace-ref <ref>` lists the servers whose key is the
  canonical key of `<ref>` (any spelling of the same repository matches), and
  `unknownWorkspace` names the ids whose key is not known yet. One host can
  carry several registrations, one per deployment.

`server check` also asks the host whether its Git reads the workspace remote
(`workspaceReadable`; the host's [`onboard --check`](#what-connect-runs-on-the-host)),
which is where a [macOS keychain](#git-on-a-macos-host) problem shows up.

## Harness credentials

Read or remove an installed harness credential through the operator route:

```bash
oats harness token status claude --server build --name team
oats harness token remove claude --server build --name team
```

The harness is `claude`, `codex`, `pi` or `opencode`. `--name` is the
receiver's configured team name: lowercase letters, digits and dashes,
starting with a letter or digit, at most 63 characters. When omitted, the
server label is used only if it already matches that grammar; otherwise
give `--name`. OATS never guesses a slug from a display label.

These commands use the separate operator SSH alias and its forced-command
receiver, with the usual noninteractive SSH options and `ControlPath=none`.
They never reuse the agent connection or fall back to the agent alias.
Without an operator route, OATS refuses with `E_HARNESS_TOKEN_ROUTE` and
names `oats server add <id> --operator-ssh <alias> --replace` as the remedy.
The receiver answers only a fingerprint and replacement time; it never
returns a credential. Removal deletes the delivered credential file; revoke
the original credential with its provider too.

The forced command is Hestia's `oats-login-receive`, installed root-owned
and bound to a dedicated key. It accepts `status|remove <harness> <name>`
through `SSH_ORIGINAL_COMMAND`; the destination is the receiver's root-owned
configuration, never a client-supplied path. See the
[CLI JSON contract](desktop-cli-api.md#harness-token).

## Connect a machine

```bash
oats server connect altair-aweb --ssh altair --dir '~/acme' --install-oats
```

Run from a deployment, `server connect` puts that deployment's workspace on
the machine behind `--ssh` and registers it, from a host with nothing but
ssh access and Node.js. Every run re-checks every step and does only what is
missing, so after a human step you run the same command again.

| Option | Default |
|---|---|
| `--dir <path>` | none, inside a deployment too: the folder on the host for this deployment, absolute or `~/…` (resolved by the host). Without it: `E_BAD_ARGS` "--dir <path on the host> is required: the folder on `<host>` for this deployment (absolute, or ~/… resolved there)". A registration made before it was required is unchanged |
| `--workspace-ref <ref>` | this deployment's `oats-local.yaml` `workspace:` |
| `--oats <path>`, `--path <dirs>`, `--label <text>` | as for `server add`; `--path` is where the host finds `npm`, `oats` and the harnesses. Without it, connect uses the PATH of the host user's [login shell](#the-hosts-login-shell-path) |
| `--operator-ssh <alias>`, `--no-operator-ssh` | set or clear the separate operator route; with `--replace`, omitting both keeps it. Same alias validation as `--ssh` |
| `--install-oats` | off: a missing or older OATS is a human step |
| `--replace` | off: an id registered for another host or directory is refused |

The steps, in order:

| Step | Checks | When something is missing |
|---|---|---|
| `ssh` | the host answers a non-interactive ssh; without `--path`, the PATH of the host user's [login shell](#the-hosts-login-shell-path) is read (its `detail` says whether) | `failed` `E_SSH` |
| `oats` | `oats version --json` there is this kernel's version or newer and advertises `server-connect` (a build of the same version without it is not enough) | with `--install-oats`: runs `npm install -g @awebai/oats@<this version>` there (`done`); without it: `needs-human` with the command to run. With no `npm` on the PATH it searched (named in `detail`): `needs-human` to install Node.js there, with a command that checks the login shell finds `npm`, then check again |
| `git` | the host's Git reads the workspace remote | `needs-human` with the remedy (and the [keychain hint](#git-on-a-macos-host)) |
| `deployment` | `--dir` holds a deployment of this workspace | an absent or empty directory is onboarded there (`done`); a deployment of another workspace is `failed` `E_SERVER_WORKSPACE_MISMATCH`; a non-empty directory without `oats-local.yaml` is `failed` `E_DIR_NOT_EMPTY` and nothing is written into it |
| `register` | the registration exists, with its `workspaceKey` | written (`done`); an id registered for another target is `failed` `E_SERVER_EXISTS` unless `--replace` (checked before anything else, so a requested id never reports ready while it routes elsewhere); a new id whose host and directory are already registered under another id is reported (`ok`, naming that id; the text result then names that id to spawn with) and not registered twice |
| `readiness` | each soul of the host deployment (disabled souls skipped) passes `oats readiness` there | each failing or unknown required item becomes a `needs-human` line, once for all the souls that share it; the listing and the checks share one 60 s budget, and souls it does not reach (a check it cuts off included) become one line naming the command to check them; a broken link still fails the run (`E_SSH`) |

A step is `ok` (already so), `done` (this run did it), `needs-human` (its
`remedy` says what to run where; later steps are `skipped`, waiting for it)
or `failed` (the run ends). The result is `ready` when no step needs a
human. Connect never handles credentials: what Git on the host cannot read
is always a human step there. The `--json` shape is in
[desktop-cli-api.md](desktop-cli-api.md#oats-server-connect).

### The host's login-shell PATH

A non-interactive ssh command does not read the user's login files, so on a
host whose PATH comes from `~/.zprofile`, `~/.bash_profile` or `~/.profile`
(a Homebrew or version-manager directory, say) it finds neither `npm` nor
`oats`. Without `--path`, connect therefore asks the host user's own login
shell for its PATH once, in the `ssh` step, by the rules OATS uses for the
local login environment ([execution-targets.md](execution-targets.md)):

- The shell is the host's `$SHELL`, which sshd sets from the host's password
  database. Only bash, zsh or fish at an absolute path is run; it runs
  `-l -i -c` (login and interactive, so both its profile and its rc files are
  read) and prints its PATH between two delimiters that carry a random nonce,
  within 15 s and 1 MiB.
- The PATH's absolute directories (each once, in order) become the
  registration's `path`, the field `--path` sets, so every later step and
  every later `--server` command runs with them. `oats` found on that PATH is
  recorded as `oatsPath` by its absolute path.
- Another shell, no answer in time, or an answer that is not one PATH: the
  `ssh` step stays `ok`, its `detail` says why the PATH could not be read, and
  connect goes on with ssh's own PATH.
- An explicit `--path` always wins: the login shell is not asked. An explicit
  `--oats` is kept as given.
- A registration of the same host and directory made before keeps the `path`
  and `oatsPath` it has; connect only fills in the ones it lacks (`register`
  `done`, "recorded …"), and `--replace` rewrites them with what it found.
- The recorded `path` and `oatsPath` are a snapshot of the login shell at
  connect time. On a host whose Node comes from a version manager (nvm,
  asdf), a later Node upgrade can leave `oatsPath` pointing at a directory
  that is gone; `oats server connect … --replace` reads them again.

### What connect runs on the host

Besides `version --json`, `status --json`, `souls --json` and `readiness
--json`, connect runs two commands there:

- `oats onboard <dir> --workspace <ref> --check --json`, read-only: where
  `<dir>` is (a leading `~` is the host's home), whether it is absent, empty,
  not empty, not a directory or a deployment, and whether the host's Git
  reads the workspace remote. An unreadable remote is part of the answer
  (`remote.readable: false` with the error), not a failure. Without
  `--workspace`, a deployment's own workspace is read.
- `oats onboard <dir> --workspace <ref> --json`, only when the directory is
  absent or empty. This is the only way connect onboards on a host; `onboard`
  itself is not routed with `--server`.

### Git on a macOS host

Git on macOS usually keeps the forge token in the login keychain, through
its credential helper. A session without a terminal (an ssh command, which is
how every routed command runs, or a background job) cannot open that
keychain, so reading a private remote fails as `auth` even though the same
command works in a terminal on that Mac.

When a remote read fails as `auth` on macOS in a session with no terminal on
stdin or with `SSH_CONNECTION` set, `E_REMOTE_UNREADABLE` carries
`details.hint: "keychain-non-interactive"` and `details.remedy`, and the
message names the two ways out, run once on that Mac:

```bash
gh auth login --insecure-storage   # keep the token in gh's own file, not the keychain
gh auth setup-git                  # let Git use gh's token
```

or read the remote with an SSH key the session can reach. A key with a
passphrase fails in the same sessions for the same reason: an ssh session has
no `SSH_AUTH_SOCK` of its own, so it cannot reach the desktop login's
ssh-agent. Use a key without a passphrase, or point `SSH_AUTH_SOCK` at the
login agent in the shell's startup file (for zsh, `~/.zshenv`, which
non-interactive sessions read). OATS never reads or changes credentials
itself; the hint is about where Git ran, not a probe of the keychain.

- **Which remedy applies depends on the remote.**
  - An `https://` remote is read through the credential helper: gh's token.
  - A `git@github.com:` remote is read through the SSH key. Its
    `UseKeychain yes` works only in the desktop session.
  - SSH commit signing (`gpg.format=ssh`) reaches its key the same way, so it
    has the same requirement.
- **The trade-off.** `--insecure-storage` keeps gh's token in gh's own
  configuration file, protected by file permissions instead of the keychain.
  The machine's operator makes that choice.
- **When to set it up.** At onboarding (`/oats-onboarding` card 4), on a Mac
  that another machine will drive (`oats server add`), or that runs Git from
  background jobs. The person's whole Git and GitHub setup, including the
  system `osxkeychain` helper a Git without `HOME` falls back to, is
  oats.setup's `/oats-git-setup`.
- **Verify** from a session without a terminal: `ssh <host> git ls-remote
  <workspace remote> HEAD`, or `oats server check <id>` from the driving
  machine.

## Connections

Every routed ssh call carries these options, before `--` and the host:

| Option | Why |
|---|---|
| `BatchMode=yes`, `ConnectTimeout=15` | a prompt or an unreachable host fails fast |
| `ServerAliveInterval=15`, `ServerAliveCountMax=3` | a link that died without a reset ends the call, an attached viewer included, within about 60 s |
| `ControlMaster=auto`, `ControlPath=~/.oats/ssh/%C`, `ControlPersist=60` | every call to one host (the probe, the command, a viewer, concurrent Desktop reads) shares one authenticated connection, kept 60 s after its last client |

- Concurrent first calls to a host with no master yet (the roster probes
  every registration at once, so two registrations of one host do) race to
  create it. ssh lets the one that loses run over a connection of its own
  ("ControlSocket … already exists, disabling multiplexing"): the call still
  succeeds, and later calls share the master. A dead host's registrations
  each wait out the connect timeout, side by side.
- Options given with `-o` override `~/.ssh/config`, so these replace any
  `ControlMaster`, `ControlPath` or `ControlPersist` set there for the host.
  Everything else in your ssh config (users, keys, `ProxyJump`, host
  verification) applies as usual; a `ProxyJump` host is reached once per
  master.
- `~/.oats/ssh` (under `OATS_HOME_DIR` when set) is created mode 0700. OATS
  does not use it if it is owned by another user or writable by group or
  others.
- ssh binds the control socket at the path plus 17 bytes, within the 104-byte
  socket path limit of macOS, so the directory path may be at most 45 bytes.
  `/Users/<name>/.oats/ssh` fits for any name up to 23 characters. The path
  must also be one ssh reads literally: letters, digits and `. _ / + , : @ =
  -` only (a space, `%`, `$`, a quote or `#` is ssh syntax).
- When the path does not fit, has other characters, or the directory is not
  private, calls run with `ControlPath=none` instead: no connection sharing,
  including any your ssh config sets up; keepalives still apply. The command
  warns once per server on stderr, naming the path and the fix (an
  `OATS_HOME_DIR` or `HOME` that is shorter or plain).
- A master left stale by a network drop is replaced by ssh on the next call.
- The version probe (`oats version --json`) is asked once per process per
  server and target. `server add --replace` to another target forgets it.
- When ssh fails under an attached viewer (a lost link, or one never made),
  `session attach --server` exits 255 and says that, if the link was lost,
  the instance keeps running on the server, with the command to reattach.
  When `--detach-key` was given, that command carries it (` --detach-key
  <key>`, shell-quoted); without one the line is as before.
  When ssh fails before the viewer opens (the version probe, or a name
  resolved through the host's roster), it also exits 255, with `oats: ssh to
  <host> failed: …` (`--json`: the `E_SSH` envelope). Every other refusal
  (an incompatible host, an unknown or ambiguous name, bad arguments) exits 1,
  and so does an ssh that cannot be run on this machine at all: no link can
  come back. Otherwise the host's own status is relayed through ssh: 20 when
  the viewer was left by its detach key (`--detach-key`, below), 0 when it
  ended without the key, 1 for a refusal or a tmux failure there.
- Every routed command reports ssh's own failure as `E_SSH` (`ssh to <host>
  failed: …`). When ssh never started on this machine, the `--json` envelope
  says so with `error.details: {"sshStarted": false}`; without details, ssh
  ran and the link failed
  ([desktop-cli-api.md](desktop-cli-api.md#ssh-failures-e_ssh)).

## Run there

```bash
oats spawn dev --server build --purpose fix-123 --task-file task.md
oats status --server build
oats session attach --server build --instance dev-fix-123
oats retire dev-fix-123 --server build
```

Arguments are quoted for the remote shell. Local files (`--task-file`,
`--wake-file`, a schedule or launch-configuration `--file`) are read here and
sent as text or on stdin, never as paths.

| Command | Where it runs | The server must advertise |
|---|---|---|
| `spawn` | registered workspace | the requested harness, backend and yolo option; `launch-config` for `--launch-config`; `schedule` for a wake schedule; `spawn-name` for `--name`; `spawn-preview-2` for `--preview`; `spawn-suggest-name` for `--suggest-name` on a preview, `spawn-apply-suggest-name` on an apply; `instance-background` for `--background` or `--no-background`; `instance-same-work` for `--same-work` |
| `status` | registered workspace | |
| `retire` | the instance's home | `retire-home` to retire by exact home |
| `session inspect`, `session attach` | the instance's home | `session`; `session-attach-detach-key` for `attach --detach-key`; `session-attach-no-status-line` for `attach --no-status-line`, which a host without it ignores |
| `session start`, `session restart` | the instance's home | `session-start`; `session-restart`; `launch-config` when `--launch-config`, `--harness` or `--yolo` is given |
| `session upload` | the instance's home | `session-upload` |
| `okf harvest --instance <name>` | the saved home | `harvest` |
| `schedule ...` | registered workspace | `schedule` |
| `launch-config list\|set\|remove\|preview` | `--dir`, the instance's home, or the registered workspace | `launch-config` |
| `inspect`, `operation run` | `--dir`, the instance's home, or the registered workspace | `operations`; `inspect --instructions` also `soul-composed-instructions`, `inspect --skills` also `soul-skills`, `inspect --composed-skills` also `soul-composed-skills` |
| `readiness` | the instance's home, `--dir`, or the registered workspace | `readiness` (`readinessApi: 2`) |
| `instance events` | the instance's home | `instance-events-2` (`eventsApi: 2`) |
| `instance git`, `instance diff` | the instance's home; the Git runs there | `instance-git` (`instanceGitApi: 1`) |
| `instance stop --plan\|--apply`, `retire --plan`, `retire --plan-revision … --idempotency-key …` | the instance's home | `lifecycle-plans` (`lifecycleApi: 1`) |
| `instance color` | the instance's home | `instance-color` |
| `instance background` | the instance's home | `instance-background` |
| `instance same-work` | the instance's home | `instance-same-work` |

`instance suggest-name` and `instance upgrade` are never routed: `--server` is
`E_BAD_ARGS`. `instance suggest-name` names a spawn on the machine that asks,
for a spawn that may land on another; the host it lands on makes the name
unique, or names an unnamed spawn itself with `--suggest-name`.

Before every routed command except `status`, the kernel reads the server's
`oats version --json`. A remote OATS older than 0.22.1 is refused, and so is a
missing feature (`E_REMOTE_INCOMPATIBLE`), before anything is sent. A spawn is
checked against the harness it would use (the flag, or the soul's default as
the remote roster reports it). A host that advertises no harness list is
assumed to run only pi and claude, on tmux, with no launch options.

**A routed preview.** `oats spawn <soul> --server <id> --preview` runs the
spawn's checks here (`E_ROUTE_CHANGED`, `E_ROUTE_EXISTS`, the harness and
options), then asks the server's kernel for its preview. It prints the local
preview's line with the server named (`preview <soul> → <instance> on <id> …;
nothing was created`), and saves no route or other state on this machine. Its
`--json` result is the server's preview plus `server` and `target`. When a
saved route already holds the previewed name for another home, a warning says
a spawn would save no route. A server that does not advertise
`spawn-preview-2` is refused (`E_REMOTE_INCOMPATIBLE`) before the spawn is
sent, since an older kernel might spawn for real.

**Addressing an instance.** Instance commands (`retire`, the `session`
commands, `inspect`, `operation`, `launch-config`) reach any instance on the
server, whoever spawned it, by `--home </remote/home>` or by name
(`--instance <name>`, or the positional name of `retire`):

- A name spawned from this machine resolves through its saved route.
- Any other name resolves through the server's roster (one `status --json`
  in the registered workspace) to its one home. A name that two homes carry
  there is `E_AMBIGUOUS`, listing the homes (`error.details.candidates`);
  pass `--home`. A name the roster does not list is `E_SNAPSHOT_UNKNOWN`.
- A `--home` no saved route owns is sent through the registration's target;
  the server's kernel decides whether it is an instance home and its refusal
  is relayed as is.
- The home is the identity; use it when two souls on the host own
  same-named instances. A name and a home that disagree are refused
  (`E_HOME_MISMATCH`).

**`--dir` with `--server`.** For `inspect`, `operation`, `launch-config`,
`readiness`, `instance`, and a `retire --plan` or guarded retire apply, an
explicit `--dir` names a directory on the server and travels as is. Every
other routed command refuses `--dir`; its scope comes from the
registration.

**Capability commands.** Any capability command routes with `--server`:

```bash
oats aweb setup --join aweb --invite-stdin --soul dev --server altair-aweb < invite.txt
```

The host runs the same argv, minus `--server <id>` (or `--server=<id>`;
after a `--` the argv is the provider's and is never read), as `oats <namespace>
<command> …` from the registered workspace directory: the kernel's
capability dispatch finds the deployment from its working directory, so no
`--dir` is added to the provider's argv. `--soul` and every other flag go
through untouched. Stdin is forwarded as is and never read or logged here;
when stdin is a terminal nothing is forwarded and the host's stdin is
closed. The host's stdout, stderr and exit status are relayed; with
`--json` its envelope is relayed verbatim, and when nothing comes back this
side answers one envelope (`E_SSH`, or `E_REMOTE_ENVELOPE`). Wherever this
side prints the argv, `--invite` values are replaced by `<redacted>`.
Kernel commands keep the table above.

**A detach key on a routed attach.** `session attach --server <id>
--detach-key <key>` names the key that leaves the viewer, as on the host
itself ([execution-targets.md](execution-targets.md#inspect-input-and-attach):
the grammar, the suggested `'C-\'`, exit status 20). The key is checked here
first, before any ssh call (`E_BAD_ARGS`). The flag travels only to a host
that advertises `session-attach-detach-key`: a kernel without the feature
would ignore it and open a viewer with no exit. Such a host is refused on
this machine after the version probe, with nothing else sent, exit 1:
`E_REMOTE_INCOMPATIBLE`, `remote oats <version> at <host> does not advertise
session-attach-detach-key; upgrade it there, or attach without --detach-key;
nothing was sent`. Under `--json` the envelope's `error.details` is
`{"feature":"session-attach-detach-key"}`. With a key the probe also runs
under `--print`, which otherwise skips it: a printed command must not carry
a flag its host would ignore.

`--no-status-line` travels as it is, with no probe of its own: a host that
does not advertise `session-attach-no-status-line` ignores it and shows the
viewer's status line, which loses nothing
([execution-targets.md](execution-targets.md#inspect-input-and-attach)).

**Not routed.** `session input` runs on the execution host, where schedules
and messaging capabilities call it. `session restart --stop-grace` is refused
with `--server`; the remote default applies. `session attach --print` shows
the ssh command without running it. A server without the `session` commands
(before 0.22.2) is refused with the tmux command to attach there directly,
naming the session and window its roster records for the instance (else
`pi-agents`, that kernel's default), and the tmux socket when the roster
records one. The remote command is one quoted word either way: `ssh -t
<host> 'tmux attach -t <target>'`, or `ssh -t <host> 'tmux -S <socket>
attach -t <target>'`.

## The roster and harvest

```bash
oats server roster --json                                # one group per server and target
oats okf harvest --server build --instance dev-fix-123   # the harvest, run in the saved home
```

The **roster** is what the Desktop shows: one group per server id and route
target (host and workspace), with the registration (present or not), the
probe result, the host's workspace identity (`workspace`: its own `status
--json` `workspace` object relayed verbatim, reachability only from a host
before 0.36.0, `null` when it reports none or the probe failed), the remote souls, the instances joined with saved routes
(`savedRoute`, `running` or `null` when unknown, `retirePending`,
`rollbackIncomplete`, `missingRemotely`, `addressable`), and `retireFailures`
(deferred self-retirements that failed there). Each instance row also relays
the host's own facts from its `status --json`: `identity`,
`identityAddress`, `teams`, `startedAt`, `createdAt`, `model`,
`runtimeState`, `parentInstance`, `siblingInstance`, `relation`,
`relativeTo`, `spawnOrigin`, and (0.42.1) `work`, `repo`, `branch`,
`modelFrom`, `soul` and `modules`: the local row's facts, with `soul` and
`modules` the host's own drift observation, never recomputed here, and
`repo` a path on the host. A fact the host does not supply is `null`
(an older host, or a saved route the host no longer lists). A row also
carries `waitingOnYou` (needs input) when the host's kernel reports it, and
only then: an older host's row has no such key. `retire` (0.59.0, a retire
of the home running, unknown, failed or interrupted) is relayed the same
way, through the kernel's own read of it, and a value that read refuses is
dropped ([`retire`](desktop-cli-api.md#row-retire)). `sameWork` (feature
`instance-same-work`, the instance does the same work as its parent) is
relayed only when the host's row has `sameWork: true`, and is absent
otherwise ([`sameWork`](desktop-cli-api.md#row-same-work)). A removed or edited registration keeps
its group from the saved routes. State is pulled on every call, from every
group at once: each probe has its own deadline, `--per-target` (default 20 s)
capped by `--budget` (default 45 s, the deadline of the whole answer), and a
group that fails or does not answer in time reports its own `E_SSH`, so a
host that is switched off never hides the others. The groups keep their
registration order whatever order their probes finish in. `--server <id>`
narrows it. `--workspace-key <key>` (0.56.0, repeatable) narrows it to the
groups that can belong to those workspaces: a registration recorded for one
of them, a registration whose workspace is not known yet, and a group of
saved routes only, whose workspace is unknown; a registration recorded for
another workspace is not probed at all
([the flag](desktop-cli-api.md#roster-workspace-key)).

The group's `probe` also relays the host's kernel features (0.49.0,
`probe.features`): the top-level `features` of the same `status --json`
answer, never a separate `version --json`, kept only when it is a valid list
of feature names and otherwise `null` (unknown, as from a host before
0.49.0); a failed probe has no `features` key
([the field](desktop-cli-api.md#the-remote-roster-oats-server-roster---json)).
It relays the host's viewer fact the same way, `probe.sessionViewer`
(`{prefixScroll}`, feature `session-attach-prefix-scroll`): whether that
host's viewer takes `C-b [`, or `null` when unknown.

**Harvest** runs the knowledge capability's `okf harvest --json` in the
instance's saved home on the server and relays its envelope.

## What this machine keeps

A **saved route** per remote instance, under `~/.oats/remote/<server>/`,
written at spawn (never by a preview): the ssh host, workspace, oats path and
PATH prefix, and the remote home. Retire, harvest and session commands use
the saved route, not the current registration, so editing or removing a
registration never orphans a remote home. The route is removed when the
remote kernel reports the home gone.

- `oats server add --replace` to a different host or workspace, while saved
  routes still point at the old one, makes the next `spawn --server` fail with
  `E_ROUTE_CHANGED`. Register the new target under a new id, or retire the old
  instances first.
- A saved route is never pointed at a different home. A spawn whose name already
  has a route under that server leaves the new instance without one
  (`routeConflict` in the result, with a warning naming the host-side retire).
- A saved route whose instance is gone on the host (`missingRemotely`) cannot
  be retired. Drop it with `oats server forget <id> --instance <name>`.
- `retire --server` sends the saved home as `--home`, so a same-named
  instance under another soul is never the one retired.

## Limits

- No Git runs over SSH: repository operations always run on the server, by
  its kernel, in its deployment.
