# Configuration: `oats-local.yaml`

A deployment has **one** per-machine file, `oats-local.yaml`. It names the
workspace this machine realizes and holds the facts that are true of this host
only. Everything shared (members, packages and their versions, shared teams,
defaults, stores) lives in the workspace repository's `oats-workspace.yaml`,
and everything about a soul lives in its `soul.yaml` ([workspaces.md](workspaces.md)).
Write the first version with `oats onboard`; never commit it to a shared
repository.

## The file

```yaml
schemaVersion: 2
workspace: git:github.com/acme/agents        # REQUIRED: the workspace host, read over the remote

clones:                                      # member clones not beside this file under their repo name
  github.com/acme/platform: /Users/ana/src/acme-platform

settings:                                    # host-owned values per capability
  oats.okf:
    bindings-file: /Users/ana/.oats/okf-bindings.json

teams:                                       # LOCAL teams (only where the workspace says localTeams: true)
  ana-research: { team: "ana-research:acme.aweb.ai", description: Ana's research }
defaultTeam: ana-research                    # this deployment's default team (same condition)
souls:
  disabled: [legacy-bot]                     # souls not run on this machine

host:
  name: ana-laptop                           # which workspace triggers and schedules run here
session:                                     # terminal defaults for NEW launches on this host (0.31)
  tmuxSession: oats-agents                   # the tmux session new tmux instances open in
triggers:
  disabled: [platform/nightly-review]
schedules:
  disabled: [platform/weekly-digest]

launch-configs:                              # named ways this host starts a harness
  personal:
    harness: claude
    executable: "./bin/claude-wrapper.sh"    # relative → against this deployment directory
    args: ["--verbose"]
    env:
      CLAUDE_CONFIG_DIR: { fromEnv: PERSONAL_CLAUDE_DIR }
    model: opus
    yolo: false
  mine:
    harness: claude
    default: true                            # this host's baseline for every claude launch (0.32)
    env:
      CLAUDE_CONFIG_DIR: /home/ana/.claude-personal
```

Schema: [`oats-local.schema.json`](oats-local.schema.json). Unknown keys are
refused (`E_WORKSPACE_SCHEMA`).

