# bb-plugin-oats (staging)

The OATS plugin for bb. This directory is a **staging copy**: it lives on a branch of the oats
repository only until the bb package repository exists, where it becomes `plugin/` with its
history. It is never merged into oats and no pull request is opened for it here.

Your OATS agents in bb: who each one is (soul, instance, aweb alias, parent, children), which ones
need you, and the workspace they come from (souls, capabilities, teams, machines). From bb you can
spawn, stop, start, restart and retire an agent. The plugin draws and asks; it owns nothing: every
OATS fact it shows is an answer of the `oats` CLI's `--json` verbs, every bb fact comes from bb's
SDK, and everything it does goes through `oats`. It never reads `instance.json`, receipts, event
files' contents or bb's database, and it never infers whether an agent runs.

Tested on bb-app 0.50.1 (plugin SDK 0.6.157); `engines` in `package.json` names the range. POSIX
only (Linux, macOS): the host entry runs `oats` in its own process group. bb, its npm packages and
this plugin's dependencies are installed and run only in containers (see [Developing](#developing)).

## Install

```sh
bb plugin install <path to this directory> --yes     # builds it and loads it; the plugin id is "oats"
bb plugin list                                       # oats … running
```

The plugin needs, on the bb machine that holds the OATS homes: an OATS deployment (a directory
with `oats-local.yaml`), `oats` on the PATH of that machine's login shell, and an OATS kernel whose
`oats spawn` takes `--backend bb` (the bb session provider). On a kernel without it, the tree is
empty and Spawn shows the kernel's refusal (`E_BAD_ARGS: --backend must be tmux`).

## Settings

`bb plugin config oats set <key> <value>`, or Settings, Installed plugins, OATS.

| Key | Default | Meaning |
|---|---|---|
| `deployment` | `""` | The deployment directory. Empty: the plugin walks up from each bb project's root on the machine to the first directory that holds `oats-local.yaml`. |
| `oatsBin` | `""` | An absolute path to `oats`. Empty: `oats` on the PATH of the machine's login shell. |
| `host` | `""` | The bb machine (its name or id) that holds the homes. Empty: the server's only machine. |

When something is missing, bb stays fully usable: its threads are listed as usual, and the plugin
shows one line that says what is missing. The line's code:

| Code | When |
|---|---|
| `NO_DEPLOYMENT` | no bb project of the machine is inside a deployment, or the `deployment` setting holds no `oats-local.yaml` |
| `OATS_NOT_FOUND` | `oats` is not on the machine's PATH, or `oatsBin` names no program |
| `CHOOSE_HOST` | the bb server has several machines and `host` is empty |
| `HOST_NOT_FOUND`, `NO_HOST`, `HOST_UNREACHABLE` | the machine set is not one of the server's, the server has none, or its daemon did not answer |
| `OATS_TIMEOUT`, `OATS_NOT_JSON`, `OATS_BAD_ANSWER`, `OATS_FAILED` | `oats status` took more than 20 s, printed something that is not JSON, answered a document the plugin cannot read, or failed with no answer |
| `E_…` | the kernel's own refusal, with its message unchanged |

An act's refusal has the same codes, and two of its own: `RETIRE_INCOMPLETE` (the retire ran, its
cleanup is incomplete, the kernel kept the home and its lines say what is left) and
`NO_THREAD_NAMED` (a spawn or a start went through and the kernel names no bb thread for the agent).

## The sidebar's thread list

