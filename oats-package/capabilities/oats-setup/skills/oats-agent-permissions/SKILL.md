---
name: oats-agent-permissions
description: >-
  Use when setting up or checking Claude Code's permissions for the OATS
  instances on a machine: which settings layer to write (the user settings of
  the Claude config a launch uses, never the home's `.claude/settings.json`),
  auto mode (`permissions.defaultMode`, `--permission-mode auto` in a launch
  configuration, the `autoMode` block), the narrow allow rules for the
  `oats` and `gh` reads, `oats spawn` and reading `aw` mail and chat (git
  is left to Claude's read-only set and the classifier), what stays gated, and
  the check that a spawned instance meets no permission prompt. Also for an
  instance that keeps showing `waitingOnYou` with reason `permission`.
  Claude only; says what applies to Codex and pi. Part of the setup and
  config of an OATS workspace (oats.setup); day-to-day operation inside an
  instance is oats.core.
---

# Claude Code permissions for OATS instances

An OATS instance runs unattended in its own pane. Each permission prompt
stops it until a person answers, and status shows it as `waitingOnYou` with
reason `permission`. Set Claude up on each machine so that instances run the
common OATS, aweb, git and gh acts without a prompt. Destructive and
outward acts stay gated. You make the change; the person approves it.

The facts below are Claude Code's (its settings, permissions,
permission-modes and auto-mode-config docs). Check `claude --version`: some
need a recent Claude Code, and the docs name the version.

## 1. Which layer you write

| Layer | Who writes it | For OATS |
|---|---|---|
| Managed settings (root-owned file, MDM, server-managed) | a human admin | The only layer that can forbid something on every session (`permissions.deny`, `permissions.disableAutoMode`). Name it to the admin; never write it. |
| **User settings: `settings.json` in the Claude config the launch uses** | **you, approved by the person** | **This skill's layer:** `permissions.defaultMode`, `allow`, `ask`, `deny` and the `autoMode` block |
| A launch configuration's `args` | you (`oats launch-config set`) | Optional: `--permission-mode auto` for the launches of one configuration only |
| The home's `.claude/settings.json` | oats.core, at every start | Never: it is capability-managed, and Claude ignores `defaultMode: "auto"` and `autoMode` in project files |
| The home's `.claude/settings.local.json` | Claude's "don't ask again" | Per instance, gone at respawn: not a setup layer |
| `--settings` | none | Not used: Claude honours only the last `--settings` on a command line, so OATS capabilities avoid it |

**Which Claude config a launch uses.** It is the `CLAUDE_CONFIG_DIR` in the
`env` of the Claude launch configuration (`oats launch-config list --json`
shows it is set; the value is in `launch-configs` of `oats-local.yaml`).
Without one, it is the person's own `~/.claude`. Then the person chooses:
- **Their own config (simpler):** these rules also apply to the Claude
  sessions they start themselves.
- **A config for the agents only:** a launch configuration with its own
  `CLAUDE_CONFIG_DIR` (`/oats-workspace-config`). The person logs in there
  once (`CLAUDE_CONFIG_DIR=<dir> claude`, then `/login`, in their own
  terminal). Harness trust (`oats harness trust`) and the channel plugin
  (`/oats-host-delivery`, Choice 1) then target that directory too.
  Recommend this when the person also uses Claude for their own work.

## 2. Auto mode

**What it does.** Each action goes through a fixed order:
1. Deny, then ask, then allow rules settle what they match.
2. Reads, and edits in the working directory, are approved.
3. A classifier reviews everything else, and blocks what is destructive,
   irreversible or aimed outside the trusted environment.

After 3 blocks in a row, or 20 in a session, auto mode pauses and Claude
prompts. In an OATS pane that shows as `waitingOnYou`.

**How to choose it.** Either:
- `"permissions": {"defaultMode": "auto"}` in that user settings file, for
  every launch on that config; or
- `--permission-mode auto` in one launch configuration's `args`.

From Claude Code 2.1.283, auto is already the starting mode of interactive
sessions where it is available. Setting it makes the choice explicit. When
auto mode isn't available (`disableAutoMode` in any settings file, the
model, the account), the session starts in Manual mode, and the check in
section 6 shows it.

**The first start.** A fresh config can show auto-mode notices or a
question. OATS treats an unknown screen at start as blocked
(`"$(oats root)/docs/configuration.md"`, the hidden-notice limit). So the
person starts `claude` once with that config in their own terminal, in
`D`, answers what it shows, and exits. In the same session they ask it to
read a file outside `D` (for example the first lines of that docs page).
Auto mode asks once before the first read outside the working directories,
and instances read the deployment and the kernel's docs all the time. They
answer **Yes, and keep allowing**, which Claude records. Never the answer
that blocks such reads (`blockReadsOutsideWorkingDirectories`). Never
write a setting that records the person's consent for them.

**Tell the classifier what the workspace trusts.** By default it trusts
only the working repository and its remotes. Add these entries in the
same user settings file. Prose, with `"$defaults"` kept first:

