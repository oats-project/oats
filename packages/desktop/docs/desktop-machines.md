# A workspace's own machines (#517)

A window shows one workspace, so it offers only the machines that run that
workspace: **Where to run** in the spawn dialog, the Workspace page's
**Machines** list, and **Add a machine to this workspace…** in both. Every
read and change is the installed CLI's (`oats server … --json`, `oats aweb
connect --json`); the Desktop keeps no registry.

## Gates

The probe (`oats version --json`) must declare `servers-per-workspace` and
`server-connect`. The messaging step also needs `capability-route`. Without
them nothing here changes: `/api/servers` answers the registered list as
before, Where to run lists every registered server, there is no Add entry, and
the Machines list reads no registration: it shows this computer alone (or, in a
remote-only view, the view's deployments from the panel), with no Add
(`machinesGated`, `awebConnectGated` in `packages/client/machine-contract.mjs`).

## The window's key

`machineScope(held, ws, terms)` (`packages/client/panel-views.mjs`) answers
`{ key, deployment, messaging, reason? }` for a view:

- `key` is the `workspace.key` of the view's **primary local deployment**
  (`status --json`, feature `workspace-identity`), and only when that identity
  says `keyFrom: "workspace"`. A matched view's deployments all share it.
- `deployment` is that deployment's directory: the cwd of every machine call
  (`server list`, `check`, `remove`, `connect`, `aweb connect`).
- `messaging` is its `oats workspace status` `defaults.slots.messaging.name`.
  The messaging step runs only for `oats.aweb`.
- With no local deployment (`reason: "no-local"`), or a key that is not the
  workspace's (`"no-key"`), `key` is null: the window offers no remote machine
  and no Add, and says why in one line (`MACHINE_SCOPE_REASONS`).

## Server (`server/machines.mjs`)

- **`GET /api/servers?ws=<view>`**, gated: the `server list` rows whose
  `workspaceKey` equals the window's key, each with the last check this run
  (`check: { reachable, version, error } | null`), plus `filtered: true`,
  `key`, `deployment`, `aweb` (oats.aweb messaging and `capability-route`) and
  `reason` when there is no key. A registration of another workspace, or with
  `workspaceKey: null`, is never offered.
- **Backfill.** The first gated list read of a server process starts, in the
  background, one `oats server check <id> --json` for every registration whose
  key is unknown, two at a time (`BACKFILL_CONCURRENCY`). The check records the
  host's key in the registry. Only a list read that began after the backfill
  completed is settled: any read that began before (while it ran, or before it
  started, as a concurrent first read) answers `backfilling: true`, even when
  it answers after the end, since its rows may be from before the checks
  wrote their keys. Where to run and the Machines
  box read the list again until an answer does not (`followBackfill`,
  `machine-contract.mjs`): first after 2 s, then 1.5 times later each time, at
  most 15 s apart. The backfill is bounded by its checks' own deadlines, so
  the follow ends with it; it stops early when the owner moves on, or after
  five failed reads in a row. The registrations that turn out to be this
  workspace's appear without any other action. It runs once per server process (a restart for a workspace add
  runs it again; by then only unreachable hosts are still unknown).
- A registry that cannot be read is an answer, not a refusal: `servers: []`
  with `error: { code, message }` and the window's `deployment` and `aweb`
  kept, so the Machines list says why with Retry and Add stays offered.
- **`POST /api/server-check?ws=`** `{ id }`: an id whose key is the window's or
  is unknown. **`POST /api/server-remove?ws=`** `{ id }`: the window's key
  only. Both admit the id against a fresh `server list`
  (`E_SERVER_UNKNOWN`, `E_SERVER_OTHER_WORKSPACE`).
- **`POST /api/server-connect?ws=`** `{ phase: "connect", id, host, folder,
  installOats }` runs `oats server connect <id> --ssh <host> --dir <folder>
  [--install-oats] --json`; `{ phase: "aweb", id }` runs `oats aweb connect
  <id> --install-aw --json` (oats.aweb messaging only, `E_NOT_AWEB`). One run
  per machine at a time (`E_BUSY`, 409). The envelope is relayed as the CLI
  printed it.
- The remote roster reads the machines of the workspaces the open windows show
  (`desktop-load-path.md`, #1124): a machine registered for a workspace no
  window shows is not probed.
- After a remove or connect that answered `ok`, the remote roster is read at
  once, so the view gains or loses that deployment.
- Every value is held to the kernel's rules before any argv is built
  (`machineFieldProblem`: the registration id, the ssh host alias, a folder
  starting with `/` or `~/`). Calls are argv only, never a shell, and nothing
  runs over ssh from the Desktop: only the CLI does. Timeouts: connect 15
  minutes, aweb connect 5, check 60 s. Main's api proxy (`classifyApiRoute`,
  routes `machine-connect` and `machines`) waits 980 s for a connect and 130 s
  for a check, a remove or the list, so each reports itself.

## Where to run

In a one-deployment view, Where to run lists "This computer", then the
window's machines (disabled with why from their roster group, as before), then
**Add a machine to this workspace…**. Choosing that entry opens the dialog and
leaves the choice as it was; a machine added is listed, selected, and the form
reads for it. In a view of two or more deployments the Deployment field
replaces Where to run, so Add a machine is a link-style button under it; a
machine added there shows up as a Deployment option once the roster reads it,
and is not selected.

## Add a machine (`renderer/add-machine-dialog.mjs`)

- Fields: **Machine** (an ssh host alias, free text), **Name** (defaults to
  `<host>-<deployment folder name>`, made a valid id, until edited), **Folder
  on that machine** (starts empty and is required: the dialog suggests no
  folder, #1390; its hint is "A path on that machine, starting with / or
  ~/", and Add machine with it empty says so beside it and runs nothing; the
  dialog always passes the entered folder as `--dir`), **Install OATS there
  if it's missing** (on). It never asks for or shows a secret.
- Each phase (connect, then messaging) is a box of rows, one per step the CLI
  sent: the step, its status in words (ok, done, needs you, waiting, failed),
  and the CLI's own `detail`, `remedy` (its lines kept: a readiness remedy is
  several lines joined by newlines) and code. Each command a remedy names in
  backticks gets a copy button; a remedy that names none (the kernel's git
  remedy says what to make readable, where) has none. No wording of the Desktop's replaces the
  CLI's. A failed run shows `error.details.steps` and the CLI's message and
  code.
- The messaging phase runs only when the deployment uses oats.aweb and connect
  reached `register` (its status `ok` or `done`).
- Success is connect `ready`, plus messaging `ready` when that phase applies:
  the dialog closes and hands the id back. Otherwise it stays open with every
  row, and the action becomes **Check again**, which re-runs both (they are
  idempotent) with the fields as they are.
- While a phase runs, the fields and the action are locked, a spinner marks
  the phase, and focus waits on the status line. Close and Escape always work:
  the CLI finishes on its own and a late answer changes nothing.
- The dialog belongs to its opener (`owns()`): the spawn dialog, or the
  Machines list of one workspace generation. When the opener goes (the spawn
  dialog closes, the window changes workspace), the dialog closes, and an
  answer that arrives later neither renders, takes focus nor starts the
  messaging step.

## The Machines list (`renderer/workspace-machines.mjs`)

The Workspace page's **Machines** section (the Desktop UI rework, slice 3b; until then the Setup tab's
Registered machines box): the computers this workspace runs on, one row each. **This computer** first
(reachable once its deployment is read, the CLI probe's OATS version, nothing to check or remove), then each registered machine:
its name, reachable or not from its last check this run (reachable: the check reached its deployment,
and `workspaceReadable` is not `false`; the kernel's `workspaceReadError` or error message is the
state's title), how many of **your agents** run on it, and its OATS version. The agents are the
roster's rows: this computer's carry no `server`, another machine's carry its registration id as
`server` (`packages/client/remote-roster.mjs`). They count what this Desktop reads (your agents, on
this computer and the machines registered here; team-instance-lists-state-their-observation-scope),
and a count is shown only after a settled good roster read of that machine's deployment: the roster read itself
(pending, failed or stale: "—" with the reason as its title), this computer's observed deployment (pending: "reading…";
unreadable: "not read", "—", and the observation's own words under the list), and another machine's deployment as
the panel's #482 `deployments` reports it, bound by the registration's id (each remote entry's `server`,
`machine-contract.mjs` `machineDeployment`; a display label is not unique, and none or two matches make no claim; read
now: a count; kept from an earlier read: the count "as last read"; not reached: "—" with the reason). A successful machine check is not a roster read. With no panel entry for the machine
(an older panel that names no machine's deployment), a machine its check reached counts. The
section says so in its one line.

A registered machine's row is one button: Enter (or a click) opens it under its row, with its name,
ssh host and folder, then **Check** and **Remove**; the row's title gives the same facts. A machine
not checked yet this run is checked once in the background (two at a time). Remove asks first, in the
opened machine ("Remove <id>? Agents started there keep running and can still be retired from
here."), and a refusal is said there in the CLI's words. A late Check or Remove moves focus back to
its control only when no newer press or key in the section came since and focus is not elsewhere.
**Add a machine to this workspace…** sits at the section's head (the dialog above). The section is
mounted once per workspace and kept across the tab's re-renders (`sync()` repaints the counts when
the roster moves). A workspace change disposes it (and its dialog). Without the machine gates the
route answers no filtered list: the section shows this computer only and offers no Add. A view with no
deployment on this computer (a remote-only view, or a view whose deployments are all elsewhere) has no "This
computer" row: it lists the view's other deployments from the panel's #482 `deployments` (their machine, whether
reached, your agents there; no version is claimed). The list stays mounted while the Workspace page repaints, so a
roster poll never moves focus off a row or a machine's control.

## Fixtures

`test/fixtures/machines-517/` holds the kernel's own answers (spec A's
fake-host runs: connect needing a human at git, ready, failed; `server list`
with a known and an unknown key; the backfilling check), with their source in
`provenance.json`, and oats.aweb's own `aweb connect` answers (spec B's
fake-host tests: ready, needing a human at `aw`, failed with
`E_TEAM_NOT_MEMBER`).
