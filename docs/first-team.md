# Run your first OATS team

**The quick way:** the README's [Start here](../README.md#start-here): your
coding agent downloads the `oats-getting-started` skill verbatim and follows
it. It installs OATS, creates your workspace and its team (or joins an
existing workspace), and spawns the workspace's setup expert, `oats.framework`'s
`oats-setup-expert`, which does the rest with you. This page is the manual
path, for writing a workspace by hand.

The model is in [workspaces.md](workspaces.md), packages in
[packages.md](packages.md), and the deployment layout this page creates in
[configuration.md](configuration.md).

Start with one workspace, one member repository and one small, real task. A
soul keeps the role and its curated skills; an instance gets a working session
and a repository view; every capability the instance runs is copied whole into
its home at spawn from a **member** repository (latest state, trusted by
membership) or from a **package** (a pinned version, trusted by its
declaration and locked to a commit and integrity). Nothing is installed.

## 0. Prerequisites

Node.js 22.5 or later (the floor `@awebai/oats` declares in `engines`), Git
with read access to the repositories below (your own credential helpers; the
kernel never prompts), tmux, and an authenticated harness (Pi, Claude or
Codex).

```bash
npm install -g @awebai/oats@latest
node --version && tmux -V && oats version --json   # features must list workspace-v2
```

## 1. Declare the workspace (shared, in Git)

Three files, all committed ([workspaces.md](workspaces.md) shows each field):

- `oats-workspace.yaml` (`schemaVersion: 2`) in **one** host repository: `name`,
  `members: [<repo ref>, …]`, `teams:` (the shared teams), `packages: { oats.framework: v<x>, … }`,
  `defaults:`. A member is a repo ref, never a revision.
- `oats-membership.yaml` (`{ schemaVersion: 2, workspace: <host ref> }`)
  in **every** member — the backlink half of the handshake. A repo listed
  without a backlink is `no-backlink` and contributes nothing.
- `souls/<name>/soul.yaml` (`schemaVersion: 2`) in the member that owns the
  soul: `name`, `description`, `work: worktree|checkout|directory|workspace`,
  and `capabilities: { <cap>: { from: here | <repo key> | package } | off }`.
  A capability is a directory `capabilities/<cap>/oats.json` in a member.

The smallest real setup is one repository that is host **and** member: it
carries the workspace file, its own `oats-membership.yaml` pointing at itself,
one soul and, optionally, one capability. Give every soul `oats.core` with
`defaults: { capabilities: { oats.core: { from: package } } }` and an
`oats.framework` pin.

## 2. Realize it on this machine — `oats onboard`

`oats onboard` is the bootstrap: it writes a minimal `oats-local.yaml`, creates
`agents/` and runs the first `sync` ([configuration.md](configuration.md) is
the resulting layout).

```bash
oats onboard ~/acme --workspace git:github.com/acme/agents     # any directory — an existing one with your clones is fine
```

```
~/acme/                           # the directory you chose; these three entries are what the kernel needs
├── oats-local.yaml               # { schemaVersion: 2, workspace: git:github.com/acme/agents }
├── oats-lock.json                # lockfileVersion 3: commit + integrity per package
├── agents/                       # instance homes
└── <member>/                     # clones of the members you work IN — here or anywhere named in oats-local.yaml clones:
```

Read the report it prints: every member row must be `✓↔` (confirmed) — fix
`no-backlink` / `backlink-elsewhere` / `cannot-read` before going on. Every
package in `packages:` is resolved, fetched, integrity-checked and locked; a
package is trusted because the workspace declares it, so review what a package
runs before adding its pin. Then clone the
member you will work in beside `oats-local.yaml` (only a soul's work target
needs a clone — discovery and resolution run over the remotes).