```json
{
  "autoMode": {
    "environment": [
      "$defaults",
      "Source control: github.com/<owner> and its repositories, the OATS workspace's members",
      "Trusted internal domains: <the aweb service host>, the agents' messaging service"
    ],
    "allow": [
      "$defaults",
      "OATS coordination: in an OATS instance, writing a task file in the agent's own instance home and running `oats spawn --task-file` with it, and mailing other instances with `aw`, is normal multi-agent work",
      "OATS checkpoints: in an OATS instance, adding or removing a wake job bound to the agent's own instance home with `oats schedule add` or `oats schedule remove` is normal multi-agent work"
    ]
  }
}
```

Without the `allow` entry, the classifier can read a task file written for
another instance as an attempt to instruct it, and block writing it, or
block mail to another instance. An array
without `"$defaults"` replaces Claude's built-in list: keep it.

## 3. Allow rules: narrow, for acts that stay inside OATS

An allow rule settles a command **before** the classifier, so the classifier
never sees it. Allow only what is safe without that review, whatever flags
the agent adds. Claude already suspends broad rules such as `Bash(*)` in auto
mode.

```json
{
  "permissions": {
    "allow": [
      "Bash(oats status *)", "Bash(oats souls *)", "Bash(oats capabilities *)",
      "Bash(oats workspace status *)", "Bash(oats inspect *)", "Bash(oats readiness *)",
      "Bash(oats doctor *)", "Bash(oats instance events *)", "Bash(oats instance git *)",
      "Bash(oats session inspect *)", "Bash(oats schedule show *)",
      "Bash(oats schedule host status *)", "Bash(oats launch-config list *)",
      "Bash(oats launch-config preview *)", "Bash(oats okf index *)", "Bash(oats okf cat *)",
      "Bash(oats okf search *)", "Bash(oats okf ls *)", "Bash(oats okf links *)",
      "Bash(oats okf bases *)", "Bash(oats okf status *)",
      "Bash(oats instance attention *)", "Bash(oats worktree *)",
      "Bash(oats spawn *)",
      "Bash(oats retire * --plan)", "Bash(oats retire * --plan *)",
      "Bash(oats instance stop * --plan)", "Bash(oats instance stop * --plan *)",
      "Bash(aw mail inbox *)", "Bash(aw mail show *)", "Bash(aw mail ack *)",
      "Bash(aw chat pending *)", "Bash(aw chat history *)",
      "Bash(aw whoami *)", "Bash(aw workspace status *)",
      "Bash(gh pr view *)", "Bash(gh pr list *)", "Bash(gh pr checks *)", "Bash(gh pr diff *)",
      "Bash(gh issue view *)", "Bash(gh issue list *)", "Bash(gh run view *)", "Bash(gh run list *)"
    ],
    "ask": [
      "Bash(aw *--server-name*)",
      "Bash(oats spawn *--yolo*)",
      "Bash(oats spawn *--server*)",
      "Bash(oats spawn *--wake-*)"
    ]
  }
}
```

- `oats spawn` is allowed: it is the core of multi-agent work, and the
  kernel previews and refuses on its own. Its `ask` rules, which win over
  `allow`, keep a person on the three flags that reach further:
  `--yolo` (a child with no permission checks), `--server` (another
  machine) and `--wake-*` (a host wake schedule). A launch configuration
  with `yolo: true` is the person's own choice, made in `oats-local.yaml`.
- A wake job on an instance's own home is its checkpoint while it waits on a
  child: a routine act of the instance, not an operator act. `oats schedule
  show` and `oats schedule host status` only read. Adding or removing the job
  goes to the classifier, which the `autoMode` entry above tells that this is
  normal, because a rule can't see which home a job file names.
- `oats retire` and `oats instance stop` are allowed with `--plan` only,
  which reads. Applying them ends someone's work: a stop ends a live
  session and stops its children, and a retire removes a home whose
  knowledge may not be proposed yet. They go to the classifier.
- `aw`: reading mail and chat is allowed. Sending (`aw mail send`, `reply`,
  `aw chat send-and-wait` and the rest) goes to the classifier: a send can
  attach any file and reach an address outside the team. The `autoMode`
  allow entry above tells the classifier that mailing other instances is
  normal. An `ask` rule keeps a person on `--server-name`, which points `aw`
  at another server.
- **No `git` rules.** Claude's built-in read-only set already runs
  `git status`, `diff`, `log` and `show` without a prompt, and it checks
  their flags. An allow rule would skip that check: `git diff --output=<file>`
  writes, `git fetch --upload-pack=<cmd>` and `git rebase --exec <cmd>` run
  commands, `git switch -c … --discard-changes` drops work and
  `git commit --no-verify` skips the sign-off hook. The classifier approves
  ordinary commits, branches, fetches and rebases in the working repository.
- `gh` rules name read forms only.
- A rule matches the command as written. `Bash(git push *)` doesn't match
  `git -C x push`. Each part of `cmd1 && cmd2` or `cmd1 | cmd2` must match
  on its own. These rules are not a security boundary.