The plugin registers a thread list and leaves bb's choice of the list on automatic: it does not pin
itself, because a pin outlives the plugin (after a disable or a removal the sidebar would show "No
thread list plugin is enabled" until someone resets it). On automatic, bb takes the first installed
thread list plugin by plugin id, so another one whose id sorts before `oats` takes the sidebar. To
choose this one, or to go back:

```sh
bb settings ui set sidebar.threadListProvider oats/agents
bb settings ui reset sidebar.threadListProvider
```

## Stopping an agent

Stop an OATS agent with **Stop agent (OATS)** in the thread's menu: it stops the agent through
OATS (the kernel's plan, then one confirmation), so a stopped agent stays stopped. bb's own
composer Stop, Archive and Delete cannot be hidden by a plugin, and the plugin never acts on its
own when one of them is used: an agent whose thread was archived or deleted in bb leaves the tree
and shows on its soul's page as "thread missing", with Start and Retire. Nothing is retired because
a thread was deleted.

## How it is built

| File | Runs in | Does |
|---|---|---|
| `host.ts` (`bb.host`) | bb's host daemon, on the machine that holds the homes | runs `oats`, and watches the deployment's event log; nothing else |
| `server.ts` (`bb.server`) | bb's server process | the settings, the RPC contract, one cached snapshot for all clients, the realtime invalidation |
| `app.tsx` (`bb.app`), `app/` | the web UI | the slots |
| `contract.ts` | shared | the RPC contract (app to server), the host contract (server to host), the realtime channel |
| `kernel/` | the host entry and tests | one function per `oats` command: the argv, and the answer read with a schema into the plugin's types |
| `model/` | the app and tests | pure functions from the agents and bb's threads to what each slot draws |

`kernel/` and `model/` import neither bb nor React.

- **Why the host entry runs `oats`.** Only it sees the user's login-shell PATH, and only it can
  target the machine that holds the homes.
- **Children.** bb reaps no child of a plugin on reload or stop. Every `oats` runs in its own
  process group with the call's abort signal; on an abort, a timeout, the worker's lifecycle signal
  and in `dispose`, the group gets SIGTERM, then SIGKILL after a grace (`kernel/run.ts`). What an
  `oats` that finished by itself left running is the kernel's and is left alone.
- **Inputs are untrusted.** bb's API has no login, so any client of the server can call the
  plugin's RPC. No RPC takes a path, a flag or a command. A soul must be one `oats souls` lists; a
  name must match `^[a-z0-9][a-z0-9-]{0,62}$` and is one argv element; a task travels as a 0600
  file in the host worker's temporary directory, removed when the call ends; an instance must be in
  the current snapshot, and its home is the one the kernel named. The plugin adds no power a caller
  of bb's own API lacks.
- **Spawn.** The kernel takes an idempotency key only with the decision it confirms
  (`--expect-decision`), so Spawn reads the kernel's preview and applies exactly that decision with
  the key; asked again with the same key, it replays the same spawn. A spawn or a retire that runs
  capability hooks can take minutes: if the client stops waiting, the act still finishes and the
  tree shows it.
- **Freshness.** The server keeps one snapshot (`oats status --json`). It rereads on the host
  entry's `changed` signal (a watch on `<deployment>/.agents/events`, where the kernel appends one
  line per spawn, launch, stop, retire and waiting claim, set or cleared), after each of the
  plugin's own acts, on bb's thread created and deleted events, and every 15 s while a client
  watches the snapshot: never two reads at once, never within 5 s of the last, 20 s limit. Each
  reread that differs publishes `oats/changed`, and the app refetches. A harness that exits by
  itself writes no event: the 15 s poll carries it. The watch dies with the host worker; it is
  asserted again at every start of the plugin's service, after a worker exit, and after any read
  that finds it gone.

## `experimental_*` names used (SDK 0.6.157)

The one list to check at a bb upgrade.

Backend and contracts: `experimental_defineHostEntry`, `experimental_signals`,
`experimental_retryable`, `context.experimental_paths.tempDir`, `context.experimental_watch`,
`context.experimental_emitSignal`, `bb.hosts.experimental_client`, `host.experimental_onSignal`,
`host.experimental_onWorkerExit`, `experimental_PluginRpcRefusal`,
`bb.rpc.experimental_whileWatched`, the RPC handler context's `experimental_signal`.

Backend tests: `experimental_createHostEntryHarness` (`experimental_call`,
`experimental_getSignals`, `experimental_dispose`, `experimental_paths`, `experimental_watch`),
`createFakePluginHost`'s `experimental_callHostRpc`, `experimental_hostRpcCalls`,
`experimental_emitHostSignal`, `experimental_watchRpc`.

App: listed by the frontend half (below).

<!-- frontend: the app's experimental_* names -->

## Developing

Everything runs in a container (`--cpus 2 --memory 6g`, no mounts, no Docker socket, no host home;
bb sovereign: no account, `BB_TELEMETRY=false`, loopback). Never `npm install` on the host.

```sh
container/ci.sh            # the image, the installs, typecheck, unit tests, build, live tests
container/ci.sh unit       # typecheck, unit tests and the build
container/ci.sh live       # the live tests only (bb-app, the plugin installed, a fake oats)
```

`container/README.md` says what each script does and how to keep a container for a session of
work. The unit tests run `kernel/`, `host.ts` and `server.ts` against a fake `oats`
(`container/fake-oats.mjs`) that prints the recorded answers in `test/fixtures/`; the live tests
run bb-app at the pinned version with the plugin installed from the checkout and the same fake.

`contract.ts`, `model/types.ts` and `test/fixtures/status.json` and `threads.json` are pinned by the
spec: a change to them is agreed with the spec's author first.
