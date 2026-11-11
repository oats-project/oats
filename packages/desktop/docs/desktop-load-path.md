# Desktop load path: parallel cycle, held catalogs, focus-safe cadence

How the backend (`server/oats-web.mjs`) turns kernel reads into what the
renderer sees, and why it is shaped this way. The kernel stays the model
(`docs/desktop-deployment-model.md`); this page is about *when* the backend
asks it and *what it keeps*.

## The observation cycle

One cycle reads every registered deployment (`observeDeployment` each),
at most `MAX_DEPLOYMENT_OBSERVATIONS` (2) at a time, first come first served
(`mapBounded`, `packages/client/deployment-observer.mjs`): the bound is the observer's
own admission, so no deployment is refused for being third. An empty
deployment (no souls, no instances) is an observation like any other: it is
published as `observed` with no instances, never left `pending`. For each:

1. `oats status` and `oats workspace status` run together
   (`packages/client/deployment-observer.mjs`). On a **cold** cycle — nothing held for
   the deployment, or only a failure past its retry window — `oats souls` and
   `oats capabilities` start in the same tick, *unbound*: their key is not
   known until the workspace status lands.
2. When the two roster reads land, the roster snapshot is published. It never
   waits on souls or capabilities.
3. The cycle's key (`soulCatalogKey`: CLI bin/version, workspace commit,
   member commits/status, externals) binds the unbound reads (`settle`). A
   read that already landed is bound the same way. The souls catalog is
   attached to the published snapshot entry when it lands; `/api/agents`
   reports `refreshing: true` until then.
4. On a **warm** cycle nothing but the two roster reads runs. Souls and
   capabilities are re-read only when their key moves.

The holding rules live once, in the shared home's `keyed-catalog.mjs`
(`packages/client/`), and the two catalogs are thin wrappers over it
(`packages/client/soul-catalog.mjs` and `packages/client/capability-catalog.mjs`,
which every client makes with its own terms). Each is a factory
the client owns: nothing is held at module level, so two catalogs share no
flight and no held entry:

- one flight per deployment; a failed read keeps the last good value with the
  failure next to it, and background cycles retry it only after 60 s;
- an unbound prefetch is bound **only by the same cycle's settle**. Every
  prefetch opens a cycle; a flight (or a landed value) from an older cycle —
  its roster reads failed — is never bound to a state it was not read under,
  and that cycle reads under its own key at settle time. A value that landed
  unbound is still *held*, so a deployment whose roster reads keep failing
  (a status timeout) costs
  one souls/capabilities read per window, not one per cycle. A value held
  under `null` answers for no key;
- the retry window throttles background cycles, never a user: a request that
  finds no good value held (`demand`) reads now; `refresh` is a live read
  (`--max-age 0`) that joins only a live flight for the same key — a
  background flight in the air may carry heads up to a minute old, so a live
  one starts beside it. On a kernel without `observe-max-age` every flight is
  live, so a refresh always joins.
- `observedAt` is the kernel's `observation.observedAt` when reported, else the
  read's completion time; a failure keeps the previous stamp. A malformed
  `observation` block is *no stamp* (`observationData` projects nulls): the
  stamp is provenance beside the result, and a bad stamp never costs the
  roster, the catalog or the document.
- a keyed flight that lands after the key moved on (a newer `settle`,
  `demand` or `refresh` under another key) is not held, so a slow read under
  an old state never overwrites the newer state's entry; every flight still
  resolves with the entry *it* built, so a request awaiting it is answered for
  the key it asked, never with whatever happens to be held (or nothing).

