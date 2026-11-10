---
name: oats-getting-started
description: >-
  The way into OATS (Open Agent Team Specification) for a person who has only
  a coding agent. Asks about their project, installs OATS, OATS Desktop and
  the messaging CLI, creates the workspace's messaging account and team (with
  no sign-in, or on the person's own account if they sign in), writes a new
  workspace's skeleton (or joins this machine to an existing workspace),
  spawns the workspace's setup expert, which does the rest, and opens the
  Desktop on it. Offers the TUI.
  Use for "get started with OATS", "set up / install / adopt OATS", "set up
  OATS for this project", "join our OATS workspace", or when someone gives
  you this file or its URL. Download this file whole (`curl -fsSL
  https://raw.githubusercontent.com/oats-project/oats/main/skills/oats-getting-started/SKILL.md`)
  and follow it as written: a summary of it is not the procedure.
---

**Read this whole file, never a summary of it.** If you only have a summary
(a web fetch that summarises, say), download it whole with
`curl -fsSL https://raw.githubusercontent.com/oats-project/oats/main/skills/oats-getting-started/SKILL.md`
and follow it as written.

# Getting started with OATS

You are the person's own coding agent. This skill takes them from nothing to
a running **setup expert**: an OATS agent of their workspace that does the
rest of the setup with them (their repositories, their own coordination
and knowledge capabilities, a tracker they already use, their first
agents). You ask, install,
write a few files and spawn it. Then you are done.

A **workspace** is one Git repository declaring which repositories belong to
an organisation and which packages it trusts. A **soul** is a durable agent
role defined in Git; an **instance** is a soul at work, in its own home and
terminal. A new workspace's setup expert is `oats.framework`'s soul
`oats-setup-expert` (capabilities `oats.setup` and `oats.onboarding`, and
`oats.coordination-setup` from oats.framework 1.23.0),
spawned as `<workspace>-oats-setup-expert`.

**A machine found-list** is a JSON file in your prompt whose
`machine.platform` is set (oats-omarchy's installer writes one). The
workspace you make is then this machine's own, its setup soul is the
machine's steward, `oats.machine/steward`, in place of the setup expert, and
the steward gets a global aweb address; steps 1, 5, 7, 8 and 9 say what
changes. When the found-list lists a deployment whose `steward` is `true`,
tell the person this machine already has its workspace and steward, and
stop. Wherever a later step says to ask the
person, on a machine found-list you tell them what happened, as it is, and
stop instead: the person answers nothing after step 1.
Step 1's machine round is always asked, even when the prompt that started
you says to ask for nothing more (an installer's "beyond starting this, ask
no other yes"). Its one yes, naming the changes, is the consent your
harness's permission check reads; without it, the check refuses each change
on its own (the repository, the aweb signup, the folder trust), and each
costs the person a round. After that yes, nothing more is asked.

**How to work.**
- **Ask first, then run.** Ask everything in one round (step 1), then run the
  steps yourself and read back what each did. Touch nothing you were not
  asked to (see "Never").
- **The time budget.** The whole setup should take a few minutes, and only
  seconds of the person's time: their answers, a login to approve, a secret
  to type. Don't wait more than about a minute for the Desktop's background
  download once the CLI is installed: if it hasn't verified by then, go on
  without the Desktop and record that in the hand-over (the person can
  install it later with the setup expert, through `/oats-upgrade`).
- **Talk to a newcomer, in everyday words.** They may not know what a
  repository, Git, a terminal or a command is. Talk about their projects,
  code and folders: "your agents' shared setup" (the workspace), "the setup
  assistant" (the setup expert), "the group your agents talk in" (the team),
  "the folder where your agents live" (`D`), and GitHub as "where your code
  is kept online, so your agents and your colleagues can reach it". Unless
  they ask or use the word first, don't say repository, workspace file,
  soul, instance, root, harness, readiness, deployment, capability, CLI or
  token, and don't show a file path, a command, an error code or raw output,
  except the name the Desktop shows for the setup expert, which they click.
  When a command fails, say in one sentence what it means and what you do
  next. Keep a check's output and exit status for yourself
  (`2>&1; echo "exit=$?"`), and don't show an expected failure as an error.
  Before a step that takes over half a minute, say what it does and about
  how long it takes.
- **One yes covers the changes to their computer.** Step 1's message lists
  them in plain words, and their yes covers every one: don't ask again step
  by step. The list, from step 2's checks: the tools you install (on Linux
  per user, under `~/.local`; on macOS with Homebrew), the line that puts
  them on their PATH in their shell's startup file (`~/.local/bin` on Linux;
  on macOS, Homebrew's `brew shellenv` line, only when Homebrew is new), the
  aweb channel plugin in Claude (Claude only) or pi's aweb extension,
  without its skills (pi only), the folder where their agents
  live (`D`, spelled out) marked as trusted by their coding agent, OATS
  Desktop with its app-launcher entry, each system package step 2 found
  missing, with what it is for, Git told to use their GitHub login (`gh auth
  setup-git`, in `~/.gitconfig`), on Linux npm's per-user folder (in
  `~/.npmrc`), and, for a new workspace whose host step 6 creates, the
  private repository `<owner>/<repo>` on GitHub, or, when the host is an
  existing repository (a monorepo), the two setup files committed and
  pushed straight to `<owner>/<repo>`'s default branch, which runs its
  automatic checks or deploys if it has any (or a pull request, step 7).
  Name each change by what and where, not by kind: a permission check that
  reads the conversation lets a step through only when their yes named it.
  Run each change on the list as its own command, never batched with other
  changes, so that check sees it by the name their yes gave it (a fenced
  block below that makes one change on the list counts as one).
  Never run `sudo` for something that was not on that list, even where no
  password is asked; if they say no to a system package, tell them what will
  not work without it.
- **When your harness's permission check stops a step on the list** and
  asks the person to approve, tell them it is one of the changes they said
  yes to. If it refuses the step outright, never run it another way
  (another shell, a script, a window you open), and never split it into
  pieces or re-run its parts, `sudo` included: ask the person once, naming
  the change, whether you may make it, and try again once on their yes.
  Still refused: tell them in one sentence which change is missing and what
  won't work without it, and go on where you can. Never ask them to type a
  command with `!`.
- **Secrets.** The person types only what you must never hold: passwords,
  tokens and logins, by a browser device flow you start (GitHub, step 3; the
  messaging login, step 5, only for the team on their own aweb account) or
  by the exact command in their own terminal, which you open for them (a
  `sudo` or Homebrew password, an aweb invite token; below). Never ask for a
  secret in the conversation or write one to a file ("Never").
- **Your shell may keep nothing between commands** (many harnesses start
  each command in a new shell, in the same starting folder). Run each fenced
  block below as one command, and write in literally any value an earlier
  one found (`V`, `ARCH`, a path, the team id `T`).
- **Sandboxes.** If your harness sandboxes commands, these steps need network
  access and writes in the home folder: ask the person to approve them.
  Starting the Desktop and opening a terminal also run outside the sandbox.
- **Their own terminal, opened by you.** Write the command to a file
  (`mktemp`; it holds no secret) after a first line
  `export PATH="<node dir>:<oats dir>:<harness dir>:$HOME/.local/bin:$PATH"`,
  with the folders `command -v node`, `command -v oats` and `command -v
  <harness>` print written in (a window may load no shell startup file), and
  a last line `printf '\nDone: close this window.\n'; read -r _`. Then open
  a window that runs it, with `F` the file's path written in:
  - **macOS:** `osascript -e 'tell application "Terminal" to do script "sh F"'`.
    The first time, macOS may ask the person to let you control Terminal.
  - **Linux:** `systemd-run --user --collect --quiet -p KillMode=process -E DISPLAY -E WAYLAND_DISPLAY -E XAUTHORITY xdg-terminal-exec sh "F"`,
    or `x-terminal-emulator -e sh "F"` in place of `xdg-terminal-exec` where
    only that exists. Through `systemd-run` the window gets their desktop
    session's environment, not yours. If `systemd-run` fails (for example
    "Failed to connect to bus", when there is no user session bus), start
    the terminal directly, detached, before you give them a command to type:
    `setsid -f xdg-terminal-exec sh "F" </dev/null >/dev/null 2>&1`, or
    `setsid -f x-terminal-emulator -e sh "F" </dev/null >/dev/null 2>&1`.
    It uses the `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY` and
    `XDG_RUNTIME_DIR` your environment already has; when they are unset,
    don't guess them: take "When no window opens".

  Tell them what to type there, and ask whether the window opened (a
  command that started is no proof of one). Check the result with a
  read-only command, never by reading the window, then delete the file.
  When no window opens: for a secret, a login or a `sudo` or Homebrew
  password, give them the command to run in a terminal of their own, the
  one time a person types a command; otherwise tell them what did not
  happen, and leave it to the setup expert.