| key | meaning |
|---|---|
| `workspace` | Repo ref of the workspace host (`git:host/org/repo`, `https://…`, `git@host:…`, `ssh://<user>@<host>[:<port>]/…` with no password, `file:///…`, `/abs/bare.git`). Read with your own Git credentials; it need not be cloned. |
| `standalone` | A repo ref to realize on its own: its souls and `from: here` capabilities plus `oats.core`, with no workspace lookup. For a repository whose workspace this machine cannot read ([workspaces.md](workspaces.md#the-standalone-case)). |
| `clones` | `<repo key>: <absolute path>` for a member clone that is not at `<deployment>/<member name>/`. Only a soul whose work target needs a clone (`work: worktree \| checkout`) uses it. Lookup order: `spawn --repo`, then this map, then `<deployment>/<member name>` (a member named `agents` → `<deployment>/agents-repo`). None → `E_CLONE_MISSING`; a directory whose `origin` is another repository → `E_CLONE_MISMATCH`. |
| `launchPromptAnswers` | Ignored, with a warning to remove it; a home entry `awebDevelopmentChannel: false` is refused. See [the development-channel confirmation](#the-development-channel-confirmation). |
| `settings.<cap>.<key>` | Host-owned values a capability's manifest asks for: absolute paths, state roots, delivery modes. The workspace file refuses absolute paths; they go here. Merged into the capability's provider payload after the soul's own and before any `--provider` flag ([three homes](workspaces.md#provider-payloads-have-three-homes)). |
| `teams.<label>` | A **local** team: `{ team: <provider team id>, description? }`, a team only this deployment uses; every soul may join it. Allowed only where `oats-workspace.yaml` says `localTeams: true` (or in the standalone view); otherwise refused (`E_WORKSPACE_SCHEMA`, reason `local-teams-closed`). Shared teams are committed in `oats-workspace.yaml`; a label in both is `team-label-collision` (the shared one wins). Written by `oats teams add <label> --team <id>` and `oats teams remove <label>`. |
| `defaultTeam` | This deployment's default team: a label of a local or shared team, under the same condition as `teams`. A soul's own default in the workspace's `souls:` wins over it; it wins over the workspace's `defaultTeam`. The first `oats teams add` sets it (unless `--no-default`); `oats teams default <label>` changes it, and `--if-absent` / `--expect <label>` change it only where there is no effective default / it is that label. |
| `souls.disabled` | Souls not run on this machine; a spawn is refused with `E_SOUL_DISABLED`. A bare name disables every soul of that name; `<package>/<soul>` or `<member>/<soul>` disables one. It is for a soul that must not run here (broken, or not for this machine), with the reason in a comment; it is not a gate for souls without a `launch:`, which take the host default like any launch nobody named (see [Launch preferences](#launch-preferences)). An entry is matched by exact name only, so one whose soul was renamed or moved (a removed package pin, for example) names no soul and keeps nothing off: it fails open, and the soul becomes spawnable again under its new name, unlike a stale `souls.launch` key, which fails closed. Run `oats doctor` after any rename or removal: it reports such an entry as `disabled-soul-unmatched`, with the nearest souls ([what doctor reports](desktop-cli-api.md#launch-preferences)). |
| `session.tmuxSession` | The tmux session new tmux instances open their windows in (0.31). Absent: `OATS_TMUX_SESSION`, else `PI_AGENTS_TMUX_SESSION` (the pre-0.31 variable), else `oats-agents`. `session: { tmuxSession: pi-agents }` keeps the pre-0.31 layout. `oats inspect --json` reports it as `session`. |
| `host.name` | This machine's name. A workspace trigger or schedule runs only on the host named by its `runsOn` ([schedules.md](schedules.md)). |
| `automations.trust` | The workspace triggers and schedules (`<member>/<id>`) this host agrees to run, or `"*"` for every one the workspace places here (0.30). Absent or empty: none runs. See [Who runs workspace automations](#who-runs-workspace-automations). |
| `triggers.disabled`, `schedules.disabled` | Workspace triggers and schedules (`<member>/<id>`) this host does not run, without a commit. Written by `oats trigger disable` / `oats schedule disable`. |
| `launch-configs.<name>` | A named way to start a harness on this host, chosen at spawn or session start, never by the soul. `default: true` makes it this host's baseline for its harness (0.32). See [Launch configurations](#launch-configurations). |
| `souls.launch` | This machine's launch preference per soul (0.30): `"*"` for every soul, a soul's own entry (its name, or `<package>/<soul>`) over it. A value is a `launch-configs` name or an inline `{ harness, model? }`. It overrides the soul's own `launch:`; explicit spawn flags win over both. Written by `oats soul launch set\|remove` (0.53). See [Launch preferences](#launch-preferences). |

Which teams a soul may join, and its default, are committed in the workspace's
`souls:`, never here: `souls.teams` and `souls.default` were removed in 0.38.0
(`E_WORKSPACE_SCHEMA`, reason `removed-key`; the refusal prints the `souls:` to
commit instead). How teams are resolved, and what a messaging provider does
with them, is in [workspaces.md](workspaces.md#teams).

## Claude channel delivery: the approved route

Claude seats on aweb channel delivery start without Claude's “WARNING:
Loading development channels” prompt through the **approved route**: the
`oats.aweb` setting `claudeChannelMode: approved` starts Claude with
`--channels plugin:aweb-channel@awebai-marketplace`, and Claude shows no
development prompt. Claude admits the plugin when a root-owned machine
managed-settings file lists it. The route does not depend on the Claude
version and needs no OATS mechanism beyond these settings. The operator's
ordered procedure is the `oats.setup` skill `/oats-host-delivery`, whose
Choice 1 is this route and whose Choice 2 is the host wake broker;
`/oats-onboarding` card 4 makes both choices and card 8 checks them. The provider's side is
`/oats-aweb` §4.

An unset `claudeChannelMode` is development mode, so a host that never makes
the choice runs every Claude home with the development prompt. Set the key
explicitly, to `approved` or, as a recorded fallback, `development`.

**The managed-settings file** is a host change made by a human admin with
sudo. OATS never writes it.

| | |
|---|---|
| Location | Linux: `/etc/claude-code/managed-settings.json`; macOS: `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Owner and mode | root, `0644` |
| Content | exactly `{"channelsEnabled": true, "allowedChannelPlugins": [{"plugin": "aweb-channel", "marketplace": "awebai-marketplace"}]}` |
| Existing file | merge these two keys into it; never overwrite other keys |
| Drop-ins | Claude also reads `managed-settings.d/*.json` beside the file |

Setting `allowedChannelPlugins` **replaces Anthropic's default channel
allowlist** on that host. That list is the official discord, telegram,
fakechat and imessage plugins; a host that uses any of them must list them
too.

**Precedence.** Claude reads its managed policy from the first source
present: server-managed settings (a claude.ai Team/Enterprise organization's
admin console), then an MDM profile (`com.anthropic.claudecode` on macOS), then
the file. On an account governed by server-managed settings or MDM the file is
ignored, and the organization admin sets the same two keys there instead.
Pro/Max accounts and plain API-key use have no server-managed settings, so the
file applies. `channelsEnabled: true` is required for API-key users whenever
any managed policy exists, and for Team/Enterprise subscribers; Pro/Max ignore
it. It is harmless there: always include it.

**OATS side**, in this host's `oats-local.yaml` under `settings.oats.aweb`:

```yaml
settings:
  oats.aweb:
    claudeChannelMode: approved   # host-only
    delivery: channel             # host-wide; or per spawn: --provider oats.aweb delivery=channel
```

With channel delivery, pi uses its `@awebai/pi` extension and Codex always
uses the host broker. The broker (`aw wake run`, one per host user) also wakes
every joined team and every `delivery: session` home. Without it, joined teams
are poll-only. It runs as a per-user launchd or systemd service that the
operator installs, with `AW_WAKE_OATS_BIN` and a `PATH` that reaches `oats`,
`node` and `tmux`. That procedure is Choice 2 of `/oats-host-delivery`.

**The plugin.** `aweb-channel` must be installed from the marketplace named
`awebai-marketplace` (GitHub `awebai/claude-plugins`) and enabled, in the
Claude config directory the host's Claude launch configuration uses (its
`CLAUDE_CONFIG_DIR`, else `~/.claude`).

**Existing homes** keep the delivery and channel mode recorded at their spawn.
Respawn a home to adopt the route. Setup never restarts running agents
without the operator's word.

**No prompt** appears in approved mode, so there is nothing for OATS to
confirm: [the development-channel confirmation](#the-development-channel-confirmation)
applies only to a launch with the development-channel flag.

**Verify** with the success list and the failure-banner table of
`/oats-host-delivery`, Choice 1: the preview's mode, the admitted banner
with no failure banner, then the `/oats-aweb` nonce exchange, which alone
proves receive.

**Limits.** Channels are an Anthropic research preview. Anthropic's
account-level feature flag gates channels on every route. The allowlist
matches the marketplace by name.

## The development-channel confirmation

**What engages it.** Whenever OATS itself starts Claude Code (a spawn, `oats
session start` or `session restart`, by hand or by an agent) with
`--dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace`
in its argv, the launcher confirms Claude's development-channel prompt once.
Launching with that flag is the decision: there is no consent setting and no
list of homes. Every Claude home the messaging provider starts in development
mode (`settings.oats.aweb.delivery: channel` with `claudeChannelMode:
development`, today's defaults) is covered, existing homes included at their
next start. This reverses the earlier rule that no existing home is enabled
automatically. Any other argv (approved-mode `--channels`, another plugin,
several plugins, contradictory channel arguments), Codex and pi never engage it,
and nothing is captured. `--no-launch` never answers.

**What it proves before the one key.** The visible screen of the pane this start
created, normalized by the [enumerated tolerance](../lib/launch-prompt-fixtures/README.md)
(box-drawing rows dropped, whitespace collapsed, nothing else), must equal one
entry of the tolerance list: the confirmation's own text, exactly one channel
(`plugin:aweb-channel@awebai-marketplace`), the affirmative option
`1. I am using this for local development` with `❯` before it, option `2. Exit`
without it, and nothing else on the screen. Matching does not depend on the pane
width, the Claude binary or the platform: one entry covers Claude 2.1.289 and
2.1.296 on macOS and Linux, from committed captures, and a release review
reports the same match for 2.1.288 on linux-x64. A pane too narrow for Claude to wrap at word
boundaries (about 40 columns for this prompt) does not match.

**What it never does.** It sends one `Enter`, never another key, never a retry,
and never into a pane it did not create in this start (a respawned pane must
show a new process and a fresh screen). It confirms no other prompt: folder trust
(owned by [`oats harness trust`](harness-trust.md)), API-key and login questions
are unexpected and block. While the screen keeps changing it waits, within 30 s
at 100 ms. An unknown screen is no verdict until it has held unchanged for the
settle window (`SETTLE`, 2 s): Claude paints transient frames while it starts (a
logo mid-animation, a renderer notice) and can hold one for a second or more
under load. An unknown screen that holds still for `SETTLE` blocks with no key,
`blocked: unexpected prompt`, and the receipt says what `differed` from the
nearest entry. A screen still changing when the 30 s bound is reached, or blank
for the whole bound, never settled into a prompt: it blocks with no key,
`blocked: observation timeout`, keeping what `differed` and the last screen as
evidence, and its error and readiness remedy say no prompt was established (look
at the pane; restart a running session) rather than to read and answer one. The instance then waits for a person: the spawn is retained
(`E_SPAWN_INCOMPLETE`), the home records `launchPrompts.status: "blocked"`, and
readiness shows the `launch-prompt` warning. Every attempt and outcome is a
`launch-prompt` event carrying the Claude version read from the executable's
path (`claudeVersion`, `claudeVersionSource`) and the entry it matched; the
version is `unknown` when Claude is started through a wrapper, whose path carries
no version, so it informs and never decides. What
follows the Enter is reported, never answered: the start completes after
`SETTLE` (2 s) of consecutive clean captures (no question marker, no
confirmation; the screen may keep changing), and a question first painted more
than 2 s after the session is working is the session's own, not a launch prompt.
See [launch completion](launch-prompt-completion.md).

**When Claude ignores the flag.** This affects a Claude account (or
organization) for which Claude Code offers no channels, on the messaging
provider's default `delivery: channel`. Claude Code disables channels when telemetry is opted out (`DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), so a launch
environment that sets any of them is affected the same way; the messaging
provider's readiness warning names the three variables that do it. Claude then ignores
`--dangerously-load-development-channels`, shows no confirmation, and starts the
session with a notice: `--dangerously-load-development-channels ignored
(plugin:aweb-channel@awebai-marketplace) Channels are not currently available`.
Before 0.52 such a start reported launched and said nothing, and the instance
was never woken by mail or chat. Now, when that notice block equals a
`flag-ignored` tolerance entry (the block's rows with their `▎` dropped,
normalized the same way; never a contains test; the entry takes no input), and
the screen shows no question (none of the
[question markers](launch-prompt-completion.md)), OATS sends no key and the start
succeeds. A notice beside a question blocks like any unknown screen. It records `launchPrompts: {status:
"flag-ignored", reason: "channels-unavailable", signatureId, startId, at}` (the
entry's id, no screen text), and the start's warnings say, in place of the
statement that OATS confirms the prompt:

> Claude reported that channels are not currently available and ignored the development-channel flag, so this instance gets no channel delivery: mail and chat will not wake it. Check first for a telemetry opt-out in the launch environment (DISABLE_TELEMETRY, DO_NOT_TRACK or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: Claude Code disables channels when one is set), then whether this Claude account offers channels; otherwise change the messaging provider's delivery (its readiness warning says where the setting is). See docs/configuration.md#the-development-channel-confirmation.

Every start says so until the cause is removed or delivery changes. The kernel's readiness shows no `launch-prompt` warning for it; the
messaging provider's readiness reports the missing channel. A notice in a wording
no entry holds is an unknown screen and blocks.

**Known limit: a hidden notice.** Claude shows a limited number of notices. On a
fresh Claude configuration another notice (for example, auto mode becoming the
default) can take the slot and keep this one behind `1 more notice hidden`,
typically on an instance's first spawn. OATS cannot see a hidden notice, so that
start stays `blocked: unexpected prompt` (no key, the home retained). When the
blocked screen starts with Claude's running-session banner (`Claude Code
v<semver>` after the logo, which may be caught mid-animation), the error and the readiness remedy add:

> Claude may have reported that channels are not currently available and ignored the development-channel flag, its notice hidden behind another one: look at the pane. If the session is running, restart the instance, and the notice will then show. Check first for a telemetry opt-out in the launch environment (DISABLE_TELEMETRY, DO_NOT_TRACK or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC), then whether this Claude account offers channels; otherwise change the messaging provider's delivery (its readiness warning says where the setting is). See docs/configuration.md#the-development-channel-confirmation.

A restart where the notice shows records `flag-ignored`.

**Known limit: a split window.** The confirmation still requires the agent's
window to have one pane. A start or restart in place on a window that has
another pane (oats.setup's no-echo prompt, for example) relaunches Claude in
the agent's pane
([which pane is the agent's](execution-targets.md#which-pane-is-the-agents))
but answers nothing: the home records `launchPrompts.status: "blocked"`, and
Claude waits at its development-channel prompt for a person, as after any
blocked start. Close the other pane before the restart.

**The setting that stops it.** OATS confirms the prompt only because the
deployment launches Claude with the development-channel flag. To stop that, use
`settings.oats.aweb.claudeChannelMode: approved`
([the approved route](#claude-channel-delivery-the-approved-route), no prompt at
all). It is captured at spawn, so respawn a home to change it. Every
start that engages the confirmation says so in its output (`launch-config preview`,
the spawn's warnings, `session start|restart`). `spawn --preview` cannot say it
yet: the argv comes from the provider's spawn hook, which a preview does not run.

**A new Claude wording** blocks loudly until a reviewed change adds it as a new
tolerance entry with its captured provenance. Until then, read the prompt in the
instance's terminal and press Enter yourself.

**An old `launchPromptAnswers` block** in `oats-local.yaml` is judged, never used:

- only `awebDevelopmentChannel: true` entries, an empty block, or
  `workspaceTrust`: ignored, with one warning per command naming the key and
  saying to remove it;
- any home entry `awebDevelopmentChannel: false`: refused (`E_WORKSPACE_SCHEMA`,
  reason `removed-key`, at that entry), because this kernel can no longer honour
  that refusal. The message says what to set instead.

`launchPromptAnswers` remains refused in workspace and soul declarations.

## Launch configurations

An entry has `harness` (`pi` \| `claude` \| `codex`, required), `executable`
(a bare name looked up on `PATH`, or a path relative to the directory of the
file that declares it), `args` (literal, no shell), `env` (a literal string, or
`{ fromEnv: NAME }` or `{ fromFile: /absolute/path }` resolved on the host at start), `model`, `yolo` and
`default` (0.32; see [the harness default](#the-harness-default)). A launch
configuration is a host choice: a soul never names one.

- Select one with `--launch-config <name>` on `oats spawn`,
  `oats session start` and `oats session restart`. A named configuration is
  a unit: a `--harness` that disagrees with it is refused
  (`E_LAUNCH_CONFIG_MISMATCH`); `--model` and `--yolo` override its fields.
- Without `--launch-config` or `--harness`, a spawn follows the soul's
  [launch preference](#launch-preferences) (else `pi` with its defaults), and
  an existing home keeps what it recorded. `--harness` alone leaves the recorded
  configuration behind and uses the new harness's defaults. A model never
  crosses harnesses.
- The executable must be a regular executable file; it is never run to probe
  it.
- `oats launch-config list` shows the effective entries;
  `oats launch-config set <name> --file <json>` and
  `oats launch-config remove <name>` rewrite only this block, under the
  lock every kernel command that rewrites `oats-local.yaml` holds;
  `oats launch-config preview (--home <abs> | --soul <name>) --json` shows
  what a start would run (harness, model, executable, argv, redacted
  environment, command and preflight checks) and starts nothing.
- The old key `runtime` is still read as `harness`, with a
  `deprecated-runtime-name` warning.
- **Claude's permissions** are Claude's own settings, not OATS keys. They go
  in the user settings of the Claude config a launch uses (its
  `CLAUDE_CONFIG_DIR`, else `~/.claude`), or `--permission-mode` goes in a
  configuration's `args`. Never in a home's `.claude/settings.json`: the
  capabilities manage it at every start, and Claude ignores auto mode there.
  oats.setup's `/oats-agent-permissions` (oats.framework 1.13.0) teaches the
  setup: auto mode, narrow allow rules for the `oats` and `gh` reads,
  `oats spawn` and reading `aw` mail and chat, and what stays gated.
  `yolo` is separate and is meant for isolated machines.

### This machine's launch configurations

`~/.oats/config/launch-configs.yaml` (`$OATS_HOME_DIR/config/` when
`OATS_HOME_DIR` is set) declares launch configurations for every deployment
on this machine. The person writes it, or an installer running as the
person; nothing in OATS writes it.

```yaml
launch-configs:
  claude-auto:
    harness: claude
    args: ["--permission-mode", "auto"]
    default: true
```

- **One key.** The file holds `launch-configs:` and nothing else. Its entries
  have exactly the schema of the deployment's block and the same checks.
- **Missing or broken.** A missing file declares nothing. A file that is there
  but cannot be read, is not valid YAML, is empty, lacks `launch-configs:`,
  has any other top-level key, or holds an invalid entry is refused
  (`E_LAUNCH_CONFIG_INVALID`, naming the file). The refusal reaches every
  listing, preview, spawn and start that reads launch configurations. It is
  never skipped. `oats doctor` reports the file and does not fail on it.
- **Precedence, by name.** Each deployment reads the machine's entries under
  its own. A deployment entry with the same name replaces the machine's
  whole: no field of the machine's entry is kept. Its `shadows` names the
  machine file. With no deployment in reach, the machine's entries alone
  apply.
- **Precedence, for the default.** The [harness default](#the-harness-default)
  is per harness. A deployment's `default: true` for a harness wins over the
  machine's: the machine's entry for that harness stays listed, but not as
  default. The machine's default applies when the deployment declares none
  for that harness. Two defaults for one harness within one file are refused,
  as in the deployment.
- **`source`** is the directory an entry was declared in: the deployment
  directory, or `~/.oats/config`. A relative `executable` resolves against
  it.
- **Where it shows.**
  - `oats launch-config list` (and `--json`) gives each entry's `source` and
    `shadows`.
  - `oats spawn --preview` names the machine file when it supplied the
    configuration; the JSON carries `launchConfigSource`.
  - `oats doctor --json` reports the file under `machineLaunchConfigs`:
    `file`, `present`, `ok`, `configurations` (the names) and, when broken,
    `error`.
- **Writes.** `oats launch-config set|remove` writes only the deployment's
  `oats-local.yaml`. Setting a name the machine also declares adds a
  deployment entry that shadows it, and removing that entry uncovers the
  machine's again. Desktop's launch-configuration editor writes the same
  way: saving a row whose source is the machine file writes a deployment
  entry of that name, which then shadows the machine's.
- **Homes.** A spawn records the configuration as it was, the machine's like
  the deployment's (`launchConfigSource` is the directory it came from). A
  start or restart runs the recorded recipe; a later edit of either file
  reaches a home only through `--launch-config <name>`, `--reselect-launch`
  or a respawn.

### The harness default

`default: true` makes a configuration this host's baseline for its harness
(0.32, feature `launch-config-default`). Use it for what every launch of a
harness on this machine needs, whatever soul or preference chose it: an
account directory (`CLAUDE_CONFIG_DIR`), a wrapper `executable`, an argument.

- **When it applies:** a new launch that picks the harness without naming a
  configuration: a soul's `launch:`, an inline `souls.launch` preference,
  `--harness` (on a spawn, or on `session start|restart` of an existing
  home), `--reselect-launch`, and the host default (`pi`). It supplies the
  executable, args, env and `yolo`. A `yolo` recorded from a default stays
  with it: a later `--launch-config none` or another harness does not carry
  it over.
- **The model** comes from whatever picked the harness (`--model`, then the
  preference); the default's `model` is the last fallback, before the
  harness's own.
- **A named configuration runs as declared**: `--launch-config <name>` or a
  `souls.launch` name never inherits from the default. `--launch-config none`
  (or a `souls.launch` entry of `none`) asks for the bare harness and
  bypasses it.
- **One per harness.** A second `default: true` for the same harness is
  refused (`E_LAUNCH_CONFIG_INVALID`, naming both); move it by clearing the
  old one first.
- **Several configurations and no default is ambiguous for a spawn.** When a
  spawn's harness has more than one configuration here, none of them
  `default: true`, and the spawn names none, it is refused in preview and
  apply alike (`E_LAUNCH_CONFIG_AMBIGUOUS`, naming the harness and its
  configurations) instead of starting the bare harness. Naming one decides
  it: `--launch-config <name>`, `--launch-config none` (the bare harness) or
  a `souls.launch` name (`none` included). An inline `souls.launch`
  preference, the soul's `launch:` and `--harness` alone name no
  configuration. One configuration for the harness is not ambiguous (without
  `default: true` it is not used). `oats souls` and `oats inspect --soul`
  show the refusal as the launch's `problem`. A start or restart of an
  existing home, with `--harness` or `--reselect-launch` too, is not refused.
- **Existing homes keep their launch** until `--reselect-launch` or a
  respawn, like any change of preference. Declaring a default is such a
  change: `oats readiness --home` warns `launch-changed` on each existing
  home the default would now apply to, until it is restarted with
  `--reselect-launch` or respawned.
- **It is visible.** `oats launch-config list` marks it; `spawn --preview`,
  `launch-config preview`, `instance.json` and `oats inspect --home` say when
  a launch's configuration came from the default (`launchConfigDefault`).
  A default with `yolo: true` turns yolo on for every launch of that harness
  here: the preview shows it.
- **Every kernel that reads the deployment needs OATS 0.32+.** OATS 0.31
  and older refuse the whole `oats-local.yaml` (`E_WORKSPACE_SCHEMA`) once a
  configuration declares `default`.

`oats-claude-config` (a one-line file naming the claude binary, found walking
up from the deployment) is no longer read. A new claude launch with one in
reach is refused (`E_CLAUDE_CONFIG_REMOVED`) naming the file: declare the
name it holds as the claude default (`executable: <name>`, `default: true`)
and delete the file. Homes launched with it keep their recorded executable.

### Launch preferences

A soul says what its role should run on, and each machine may override it
(0.30; the design is
[soul launch preferences](design/2026-09-28-soul-launch-preference.md)):

```yaml
# souls/<soul>/soul.yaml — only a harness and a model
launch: { harness: claude, model: claude-opus-5-5 }

# oats-local.yaml
souls:
  launch:
    "*": personal                                    # a launch configuration, for every soul here
    oats-engineering-expert: { harness: claude, model: claude-opus-5-5 }
    oats.engineering/code-reviewer: { harness: codex }   # a package soul
```

- **Write `souls.launch` with `oats soul launch`** (0.53.0), not by hand:

  ```
  oats soul launch set <soul>|'*' (--launch-config <name>|none | --harness pi|claude|codex [--model <id>])
  oats soul launch remove <soul>|'*'|<exact key>
  ```

  each with `--plan` (every check, nothing written), `--dir <deployment>`
  and `--json`.
  - `set` names the soul as a spawn does and writes the key that soul has:
    its bare name, or `<package>/<soul>` for a package's. So it cannot write
    a key that names no soul. `'*'` is every soul without an entry of its
    own. `--launch-config <name>` must be a launch configuration this file
    declares (`none` is the bare harness); `--harness` writes the inline
    preference.
  - `remove` takes a soul, `'*'`, or the exact text of a key in the file.
    The exact text is tried first and needs no read of the workspace, so a
    key that names no soul can always be removed. An entry the file does not
    have is refused (`E_LAUNCH_PREFERENCE_UNKNOWN`), never answered "done".
  - Both answer what the next spawn of that soul selects, and every key of
    `souls.launch` that still names no soul the workspace offers.
  - **The file is rewritten, and every other entry keeps its value and its
    comments.** The write holds the lock `oats teams` holds, so neither
    drops the other's change.
  - **A name two members offer.** A member's soul is keyed by its bare name,
    so one entry pins every member's soul of that name: an entry cannot pin
    one of them and leave the other. `oats soul launch set <member>/<soul>`
    writes the bare name and lists each soul the entry applies to; the bare
    name alone is refused, as for a spawn (`E_SOUL_AMBIGUOUS`). To run one
    of them differently, name its launch on that spawn (`--launch-config` or
    `--harness`), or keep the other off this machine (`souls.disabled` takes
    `<member>/<soul>`).
- **Precedence for a new launch:** `--launch-config` or `--harness`, then
  `souls.launch.<soul>`, then `souls.launch."*"`, then the soul's `launch:`,
  then `pi` with its defaults. `--model` alone keeps the deciding layer's
  harness and replaces only its model.
- A **launch configuration** name runs that configuration's full recipe. An
  **inline or soul preference** runs its harness the way this host starts it
  without a configuration: [the harness default](#the-harness-default) if
  one is declared, else the executable on `PATH` with no args and no env,
  with the preference's `model`. A spawn is refused instead when the harness
  has several configurations and none is its default
  (`E_LAUNCH_CONFIG_AMBIGUOUS`). A preference without `model` uses the
  harness default's model, else the harness's own; it never borrows a lower
  layer's.
- **A key that names no soul refuses the launches it might have pinned**
  (0.53). While `souls.launch` holds a key, other than `"*"`, that is the key
  of no soul the workspace offers, a new launch that names no launch, of a
  soul with no entry of its own, is refused
  (`E_LAUNCH_PREFERENCE_UNMATCHED`). `souls.launch."*"`, the soul's `launch:`
  or the host default would have decided that launch, and the kernel cannot
  tell which soul the key was meant to pin. Before 0.53 the key was never
  read, and the soul it was written for ran on the fall-through.
  - **Refused:** `oats spawn`, preview and apply, and `oats session
    start|restart --reselect-launch`, before anything is created, stopped or
    started. `--model` alone names no launch.
  - **Goes on:** a soul with its own entry; a launch named with
    `--launch-config` or `--harness`; a plain start or restart of an
    existing home, which selects nothing again.
  - **The remedy, in this order:** pin the soul the key was meant for (`oats
    soul launch set <soul> --launch-config <name>`, or `--harness <h>`),
    then remove the key (`oats soul launch remove <key>`). Removing first
    ends the refusal and leaves that soul on the fall-through. The refusal
    names the keys and, for each, the nearest soul keys.
  - **Where it shows:** `oats souls` and `oats inspect --soul` carry it on
    each soul a spawn would refuse and list each such key; `oats doctor`
    lists each key with the command that removes it, from this machine's
    last read of the souls.
  - **A key the kernel could not check refuses nothing:** a bare key while a
    member is not confirmed or a member's or an external soul failed to
    read, a `<package>/…` key while that package is declared and not locked
    or one of its souls failed to read, and every key in the standalone view
    of a workspace whose host cannot be read. `oats doctor` says so
    (`launch-preference-unchecked`). The key of a soul listed in
    `souls.disabled` matches that soul. `"*"` is never reported.
- **A missing harness is refused**, never replaced: `E_HARNESS_UNAVAILABLE`
  names the layer that chose it and the fix (install the harness, or override
  it here in `souls.launch`). `oats souls` still lists the soul, with the
  problem.
- **Existing homes keep their launch.** A changed preference does not affect
  a running or stopped home until `oats session restart --reselect-launch`
  (or `start --reselect-launch`) or a respawn. `session start|restart --model`
  keeps the recorded harness and replaces only the model. `oats readiness --home` shows
  the drift as the `launch-changed` warning; `oats inspect --home` shows
  `launch` (the record) beside `launchCurrent`.
- `oats souls`, `oats inspect --soul` and `oats spawn … --preview` show each
  soul's `launch`: its own preference, the effective launch, and which layer
  decided (`from`) and where (`at`).
- **Migration.** 0.29 refuses a soul.yaml it does not know, so a committed
  soul gains `launch:` only once every deployment of the workspace runs 0.30.
  Until then, set the preference in `souls.launch` on each machine.

**Environment references.** `{ fromEnv: SRC }` is rendered as a reference,
never a value, in the recorded command and in every answer. At start each
source variable must be set on the host (`E_LAUNCH_ENV_MISSING`, before
anything is created or stopped), and only the harness's pane receives it.
`list` and `preview` redact every environment value, literals included.

`{ fromFile: /absolute/path }` reads a regular UTF-8 file on the host that
starts the harness, at every start. It removes exactly one trailing LF or
CRLF; an empty file is allowed. Invalid UTF-8 and NUL are refused. A leading
UTF-8 BOM is preserved as part of the value. A missing, unreadable or
non-regular file refuses with `E_LAUNCH_ENV_MISSING`, naming
`oats harness token set <harness> --server <id>` or operator provisioning on
that host. The token command is a separate provisioning feature.

```yaml
launch-configs:
  subscription:
    harness: claude
    env:
      CLAUDE_CODE_OAUTH_TOKEN: { fromFile: /etc/agent-login/claude-token }
```

**Claude login credentials.** At a Claude start, OATS checks for
`$CLAUDE_CONFIG_DIR/.credentials.json`, or `$HOME/.claude/.credentials.json`
when no config directory is selected, using the launch's effective environment.
If OATS sets `CLAUDE_CODE_OAUTH_TOKEN` through a literal, either reference kind,
or a capability's launch contribution, it refuses with
`E_CLAUDE_LOGIN_CREDENTIAL`. An empty value counts. Remove the `/login`
credential from that Claude configuration and use `oats harness token set
claude` to provision an inference-only token. Without an OATS-set token, OATS
warns with that command. An inherited token does not select the token route.
Other harnesses are unaffected.

Both reference kinds use `OATS_LAUNCH_REF_<NAME>` aliases. Their values are
absent from process arguments, tmux command lines, recipes, events and logs.
The kernel hands them to the pane through a per-start file in the instance
home, created exclusively with mode 0600; the launcher reads and deletes it
before executing the pane command. A failed dispatch removes it. Retirement
recovery excludes leftover handoff files. Each subsequent start removes
abandoned handoffs before dispatch, even when the new launch has no references. The start environment records only
keyed digests of reference values, including file references, so a resume
refuses a changed value; an ordinary start adopts a rotated file.

**The instance's `oats`.** Every launch (`oats spawn`, `session start`,
`session restart`, locally or through `--server`) writes `<home>/.oats/bin/oats`,
a link to the launching kernel's `bin/oats.mjs`, and runs the harness with
`<home>/.oats/bin` first on `PATH` and the rest of `PATH` unchanged. Plain
`oats` inside an instance is therefore the kernel that launched it, even on a
machine whose `PATH` finds another kernel first. A launch configuration's own
`PATH` (literal or `fromEnv`) comes after it. A restart by a different kernel
re-points the link to that kernel; `spawn --no-launch` writes it too. The
recipe in `instance.json` records the target as `launch.kernelBin` (no JSON
answer carries it); `oats status` prints it
(`kernel:`) under `--verbose`, or when it is not the `oats` running the status.
A launch that cannot write the link fails with `E_LAUNCH_SHIM` naming the path
and the cause: a spawn is rolled back, a start starts nothing. The recorded
`command` does not carry the `PATH`; the kernel adds it when it runs the
command. Hooks still receive `OATS_CLI_BIN`, unchanged.

**The launch recipe.** A spawn records what a start is made of in
`instance.json` under `launch`: the harness, the configuration and where it
came from, the executable, args, env, model, yolo, and each capability's
launch contribution with its settings and trust, and the kernel that launched
it (`kernelBin`, re-written by every start). One renderer turns it into
the `command`. Configuration `args` go after the harness's own options and
before capability arguments; every argument is single-quoted.

**Starting and restarting a home.** `oats session start --home <abs>` runs
the recorded recipe. With `--launch-config`, `--harness` or `--yolo`, the
recipe is resolved again against the home's recorded context and every check
runs first. With `--reselect-launch`, the launch preferences decide again
(the home's recorded soul and this deployment's `souls.launch`). A capability that contributed harness-specific arguments must
declare a `launch` hook to follow a harness change; otherwise the start is
refused (`E_LAUNCH_PREPARATION`). The checks use the preview run
(`OATS_LAUNCH_PREVIEW=1`) of the launch hooks whose capabilities declare
`launchPreview`. Those hooks run for real only after every check has passed,
so a start refused by preflight has run none of them for real. Other launch
hooks run once, for real, during the checks (see
[capabilities.md](capabilities.md)). A launch hook's warnings do not stop
the start: `session start|restart` print them (and answer them as
`warnings` under `--json`), as spawn does, and each is kept as a
`launch-warning` instance event (`oats instance events`).
`oats session restart` runs the same
checks, then sends SIGTERM to the harness and what it started, waits
(`--stop-grace <seconds>`, default 20) for them to exit, and starts again in
place. It never escalates: a harness still running is reported
(`E_SESSION_STOP_FAILED`) and nothing is launched. What a harness saves on
SIGTERM is its own; a wrapper script should `exec` the harness or forward
signals.

## Who runs workspace automations

A workspace trigger or schedule names the host that runs it (`runsOn`) and
the GitHub account it acts as (`owner`). Both come from a commit, so a host
also has to say yes itself (0.30):

```yaml
automations:
  trust:
    - agents/pr-review          # <member>/<id>
    - agents/nightly-digest
# or: trust: "*"                # every automation the workspace places on this host
```

- It runs only if `runsOn` is this host's `host.name`, its `owner` is this
  host's `gh` account, **and** `trust` admits it. `triggers.disabled` and
  `schedules.disabled` still opt out on top.
- A placed but untrusted one never runs. Its row has reason `untrusted`, and
  `oats workspace status` warns with the line to add.
- An entry that names nothing is a warning, not an error.
- `automations` is a host key: the committed `oats-workspace.yaml` refuses
  it.
- **Upgrading to 0.30:** a host that ran workspace automations must add its
  `trust` lines; until then they do not run there.
- Your own triggers and schedules (`oats trigger add`, `oats schedule add`)
  need no trust. Details: [schedules.md](schedules.md#workspace-triggers-and-schedules).

## The deployment directory

Every `oats` command that needs the workspace walks **up** from the current
directory (or `--dir`) to the nearest `oats-local.yaml`; its directory is the
deployment. Not found → `E_LOCAL_MISSING`. Nothing above that directory
composes into it: a deployment created inside another one sees only its own
files.

```
~/acme/
├── oats-local.yaml
├── oats-lock.json          # written by `oats sync` (packages.md)
├── oats-schedules.json     # this host's local schedules and triggers (schedules.md)
├── agents/                 # instance homes and the fetched soul copies
├── .oats/modules/          # the capability store for operator-level commands
└── <member clones>/        # only where someone works IN a repository
```

**The capability store.** A capability command run from the deployment for a
soul (`oats <namespace> <command> --soul <soul>`) fetches that capability at
its locked commit into `.oats/modules/<capability>@<commit12>/`, verifies its
content digest against the lock (recorded beside it as
`.<capability>@<commit12>.digest`) and runs that copy. A tree that no longer
matches its record is fetched again. An instance never uses the store: each
home has its own copy under `<home>/.oats/modules/<capability>/`
([souls-and-instances.md](souls-and-instances.md)). The store is a cache; it
is safe to delete.

## The compile cache

Every `oats` command keeps Node's compile cache in `~/.oats/compile-cache`
(`$OATS_HOME_DIR/compile-cache` when `OATS_HOME_DIR` is set), so a command
does not recompile the kernel each time it starts. The CLI creates the
directory mode 0700. It is a cache: delete it at any time; it holds one
subdirectory per Node version, so it grows a little with each Node upgrade.
Node's own variables override it: `NODE_COMPILE_CACHE=<dir>` moves it there,
and `NODE_DISABLE_COMPILE_CACHE=1` turns it off. A cache that cannot be
written means no cache, never a different answer. Hooks and other processes the
CLI starts do not inherit it.

## What is not in it

- **Which capabilities a soul gets:** the soul's `capabilities:` plus the
  workspace `defaults`.
- **Versions:** `packages:` in the workspace file; exact commits in
  `oats-lock.json`.
- **Trust:** membership for members, the workspace's `packages:` declaration
  for packages ([packages.md](packages.md#trust)).
- **Per-instance provider facts:** `oats spawn <soul> --provider <cap> key=value`,
  recorded in the instance's `instance.json`.
- **Shared teams, stores and defaults:** the workspace file.
- **Claude's channel admission:** Claude's own managed policy (server-managed
  settings, an MDM profile or the root-owned managed-settings file; see
  [the approved route](#claude-channel-delivery-the-approved-route)).

## Inspecting the effective configuration

```bash
oats workspace status          # members, locked packages, external souls
oats sync                      # confirm, resolve, lock, report the diff
oats teams                     # shared and local teams, and the default
oats soul teams <soul>         # the teams one soul may join here, and why
oats spawn <soul> --preview    # the exact modules, teams and provider payloads
oats doctor                    # this deployment's files and the lock
```

Environment: `OATS_REMOTE_CACHE` relocates the fetch cache (which also holds
the bounded parsed-read cache, the observations `--max-age` reuses and the
records of verified package trees; all of it is safe to delete); `OATS_PACKAGE_CATALOG` names an alternative package
catalog file. The read verbs (`status`, `workspace status`, `souls`,
`capabilities`, `inspect`, the read forms of `teams` and `soul teams`, and
`spawn --preview`), and a spawn apply bound by `--expect-decision`, take
`--max-age <seconds>` to reuse a remote head observed that recently
([Observation reuse](desktop-cli-api.md#observation-reuse-feature-observe-max-age-oats-0311)).