Every held result also has an **age bound**: `HELD_TTL_MS` (60 s, the
background max-age; `packages/client/keyed-catalog.mjs`) from the time it was stored,
for the souls catalog, the capabilities table and inspections alike. Past it
the entry is `stale`, and staleness is **request-driven**: the observation
cycle still answers from a stale entry and never starts a catalog re-read
because of age alone (a `souls` plus an `oats capabilities` run — 26–34 s,
hundreds of git processes — per deployment every minute, focused or blurred,
is exactly the churn the app must not cause; key changes and admission
re-read as before). A *request* that finds the entry stale — `/api/agents`
(`revalidateCatalog`), a `/api/workspace-sync` read — answers at once from
the held value with `refreshing: true` and starts **one** re-read behind it
(`revalidate`: single-flight, joined by every request and cycle until it
lands, attached to the published entry when it does; it starts nothing while
another key's flight is in the air — that read answers). An inspect past its
TTL is a miss and awaits its per-subject read (~7 s). `/api/agents` is
*polled* by the renderer's Spawn/Workspace view every 8 s while mounted, so
its revalidation is gated on window focus (`refreshLoop.focused()`):
focused with that view open, the souls catalog is re-read about once per TTL
+ read; blurred or minimized, never. The capabilities table is read on tab
open and Retry only, so it needs no gate. So a catalog is re-read when
*viewed* after 60 s: a Workspace-tab visit never waits for a kernel run while
the key is unchanged, and a blurred app costs nothing. The key sees what
`workspace status` reports; the TTL bounds what it cannot — local
configuration edited outside Desktop (`oats teams`, `oats soul teams`, `oats
sync` from a terminal, an agent editing its own teams) is seen within the TTL
plus one read *of the next time someone looks*. There is no pre-emptive
(TTL/2) refresh: the kernel's local-configuration revision behind
`observe-max-age` is the real fix and comes as a follow-up. The Desktop does
not stat, name or parse
any deployment file to find out sooner: which files hold local configuration
is the kernel's to know (`test/desktop-package-boundary.test.mjs` enforces
it), and a kernel-computed local-configuration revision is the maintainer's
planned follow-up behind `observe-max-age`.

The capabilities key (`capabilityCatalogKey`) is the souls key plus package
identity (id, version, commit, integrity from the lock rows) and lock currency
(`declaredPackages`, `unsynced`, `stale`, lock path/version): the table lists
member and package capabilities and whether the lock is current, and nothing
else in `workspace status` changes it.

## The request path never runs a kernel read it can avoid