The last next step names the workspace's OATS setup expert to spawn, among the
souls that declare `oats.setup` in their own `soul.yaml`: the one named
`<workspace name>-oats-setup-expert` (`acme-oats-setup-expert` for a
workspace named `acme`), else the first by name. With neither, it says so and suggests
adding that conventional soul, or spawning any listed soul. The full rule and
its limits are in
[desktop-cli-api.md](desktop-cli-api.md#oats-onboard-onboardapi-2).

`--json` returns `onboardApi: 2` (`local`, `dir`, `agents`, `lock`, the full
`sync` report, `hosting`, `next.clone[]`, `next.spawn`); running it twice is
`E_ALREADY_ONBOARDED` (use `oats sync`); a mistyped ref is `E_REPO_REF`, an
unreadable one `E_REMOTE_UNREADABLE` with `details.rolledBack: true` — nothing
half-written is left behind. Exact shapes:
[desktop-cli-api.md](desktop-cli-api.md#oats-onboard-onboardapi-2).

Host-owned provider values (absolute paths, state roots) go under `settings:` in
`oats-local.yaml` afterwards — never in the workspace file, whose schema refuses
them. Do not commit `oats-local.yaml`.

**Trust the deployment once, for unattended launches.** Claude Code and Codex
ask before they work in a folder they have not seen, and every instance home is
new: a launch that stops at that prompt waits for a human. On the target host,
preview the exact deployment-root entry, then explicitly apply it while native
configuration writers are quiescent:

```bash
oats harness trust --dir ~/acme --harness all --plan
oats harness trust --dir ~/acme --harness all
```

Select `claude` or `codex` instead of `all` when only one is needed. The apply
records a deployment audit; it does not launch a harness. Claude inheritance
stops at a Git boundary; Codex uses the existing per-invocation home override.
See [native trust](harness-trust.md) for qualification, format and recovery
limits. A launch configuration that sets its own `CLAUDE_CONFIG_DIR` or
`CODEX_HOME` is one more file, and the same command covers it. Spawn and
`oats readiness` warn when the file a launch reads does not establish trust.

## 3. Give the deployment a team

With a messaging capability in the soul's composition, every instance lives in
a team, and readiness fails with `E_TEAM_UNCONFIGURED` until there is a
default. Create the team with your messaging provider (its own docs say how;
for `oats.aweb`, see its skills), then commit it in `oats-workspace.yaml` as a
**shared** team and the workspace's default:

```yaml
teams:
  research: { team: "<provider team id>" }
defaultTeam: research
```

```bash
oats teams                                           # shared and local teams, the default, the workspace's souls:
```

Which other teams each soul may join is committed there too, in `souls:`
([workspaces.md](workspaces.md#teams)). A team only this deployment uses is a
**local** team (`oats teams add research --team <provider team id>`; the first
one becomes this deployment's default), which the workspace must allow with
`localTeams: true`. Without messaging, skip this step.

## 4. Look before you spawn

```bash
oats souls                    # every soul of every confirmed member, with origin and its teams here
oats capabilities             # member (origin: member <key> @ <commit>) and package (package <id> v<ver>) capabilities
oats workspace status         # membership table, locked packages
oats spawn backend-expert --preview   # modules[] with from/commit/changedSince, composed skill names, teams + default
```

The preview is where a skill-name clash between two composed capabilities
(`E_SKILL_DUPLICATE`) or a package missing from the lock (`E_PACKAGE_MISSING`)
shows up, before anything is created.

## 5. Give an instance a real task

```bash
oats spawn backend-expert --purpose first-fix --task "Fix one small issue, run the relevant checks, commit the code change, and report what changed."
oats status
```

`--harness pi|claude|codex` picks the harness; complete any native
authentication prompt in the printed session (folder trust is the one-time step
in section 2). The instance home is
`agents/<soul>/instances/<instance>/`; `work/` is its repository view;
`.oats/modules/<cap>/` are the copied capabilities and `.agents/skills/<skill>/` their skills;
`instance.json` records `modules` (from, commit, digest), `providers` and
`workspace`. A running instance never changes under itself; a stopped one can
be moved to the locked package versions with `oats instance upgrade`. Member
modules and the soul body still require a new spawn. `oats status` shows the
drift (`member moved since (now @ …)` / `capability no longer present`). See
[upgrading package modules](upgrading.md#moving-existing-homes-to-locked-package-versions).

Instance-specific provider values belong to the spawn:
`oats spawn <soul> --provider <cap> key=value` (repeatable; dotted keys nest),
recorded under `instance.json.providers.<cap>`.

## 6. Judge and retire

Review the instance's code through the repository's ordinary PR workflow. Then:

```bash
oats retire backend-expert-first-fix
oats status
```

Read the retirement result rather than assuming local cleanup proves release;
knowledge and messaging capabilities (packages such as `oats.okf`, `oats.aweb`)
add their own retire hooks and receipts — see [knowledge.md](knowledge.md) and
[capabilities.md](capabilities.md) once you add them to `packages:` and to the
soul's `capabilities:`.

## The standalone case

If you can read a member repository but not its workspace host (a public member
of a privately hosted workspace), point `oats-local.yaml` at the
member: `oats sync` and `oats spawn` then give the **standalone view** — the
repo's own souls with their `from: here` capabilities plus `oats.core`, marked
`standalone: true` in `sync --json` and `instance.json.workspace.standalone`.
A repository with no `oats-membership.yaml` is not a member and gets no such
view (`E_WORKSPACE_SCHEMA`); a network failure reading the host is
`E_REMOTE_UNREADABLE`, never a silent standalone.