## 1. Ask, in one round

On a machine found-list, ask the machine's round below instead of this list.

**First, step 2's checks.** They only read, so run them before the message
(not its installs): the changes to their computer that the message lists
are what they found missing. On Linux x64 they include the Desktop's system
libraries: a missing one goes on the list as a system package, dropped if
they decline the Desktop, so the Desktop's install needs no second yes.

**No GitHub account.** Their agents' shared setup and their projects live
on GitHub. When gh is not logged in, ask in the same message whether they
have a GitHub account. Without one, they make one, free, in their browser
at step 3, and nothing else changes: gh goes on the list of changes like
any missing tool, and you install it.

**The message.** Ask three things, and in the same message propose
everything else as defaults they accept with "ok" or change:
1. What they want their agents to help with (the use case), and where their
   notes and documentation live today, if anywhere (a docs repository, a
   wiki, Notion, Confluence).
2. Which projects the agents should work on: the folders on this computer,
   or where the code is kept online. Work out the rest yourself (where
   each is cloned, whether it's private: `git -C <dir> remote -v`,
   `gh repo view <owner>/<repo> --json visibility`); ask only what you
   can't find.
3. Whether they're starting fresh, or joining agents that someone on their
   team already set up (then the reference that person gives them).

Then the defaults, one plain line each: the workspace name, where its two
files live (the host, in plain words: "kept with your notes-app code on
GitHub", or "in a new private space on your GitHub, `<workspace>-oats`"),
the messaging account, the folder where their agents live, OATS Desktop
installed and opened, the name on their commits (only when Git has none),
where their agents keep track of work (tasks, below), and the changes to
their computer ("How to work"). Don't ask for the GitHub
owner (below), or for the coding agent the setup expert runs on: it is you,
when you are `claude`, `codex` or `pi`. When an answer changes a default (a
name, a host, a fresh start or a join), derive every default again and show
the final values in one short message before you go on. The rules:

- **A new workspace, or an existing one?**
  - Existing: its repository reference, for example
    `git:github.com/acme/acme-oats`, from whoever runs that workspace. Until
    step 8, take its name from the reference's repository name without a
    trailing `-oats` (`acme`), for the folder `D` only. Step 8 gives its real
    name, which `A` and the setup expert's name use.
  - New: the **workspace name**: lowercase letters and digits, words joined
    by single `-` (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), for example `acme`. Refuse
    `agents`: OATS keeps instance homes in a folder of that name. Default:
    their project's name (its repository's, or its folder's), normalised as
    in the machine's round, with repeated `-` collapsed and a leading or
    trailing `-` dropped (`My_App_` gives `my-app`); with no project, ask
    for a name.
- **New workspace: the host,** the one repository that holds the
  workspace's files:
  - **One repository (a monorepo):** that repository, the files at its root;
    its owner and name come from its remote.
  - **Several repositories:** a dedicated host repository, private, created
    in step 6 and named `<workspace>-oats`. Its owner is the one their
    repositories share, when they share one; otherwise their GitHub login.
  - **No repositories yet:** their first one, created in step 6, named
    `<workspace>`, under their GitHub login.

  The GitHub login is `gh api user --jq .login`: now, if gh is logged in,
  else after step 3; until then the line says "your GitHub account". If any
  repository of theirs is private, the host is private: the workspace file
  names every member.
- **Messaging between agents:** which messaging capability, or none. The
  default, and the one this skill sets up, is aweb (`oats.aweb`): agents
  that can mail each other can coordinate. For
  another, leave messaging out here: the setup expert adds it. A new
  workspace with aweb gets an aweb account of its own, which step 9 creates
  with no sign-in:
  - the messaging account's name `N`: the part of every agent's address
    before the `/`, in the same form as the workspace name, default
    `<workspace>-oats`. The root's name `A` is `<workspace>-root`.
  - Tell them they attach themselves to that account later in the setup, with
    the setup expert. Only if they want the team on their own aweb account
    now, they sign in to it in their browser in step 5 instead.
- **The harness for the setup expert:** `claude`, `codex` or `pi`. Default:
  the one you are, if it is one of these.
- **The deployment directory `D`:** where OATS lives on this machine.
  Default: `<home>/Agents/<workspace>`; any folder but their home folder
  itself works (`oats onboard` lists it in `~/.oats/config/deployments.json`,
  where the Desktop and the TUI find it). Write `D` everywhere as an absolute
  path, with the home folder spelled out: never `~`, which the shell does not
  expand inside quotes.
- **OATS Desktop:** installed and started unless they decline. Offer the TUI
  (`oats tui`, a terminal client, preview) only if they ask for a terminal
  client or decline the Desktop.
- **The name on their commits:** whenever step 2's checks printed
  `NO_GIT_IDENTITY`, and only for a new workspace (step 7 commits only for
  one). Default: the name Git already has (`git config --global user.name`),
  when it has one; else their computer account's full name
  (`getent passwd "$(id -un)" | cut -d: -f5 | cut -d, -f1` on Linux, `id -F`
  on macOS); when that is empty or just their login name capitalised
  (`Ubuntu` for `ubuntu`), their GitHub profile name, found after step 3
  (`gh api user --jq '.name // .login'`), and the line says "your GitHub
  name". Step 7 uses it without asking again.
- **Tasks, a new workspace with aweb only:** where the agents track work.
  The default is aweb's task list (`oats.aweb-tasks`). It gives way only to
  a tracker the person already uses, which you find, never ask about. The
  first message can't know their projects yet, so its line says "aweb's
  task list, unless your projects already use a tracker"; once they have
  named them, look, and the final-values message (above) gives the result.
  A tracker is:
  - **GitHub issues:** a project's GitHub repository with an issue, open or
    closed, updated in the last 180 days and not opened by a bot:
    `gh issue list -R <owner>/<repo> --state all --limit 1 --json number --jq length --search "updated:>=<date 180 days ago> -author:app/renovate -author:app/dependabot"`
    prints `1`. Issues switched on but unused are no tracker, and so is a
    repository with issues switched off (the command says they are
    disabled). If gh isn't logged in yet, step 3 runs this check after its
    login.
  - **Jira, Linear or another tracker:** the person named it in their
    answers, or ticket keys are in the project's recent branch names or
    commit subjects (`git -C <dir> log -50 --format=%s`,
    `git -C <dir> branch -a --format='%(refname:short)'`): one prefix
    matching `[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*` with two different numbers,
    other than `UTF`, `SHA`, `ISO`, `RFC`, `CVE`, `ES`, `HTTP`, `TLS`,
    `PEP` and `GPT`.

  With a tracker, the agents keep using it: the line says so ("your agents
  use your GitHub issues; the setup assistant offers to connect them") and
  step 7 writes `tasks: none`; the setup expert offers to connect the
  tracker with the person later. Without one, the line says "aweb's task list, shared by your
  agents". Ask only when unsure, as the final-values message's one open
  line, prefilled with the answer you'd pick: ticket keys the person didn't
  name, a project kept somewhere other than GitHub (its issues can't be
  read), or a `gh issue list` that failed for another reason. An existing
  workspace or a machine found-list has no tasks line: its owner decided.

**The machine's round.** Read the found-list, then ask only these choices,
together, each with its default and one line on what it is. Enter, or
"yes", accepts every default. Nothing is asked after this round, and never
a key. Ask it even when your prompt says to ask nothing more (above). The
use case, repositories and knowledge tools are not asked: the steward takes
them up with the person later.
- **The workspace:** a new one, the machine's own. Its name defaults to the
  hostname, lowercased, with every character outside `[a-z0-9-]` turned
  into `-` (`Ada's-Laptop` gives `ada-s-laptop`). Its repository defaults to
  `<github.login>/<workspace>-oats`, private, a dedicated host. Or an
  existing workspace's reference.
- **The namespace `N`:** the part of every agent's address before the `/`,
  which other people's agents use to reach this machine's agents. Default:
  the hostname, normalised as above, so the namespace is the machine's own.
  Messaging is aweb, and the root's name `A` is `<workspace>-root`.
- **The steward's name:** lowercase letters and digits, words joined by
  single `-`. Default: `steward`. It gives `R`, the steward's instance name
  here and the name in its address, `N.aweb.ai/R`. `R` is the chosen name,
  or `<hostname>-<chosen name>` (the hostname normalised as above) when the
  person says `N` is a namespace another machine already uses, so that this
  machine never adopts the other machine's resident.
- **The deployment directory `D`:** default `<home>/Agents/<workspace>`,
  with the home folder spelled out.
- **OATS Desktop:** installed and started by default; the TUI not opened.
- **The harness:** the found-list's `harness`. Ask only when it names none,
  with the one you are as the default.
- **The name on its commits:** as in the list above, when Git has none.
- **The changes to this computer:** the list in "How to work", from step 2's
  checks, as one line; "yes" covers it.

**This machine's name** (an existing workspace only, below) is its short
hostname (`hostname -s`, never the full domain name), normalised as in the
machine's round: `ada-s-laptop`. When that is a name many machines share
(`localhost`, `ubuntu`, `debian`, `fedora`, `raspberrypi`, or a model name
such as `macbook-pro`), add `-` and the first eight characters of a keyed
hash of the machine's id: `ubuntu-7d41e0c9`. Never the id itself: the whole
team sees this name, and the id is confidential (machine-id(5)). Linux:

```bash
printf 'oats-machine-name:%s' "$(cat /etc/machine-id)" | sha256sum | cut -c1-8
```

macOS:

```bash
printf 'oats-machine-name:%s' "$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/{print $4}')" | shasum -a 256 | cut -c1-8
```

## 2. Check, and install what is missing

You ran this step's checks (the commands that only read) before step 1's
message. Install now what they found missing, as step 1's yes allows.
`sudo -n true` is not one of those checks: it runs after the yes, right
before the first line that needs `sudo`.

```bash
uname -sm; node --version; git --version; tmux -V; gh --version; npm prefix -g; { git config --global user.name && git config --global user.email; } >/dev/null || echo NO_GIT_IDENTITY
```

On Linux x64, also check the Desktop's system libraries, ALSA and FUSE 2
(what a missing one means is under "The Desktop's system libraries", below):

```bash
for l in libasound.so.2 libfuse.so.2; do PATH="$PATH:/sbin:/usr/sbin" ldconfig -p | grep -q "$l" || echo "MISSING $l"; done
```

- **Versions:** Node 22.5 or later; Git 2.45 or later recommended (partial
  caches; older Git works with whole-tree fetches); `gh` 2.49 or later
  (step 3 uses `gh attestation`).
- **The harness** they chose must be installed and logged in (`claude
  --version`, `codex --version` or `pi --version`).
- **macOS:** with Homebrew (`brew --version`), `brew install node git tmux gh`.
  - **Without Homebrew,** it asks for their password, so it installs in
    their own Terminal, which you open for them ("How to work"), with the
    command under “Install Homebrew” on <https://brew.sh>. Then add its
    `brew shellenv` line to their `~/.zprofile` yourself, as its “Next
    steps” say, and start each later command of yours with
    `eval "$(/opt/homebrew/bin/brew shellenv)"` (`/usr/local/bin/brew` on
    Intel): your running process does not see their new PATH.
- **Linux:**
  - **Packages:** the distribution's, for git and tmux.
  - **gh:** from GitHub's own apt or rpm repository
    (<https://github.com/cli/cli/blob/trunk/docs/install_linux.md>), not the
    distribution's, which is too old.
  - **Node 22:** distributions ship older ones (Debian 13 has 20, Ubuntu
    24.04 has 18). On Debian and Ubuntu, x64 or arm64, from NodeSource:

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
    ```
  - **Git 2.45 (recommended):** Debian 13's is new enough. Ubuntu 24.04
    ships 2.43; on Ubuntu, x64 or arm64, from the git-core PPA:

    ```bash
    sudo add-apt-repository -y ppa:git-core/ppa && sudo apt-get update && sudo apt-get install -y git
    ```
  - **The Desktop's system libraries** (x64), from the check above, run
    before step 1's message:
    - **ALSA missing:** the Desktop needs it, so step 1's list names its
      package, to install with the other system packages: `libasound2t64`
      on Ubuntu 24.04 and Debian 13, `libasound2` before them, `alsa-lib` on
      Fedora.
    - **FUSE 2 missing:** install nothing. Step 10 starts the AppImage with
      `--appimage-extract-and-run`, which needs no FUSE.
  - **Passwords:** a line that needs `sudo` runs only after their yes in
    step 1, and goes to their own terminal unless `sudo -n true` succeeds.
- **Then check again** with `node --version` and `git --version`. Node still
  under 22 (another distribution, or where that route does not apply): stop,
  tell the person the minimum and the version found, and go no further until
  they have installed it. Git under 2.45 is no stop: tell them it works with
  whole-tree fetches, and go on.
- **npm's global folder** must be writable for step 4's installs
  (`test -w "$(npm prefix -g)/lib"`). If it is not (a system Node under
  `/usr`, as NodeSource installs it), make the two changes step 1's list
  named for it (when Node will come from NodeSource, the list names the
  per-user folder and its PATH line), each as its own command, never
  joined into one:
  - **npm's per-user folder** (in `~/.npmrc`):

    ```bash
    npm config set prefix ~/.local
    ```
  - **The line that puts it on their PATH** in their shell's startup file:
    `~/.zshrc` when `$SHELL` ends in `zsh`, else `~/.bashrc` (for fish,
    `fish -c 'fish_add_path ~/.local/bin'` instead), so their own terminal
    finds `oats` too. Tell them which file.

    ```bash
    RC="$HOME/.bashrc"; case "$SHELL" in *zsh) RC="$HOME/.zshrc";; esac; grep -qsF '$HOME/.local/bin' "$RC" || printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC"; echo "$RC"
    ```

  Your own shell doesn't read their startup file, so start each later
  command of yours with `export PATH="$HOME/.local/bin:$PATH"`.
- **Windows** is not supported.

## 3. Log in to GitHub

Always run this check, even when step 2 just installed gh (an existing gh
config or `GH_TOKEN` may already log it in), and start the device login
below only if it says gh is not logged in.

```bash
gh auth status
```

If it is logged in, let Git use it (without this, step 6's push and step 8
fail with "could not read Username"), then go on below:

```bash
gh auth setup-git
```

**When they have no GitHub account** (step 1), open GitHub's sign-up page
in their browser first: `open https://github.com/signup` on macOS,
`xdg-open https://github.com/signup` on Linux, or give them the URL if that
fails. Tell them it is free, and that they choose a username, an email and a
password there, in their browser, never in this conversation; GitHub emails
them a code to confirm the address. Wait until they say the account is
made, then start the login below.

If not logged in, start the login yourself, detached and without a terminal (your
harness's background mode if it has one); gh prints a one-time code and a
URL instead of opening a browser, and waits:

```bash
nohup gh auth login --web --hostname github.com --git-protocol https --skip-ssh-key </dev/null >"$HOME/.oats-gh-login.txt" 2>&1 &
```

In a separate command, a few seconds later, read the code and the URL:

```bash
cat "$HOME/.oats-gh-login.txt"
```

- **Give the person the code, and open the URL** in their browser
  (`open https://github.com/login/device` on macOS, `xdg-open …` on Linux;
  give them the URL if that fails). They enter the code (not a secret) and
  approve. It expires after about 15 minutes; then start again.
- **Once they say they approved,** check the login and let Git use it:

```bash
gh auth status && gh auth setup-git && rm -f "$HOME/.oats-gh-login.txt"
```

The token stays in gh's store and never reaches you. Now run step 1's
GitHub-issues check if it waited for this login; a tracker it finds changes
the tasks line, so tell the person in one sentence. If the check fails for
another reason (access refused, say), ask now in one line, prefilled with
their GitHub issues (`tasks: none`): never aweb's task list beside a
tracker you couldn't rule out. That is all the Git
setup this needs: an SSH key, commit signing and the DCO sign-off are the
setup expert's `/oats-git-setup`, when Git access is broken or the person
wants them.

**Then find the OATS version `V`,** and on macOS `ARCH`; step 4 installs the
CLI and the Desktop of this one version:

```bash
npm view @awebai/oats version
sysctl -n hw.optional.arm64 2>/dev/null   # macOS: 1 means ARCH=arm64, otherwise ARCH=x64
```

**Then start the Desktop's download, in the background,** unless they
declined the Desktop or this machine has none (Linux arm64, step 4); it runs
while step 4 installs the CLI. With `V` written in, and `F` the release
file: `oats-desktop-V-linux-x86_64.AppImage` on Linux x64,
`oats-desktop-V-mac-ARCH.zip` on macOS (where `shasum -a 256 -c -` replaces
`sha256sum -c -`). It prints `VERIFIED` only when the download, the
checksum and the release's attestation all pass:

```bash
W="$(mktemp -d)" && echo "$W" && { nohup sh -c 'cd "$1" && gh release download "vV" -R oats-project/oats -p "F" -p SHA256SUMS.txt && L=$(grep " F\$" SHA256SUMS.txt) && printf "%s\n" "$L" | sha256sum -c - && { gh attestation verify "F" --repo oats-project/oats --signer-workflow oats-project/oats/.github/workflows/release.yml --source-ref refs/tags/vV || case vV in v0.[0-9].*|v0.[1-5][0-9].*|v0.6[0-8].*|v0.69.[0-9]|v0.69.1[0-2]) gh attestation verify "F" --owner awebai --signer-workflow awebai/oats/.github/workflows/release.yml --source-ref refs/tags/vV;; *) false;; esac; } && echo VERIFIED; echo DONE' sh "$W" </dev/null >"$W.log" 2>&1 & }
```

The attestation has two forms because the repository moved:
- **Releases after 0.69.12** are attested in `oats-project/oats`.
- **Releases up to 0.69.12** were signed in `awebai/oats`, and their
  attestations stayed with the `awebai` organisation. The `case` tries this
  second form only for those versions.

Each form accepts only its own repository's release workflow, run for the
tag `vV`. On an older release the log shows the first form's `HTTP 404`
before the second passes; that is not a failure. The checksum counts only
when `SHA256SUMS.txt` has a line for `F`, because on macOS `sha256sum` passes
empty or malformed input; the attestation checks the file itself.

Write the folder it prints in as `<W>` in step 4.

## 4. Install OATS Desktop, the CLI and the messaging CLI

The CLI and the Desktop are both of version `V` (step 3). **First the CLI,
and for pi its bridge,** while the Desktop's download runs:

```bash
npm install -g "@awebai/oats@V" && oats version
pi install "npm:@awebai/oats-pi@V"      # only when the harness is pi
```

**A new workspace needs `oats.framework` 1.19.0 or later** (its setup
expert attaches the person to the workspace's messaging account). Read the
installed CLI's catalog:

```bash
node -e 'const c=require(process.argv[1]);console.log(c.packages["oats.framework"].ref,c.packages["oats.aweb"].ref)' "$(oats root)/package-catalog.json"
```

It prints the two refs, for example `oats-framework/v1.23.0 v1.37.0`. If the
framework's version (after the `/`) is below `1.19.0`, or with aweb
`oats.aweb`'s is below `v1.33.1`, this OATS release is older than this
skill: stop, and tell the person to wait for the next OATS
release. Never write a setup soul into the workspace in its place.

**With aweb, the messaging CLI `aw`, and the harness's aweb channel,** which
wakes an agent when mail arrives (skip this without messaging): Claude
`claude plugin marketplace add awebai/claude-plugins && claude plugin install aweb-channel@awebai-marketplace`;
pi `pi install npm:@awebai/pi`, then its entry in pi's `settings.json` set
to load none of the skills it bundles (pi's extension is installed without
its skills, so it puts none on the computer; each agent gets its own);
Codex nothing (the setup expert sets up its wake). Claude's aweb channel
plugin still carries one skill of its own, until aweb ships it without
(a known gap). The pi entry, which matches `npm:@awebai/pi` alone or with
`@` and a version, never another `@awebai/pi-…` package, and prints it so
you can check `"skills":[]`:

```bash
node -e 'const fs=require("fs"),path=require("path"),os=require("os");const f=path.join(process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),".pi","agent"),"settings.json");const s=JSON.parse(fs.readFileSync(f,"utf8"));const ours=(e)=>/^npm:@awebai\/pi(@|$)/.test(typeof e==="string"?e:e&&e.source||"");s.packages=(s.packages||[]).map((e)=>ours(e)?{...(typeof e==="object"?e:{}),source:typeof e==="string"?e:e.source,skills:[]}:e);fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n");console.log(JSON.stringify(s.packages.filter(ours)))'
```

```bash
npm install -g @awebai/aw && aw version
```

`aw` must be 1.36.33 or later.

**Then the Desktop. Every step verifies before it installs.** Wait for step
3's download, then read its log. Run this once: it waits up to a minute
for a `DONE` line ("How to work", the time budget):

```bash
for i in $(seq 60); do grep -qx DONE "<W>.log" && break; sleep 1; done; tail -n 5 "<W>.log"
```

Install the Desktop only when the log has a `VERIFIED` line. If a download or
a check failed (its assets can lag the npm package), or it still has not
finished, go on without the Desktop, say so, and record it in the
hand-over: the person can install it later with the setup expert, through
`/oats-upgrade`. Never skip a check to
make it install, and never install or open this download before its
attestation has passed. A Desktop installed before this run stays as it is.

**macOS.** In one block, with `V` and `ARCH` written in. `/Applications`
needs an administrator; for a standard user, use `$HOME/Applications`
(`mkdir -p "$HOME/Applications"`) in its place in every line below:

```bash
grep -qx VERIFIED "<W>.log" && cd "<W>" &&
ditto -x -k "oats-desktop-V-mac-ARCH.zip" . &&
codesign --verify --deep --strict "OATS Desktop.app" &&
defaults read "$PWD/OATS Desktop.app/Contents/Info" CFBundleIdentifier &&
defaults read "$PWD/OATS Desktop.app/Contents/Info" CFBundleShortVersionString
```

- **Expected:** `ai.oats.desktop` and `V`, with `codesign --verify` passing
  (the app is ad-hoc signed and not notarized).
- **Download with `gh`, never through a browser,** which would quarantine
  it; `gh`'s copy starts from Finder.
- **Install it.** If the Desktop is running, tell the person and quit it;
  its agents keep running:
  `osascript -e 'quit app "OATS Desktop"'; for i in $(seq 20); do pgrep -xq "OATS Desktop" || break; sleep 1; done`.
  Then:

  ```bash
  grep -qx VERIFIED "<W>.log" && test -d "<W>/OATS Desktop.app" && cd "<W>" && rm -rf "/Applications/OATS Desktop.app" && ditto "OATS Desktop.app" "/Applications/OATS Desktop.app" && defaults read "/Applications/OATS Desktop.app/Contents/Info" CFBundleShortVersionString
  xattr -p com.apple.quarantine "/Applications/OATS Desktop.app" 2>/dev/null && echo QUARANTINED
  ```

- **If it prints `QUARANTINED`,** tell the person. Remove the attribute only
  if they agree (`xattr -dr com.apple.quarantine "/Applications/OATS
  Desktop.app"`): never silently.

**Linux x64.** It needs glibc 2.34 or later (`ldd --version`), installs per
user, without sudo, and shows in the app launcher. If the Desktop is
running, tell the person and quit it first; its agents keep running:
`pkill -o -u "$(id -u)" -x oats-desktop; for i in $(seq 20); do pgrep -u "$(id -u)" -x oats-desktop >/dev/null || break; sleep 1; done; pgrep -u "$(id -u)" -x oats-desktop >/dev/null && echo STILL_RUNNING`
(the oldest process is the Desktop's main one). On `STILL_RUNNING`, ask the
person to quit it.

```bash
grep -qx VERIFIED "<W>.log" && cd "<W>" &&
mkdir -p ~/.local/opt/oats-desktop ~/.local/share/applications &&
install -m 755 "oats-desktop-V-linux-x86_64.AppImage" ~/.local/opt/oats-desktop/OATS-Desktop.AppImage
```

Then write `~/.local/share/applications/oats-desktop.desktop`, with `<home>`
their home directory's absolute path:

```text
[Desktop Entry]
Type=Application
Name=OATS Desktop
Exec=<home>/.local/opt/oats-desktop/OATS-Desktop.AppImage %U
Terminal=false
Categories=Development;
```

- **Without FUSE 2** (step 2 printed `MISSING libfuse.so.2`; Ubuntu 22.04
  and later ship without it), or when step 10's start fails with a FUSE
  message, add ` --appimage-extract-and-run` after the AppImage's path in
  `Exec=` and in step 10's start.
- **Linux arm64** (`uname -m` says `aarch64`) has no Desktop and no
  download: say so and go on.

**Don't start the Desktop yet;** step 10 starts it on the new deployment.

## 5. Optional: the team on your own aweb account

**Only for a new workspace with aweb whose person chose, in step 1, the team
on their own aweb account now.** Otherwise skip it: step 9 creates the
workspace's account (the default), joins an existing workspace and signs up a machine
found-list.

The workspace's agents share one team, its **default team**, which the
person's own aweb account creates here. Say to them, in your words, exactly
three things:
- you are creating a team for the workspace, owned by your aweb account;
- you sign in as yourself, in your own browser;
- every agent you spawn joins this default team. More teams are an explicit
  later choice.

Don't say that the agents are attributed or bound to them: the team is owned
by their account, and tying each agent to them is a later step the setup
expert offers.

**The workspace key `K`** is exactly `github.com/<owner>/<repo>`, the host's
owner and name from step 1 (`github.com/acme/acme-oats`): a different
spelling makes a different team.

**Sign in.** First check whether this machine's `aw` is signed in already:

```bash
aw auth status --json
```

With `"status": "authorized"` and an `account`, go on to the team. Otherwise
start the login yourself, detached, as with GitHub; aw prints a URL and a
one-time code, and waits:

```bash
nohup aw auth login </dev/null >"$HOME/.oats-aw-login.txt" 2>&1 &
```

A few seconds later, in a separate command:

```bash
cat "$HOME/.oats-aw-login.txt"
```

Open the URL in their browser and give them the code (not a secret). They
sign in, or create their aweb account there, and approve; the token stays in
aw's store. Once they say they approved:

```bash
aw auth status --json && rm -f "$HOME/.oats-aw-login.txt"
```

`account.id` is the account `ACCOUNT`; `account.handle` is its name, to tell
the person.

**Create the team, with its root in `D/.aw`.** On a first run `D/.aw` must
not exist: if it does and this skill did not make it, stop and ask the
person what it is. With `D`, `K`, the workspace name and `ACCOUNT` written in:

```bash
mkdir -p "D" && test ! -e "D/.aw" && cd "D" && aw --identity-home "D/.aw" team ensure --workspace-key "K" --label "<workspace>" --expect-account "ACCOUNT" --json
```

- **Success** prints JSON whose `canonical_team_id` is the team id `T`
  (`<name>:<domain>`), which step 7 writes into the workspace. Never write
  its `team_id` (an internal id), and never guess `T`.
- **It installs the team's root** in `D/.aw`, which adds each agent the
  person spawns to the team, with no login. It holds keys: leave it alone.
- **A failure** prints one line on stderr and exits 2:
  `authorization-required` (the login is missing or expired): sign in again,
  then rerun; `identity-home-occupied` (`D/.aw` holds something else),
  `unsupported-server` or anything else: stop and tell the person what it
  printed.
- **After an interrupted run** (killed, timed out, or its answer lost),
  `D/.aw` exists and the first-run line stops at its check. Run the call
  without that check, with exactly the same `D`, `K`, workspace name and
  `ACCOUNT`: aw continues its own run, or answers `identity-home-occupied`
  for anything else. Never remove or edit `D/.aw`.

  ```bash
  cd "D" && aw --identity-home "D/.aw" team ensure --workspace-key "K" --label "<workspace>" --expect-account "ACCOUNT" --json
  ```

Tell the person the team exists, owned by their aweb account `<handle>`.

## 6. The host repository

**New workspace,** by step 1's case; `<repo>` is the host's name.
- **A dedicated host, or the first repository:** create it inside `D`,
  private unless every repository of theirs is public. `D/<repo>` must not
  exist yet: its files would end up in the first commit.

  ```bash
  mkdir -p "D" && cd "D" && test ! -e "<repo>" && gh repo create "<owner>/<repo>" --private --clone && ls -a "<repo>"
  ```
- **A monorepo:** clone it into `D`, where the setup expert's tools find it,
  or use the clone of it already at `D/<repo>`.

  ```bash
  mkdir -p "D" && cd "D" && test ! -e "<repo>" && gh repo clone "<owner>/<repo>" "<repo>" && git -C "<repo>" status --short --branch
  ```

  Its root must not hold `oats-workspace.yaml` or `oats-membership.yaml`
  yet: if it does, stop and ask the person.

The workspace reference `W` is then `git:github.com/<owner>/<repo>`
(`git:github.com/acme/acme-oats`).

**Existing workspace.** `W` is the reference they gave. Write nothing in its
repositories.

## 7. The skeleton

**New workspace.** Write two files at the root of `D/<repo>`, in one commit,
with the person's own workspace name, host and team id in place of the
example's (`acme`, hosted in `acme/acme-oats`, with aweb).

`oats-workspace.yaml`:

```yaml
schemaVersion: 2
name: acme
members:
  - git:github.com/acme/acme-oats     # the host; the setup expert adds the others
packages:
  oats.framework: v1.23.0             # the installed CLI's catalog versions (below)
  oats.aweb: v1.37.0                  # messaging: agent identities, mail and chat
  oats.machine: v0.1.1                # on a machine found-list only: the machine's steward
defaults:
  capabilities:
    oats.core: { from: package }
  messaging: { oats.aweb: { from: package } }
  tasks: { oats.aweb-tasks: { from: package } }   # or `tasks: none` (step 1)
teams:
  acme: { description: The acme workspace's team, team: "T" }
defaultTeam: acme                     # every soul starts in this team
```

- **The versions** are the ones step 4 printed: the framework's (after
  `oats-framework/`) and `oats.aweb`'s, that one never below `v1.33.1`.
- **The team** is `default:N.aweb.ai`, with `N` from step 1: the team step
  9's signup creates, checked there against this line. With step 5's
  sign-in, it is `T` from step 5 instead, written in literally. Its label
  (here `acme`) is the workspace name.
- **The `oats.machine` line,** at the catalog's
  `packages."oats.machine".ref`, only on a machine found-list.
- **The `tasks` line** is step 1's tasks answer: `oats.aweb-tasks` without
  a tracker, `tasks: none` with one. On a machine found-list, leave it out.
- **Without messaging,** leave out the `oats.aweb` line, the `messaging`
  line, the `tasks` line, `teams` and `defaultTeam`.
- **Add nothing else:** no soul (the setup expert is `oats.framework`'s), no
  knowledge; the setup expert authors those with the person.

`oats-membership.yaml`:

```yaml
schemaVersion: 2
workspace: git:github.com/acme/acme-oats
```

**Commit and push.**
- **A repository created in step 6:** straight to its default branch (it
  is the person's own, just created).
- **A monorepo:** push the commit to its default branch on step 1's yes,
  which named it, without asking again; show the person the files only if
  they ask. When others can push to the repository (`gh api
  repos/<owner>/<repo>/collaborators --jq length` prints more than 1, or
  fails), its default branch `<branch>` is protected (`gh api
  repos/<owner>/<repo>/branches/<branch> --jq .protected` prints `true`,
  `gh api repos/<owner>/<repo>/rules/branches/<branch> --jq length` prints
  more than 0, or either fails), or the push is refused: push a branch
  instead, open a pull request, tell them, and stop until it is merged.
- If `git config user.name` or `git config user.email` prints nothing in
  `D/<repo>`, commit with the name step 1's yes covered:
  `-c user.name="<their name>" -c user.email="<their noreply address>"`,
  the address from `gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"'`.

```bash
cd "D/<repo>" && git add oats-workspace.yaml oats-membership.yaml && git commit -m "OATS workspace acme: workspace and team" && git push -u origin HEAD
```

## 8. Onboard this machine

```bash
oats onboard D --workspace W --json
```

- **Effects:** it writes `D/oats-local.yaml` and `D/agents/`, reads every
  member over Git and locks the packages.
- **The host must be `confirmed`;** a host that can't be read is a GitHub
  access problem (step 3). Another member with `cannot-read` is an access
  question for the setup expert, not a reason to stop.
- **On Git under 2.45** (step 2; Ubuntu 24.04 ships 2.43), a warning
  that this Git can't keep a partial cache, so OATS fetches whole trees, is
  expected. A recent OATS prints it at most once per command that starts or
  rebuilds caches; an older one prints it once for each repository it
  starts a cache for. Either form is harmless. Don't show it to the person
  as an error, and don't try to fix it now: a Git of 2.45 or later,
  installed later, removes it, and caches already made with whole trees
  stay that way.
- **`E_ALREADY_ONBOARDED`:** `D` already is a deployment. Stop and ask the
  person whether to use it as it is or to choose another directory.

**The setup expert, `S`, and its spawn line.** `result.next.spawn` is the
line to spawn it with, and `S` is the soul it names. For a new workspace
that is `oats.framework`'s `oats-setup-expert` with
`--name <workspace>-oats-setup-expert`; for another name or no `--name`,
the text output of `oats onboard` says why.
- **An existing workspace's name** is its `--name` without the trailing
  `-oats-setup-expert` or `-oats-setup` (`acme`); with no `--name` there,
  keep step 1's.
- **On a machine found-list,** `S` is `oats.machine/steward`. An existing
  workspace that doesn't offer it: stop, and say that its owner adds
  `oats.machine` to its `packages:`.
- **An existing workspace with no setup soul** (`next.spawn` is `null`):
  stop, and say that its owner pins `oats.framework` 1.19.0 or later, whose
  `oats-setup-expert` attaches the person to the account. Once that is merged, run `oats sync --dir D` and
  look again.

**The clone.** `oats-setup-expert` needs none. A soul with `work: worktree`
needs a clone of its repository at `D/<repo name>`: for an existing
workspace whose setup soul is its own, run the `git clone` line
`oats onboard` printed for it, if it says it is missing.

**Record the harness for every soul** on this machine: a package soul names
none, and without this every later check (readiness, harness trust) and
every spawn would use the default, pi, for `S` and for each soul the setup
expert or the steward spawns later. `'*'` is every soul without an entry of
its own, `S` among them, and souls added later that name no harness of
their own:

```bash
oats soul launch set '*' --harness <harness> --dir D --plan
oats soul launch set '*' --harness <harness> --dir D
```

`'*'` wins over a soul's own `launch:` on this machine. So read
`oats souls --dir D --json` first, in a new workspace too (a package soul
may name its harness). For each row whose `launch.declared.harness`
differs from `<harness>` and whose declared harness is installed and
logged in here (`claude --version`, `codex --version` or `pi --version`,
as in step 2), give that soul its own entry with its declared harness, so
it keeps its choice. A declared harness that isn't installed here stays
under `'*'`, so the soul can run; name it in the hand-over ("For the
person, later"). Use the row's `key` (`<package>/<soul>`
for a package's soul, so the name is never ambiguous), add
`--model <its model>` only when `launch.declared.model` names one, and plan
first:

```bash
oats soul launch set <key> --harness <its harness> --model <its model> --dir D --plan
oats soul launch set <key> --harness <its harness> --model <its model> --dir D
```

Check a reviewer soul by its model too, since `'*'` replaces the model as
well as the harness: where it declares `<harness>` but another model, give
it its own entry the same way, with `--harness <its harness> --model <its
model>`. Then its `oats spawn <key> --preview --json --dir D` must show a
`launch.effective` model from a family other than the developers'. Where
its declared model can't run here, set one that can, from another family;
with none, name it in the hand-over ("For the person, later"): its reviews
share the developers' model.

`S` is the exception: it always keeps `<harness>`, the person's choice in
step 1. When `S` declares another harness, give it its own entry with
`<harness>` instead:

```bash
oats soul launch set S --harness <harness> --dir D --plan
oats soul launch set S --harness <harness> --dir D
```

## 9. Messaging on this machine

Read `oats inspect --soul S --dir D --json`. Its `result.layers.messaging.id`
names the soul's messaging capability; with `null` (none), skip this step.
Otherwise the setup expert can't spawn here until that capability is set
up; its readiness names what is missing:

```bash
oats readiness --soul S --dir D --json
```

The messaging items must not report a problem. aweb, the default, is set up
below; for another capability, follow its own setup skill, and stop if its
readiness still reports a problem.

**With aweb (`oats.aweb`):**
1. **Check:**

   ```bash
   cd "D" && oats aweb setup --soul S --check-only --json
   ```

   Its `aw.status` must be `ok` (`aw` missing: install it and the harness's
   channel as in step 4, then check again; anything else: stop and tell the
   person why). Its `defaultTeam.label` is `L`, the setup expert's team.
   - **A new workspace that signed in at step 5** expects `"member": true`
     here: step 5 installed the root. Then this step is done.
     Every other new workspace (the default, and a machine found-list)
     has no root yet, so its `"member": false` here is expected: go on to
     item 2.
   - **`"member": false` after step 5's sign-in:** stop, spawn nothing, and
     tell the person which fix applies. With
     `"root": null`, there is no root in `D/.aw`: step 5's team creation did
     not finish there, so run its line for an interrupted run, then check
     again. With a `root`, that root is not a member of `defaultTeam.team`:
     the team id step 7 wrote must be step 5's `canonical_team_id` exactly,
     so correct it in `oats-workspace.yaml`, commit and push it, run
     `oats sync --dir D`, then check again.
2. **A new workspace without step 5's sign-in, and a machine found-list:
   sign up the workspace's aweb account and team,** with `N` and `A` from
   step 1: no API key or token, nothing for the person to type. Preview
   first, then run it:

   ```bash
   cd "D" && oats aweb setup --soul S --username N --name A --label L --plan --json
   cd "D" && oats aweb setup --soul S --username N --name A --label L --json
   ```

   - **The answer:** `result.team` must be
     the team line step 7 wrote, `default:N.aweb.ai`, and
     `result.membershipVerified` must be `true`. Otherwise stop, spawn
     nothing, and tell the person what it shows.
   - **Then tell the person,** in your words: this is the workspace's
     team, on an aweb account created for it; they attach themselves to it
     later in the setup, with the setup expert.
   - **`E_SETUP_NATIVE`:** most likely `N` is taken (the preview does not
     contact aweb, and aw's output is withheld); the run may also have left
     a root part-way. Never remove `D/.aw`, and never rerun blindly.
     On a machine found-list, ask nothing: tell the person that the run
     failed, most likely because `N` is taken, and stop.
     Otherwise look first, read-only: `test -e "D/.aw" && echo RETAINED`.
     - **Nothing printed:** aw kept nothing, so `N` is free to change. Ask
       the person for another `N`, change the team line in
       `D/<repo>/oats-workspace.yaml` to `default:<new N>.aweb.ai`, commit
       and push it, run `oats sync --dir D`, then run the preview and the
       signup again with the new `N`.
     - **`RETAINED`:** the run left a root. Keep `N` and the team line, and
       run the preview again, unchanged. When its `result.team` is
       `default:N.aweb.ai`, the account exists: run the signup again,
       unchanged, and it reuses that root. Anything else, the preview
       failing included: stop, spawn nothing, and tell the person what it
       shows.
3. **Existing workspace: the person gets an invite** from a member of `L`,
   whose own agent runs
   `oats aweb invite --soul <their soul> --label L --json` in their
   deployment. The answer's `result.token` is the invite token,
   passed to the person privately, never by ordinary mail. **The token is
   all they pass** when this machine has oats.aweb 1.36.0 or later (the
   `version` of the `oats.aweb` row in the `oats inspect` answer's
   `result.capabilities`, above) and aw 1.36.53 or later (`aw.version` in
   item 1's check): the join reads the team and the service from the
   invite itself. Otherwise the member passes the service URL `U` too:
   from oats.aweb 1.33.1 the answer's `result.awebUrl`, no secret. When it
   is `null` or absent, leave `--service U` out of item 4's labelled form:
   the join then takes the service from the invite, or fails and item 5
   stops. This machine's messaging root is
   `A` = `<workspace>-<this machine's name>` (step 1), with the workspace's
   name from step 8: don't ask. Only a hosted team works: if the invite is
   refused, or the join says the team is not hosted, stop; the workspace's
   owner decides.
4. **Existing workspace: the person joins in their own terminal,** which you
   open for them ("How to work"), pasting the token at the hidden prompt,
   with `D`, `S` and `A` filled in:

   ```text
   cd "D" && sh -c 'stty -echo; printf "Invite token: "; read -r T; stty echo; echo; printf "%s\n" "$T" | oats aweb setup --soul S --invite-stdin --name A'
   ```

   Before redeeming anything, it refuses an invite it can't use here: one
   expired, used up or revoked, one for a team this workspace doesn't name
   (unless the workspace allows local teams and this machine's own
   `oats-local.yaml` sets its default team), one whose team's label is
   already another team here, one for a global identity, or one for a team
   this machine is already in. The person sees why in the window, and
   item 5 stops. In that exception, an invite for a team the workspace
   doesn't name is redeemed instead: this machine joins that team under a
   label of its own, and item 5 catches it. With an older
   oats.aweb or aw (item 3), open the labelled form instead, with `L` and
   `U` filled in too:

   ```text
   cd "D" && sh -c 'stty -echo; printf "Invite token: "; read -r T; stty echo; echo; printf "%s\n" "$T" | oats aweb setup --soul S --join L --invite-stdin --name A --service U'
   ```

5. **After items 2 to 4, check again** (item 1), and expect `"member": true`.
   On `"member": false`, stop and spawn nothing. With `"root": null` after
   item 4's invite-only form, look first, read-only:
   `ls -d "D"/.aweb-roots/*/.aw 2>/dev/null`. Nothing printed: the join
   refused before redeeming anything: ask the person for the `E_SETUP_`
   code their window shows (a code, no secret), tell them in plain words
   what it means, and that a new invite is the inviter's to send. A path
   printed for a label other than `L`: the invite was for that team, and
   this machine joined it instead: tell them so, and that an invite for
   `L` is the inviter's to send. Otherwise tell the person the run
   left this machine's root outside `L`, with what the check shows, and
   don't rerun the signup or the join (you can't see the join's output).
   When another machine of the same name may already be in the team, say
   that a taken name is a likely cause: the person who invited them can ask
   their own agent whether that name is in the group (its agent reads
   `oats aweb roster --label L`); the fix (a new invite and a name for this
   machine) is the workspace owner's. Never take the other machine's name.
The setup expert does the rest of this machine's messaging
(`/oats-host-delivery`).

**The steward's global address (machine found-list only).** The team root
you just signed up makes the steward a global, contacts-only aweb address,
`<namespace>/R` (`R` from step 1, for the resident and the instance alike),
with no API key and nothing for the person to type. Without messaging, skip
this. It needs all of these; when one fails, take the fallback below:
- a new workspace: a root that joined by invite (items 3 and 4) does not own
  the namespace, so aweb would refuse the create;
- an `oats.aweb` release that carries the root route
  ([awebai/oats-aweb#147](https://github.com/awebai/oats-aweb/pull/147)).
  None is released yet: until one is, take the fallback below, whatever
  `oats.aweb` version the `oats inspect` you read above reports;
- aw 1.36.48 or later: `aw.version` in the check (item 1).

Plan, then create, both from `D` and with no `AWEB_API_KEY`:

```bash
cd "D" && env -u AWEB_API_KEY oats aweb resident create R --team-label L --plan --json
cd "D" && env -u AWEB_API_KEY oats aweb resident create R --team-label L --json
```

- **The plan** changes nothing. Run the create only when the plan's `ok` is
  true and either `result.init.route` is `root` (a new resident) or
  `result.init` is `null` (`R` already holds it; the create adopts it and
  never makes a second one). Anything else, a refusal included (no team
  root, say), is the fallback.
- **`--team-label L`** puts the resident in the team that is already the
  default, so the run prints the spawn line as its one step
  (`result.steps`). If it prints another step first, stop and tell the
  person what it says: that step is theirs.
- **Success** prints `PASS resident <address> …`; `result.address` is the
  steward's address. Spawn with the grant-seat options below.
- **A failure:** report it to the person as it is, and spawn nothing. If
  the create was interrupted (killed, or timed out with no answer), run the
  same line again, unchanged, and nothing else. Never empty
  `D/.aweb-residents/R`: the identity may already exist.
- **The fallback:** spawn the steward without the grant-seat options, with
  a local team identity, as every instance has. Tell the person in one line,
  without asking anything: the steward has a local team identity and no
  global address because of <the reason>, and the GLOBAL residents and grant
  seats section of `/oats-aweb` moves it to one later. Never ask for a key.

## 10. Spawn the setup expert, then show it

**Write the hand-over** to `D/.oats-handover.md`. It holds no secret.

```markdown
# Onboarding hand-over from the getting-started skill

- Workspace: <workspace> (W), new | existing; deployment directory: D
- Host: <owner>/<repo>, a monorepo | a dedicated host | the first repository
- Setup expert: S, instance <name>, harness <harness> (this machine's
  harness for every soul without its own)
- Machine found-list only: steward R, address N.aweb.ai/R | local team
  identity (<the fallback's reason>)

## The person's answers
<step 1's answers, in their words: use case, repositories and where they
are cloned, knowledge tools, messaging wanted or not>

## Done by the getting-started skill
- Installed: OATS <V> (oats version), OATS Desktop <V> | not installed (why)
- GitHub: gh logged in over https as <login>; no SSH key or signing set up
- New workspace only: host <owner>/<repo>, skeleton committed (pushed |
  merged from <url>)
- Messaging: <capability>, aw <version>, <harness> channel installed;
  team T on aweb account N, created for the workspace, not yet attached to
  the person (new workspace), or T owned by aweb account <handle>
  (signed in at step 5), or new account N signed up (machine found-list),
  or joined L by invite (existing) | not set up (the setup expert has no
  messaging)
- Harness channel mode: development, confirmed by OATS at each start
  (Claude with aweb) | none (Codex, pi or no messaging)
- Tasks (new workspace with aweb): oats.aweb-tasks | none: the agents use
  <GitHub issues in <repo> | <tracker the person named> | ticket keys
  <PREFIX>-n>, for you to connect with the person; aweb's task list stays
  empty
- For the person, later: <what they may want to know but the hand-off
  message leaves out, such as a version, a skipped step and why>

## Left to you
Everything else, starting with /oats-setup-expert.
```

**Claude and Codex only: trust the deployment directory first,** so the first
start doesn't stop at the folder-trust question (`codex` for Codex):

```bash
oats harness trust --dir D --harness claude --plan
oats harness trust --dir D --harness claude
```

- **If the trust command itself refuses a file** (on macOS,
  `~/.claude.json` can carry a mark the writer refuses), don't edit the file
  or its attributes. Open their own terminal ("How to work") running
  `cd "D" && claude` (or `codex`), and tell them to answer yes when it asks
  whether to trust the folder where their agents live, then close the
  window. A refusal by your harness's permission check is "How to work"'s
  case instead.
- **Then check** that the `harness-trust` item of
  `oats readiness --soul S --dir D --json` passes.

**The channel mode.** With Claude and aweb, leave the default development
channel mode (Claude asks at each start whether to load the aweb channel,
and OATS confirms it), and don't set `delivery: session`; the setup expert
later offers the approved route, which needs `sudo`. Tell the person once,
before the spawn: a notice about a "development channel" may flash past when
the setup expert starts; OATS answers it, and the setup expert can remove it
later.

**An existing workspace names the setup expert after this machine,** since
every member's machine has its own in the same team, and two of one name
can't share it: put
`-<this machine's name>` (step 1) before `-oats-setup-expert` in
`next.spawn`'s `--name`, giving
`--name <workspace>-<this machine's name>-oats-setup-expert`. Over 64
characters, cut characters from the end of this machine's name until it fits
(then any `-` left last), so a rerun derives the same name and finds its own setup expert
(`E_INSTANCE_NAME_TAKEN`, below). A renamed machine gets a new setup expert;
its agent retires the old one. When `next.spawn` has no `--name` (a very
long workspace name), before spawning, look in `oats status --dir D --json` for a setup
expert of `S` already here, and open that one instead of spawning a second.
A new workspace keeps `next.spawn` as it is.

**Preview the spawn, read it, then spawn,** with step 8's `next.spawn` line
and the hand-over:

```bash
<next.spawn> --task-file D/.oats-handover.md --preview
<next.spawn> --task-file D/.oats-handover.md
```

For example, `oats spawn oats-setup-expert --dir D --name acme-oats-setup-expert --task-file D/.oats-handover.md`.

**On a machine found-list,** name the steward `R`. With its global address:

```bash
oats spawn S --dir D --task-file D/.oats-handover.md --name R --provider oats.aweb identity.mode=global --provider oats.aweb identity.resident=R --preview
oats spawn S --dir D --task-file D/.oats-handover.md --name R --provider oats.aweb identity.mode=global --provider oats.aweb identity.resident=R
```

In the fallback, or without messaging, leave out both `--provider` options.

- **The preview** shows what the spawn would create. If it reports a
  problem, stop and tell the person what it says.
- **The spawn** prints the instance's home `H` and its name. Then delete the
  hand-over file (the home has it as `TASK.md`).
- **A messaging name already held by another machine's agent** (the spawn
  names the conflict): spawn nothing more and rename nothing; tell the
  person another machine in the team uses this name, and the workspace
  owner decides the fix.
- **`E_SPAWN_INCOMPLETE`:** don't spawn again. Run `oats session inspect
  --home H --json` and tell the person what it shows.
- **`E_INSTANCE_NAME_TAKEN`** (the preview or the spawn): the setup expert
  already exists; don't spawn another. Its home `H` is in the error; if it
  is stopped, start it with `oats session start --home H`. Either way, open
  it in the Desktop below.

**The Desktop**, if installed, opens on the new deployment with the setup
expert selected. `I` is its instance name: the `--name` you spawned with
(after `E_INSTANCE_NAME_TAKEN`, that same `--name`), else the one the spawn
printed. Always pass `--instance`: a Desktop that does not know it ignores
it.
- **macOS:**

  ```bash
  open -n -a "OATS Desktop" --args --dir "D" --instance "I"
  ```

  A Desktop already running takes `--dir` and `--instance` from it.
- **Linux:** start it through their session manager, so it gets their
  desktop session's environment, not yours (with your harness's variables
  and sandbox, which it would pass to every agent):

  ```bash
  U="oats-desktop-$(date +%s)"; LOG="$(mktemp)"; systemd-run --user --collect --quiet --unit "$U" -p KillMode=process -p StandardOutput="file:$LOG" -p StandardError="file:$LOG" -E DISPLAY -E WAYLAND_DISPLAY -E XAUTHORITY "$HOME/.local/opt/oats-desktop/OATS-Desktop.AppImage" --dir "D" --instance "I" && for i in $(seq 30); do pgrep -u "$(id -u)" -x oats-desktop >/dev/null && break; sleep 1; done; sleep 3; if pgrep -u "$(id -u)" -x oats-desktop >/dev/null; then echo STARTED; else echo FAILED; tail -n 20 "$LOG"; fi
  ```

  - **`STARTED`:** it shows `D`, with `I` selected.
  - **A FUSE message:** see step 4, then start it again.
  - **Anything else,** or no `systemd-run`: tell the person what it printed;
    they open **OATS Desktop** from their app launcher, which lists `D` in
    its switcher.

**The TUI:** open their own terminal ("How to work") running
`oats tui --dir "D"` when they asked for it in step 1, or have no Desktop
and say yes to it in the hand-over below.

**Hand over to the setup expert,** in a short message in plain words:
- what is ready: their agents' shared setup, kept on GitHub, the group their
  agents talk in, and the setup assistant running; on a machine found-list,
  the steward, and its address when it has one;
- **where to go now:** "Switch to the OATS Desktop window. Click
  **<I's display form>** under Instances on the left, if it isn't
  selected: it has already started and will ask you its first question
  there. You can close this chat." `I`'s display form is how the Desktop
  lists it: `-` turned into spaces, the first letter capitalised
  (`acme-oats-setup-expert` shows as "Acme oats setup expert"). Without the
  Desktop, offer to open a terminal window where they can talk to it (the
  TUI, above), and say the same about it there. When neither opens, tell
  them the setup assistant is running, and the OATS Desktop, once
  installed, shows it;
- what the setup assistant does next, in one line: it learns how they work,
  then sets up their projects and their first agents with them, and it
  opens a small hidden prompt when they need to type a password or a key;
- a new workspace with aweb only, where their agents track work, in one
  line, with how to change it: "Your agents share aweb's task list; to use
  another tracker later, ask the setup assistant to switch." With a
  tracker: "Your agents use your <GitHub issues | tracker>; the setup
  assistant offers to connect them. Leave aweb's task list empty: one task there
  opts your whole group in to it. To use aweb's task list instead, ask the
  setup assistant."

Keep this message in plain words. Don't list homes, paths or commands, and
name no versions (Git's, OATS's or any other), no package sources (a PPA,
say) and no internal flags or codes (a "development-channel flag", a
"channel-not-connected", say). When you name the setup expert as the
Desktop lists it, use its display form, never its instance name. Anything they may want to know later goes in the hand-over file, for
the setup expert, not in this message. You are done.

## Never

- **Run `aw team ensure` when joining an existing workspace.** It is only
  step 5's, for a new workspace. On a join it doesn't find the teammate's
  team: it makes a new team of the person's own for the same repository,
  silently. A join goes through step 9's invite.
- **Ask for, read, print or store a secret,** or suggest Claude Code's
  `! <command>` for one: its command and output enter your context. If the
  person pastes one anyway, don't repeat it, and tell them to rotate it.
- **Overwrite or re-onboard** a deployment, edit an existing deployment's
  files (`oats-local.yaml`, `oats-lock.json`, `agents/`), touch `D/.aw`, or
  push to a repository other than the new workspace's host they agreed to in
  step 1 (step 6 creates or clones it).
- **Guess the team id:** it is the signup's `default:N.aweb.ai`, checked in
  step 9, or step 5's answer after its sign-in.
- **Write a setup soul into the workspace:** the setup expert is
  `oats.framework`'s.
- **The Desktop:** never download it through a browser, skip a verification
  step, strip quarantine without asking, or start it with an emptied
  environment (`env -i`: it loses HOME, and Git the person's login).
- **Put an absolute path or a credential** in `oats-workspace.yaml`,
  `oats-membership.yaml` or a soul (the team id is not a secret).
- **Spawn** before `oats onboard` confirmed the host.