- `POST /api/workspace-sync {action:"read"}` answers from the held table at
  once while it is a healthy answer inside its TTL. When the latest re-read failed the answer is
  today's failure shape (`status` non-ok, `reason`, `capabilities: null` —
  the renderer shows the error and Retry exactly as before) with the additive
  `lastGood: { capabilities, observedAt } | null` beside it for a renderer that
  can label a stale table; a healthy shape is never a stale one. A request
  that finds no healthy table held — a first read, or a held failure, table
  behind it or not (today's Retry button is a plain read) — reads now,
  whatever the retry window says, and answers with what lands; a healthy table
  past `HELD_TTL_MS` is answered at once and this request starts (or joins)
  its re-read, announced as `refreshing`. `refresh: true` forces a live read.
  An ok `sync` forgets the held table.
- `POST /api/capabilities {action:"show"|"file"}` (`oats capabilities show`, the capability
  page's Contents; `server/capability-show.mjs`) goes through its own LRU of 48 decoded
  answers with in-flight coalescing. Keys: (deployment, selector, the held catalog row's
  commit[, file path]). A capability's content at one commit never changes, so the commit is
  the whole invalidation story: a sync or pull moves it and the next read misses. A row
  without a commit, and an answer about another commit than the row's (the head moved
  between the two reads), are coalesced but never held. A `file` request is answered only for
  a path the (cached) show listing names. The cache is cleared when the CLI changes.
- `POST /api/capabilities {action:"inspect"}` goes through the shared home's
  inspect boundary (`packages/client/inspect-boundary.mjs`; `server/capabilities.mjs`
  makes one per call, since it holds nothing) and its bounded LRU with
  in-flight coalescing (`packages/client/inspect-cache.mjs`, 256 entries, the
  backend's own instance): two identical
  concurrent inspections are one kernel process; a repeat is a hit for at
  most `INSPECT_CACHE_TTL_MS` (= `HELD_TTL_MS`) after it was stored, then a
  miss: the TTL bounds what no key can see (local configuration, teams
  changed on the messaging side, the launch choice this machine would make
  now). Keys: `inspect --soul` → (deployment, server, soul, agents root,
  capabilities key, `instructions`, `skills`, `composedSkills`): the soul page's read with the
  composed AGENTS.md (`instructions: true`, a soul inspect only, sent to the
  CLI as `--instructions` when its probe lists `soul-composed-instructions`;
  routed, only when the held roster row's `probe.features` lists it too, else
  dropped before the key is made: `packages/client/composed-gate.mjs`) and its own
  skills (`skills: true` → `--skills`, feature `soul-skills`, gated the same
  way), and every skill a spawn gives the instance (`composedSkills: true` →
  `--composed-skills`, feature `soul-composed-skills`, gated the same way) is
  another entry than the sidebar's plain read of the same soul;
  `inspect --home` → (deployment, server, home, instance, and the status row's
  identity and drift facts: createdAt, startedAt, soul, modules), so a retire,
  restart or drift change is another subject. `refresh: true` bypasses the
  entry and shares only a live flight; the soul page's Refresh ("Inspect
  again", `renderer/soul-inspector.mjs` `show(selection, { user: true })`)
  sends it, a plain visit does not. `run` never reads or fills the cache.
  A **remote** workspace has no state key and no invalidation signal on this
  machine, so its inspections are shared between concurrent requests but
  never held between visits (`store: false`): every visit is live, as before.
- Every mutation the backend performs for a local deployment
  (`observeMutation`: lifecycle apply, spawn apply, session start/restart,
  operation run, sync, teams and soul-teams writes) drops the inspect entries
  held under that workspace's *scope* (the deployment directory the kernel
  was pointed at) and observes the roster live. A real CLI change drops
  everything.

## Cadence and window state

`packages/client/refresh-loop.mjs` owns when a cycle runs: the next one starts a fixed
interval **after** the previous completed — 5 s while a window is focused,
30 s while every window is blurred or hidden — so a slow kernel is never asked
twice at once and an idle app costs little. A cycle requested during a cycle
(a mutation's follow-up) runs exactly once right after.

**The post-spawn read (#1246).** A spawn's follow-up cycle waits behind the
cycle in flight and reads every deployment, so a created instance used to reach
the roster 1–3 s after the apply answered. When `/api/spawn` answers a created
outcome (`complete`, `partial` or `incomplete`, from `apply` or from a `result`
that found a pending apply settled), the backend also reads that one local
deployment at once (`observeSpawned`, the `OATSWEB_SPAWNREAD` block): the same
per-deployment read as a cycle (`oats status --max-age 0`, `oats workspace
status`, the liveness child where one runs), live, through a second observer made by the same
factory (`spawnObserver`). That observer is used only on demand: no timer, no
loop, and it never joins a cycle's read, which started before the apply
answered. The bound is at most 2 post-spawn reads at once beside the cycle's 2,
and per deployment one running plus one queued: a further request rides on the
queued read, which starts after the running one.

- Every read is stamped when it starts, and per deployment the later start wins:
  the post-spawn read publishes into the snapshot as soon as it lands, unless
  the entry published started later, and a cycle that started before it keeps
  it when the cycle publishes. A failed, unavailable or busy read, or a kept
  failure (`failedEntry`), publishes nothing; a read that answers the held entry
  keeps that entry's stamp.
- The created answer is sent once that read has published (or found a newer
  successful observation already published), or after
  `CREATED_OBSERVE_WITHIN_MS` (5 s), whichever comes first: a read that
  publishes nothing, or finds only a newer failure, ends no wait. Never past
  `ANSWER_WITHIN_MS` (50 s) since the request arrived: an apply that answers at
  49 s waits at most 1 s. The refresh loop's own follow-up (`observeMutation`)
  still runs, and the next cycle runs as scheduled.

The Electron main process posts `{ focused }` (a strict body: that key and
nothing else) to `POST /api/window-state` when the reduction of its windows
flips (`window-activity.mjs`: visible, not minimized, focused). Focus
returning runs one prompt cycle. A headless server assumes "focused".

The remote roster (`refreshRemoteSnapshot`, one `server roster` read that
probes every configured host at once, each within its own deadline) runs on a
second `createRefreshLoop`: 10 s after completion while focused, 30 s while
blurred, driven by the same window state. One read runs at a time, and a
caller that asks while one runs joins it. A Retry on a window with a
deployment on another machine posts `POST /api/remote-roster/refresh`, which
runs that read now (or joins the one in flight) and answers once an outcome
read under the accepted CLI is held (a read the CLI changed under is read
again first); the renderer then reads `/api/panel`, which serves it. Main's
proxy gives that request 70 s, longer than the CLI adapter's 60 s for the read.

Which machines it reads (#1124). Main alone knows the windows: it posts the
view each one shows (`{ views: [view id | null] }`, null for a window showing
the switcher) to `POST /api/windows` whenever its window set changes
(`window-set.mjs` `onChange`) and again for each server it learns
(`window-activity.mjs` `createViewsNotifier`: one post at a time, the newest
set last, a failed post retried at the next served-list update). With a CLI
that lists `roster-workspace-key`, each read passes
`--workspace-key=<key>` for every usable key of those views, computed at the
read from the set and what is held (`packages/client/panel-views.mjs`
`rosterWorkspaceKeys`: a matched view's key; an unattached view's reported or
remembered key, member-derived included, since a registration records the
key its host reports). The read is unfiltered before main has posted, before
the first answer, while a window shows the switcher or a view this server
does not serve, when a view's machine has no usable key, and with no window.
With the feature, a set that adds a key, or that needs the unfiltered read,
requests a read at once (the loop's coalesced `request()`), whatever the set
before it was: a set says what the next read asks for, never what the last
read covered, so a workspace opened after the switcher or no window still reads
now. A filtered answer replaces only what it could list
(`remote-roster.mjs` `remoteRosterState` with `asked`): a held group whose
last-known key (`lastKnownKey`) is outside the keys asked is kept as it was
last read, stays in the identity memory, and keeps its read time as its
panel's `generatedAt` (`keptReadTimes`). The server holds those times
(`held.keptReadAt`), and the shared views present a kept group as last read:
`deploymentInfo` makes its deployment stale, never live, so its rows wait for
a current read (`rowStale`) and the switcher does not count it live, and
`deploymentPanel` makes its panel at its read time. A group inside the keys,
of unknown key or from a saved route (`registrationPresent` false) that the
answer does not list is gone.

Each window's sidebar roster, and its Workspace › Machines tab when shown, re-read
every 4 s while that window is focused and every 30 s (the blurred cadence)
while it is not (`renderer/roster-cadence.mjs`); focus returning reads the
sidebar at once. The server
observes no faster while blurred, so an unfocused window's extra reads would
show nothing new.

## The CLI probe is compared, not trusted by identity

A window focus re-probes the CLI (`POST /api/cli/reprobe`, whose body names
nothing: the chosen binary is the choice file main writes after its own file
dialog, which the server reads as each probe starts). The probe
generation — the revision every pending deployment read is admitted under —
moves only when `probeSignature` (`packages/client/cli-probe-contract.mjs`:
everything but `probedAt`, `tried`, `source` and the warm reader's `reader`) changes. An unchanged probe
updates the diagnostics in place, cancels nothing and wipes nothing. The
renderer's `cli-status.mjs` applies the same rule before notifying its
subscribers (which treat a notification as "the CLI changed"), so the focus
reprobe is a no-op end to end. A changed bin, version, feature list, API
integer or remote list still invalidates as before.

## `--max-age` (kernel feature `observe-max-age`)

When the probe declares the feature, the read adapters
(in `packages/client/`: `deployment-read-cli.mjs`, `workspace-cli.mjs`, `cli-adapter.mjs
cliCapability`) append `--max-age <seconds>` to status, workspace status,
souls, capabilities and inspect: `0` for the first cycle of a deployment
(admission), a mutation's follow-up and any `refresh: true`; `60` for
background cycles, key-change re-reads, inspect cache misses and the focus
prompt cycle. Without the feature the argv is byte-identical to the flagless
one whatever the caller asked. Reuse is local only: a routed call (`--server`)
never carries the flag, and mutating verbs refuse the option
(`packages/client/deployment-contract.mjs`: `maxAgeArgv`, `validMaxAge`). The kernel
reports `observation` only when the flag was passed; otherwise `observedAt` is
the read's completion time.

## The warm reader (kernel feature `warm-reader`, `readerApi: 1`)

Both observers read through `createWarmReader` (`packages/client/warm-reader.mjs`), a reader
with `cliDeploymentRead`'s signature, so coalescing, the admission bound and probe-generation
revocation stay the observer's. A background read (`--max-age 60`) goes to one long-lived
`oats reader --stdio` child of the accepted CLI, when the probe lists the reader; every live read
(`--max-age 0`) and every read the reader cannot answer runs the CLI as before. The cadence does
not change; a cycle's reads may queue behind each other in the reader, which answers one at a time.

- **One answer, one check.** The reader's answer goes through the CLI read's own validation
  (`deployment-read-cli.mjs` `deploymentReadAnswer`, with `deploymentReadRefusal` and
  `deploymentReadArgv`, which both routes use). The line is bounded before it is parsed and
  parsed once. The reader's stderr is ignored, as the CLI read's is.
- **Start and trust.** It starts on the first background read under a probe record. That read,
  and every read before its hello, is the CLI's: no cycle waits for it. Only a hello within the
  CLI read's timeout, with the probe's version and the read listed, makes it answer. A wrong
  hello means the CLI until the probe changes. The reader belongs to the probe record it started
  for (all of its gate-relevant fields: the observer passes them all), and a read under another
  record ends it. No reader starts while the environment's PATH has a relative or empty entry: the
  CLI runs in each read's deployment, where such an entry may find another `node` for the CLI's
  `#!/usr/bin/env node`, and one reader cannot follow it there.
- **Failure and fallback.** A refusal sends that read to the CLI. An exit, a timeout (from when a
  request becomes the oldest unanswered one), `E_READER_DEFECT` or an oversized line sends every
  read in flight to the CLI. It also holds the next start back 1 s, doubling, and after 5 in a row
  without an answer the CLI is used until the probe changes. `E_READER_STALE` (the install
  changed) re-probes the CLI (`reprobeCli`), and the next reader starts only after that probe.
- **Lifetime.** The server holds the reader's stdin and closes it on exit. A killed server's stdin
  closes with it, so the reader ends with the server however the server ends, as the server ends
  with the app (#698).
- **Seen nowhere.** `/api/cli` carries `reader: { state, code }` for diagnostics. It is a probe
  diagnostic field, so a change in it is never a CLI change for the renderer, and no page reads it.
  `state` is `off`, `idle`, `starting`, `ready`, `backoff`, `stale`, `mismatch`, `given-up` or
  `stopped`. `code` is the last refusal or failure: the reader's own `E_READER_*` refusal codes, or
  this client's `E_READER_EXIT`, `E_READER_HELLO_TIMEOUT`, `E_READER_TIMEOUT`,
  `E_READER_OUTPUT_LIMIT` or `E_READER_MISMATCH`. `off` with `E_READER_PATH` means the PATH has a
  relative or empty entry, so every read is the CLI's (above).

## Contract additions (renderer-facing, additive)

`/api/panel`, `/api/agents`, `/api/workspace-sync` read and `/api/capabilities`
inspect carry `observedAt` (ISO string or null) and `refreshing` (boolean).
A failed `/api/workspace-sync` read also carries `lastGood` (`{ capabilities,
observedAt }` or null). Existing fields are unchanged.

An explicit `?ws=` the server does not serve on `/api/panel` or `/api/agents`
is a 404 `E_WORKSPACE_NOT_SERVED`, never the first workspace's answer
([desktop-deployment-model.md](desktop-deployment-model.md)).

## Testing

- Unit: the keyed catalog's behaviour through `test/soul-catalog.test.mjs` and
  `test/capability-catalog.test.mjs` (both with a fake clock: no kernel run
  past the TTL without a request; a request answers at once with
  `refreshing` and starts exactly one re-read, shared by concurrent requests
  and cycles; Refresh live); `test/inspect-cache.test.mjs`. In the
  repository's root `test/`: `client-soul-catalog.test.mjs` and
  `client-inspect-boundary.test.mjs` (two catalogs, caches or boundaries
  share nothing; terms required; `exec` forwarded), `client-soul-rows.test.mjs`
  (the `/api/agents` rows against the backend's output before the move) and
  `client-soul-facts.test.mjs`;
  `test/refresh-loop.test.mjs` (fake timers); `test/max-age.test.mjs` (flag
  gate per adapter); `test/cli-probe-signature.test.mjs`,
  `test/cli-status-parity.test.mjs` (emit on change);
  `test/window-activity.test.mjs`.
- The warm reader: its client rules against a stand-in reader in
  `test/warm-reader.test.mjs` (fake timers for backoff and deadlines; each answer checked against
  `cliDeploymentRead`'s for the same output); in the root `test/`,
  `desktop-warm-reader-lifeline.test.mjs` (the real server SIGKILLed, and its parent with
  long-lived children: the reader exits) and `desktop-warm-reader-kernel.test.mjs` (the client
  against the kernel's own `oats reader --stdio`).
- The shipped server with a scripted fake kernel:
  `test/load-path-server.test.mjs` on `test/helpers/load-path-server.mjs`.
  The fake logs every call at start and at end and **gates** the verbs the
  test names: a gated call waits after its start line until the test releases
  it, so every ordering asserted (souls started with the roster reads, the
  roster published before souls landed, two identical inspections one kernel
  run) is controlled, never timed — no delays, wall-clock waits or margins.
  Cycles run on demand: the server is blurred for the whole test (30 s
  cadence, out of reach) and a focus flip runs one prompt cycle; the cadence
  and the blur back-off themselves are proven with fake timers in
  `test/refresh-loop.test.mjs`. It proves the cold cycle, held catalogs,
  coalescing, the unchanged-focus no-op, the catalog landing before and after
  publication, the mutation follow-up and the `--max-age` gate on and off, in
  a few seconds (50/50 in a loop under a saturated CPU).
- Against a real deployment: `node server/oats-web.mjs start --socket <private
  dir>/s --token-file <0600 file> --dir <deployment> --oats-bin <timing shim>`
  (the README's [server entry](../README.md) shows how to make both) and poll
  the endpoints over the socket with the credential; never launch the packaged
  app for this.
