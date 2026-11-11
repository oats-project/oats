# @awebai/oats-desktop

The OATS desktop app — a VS Code-style Electron shell around the OATS control
panel, with a **real integrated terminal** (xterm.js + node-pty attaching
straight to the agents' tmux sessions).

Private package: NOT part of the published npm `files` set of the root
package; its dependencies (electron, node-pty, xterm) live here only.

## Run

```bash
cd packages/desktop
npm install          # postinstall bundles renderer/vendor/highlight.mjs (esbuild)
npm run rebuild      # rebuild node-pty against the Electron ABI (first install / electron upgrade)
npm start            # launches the app; connects to the backend server on 127.0.0.1:4820 or spawns the bundled one
```

Flags/env:
- `--dir <workspace>` / `OATS_DESKTOP_DIR` — the OATS workspace the panel shows
  (default: this repo's root).
- `--instance <name>` — beside `--dir`, the instance the window selects in the
  roster, opening its terminal when running while keyboard focus stays on the row
  ([docs/desktop.md](../../docs/desktop.md#opening-on-an-instance)).
- `OATS_DESKTOP_PORT` — backend server port (default 4820).

## Brand artwork

`assets/brand/oats-logo.png` is the one source of the app's brand artwork
(the human-supplied logo, SHA-256 `b1d21d9a…de69e`). Every derived icon —
the macOS `oats.icns`, the Linux `NxN.png` set and the 2x sidebar mark (the
OATS mark in the bar at the foot of the sidebar, drawn at 20px) — lives
in `assets/brand/generated/` and is regenerated from the source by one
command:

```bash
cd packages/desktop
npm run icons              # rewrite assets/brand/generated/ from the source
npm run icons -- --check   # verify the checked-in set derives from the source
```

`build-icons.mjs` is zero-dependency (square source, premultiplied-alpha
area averaging, transparency preserved); `test/brand-icons.test.mjs` fails if
any checked-in icon's pixels stop matching what the source derives.

## UX and architecture

The shell has three navigation contexts:

- **Workspace › Machines** (the Active overview, then the Deployments page,
  before 2026-10-26) — a tab of the Workspace page, before Setup (⌘1 / Ctrl+1): a
  fitted, zoomable tidy tree of running and idle instances with
  `parentInstance` spawn relationships, one tab per deployment. Agent boxes can
  be repositioned freely; edges follow live.
- **Instances** — the shell's single sidebar becomes a compact, recursively
  nested roster. Selecting a running instance opens its direct tmux-attach
  xterm terminal in the main area. Terminal tabs are scoped to this context.
- **Soul roster** (Workspace › Souls, where a window opens) — searchable soul cards with explicit **Spawn** and
  **View brain** actions. Brain and markdown artifacts are scoped to this
  context; the markdown reader is the flagship file surface.

- `main.mjs` — Electron main: server management (connect-or-spawn the bundled server),
  IPC `api` proxy, node-pty terminals (`tmux attach-session -t <target>`).
  Closing a terminal tab kills the pty ONLY — tmux sessions are the durable
  hosts and always survive.
- `server/oats-web.mjs` — the bundled zero-dependency backend: a loopback-only
  `node:http` server exposing the `/api/*` surface (roster, spawn, brain,
  session capture, keys, file). The deployment model is the installed kernel's
  JSON: `oats status --json` (roster) and `oats workspace status --json`
  (workspace header), read by `packages/client/deployment-observer.mjs` — the app reads
  no deployment file and never imports the framework kernel; lifecycle
  mutations require a compatible installed `oats` CLI. See
  [docs/desktop-deployment-model.md](docs/desktop-deployment-model.md); when
  the kernel is asked and what the server holds between asks is
  [docs/desktop-load-path.md](docs/desktop-load-path.md).
  Binds 127.0.0.1 only — it can type into your terminals. A server the app
  starts ends with the app, however main ends: its stdin is a pipe only main
  holds, and with `--exit-on-stdin-close` the server exits at its EOF
  (`server-host.mjs`, `serverSpawnSpec`). A server started by hand has no such
  tie. What the programs it
  starts receive is [below](#the-environment-of-the-programs-desktop-starts).
- `preload.cjs` — contextBridge surface (`window.oatsDesktop`); renderer runs
  with contextIsolation on, nodeIntegration off. Its one constant, `isOmarchy`,
  is a boolean read once from main's window argument `--oats-host-omarchy`
  (`host-theme.mjs` `OMARCHY_ARG`, `omarchyHost`); nothing sends it, and it
  picks only the font's and the terminal size's defaults (`renderer/theme.mjs`
  `initFont`).
- `host-theme.mjs` — the theme of the computer that runs Desktop, for the
  "This computer" theme choice: reads and follows Omarchy's `colors.toml`, else
  the system's light or dark appearance, and sends plain state to the windows.
  `omarchyHost` is the same marker as one yes or no (Linux, and Omarchy's
  `current/` is a directory; any error is no), read once by main for the
  windows' `isOmarchy`.
- `chord-family.mjs` — keys.json, the chord family both clients bind on
  Linux/Windows (Alt, the default, Ctrl+Alt or Ctrl+Shift; `packages/client/keys-file.mjs` says
  what its text means): reads it when a window asks and at app focus, writes it
  when the Shortcuts page asks (only `chords`, atomically: a temporary file in
  the same directory, then a rename), and sends plain state to every window
  (`chord-family:get`, `chord-family:set`, `chord-family:changed`). The kernel
  never reads the file. `renderer/chord-family.mjs` is its page side.
- `session-resume-launch.mjs` — lost sessions resumed: main holds one shared
  trigger per app launch (`packages/client/session-resume-trigger.mjs`, its
  probe the served CLI's through `settledCli`). It is launched after the
  startup's deployments-list step settles, and shown each accepted
  `/api/panel` reply's `instances` with the reply's local deployment ids
  (`localDeploymentIds`) in the `api` handler, under the same epoch and
  transition check as the workspaces update. The sweep's child is
  detached and file-backed (`packages/client/session-resume-cli.mjs`), so
  quitting never cancels it; nothing in `shutdown()` touches it. The Desktop
  shows nothing of a sweep: a `failed` reading is one log line with its code,
  and every other reading is dropped. No window hears of it
  ([When Desktop opens](../../docs/desktop-instance-start.md#when-desktop-opens)).
- `renderer/shell.mjs` — contextual single sidebar, stage host, artifact-tab
  host, command palette, recursive instance roster, and integrated terminals.
- `renderer/views/*.mjs` — feature views per the shared contract:
  `mount(el, ctx)` / `unmount()`, `ctx = { api, openFile, openTerminal }`.
  The shell adds feature-detected `openBrain` / `openView` affordances.
  `mount()` MAY return a disposer function; the host prefers it over the
  module-level `unmount()` (required for multi-mounted views such as markdown).
  `views/common.mjs` carries shared helpers and the workspace bus;
  `theme.css` carries the AA semantic tokens of the three built-in themes
  (White, Solarized, Dark); a fourth choice, This computer, shows the host's
  theme on a built-in base (renderer/README.md);
  `loading.mjs` / `loading.css` are the shared loading-state primitive
  (skeletons, refreshing, stale and failed; see renderer/README.md). Bare ESM deps
  (marked, dompurify, highlight.js) resolve through the importmap in
  `index.html`; highlight.js is bundled to `renderer/vendor/` by
  `build-vendor.mjs` (postinstall) because its `es/` entry is a
  dual-package CJS shim browsers cannot load.

### The shared home (`packages/client/`)

The modules that read the kernel's JSON are not in this package: the CLI
adapters (`cli-adapter.mjs`, `workspace-cli.mjs`, `deployment-read-cli.mjs`),
the warm reader's client (`warm-reader.mjs`), the contract decoders
(`*-contract.mjs`, `deployment-data.mjs`) and the liveness collector (run only
for a CLI without `status-liveness`). They are in `packages/client/`, beside this directory, so
that another client of the kernel can import the same readers. Main, the
backend and the page import them by a plain relative path (`../client/`,
`../../client/` from `server/` and `renderer/`, `../../../client/` from
`renderer/views/`). Nothing copies, builds or installs them.

Beside the readers it holds what a client decides from the kernel's rows
alone, with no document to draw in: the roster as a tree
(`instance-tree.mjs`), its sections by deployment (`roster-sections.mjs`),
which acts a row offers and why, and whether its terminal can be opened
(`instance-acts.mjs`), and whether a directory is a deployment
(`workspace-admission.mjs`).

It holds how an agent's terminal is opened with the kernel's own viewer,
`oats session attach` (`session-attach.mjs`): the viewer's arguments for this
machine and for another, whether its detach key can be used, and the
preflight that runs before a viewer on another machine, with the runner it
starts the CLI with (`terminal-exec.mjs`) and what a failed preflight says.
The word for the viewer's exit status is in `attach-exit.mjs`, which imports
nothing. The Desktop calls the preflight and the key of a remote target; its
own gate, PTY and reconnect rule stay in this package
([terminal-owner-leases.md](docs/terminal-owner-leases.md)). The rest is for a
client that starts the viewer itself. The lines of a kernel refusal's two
texts are `kernel-lines.mjs` `kernelLines`, which each client gives its terms.

It also holds what the backend serves as `/api/panel`, as functions the
backend calls: what one deployment's observation becomes
(`deployment-panel.mjs`: the rows, the liveness collector's input and
answers, the entry before a probe, after a failed read and when observed)
and the deployments and views over what a client holds (`panel-views.mjs`).
Those functions keep nothing. `server/oats-web.mjs` keeps the stores (the
snapshot, the remote roster's last answer, the remembered remote
identities), runs the kernel and the collector, and passes what it holds at
each call as one value, `held()`, with the time of the call: those
functions read no clock, and the same `held` gives the same answer. Nor
does what they call: `remotePanel` (`remote-roster.mjs`) takes the time its
panel is made at as a required argument and throws without one; the views
give it `held.at`.

And it holds the rules for other machines and for the list of workspaces, each a
function over what its caller holds:

- **What a roster answer becomes** (`remote-roster.mjs`). `remoteRosterState`
  takes the three roster values a client holds (the groups, whether an answer
  has arrived, the failure sentence), the outcome of one read of `oats server
  roster --json` (not made, an envelope, or what was thrown) and the time, and
  answers the three values again with `reported`, the groups to hand to the
  memory. A failed read keeps the groups held, marked not reached; the failure
  sentence is kept only while no answer has ever arrived. `remotePanelEntries`
  is each group's panel under its snapshot key. `server/oats-web.mjs` keeps
  the loop: one read at a time, and an answer read with a kernel record that
  is no longer the accepted one is dropped and read again. A caller also
  keeps its own `try`/`catch` around the read and around what it does with
  `reported`: if that step throws after it took the new state, it takes
  `{ thrown: <message> }` next, and the groups it just took are marked not
  reached.
- **What is remembered of a machine** (`remote-identity-memory.mjs`).
  `observeIdentities` takes the memory and the notes as two Maps, a roster
  answer's reported groups and the time, and answers new Maps; it changes
  none. It caps nothing: an answer drops every machine it no longer lists, so
  a client's memory is bounded by the roster answer. `identityMemory` gives
  the three readers the views take as `held.remembered`.
  `server/remote-identity.mjs` keeps the Maps between answers and the file
  (at most 256 groups, mode 0600, written atomically). A client that keeps
  nothing on disk starts with two empty Maps: a machine that answered once in
  its run and then stops is shown in its workspace as not reached, and one
  that never answered in that run is shown under its own name.
- **The words the list of workspaces shows** (`workspace-choices.mjs`).
  `workspaceChoiceRows` answers, for each view of `workspaceChoices`, its
  name, its one muted line, how many deployments are not live and the words
  for that, its tooltip and the deployment an unattached view opens;
  `choiceMatches` is the TUI switcher's filter (the Desktop's list has none).
  `renderer/workspace-switcher.mjs` draws the sidebar's list from the rows,
  one line each (the instance roster's circle, the name and the needs-input mark: it shows no muted line, no not-live
  mark and no section; its own `rowNames` tells twins apart by team and key,
  never by folder or machine), and keeps what is only its own: the needs-input
  words, the new-window hint and context menu, and the Add dialog (this
  computer's deployments to add, the stale rows to remove).
- **Moving in the list of workspaces** (`workspace-step.mjs`).
  `workspaceStep(rows, currentKey, step, { wrap })` is the leader's ↑ / ↓
  (`workspace-previous`, `workspace-next`): the key of the next row that can
  be opened in one direction. Both clients' moves pass `wrap`: it goes on
  from the other end, and answers the current key when no other row can be
  opened. Without `wrap` (the TUI list's own cursor) it is null at an end. Pure, imports
  nothing, so the page loads it. Each client draws its own rows and opens
  what it answers.
- **Who waits in a workspace** (the needs-input mark, the "!" disc). `workspaceChoices`
  carries `waiting` for each served view, rolled up from the instances the
  client holds (`waiting-on-you.mjs` `waitingClaim`, live deployments only):
  no read of its own. The list shows only served views, so nothing reads
  needs input for a deployment no window serves; unknown or stale is no mark.
- **This computer's deployments list** (`deployment-list.mjs`, #1390). The
  kernel keeps it (`oats deployments`); `readDeploymentList` reads the answer
  into rows of `{ path, name, state }` and refuses a document it cannot read
  whole, and the three writes' answers have their own readers.
  `deployment-list-cli.mjs` `cliDeploymentList` runs the four verbs (list,
  add, remove, import) with fixed argv, gated on the probe's `deployments-list`
  feature. Each client puts the four states into its own words; the Desktop's
  are in `renderer/workspace-switcher.mjs`
  ([desktop-deployment-model.md](docs/desktop-deployment-model.md#this-computers-deployments-list)).
- **The session resume sweep** (`session-resume-trigger.mjs`,
  `session-resume-cli.mjs`, `session-resume.mjs`). `createResumeTrigger` holds
  the clients' shared rule for when a sweep runs: once at launch, then on a
  roster read that shows a local lost session not yet settled, single flight,
  30 s apart.
  `runResumeSweep` runs `oats session resume --json` (feature
  `session-resume`, cwd `/`, instance variables scrubbed, no deadline) through
  `file-output-exec.mjs` `execFileToFiles`: execFile's signature, the child in
  a session of its own, its stdout and stderr unlinked files read back from
  the client's own descriptors, never signalled, so the change outlives the
  client. `readResumeSweep` reads the answer into one of four readings
  (`unsupported`, `busy`, `failed` with a code, `answered`), and
  `sweepSettlement` and `sweepCompleted` give the trigger the homes an answer
  settles and releases
  ([desktop-cli-api.md](../../docs/desktop-cli-api.md#how-the-clients-run-the-sweep)).

It holds the souls a deployment offers and one soul's inspection: the spawn
catalog (`soul-catalog.mjs`, over the holding rules of `keyed-catalog.mjs`),
the row each soul is listed as (`soul-rows.mjs` `soulRows`), the inspect
boundary and its cache (`inspect-boundary.mjs`, `inspect-cache.mjs`), the gate
for a soul's composed AGENTS.md and skills (`composed-gate.mjs`), the launch
vocabulary (`launch-view.mjs`) and what is said about a soul
(`soul-facts.mjs`, which the page loads). The catalog, the cache and the
boundary are factories: a client makes its own, with its own terms and its
own `exec`, and two of them share nothing. The boundary holds nothing itself,
so `server/capabilities.mjs` makes one per request around the backend's
cache, and a provider operation (`run`, the Desktop's) is admitted by the
boundary's own `capabilityAdmission`. It holds a spawn's two boundaries too:
the preview (`spawn-preview.mjs` `createSpawnPreview`), which is the dialog's
read, prepare's read and the settled answers they share, both reads within one
budget of two flights, and the suggest read's own lane (`suggest`: one per
workspace, the newer ending the older); and the confirmed-spawn broker (`spawn-apply.mjs`
`createSpawnApplyBoundary`), which prepares, applies and reads a result,
prepares through a preview's `prepareRead`, and runs each apply's `oats spawn`
in a process session of its own. Both refuse a remote workspace. The backend
makes one of each and owns them. And it holds the spawn's client half: the
transaction (`spawn-transaction.mjs` `createSpawnTransaction`: prepare, apply
the confirmed decision, follow, check and recover, each answer read as one
outcome kind), which the background store and the dialog's store-less path
each make and drive; a problem's and an outcome's words (`spawn-messages.mjs`:
a shared `fact` and a `next` code, which `renderer/spawn-words.mjs` says in the
Desktop's words); the preview's facts (`spawn-preview-facts.mjs`
`previewFacts`); the suggested name's rules (`spawn-naming.mjs`: when the dialog
asks, what it remembers an answer by, and a numbered spawn's words); and the
untouched choices (`spawn-preview-contract.mjs` `defaultSpawnChoices`). Two of a soul's rules sit beside them, so the page can
load them: the soul filter (`soul-facts.mjs` `soulMatches`) and the sentence of
a failed catalog read (`spawn-messages.mjs` `soulCatalogFailure`).

It holds a deployment's capabilities as every client reads them: the
capability table (`capability-catalog.mjs` `createCapabilityCatalog`, over the
same holding rules: a factory made with the client's terms and an optional
`exec`, whose `settle` answers what is held and what is still coming), a
capability row's rules (`capability-rows.mjs`: its source and group, the
sections and the search, and who uses it, `capabilityUsers`), and its facts as
the capability page shows them (`capability-facts.mjs` `capabilityFacts`, with
the page's own words in `CAPABILITY_COPY`). The backend makes the table and owns
it; the page loads the other two. And it holds the house fuzzy matcher
(`subsequence-score.mjs` `subsequenceScore`), one copy for the Desktop's palette
and Quick Open and the TUI's palette and switcher.

- **What it holds.** `.mjs` modules and nothing else, in one flat directory:
  no test, fixture, script or manifest, and no subdirectory. A module there
  imports `node:` builtins and its own siblings only: no third-party package
  and no Electron, as a module or as a runtime. Two files are a program, not
  a library: `liveness-main.mjs` is the collector's entry and
  `own-environment.mjs` is its first import
  ([below](#the-environment-of-the-programs-desktop-starts)); no other module
  there imports either.
- **Which of them the page may load.** The window's page is a browser page:
  it cannot load a `node:` builtin. Some modules of the home import one (the
  kernel callers, `deployment-panel.mjs`, `panel-views.mjs`) and are for main,
  the backend and a terminal client only. A function the page needs goes in
  a module that imports none: `deploymentUnavailableText` is in
  `deployment-facts.mjs` for that reason, not beside the panel's functions,
  and the words of the list of workspaces are in `workspace-choices.mjs`,
  not beside the views.
  `test/inventory.test.mjs` walks what the page loads and fails on a `node:`
  import anywhere in it.
- **What goes there, and what stays here.** A function belongs in the shared
  home when it answers a question from the kernel's rows alone: who is who,
  who relates to whom, which groups, what order, what is visible, who waits,
  what holds a home, which acts apply. It stays in this package when it takes
  a document or an element, or belongs to one of the Desktop's own surfaces:
  terminal tabs, drawn connectors, loading state, its routes and its stores.
  The shared home keeps no state at module level: a function there takes what
  it needs as arguments, a factory's instance holds only what the client that
  made it owns, and what the Desktop holds between calls stays here. A file that mixes the two is cut in two, and nothing is re-exported:
  an importer names the module that has the export
  (`renderer/instance-tree-view.mjs` is the Desktop's half of the tree,
  `renderer/view-deployments.mjs` of the sections, `workspace-registry.mjs` of
  admission). A decision is made there and drawn here: `instanceActs` returns
  verbs and reasons, never a label, an icon or a key, and
  `renderer/instance-actions.mjs` builds the menu from them.
- **Whose words a deployment's failure carries.** A deployment that is not
  observed says why in one sentence, `deploymentUnavailableText`
  (`deployment-facts.mjs`). A reason the reader marked `origin: 'kernel'`
  (`deployment-read-cli.mjs`: the error the installed CLI printed) reads "OATS
  answered with an error (<code>). It says: <message>", with the kernel's
  message through the display filter; a failure the reader made itself reads
  `<code>: <message>`, its own fixed sentence. `deploymentUnavailableParts`
  answers the same as `{ headline, lead, sentence }`, where `sentence` is the
  only part that can carry words the client did not write. A client that
  shows one line calls the first; one that sets the kernel's words apart (a
  quote, another style) calls the second. The Desktop's views call the first.
- **Who made a text a client shows.** Three texts can hold words the client
  did not write, and each carries a key beside it that names its speaker: a
  row's `runtimeError` (`runtimeErrorOrigin`), a reason's `sentence`
  (`origin`: `rowReason` in `remote-address.mjs`, passed on by
  `instanceActs`) and the message a deployment keeps when its re-read failed
  (`errorOrigin` beside `error`, from `failedEntry`). The values are
  `kernel`, `terminal-probe` and `roster-read`; `kernel` covers this
  machine's OATS and a host's OATS relayed by it. `originLead(origin, terms)`
  (`instance-presentation.mjs`) answers the words a client puts in front of
  the text ("OATS says:", "<name>'s terminal check says:", "<name>'s read
  of other machines says:"), and `null` for anything else. Only the shared
  home writes the keys, from the path the text took: one that arrives in a
  kernel's answer, a host's row, another machine's panel or the collector's
  output never survives. A reason's `origin` is there exactly when its
  sentence is not the shared home's own, so a client filters a sentence
  with an `origin` and shows one with none as written; its fourth value,
  `unattributed`, stands for a row's text nobody attributed and has no
  words. A text with no speaker is shown as before and never under "OATS
  says:". `keptFailure` (`deployment-facts.mjs`) is the one rule for "the
  last read failed and the last observation is kept": `error` is a string,
  whatever it holds. The Desktop makes every such line in
  `renderer/speaker-line.mjs`. The speakers' words, the table of which text
  gets which and the places are in
  [docs/desktop-deployment-model.md](docs/desktop-deployment-model.md#who-made-a-shown-text).
- **Whose words a sentence uses.** The home also holds the sentence shown for
  a code, one explanation for every client. Where a sentence names the client
  that shows it ("this Desktop", "Update OATS Desktop") or the machine it
  runs on ("This Mac"), the table that builds it takes the client's **terms**
  as an argument: `clientTerms({ name, self, selfInitial, update,
  thisMachine })` in `client-terms.mjs`. The home holds no terms of its own
  and no default: a table throws a `TypeError` when it is not given the
  object `clientTerms` returned, so a sentence can never be built with a
  missing word. A shared function that calls such a table takes the terms
  from its own caller and passes them on. The Desktop says its five terms
  once, in `renderer/desktop-terms.mjs` (`DESKTOP_TERMS`), which main, the
  backend and the page import, and every call site passes them itself:
  nothing re-exports a table with the terms bound, and a table is never
  handed along uncalled. `test/desktop-terms.test.mjs` writes out the
  Desktop's sentences and reads every shipped module for a call that forgot
  the terms; the root test `test/client-terms.test.mjs` builds every sentence
  of every table with a second client's terms and refuses any that still
  holds the Desktop's words. A sentence only the Desktop can raise is not in
  the home at all (`renderer/lifecycle-frame.mjs`).
- **Who may import what.** `test/client-boundary.test.mjs`, a root test that
  reads sources and imports none, holds the rules: the shared home imports
  only itself and `node:` builtins; `lib/` and `bin/` import nothing from it
  or from this package; a second client (`packages/tui/`) imports from it only
  the **stable surface**, by name. The surface is the list in that test, module
  by module and export by export: changing a listed export changes its other
  client in the same change, and anything not listed is this package's own
  composition. `test/client-loading.test.mjs` loads every module of the home
  under plain Node, which is the proof that none needs a DOM to load.
- **Its own error codes.** The home writes error codes of its own that have
  the kernel's shape (`E_` and capitals) and reads them where it reads the
  kernel's, so a kernel code that took one of those names would be read as the
  client's own. `own-codes.mjs` lists them (`CLIENT_OWN_CODES`), and the root
  test `test/client-own-codes.test.mjs` reads the sources both ways: the code
  of `lib/` and `bin/` writes none of them, and every name of that shape
  written in the home is on the list or is the kernel's. A code of the home's
  own that a table or a reader gains goes on the list in the same change. The
  test's header says what it does not read.
- **Where it is in the installed app.** The builder places it beside
  `app.asar`, as `client/` in the resources directory (`extraResources` in
  `electron-builder.config.cjs`): `Contents/Resources/client/` in the macOS
  bundle, `resources/client/` on Linux. From inside the asar `../client/` is
  then the same relative path as in the repository, which is why one specifier
  works in both. On macOS the files are sealed resources of the bundle: the
  ad-hoc signature covers them, and strict verification fails if one is
  changed, added or removed.
- **What it costs.** These files are outside the asar. Electron's asar
  integrity validation and its load-only-from-asar fuse cover what is in
  `app.asar`, and the app turns neither on. If one of them is ever turned on,
  the shared home is outside what it covers, and the layout has to change to
  one that puts these modules inside the asar.
- **What holds it in place.** `test/inventory.test.mjs` reads every file the
  builder ships and follows each path it reaches: the path must be shipped, or
  be in a directory the builder places at the same relative position as in the
  repository. The same test pins what the directory may hold and import. The
  installed-artifact smoke (`scripts/dist-smoke.mjs`) compares the packaged
  `client/` with the repository's directory, runs the backend and the
  collector from the package, and loads every module main imports under the
  packaged executable; where it launches the window, the page's own imports
  are the proof. The development harness serves the directory at `/client/`
  (`renderer/harness-server.mjs`), where a browser lands when a renderer
  module climbs above the harness's root.

### The environment of the programs Desktop starts

A program Desktop starts gets the user's environment: nothing Desktop or its
packaging added reaches it. The backend and its liveness collector, which are
the packaged executable running as Node, are started with their parent's
environment and clean their own before anything else. The main process keeps
its environment and gives each child the cleaned one when it starts it.

It matters because a tmux server takes its environment from the program that
creates it (the oats CLI on a spawn or a start, or `tmux` itself), and every
pane on that server then has it.

The rule is one function, `cliEnvironment(source)` in
`packages/client/cli-environment.mjs`, which imports nothing:

- `ELECTRON_RUN_AS_NODE` (main sets it for the backend) and `CHROME_DESKTOP`
  (Electron sets it on Linux) are removed.
- `MallocNanoZone` is removed when it is exactly `0`: the launch environment
  Electron's `Info.plist` declares on macOS.
- When the environment has `APPDIR` (an absolute path other than `/`; the
  AppImage's mount), `APPIMAGE`, `APPDIR`, `ARGV0` and `OWD` are removed, and
  every other value is read as a `:` list: entries that are the mount or under
  it are dropped, with the empty ones, and a name with nothing left is
  removed. A value with no such entry is passed through unchanged.

Where it is applied:

- **A process that runs as Node cleans itself first.** The first import of
  `server/oats-web.mjs` and of `packages/client/liveness-main.mjs` is
  `packages/client/own-environment.mjs`, which changes `process.env` in place. It has
  to be an import, and the first one: modules take their environment when they
  are loaded (`server/forge.mjs`, `packages/client/tmux-status.mjs`), and a module's
  imports are evaluated in order, each completely before the next. So
  `own-environment.mjs` and `cli-environment.mjs` must keep no other imports
  and no top-level `await`, and nothing may import an entry module or be
  preloaded ahead of one. After that no place in `server/` that starts a
  program needs the function, and none has it.
- **Such a process is started with its parent's environment**, so the
  executable starts as it always did (on an AppImage that includes the library
  path into the mount). Main starts the backend with
  `{ ...process.env, ELECTRON_RUN_AS_NODE: "1" }`; the backend starts the
  collector with `launchEnvironment`, the copy `own-environment.mjs` took
  before cleaning. No other child receives either.
- **Main cleans nothing of its own** (Electron and the AppImage's machinery
  read it). Every program it starts gets `cliEnvironment(<the environment at
  that moment>)`, computed at the call: the login shell, `oats` workspace
  verbs, the terminal viewers' `tmux` calls and PTY, the remote terminal and
  its `oats session` calls, the orphan-viewer sweep. `gh`'s allow-list
  (`forgeEnvironment`) is picked from it too. That is the one copy made at
  module load, so after the login shell's `PATH` is applied, `gh`'s `PATH` is
  taken again from `forgeEnvironment()`. The `PATH` the login shell answers is
  not assumed clean (a profile can print anything), and main's own `PATH` is
  whatever the merge returns; children are filtered when they start.

A new child of the main process needs `cliEnvironment`; a new child of the
backend or the collector needs nothing.

Limits, known and not fixed:

- A packaged Electron empties most of `NODE_OPTIONS` before any Desktop code
  runs, so a user's `NODE_OPTIONS` does not reach the CLI.
- The AppImage launcher also adds entries that are not under its mount, and
  those stay. As generated by `app-builder-lib` 26.15.3
  (`generateAppRunScript`): `/usr/share/gnome`, `/usr/local/share/` and
  `/usr/share/`, appended to `XDG_DATA_DIRS` after the user's entries. A user
  with no `XDG_DATA_DIRS` therefore gets one made of those three.
- The rule follows `APPDIR` in the environment, whoever set it. Desktop
  started from a shell that is itself inside another AppImage drops that
  image's entries too. A launcher run without the AppImage runtime (an
  extracted image) does not export `APPDIR`, so its entries are not
  recognised.
- A value that is rewritten also loses the user's own empty entries.
- A user's own `MallocNanoZone=0` is removed too: it cannot be told from the
  one the app's launch declares.
- A tmux server that is already running with such an environment is not
  changed ([#616](https://github.com/awebai/oats/issues/616)).