- If the workspace adds its own commands (a test runner, a build), add
  narrow rules for them the same way, and only for forms that are safe with
  any flags.
- `autoMode.classifyAllShell: true` (in managed or user settings) suspends
  every Bash allow rule: then the classifier sees every command.

## 4. What stays gated

- **Left to the classifier (no allow rule):**
  - `git` beyond its read-only forms, `git push`, `gh pr create` and
    comments, and every `aw` send: auto mode allows ordinary
    pushes and pull requests to the working repository, and blocks force
    pushes, secrets in commits and pushes to deploy branches. An allow rule
    would skip those checks.
  - `oats retire` and `oats instance stop` without `--plan`.
  - The operator acts: `oats sync`, `oats onboard`, `oats aweb …`,
    `oats harness trust`, `oats launch-config set`, `oats teams …`,
    `oats schedule …` apart from its two reads and a wake job on the
    instance's own home, `oats trigger …`, `oats session input`. Installing
    the host's timer stays the operator's.
  - `aw` identity and team acts.
- **`ask`, always a prompt even in auto mode:** what the workspace says needs
  a person, for example `"ask": ["Bash(gh pr merge *)", "Bash(gh release *)"]`.
  Ask the person: some workspaces let agents merge.
- **`deny`:** none by default. For a boundary no session may cross, the admin
  puts `permissions.deny` in managed settings, where nothing overrides it.
- **Never** a blanket rule (`Bash(*)`, `Bash(oats *)`, `Bash(aw *)`,
  `Bash(git *)`): it would hide `oats aweb setup`, the identity acts and
  every destructive flag from the classifier.
  Never yolo (`--dangerously-skip-permissions`, `yolo: true`) outside an
  isolated container or VM.
- **Secrets:**
  - No rule and no `autoMode` entry holds a secret.
  - No allow rule covers a command that takes one (`oats aweb setup`,
    `gh auth`, an `aw` key).
  - The person types secrets by the briefing's route 2 or 3, never with
    `! <command>`.
  - A permission prompt is the person's to answer: never answer one for
    them, never work around a refusal.

## 5. Apply it

1. Read the current file. Show the person what you will add: the
   `permissions` entries, the `defaultMode` if they chose it, and the
   `autoMode` block, with every existing key kept.
2. On their yes, back the file up and merge. Write the additions to a file
   of your own first, with the person's chosen values. Give both paths
   absolute (`$HOME/.claude`, never a quoted `~`):

   ```bash
   F="<absolute config dir>/settings.json"; if [ -f "$F" ]; then [ -e "$F.before-oats" ] || cp "$F" "$F.before-oats" || exit 1; fi; node -e '
   const fs = require("fs"); const [f, p] = process.argv.slice(1);
   const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
   const add = JSON.parse(fs.readFileSync(p, "utf8"));
   for (const sec of ["permissions", "autoMode"]) for (const [k, v] of Object.entries(add[sec] || {})) {
     cur[sec] = cur[sec] || {}; const had = cur[sec][k];
     cur[sec][k] = !Array.isArray(v) ? v : Array.isArray(had) ? [...had, ...v.filter((x) => x !== "$defaults" && !had.includes(x))] : v;
   }
   fs.writeFileSync(f, JSON.stringify(cur, null, 2) + "\n");' "$F" "<absolute path of your additions file>"
   ```

   An existing `autoMode` list keeps its own choice about `"$defaults"`.
   A second run keeps the first backup.
3. Nothing allows this write, so the classifier judges it, and it treats a
   change to an agent's own permissions as self-modification. It clears
   that only when the person's message names the change. So their yes names
   the file and the rules being added. A prompt is theirs to answer.
4. Respawn or restart the instances that should get it. A session reads its
   settings when it starts.

## 6. The check

Read-only, first:

```bash
oats launch-config preview --soul S --json
oats readiness --soul S --json
```

- The preview's argv shows `--permission-mode auto` when a launch
  configuration sets it. A running instance's pane shows auto mode in its
  status line.
- `CLAUDE_CONFIG_DIR=<config dir> claude auto-mode config` prints the
  effective `autoMode` with your entries. Drop the variable for `~/.claude`.

Then the behaviour, with the first working soul (`/oats-onboarding`
card 8). Put these in its first task: `oats status`, `aw mail inbox`,
`git status`, and `gh pr list` when it works in a GitHub repository.
While it runs, `oats status --json` must never show `waitingOnYou` with `reason: "permission"` on its row: oats.core sets that on
every permission prompt. Card 8's mail exchange proves `aw`. A prompt that
does show names the command: add a narrow allow rule, an `autoMode`
entry, or keep it gated, with the person. No readiness item checks
permissions; this is the check.

## Codex and pi

- **Codex** has its own approval and sandbox settings, in `config.toml`
  under its `CODEX_HOME`. This skill's rules are Claude's only. The same
  principle holds there: no blanket bypass outside a container. OATS's yolo
  adds `--yolo` and home trust for Codex.
- **pi:** OATS adds no permission flag for pi, and nothing here applies.
