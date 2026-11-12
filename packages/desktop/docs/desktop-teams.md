# Desktop teams (team model v2, OATS 0.30; team model 3, OATS 0.38)

The Desktop reads and edits a deployment's teams through the kernel verbs `oats teams` and
`oats soul teams`, on a CLI with feature `team-model-2` (OATS 0.30–0.37) or `team-model-3` (OATS
0.38; `teamModelOf` in `packages/client/team-rows.mjs`). The kernel is the only writer of
`oats-local.yaml`; the Desktop server never writes that file (or `oats-workspace.yaml`) itself.

**Team model 3** ([design](../../../docs/design/2026-10-02-team-model-3.md), the shapes in
[desktop-cli-api.md](../../../docs/desktop-cli-api.md#oats-teams)) commits which teams a soul may
join, and its default, in the workspace's `souls:`. So:

- `oats soul teams` is read only. Under `team-model-3` the soul-teams route admits `show` only:
  an edit is refused with `E_BAD_ARGS` before any process runs, and the removed `--add`,
  `--remove`, `--default` and `--clear-default` are never sent.
- Local teams are a deployment's only where the workspace says `localTeams: true` (or in the
  standalone view, `localTeams: null`). Where they are closed the kernel refuses `oats teams add`
  and `default` before writing, so the Teams page offers neither; it keeps Remove for a local team
  still in `oats-local.yaml`, which the kernel accepts there (proven against the real CLI in
  `test/desktop-team-model-3-kernel.test.mjs` at the repository root).
- What the Desktop says about changing teams is the kernel's own wording: `souls: in
  oats-workspace.yaml (a PR to the workspace file)`, the local-teams-closed message and fix, the
  unmapped fix.

## The Teams board

`renderer/computer-teams.mjs`. One centred column, at most 1120px wide: the page head (the title, its
one line, and **Add a local team** where local teams are allowed), then three sections 40px apart, each
with a sentence-case heading and one muted line:

- **Shared teams**: "Declared in oats-workspace.yaml and shared through Git, so every computer that runs
  the workspace has them."
- **Local teams**: "Only on this computer, in its oats-local.yaml. Not shared." Where local teams are
  closed and none is left, the section holds one dashed paragraph, not a card: "No local teams:
  oats-workspace.yaml does not allow local teams (localTeams: true)." Where they are allowed and there
  is none, an empty card offers **Add a local team**. The add form opens in this section.
- **Which teams each soul may join** (team model 3, not in the standalone view): "And its default:
  souls: in oats-workspace.yaml (a PR to the workspace file)."

The page's own problems (those no card holds) come before the sections, failures first. Each section
puts the default team's card first, then keeps the document's order. A local team's card has a dashed
frame, a shared one a solid frame.

**A card**, top to bottom:

1. **The header.** The label. For the default team, a **Default team** tag and where the default comes
   from: "set by the workspace" or "set on this deployment" (team model 3), "on this computer" before
   it. Then the description, muted. The actions (Make default, Remove) sit on the right of the label row;
   under a 760px container they wrap below the description.
2. **Any problem that blocks spawning** (the kernel's `default: true`, or a failure), as an alert with
   the danger edge.
3. **The facts**, a `dl` of labelled rows. Team model 3: **Default for** and **May join** (the audience,
   below), then **Address**. Before it: **Address**, then **Who may join** (`whoMayJoin`, bold; "No soul
   yet" muted). The address is the provider team id in the mono face, or "no provider id yet" in the warn
   colour.
4. **The team's warnings**, each a tinted box: the message in bold, then the kernel's fix verbatim on its
   own line (said once when the message already holds it).
5. **Why Remove is off** (`teamInUse`), a muted line.
6. **The confirmation** of Make default, or the row's error: a refusal, one sentence and then the
   kernel's code under Details.
7. **The summary foot**: your instances on the team, and "Open team ›" on the right. The cue is
   `aria-hidden`: the label's button carries the action.

**The audience** (team model 3) is two labelled rows, each shown only when it has entries:

- **Default for**: whose default the team is, e.g. "all souls of **lab-ai-engineering**",
  "**writer** (acme-agents)", or, for the document's `defaultTeam`, "every soul without its own
  default" (with "(this deployment's choice)" when it is the deployment's).
- **May join**: who else may join it without it being their default, e.g. "souls of
  **lab-agents** · **ai-reviewer** (lab-ai-engineering)", or "every soul (local team)" for a local
  team where local teams are allowed.

A card with neither says "No soul may join it yet". Repo and soul names are bold, each titled with
the `souls:` key it comes from.

`teamAudience(document, label)` computes both from the committed `souls:` map alone, with the
kernel's resolution (`lib/teams.mjs`): a soul's teams come from its most specific key outright, its
default from the most specific key that sets one, and `any` is every shared team. So an entry a
broader key already implies is never repeated (`lab-ai-engineering/ai-reviewer` defaulting to the
same team as `lab-ai-engineering/*`). A pattern lists as `except` the more specific keys under it that
fall outside, as in "all souls of p except x". Where `"*"` sets a default, no soul falls back to the
`defaultTeam`, and its row says so quietly. Before team model 3 the function answers null, and the
card keeps the team model 2 **Address** and **Who may join** rows, from `whoMayJoin`.
This is a second reading of the kernel's resolution in the renderer. `test/desktop-team-audience-kernel.test.mjs`
(at the repository root) pins it to the kernel: for each fixture it resolves every concrete soul with
`soulTeams` and checks each team's audience against it. A change to resolution in `lib/teams.mjs` must
keep that test green, or change `teamAudience` with it.

**The foot's words** (`memberSummaryParts`, joined into one string by `memberSummary`): "N of your
instances", then ", M on other machines" when some run on another machine, then ", <machine>[,
<machine>] not reached" in the warn colour for the team's machine groups whose last read failed (each
machine once). With no members it reads "None of your instances". The foot is empty until the members are
known, and for a team with no provider id; a board without `onOpenTeam` leaves an empty foot out.

**How a card opens.** With `onOpenTeam`, the label is a `button.ct-open` inside the card's `h4`, named by
the label and described as "Opens the team's page with your instances on it". Its `::after` covers the
card (the card is `position: relative`), so a click on the card opens the page. The card's other
controls (the actions, the confirmation, the row error, links) sit above it, and so do its problem boxes
(blocking and warnings), so their text, a fix to copy, can be selected, and a click on them opens nothing.
A card is therefore one Tab
stop, and the focus ring is the shell's own, on that button. Hover frames the card in `--tree-line` and
underlines the label.

**The type steps** (shared with the Setup tab): screen title 24/700, section heading 18/650, card title
17/700, primary facts 14/600, body 13, secondary 12 in `--muted`, tags 11.5/600. Contrast comes from size,
weight and `--muted`, never a new colour; mono is for paths, ids, addresses and patterns only, 1px above
the sans step it stands in for.

**The souls table** (team model 3) is a real table in a card, one row per `souls:` key in document order:
**Souls** (the pattern in mono, its folder up to the last `/` muted; `*` reads "* every soul"), **Default
team** (a tag, or a muted "none") and **May also join** (the other teams as tags, without the default;
`any` is "any shared team"; else a muted "none"). Under a 760px container each row stacks: the pattern on
its own line, then the two cells. Its explicit table roles keep the semantics through that. An empty
`souls:` says so in a card.

## A team's page

A card opens its team's page through `onOpenTeam(label)`, an option of `createComputerTeams` that
`renderer/workspace-discovery.mjs` wires to `openTeam` in `renderer/views/spawn.mjs`. spawn.mjs shows it
as the Workspace page mode `"team"`, beside the soul and capability pages: the page's bar replaces the
Workspace header and tabs, and `s.teamOpen = { label, scrollTop }` keeps the board's scroll offset, which
hiding the board drops. The Teams controller paints it: `showTeam(host, label, { onBack, onGone })` puts
the shared `pageBar` (Back, named "Back to Teams"; Workspace / Teams / the label) and the page's content
in the host, and answers false when the document has no such team. Opening focuses Back, and claims the
selection intent (`nextSelectionIntent`) as any explicit choice does, so an older handoff still waiting (the
shell opening a Workspace tab, such as ⌘N or ⌘1, while it imports the page; a preselect) cannot
replace the page once it lands.

The page, top to bottom:

- **The team's card**: the board card's header, problems, facts, warnings, why Remove is off, actions
  and confirmation flows, with the label as the page's `h2` at 24px. It has no foot and opens nothing.
  The Workspace header is hidden with its scope line, so in a view of two or more deployments the card
  says which one its actions edit under the label ("On This Mac · ~/acme"), from its own
  `createDeploymentScopeLine`, which lives as long as the page. A failed read of the document ("The teams
  on this computer could not be read.", or the kernel's refusal) shows in the card after its
  confirmation, as the board says it, so the page never shows stale facts silently; the add form's
  errors stay on the board.
- **Your instances on this team**, a section headed as the board's are, with the line "On this computer
  and the machines you added to this workspace. Instances other people run on <label> are not listed
  here." That is what `/api/team-members` answers: the view's deployments only ([Team
  members](#team-members)).
  - **The counts**: N instances, R running, then S stopped and A need(s) attention (in the warn colour)
    when they are not zero, and "on M machine(s)" on the right. R counts the members that are running and
    can be opened, A those whose state is `warn` (`stateKind`), S the rest; this computer is one machine,
    each server another. For the default team a muted note follows: "Every instance joins its default
    team, so all of your instances are here."
  - **One card per machine group** (`memberGroups`, this computer's first): a `role="group"` named by its
    machine (with its short path where two groups share a machine), under a head band with the machine,
    the deployment's short path (the full path as its title) and "N instances, R running". A group not
    reached reads "not reached" in the warn colour, with the error as the head's title.
  - **A table per card** (`role="table"`, named "Your instances on <label> on <machine>"). The cards sit
    in one grid (`.ct-mcards`, the only place the columns are set); each card, its table and its rows
    are subgrids of it, so every name on the page sizes the same columns and they line up from machine
    to machine. The columns: **Instance** (the soul's
    mark, titled with the full agent, and the name button; a leading `<soul>-` is muted so the rest
    stands out), **Soul** (`soulShort`, the full agent as title), **State** (a pill), **Created**
    (`ageText(createdAt)`, the exact timestamp as title; empty when the route sends none) and a visually
    hidden **Terminal**.
  - **Names come first.** From a 760px container up, a name's cell is as wide as the name and the Soul
    column gives way. The name is cut only past `--ct-name-room`: the page's width less everything else
    on its row (paddings, borders, the mark, the other columns at their least; below 900px State keeps
    96px). Real instance names (lowercase slugs up to 50 characters) stay whole from a 760px container
    up, and a name is never cut while its row has room; one made only of wide letters may be cut, whole
    in its title. Created hides under a 1000px container and
    Soul under 900px to make room. Under 760px Instance, State and Terminal remain, and a name too long
    for its cell is cut with an ellipsis, whole in its title.
- **The empty states**, each a dashed paragraph: "This team has no provider id yet, so no instance can be
  on it.", or "None of your instances is on <label>." Until the members are known, the section shows its
  heading and nothing else.

**Repaint.** The page follows the pages' rule, not the board's redraw barrier. At each render and each
roster poll it computes a signature: the team's document entry with its problems, audience and why Remove
is off, the default, the card's own state (a mutation in flight, its confirmation, its row error, a failed read), and its
members and machine groups. It repaints only when that changes, and puts focus back by `data-focus-key`
(a member's controls are keyed by its deployment and instance name), else on Back. The Created ages are
updated in place at each poll, without a repaint.

**Closing.** Back and Esc (not from a text field) return to the board at its scroll offset and focus that
card's `.ct-open`. A tab change closes the page. A team that leaves the document closes it: removed (here,
from its own page once the document answers, or elsewhere), or the workspace changed or switched. There is
no card to return to then, so the Teams tab takes the focus when the page held it. However the page closes,
a Make default confirmation open on it closes with it (`hideTeam`), which releases the board's redraw
barrier and takes the confirmation off the board's card.

## Routes

Both are `POST` with exactly one `?ws=<view id or deployment id>` and a JSON body of at most 4 KiB.
The teams configuration is one deployment's: a view id is read as the view's primary deployment
(its first local one, else its first; see
[workspace views](desktop-deployment-model.md#workspace-views-and-deployments)), and in a view of
two or more deployments the configuration says which under its heading ("On This Mac ·
~/acme"). A remote primary is `unsupported-remote-operation`: teams are edited on the
computer that runs the deployment.
They sit behind the server-wide credential check and Host and Origin guards (loopback only; a foreign, `null` or
malformed `Origin` is 403 before any process), so a cross-origin page cannot rewrite the file.
The renderer reaches them through the generic guarded proxy (sender-frame guard, `ws` pinned to
the connected server's view and deployment ids, 20 s deadline; the verbs run with a 15 s timeout).

`POST /api/workspace-teams`: `{action}` is one of:

| action | fields | kernel argv |
| --- | --- | --- |
| `list` | none | `oats teams --dir W --json` |
| `add` | `label`, `team`, optional `description` | `oats teams add <label> --team=<id> [--description=<text>] --dir W --json` |
| `remove` | `label` | `oats teams remove <label> --dir W --json` |
| `default` | `label` | `oats teams default <label> --dir W --json` |

`POST /api/workspace-soul-teams`: `{action, soul}` plus:

| action | fields | kernel argv |
| --- | --- | --- |
| `show` | none | `oats soul teams <soul> --dir W --json` |
| `add` / `remove` | `labels` (1–64) | `… --add=<a,b>` / `… --remove=<a,b>` |
| `default` | `label` | `… --default=<label>` |
| `clear-default` | none | `… --clear-default` |

Under `team-model-3` only `show` runs; every other action is `E_BAD_ARGS`.

## Arguments

- **Argv only.** No shell is involved.
- **Positionals are grammar-bound:**
  - a label follows the workspace label grammar;
  - a soul is a bare name, `<package>/<soul>`, or `*`, where `*` takes no default.
- **No value can become a flag.** Every option value travels as one `--flag=value` token, which the kernel reads as `--flag value`.
- **A team id** is the aweb `<name>:<namespace>` shape.
- **A description** is bounded printable text, never `-`-led.
- **The request's keys are closed** for each action.
- **Anything else is `E_BAD_ARGS`,** refused before any process runs.

## Results

The shape is the lead's (0.30 D2 review):

- **Success:** `{status: "ok", teams}` (`/api/workspace-teams`) or `{status: "ok", soulTeams}` (`/api/workspace-soul-teams`). The value is the decoded kernel result:
  - `teams` is `teamsData`, with `teamsApi`, `deployment`, `defaultTeam`, `teams`, `souls`, `problems`, and `changed` on a mutation. Its `deployment` must be this workspace's, or the answer is `E_DEPLOYMENT_SCOPE`. With `teamsApi: 1` the `defaultTeam` is a label and `souls` is `{teams, default}` by soul key; with `teamsApi: 2` it adds `localTeams` (`true`, `false`, or `null` standalone), the `defaultTeam` is a `DefaultTeam` (`from`: `deployment` or `workspace`), and `souls` is the workspace's `souls:` as committed (`{<pattern>: {default?, teams?: [labels] | "any"}}`). A problem keeps its own keys: a `souls:` `key` (`team-soul-unknown`), the local-teams-closed `condition`, `path` and `keys`.
  - `soulTeams` is `soulTeamsData`, with `soulTeamsApi`, `soul`, `key`, `defaultTeam`, `teams` (+ `via`) and `changed`; `soulTeamsApi: 1` adds `local` and `all` (`via`: `default`, `*`, `soul`), and `soulTeamsApi: 2` adds `match` and `defaultMatch`, the `souls:` keys its teams and default came from (`via`: `default`, `workspace`, `local`).
- **Refusal:** `{status: "refused", reason: {code, message, details?}}`.
  - **The kernel's code and message** pass through verbatim, and a message is always present.
  - **The team refusals** carry their bounded details: `E_TEAM_IN_USE` (`label`, `usedBy`: `defaultTeam`, `souls.teams:<key>`, `souls.default:<key>`), `E_TEAM_SHARED` (`label`, `at`), `E_TEAM_EXISTS`, `E_TEAM_UNKNOWN` and `E_TEAM_NOT_ELIGIBLE` (0.37 and earlier). A local-teams-closed `E_WORKSPACE_SCHEMA` keeps `reason`, `path` and `keys`.
  - **The Desktop's own codes** come with a plain message: `E_TEAMS_UNAVAILABLE` (neither team model, e.g. on 0.29: a clear refusal, no kernel call), `unsupported-remote-operation`, `E_WORKSPACE_UNKNOWN`, `E_BUSY` (one mutation per deployment at a time; reads are not blocked), and `E_CLI_PROTOCOL`.
- **Actions** come from a closed allow-list: each builds its own argv, and the action string is never passed through.

## Team members

`GET /api/team-members?ws=<view id>` answers who is in each team across the view's deployments
(`packages/client/team-members.mjs`, called by `teamMembersFor` in `packages/client/panel-views.mjs`). A deployment id is read as the view that holds it.

- **The view's deployments only.** Its local deployments' rosters and its remote groups' panels;
  never another workspace's groups. Any view is answered, a view with no local deployment
  included.
- **Held observations only.** It runs no command and adds no ssh: remote groups are read as the
  remote roster loop's one `oats server roster` read left them. The server-wide credential check and Host guard apply,
  and the proxy pins `ws` to an advertised view or deployment id.
- A missing or repeated `ws` is `E_BAD_ARGS`; one that names no view is `E_WORKSPACE_UNKNOWN`.

```json
{"members":[{"workspace":"<deployment id>","deployment":{"id":"<deployment id>","machine":"This Mac","path":"…"},
  "server":null,"serverLabel":null,"instance":"…","agent":"…",
  "agentsRoot":"…","home":"…","team":"<identity.team>","running":true,"addressable":true,"missingRemotely":false,
  "reason":null,"reasonLabel":null,"createdAt":"…"}],
 "servers":[{"server":"<id>","label":"…","group":"<group id>","deployment":"remote:<group id>","reached":true,"error":null,"registered":true}],
 "notReached":[{"server":"<id>","label":"…","deployment":"remote:<group id>"}]}
```

- **`members`**: every row whose `identity.team` is a non-empty string: the view's local deployments'
  rows, then each remote group's rows. `workspace` is the member's deployment id, which every action
  on the member is addressed to; `deployment` names it with its machine. `running` is `null` when
  unknown; `reason` and `reasonLabel` are the roster's own reason the row can't be opened and its
  short label (`rowReason`), or `null`. The same instance seen from two machines is two members.
- **`servers`**: one entry per remote group of the view. `reached` is the group's last roster read;
  `registered` marks the group the server's registration targets (where `spawn --server` goes).
- **`notReached`**: every group of the view whose last read failed and that holds no rows,
  last-known or current. Before the first roster answer there are no groups, so nothing is named.

**On a team's page** (`renderer/computer-teams.mjs`, read on mount and at each roster poll; the layout is
in [A team's page](#a-teams-page)):
- A team with a provider id lists its members, grouped by deployment and named by machine
  (`memberGroups`): this computer's deployments first, then the others by label; within a group by
  instance name, then home. An unmapped team lists none.
- The **name** is a text button that shows the member's roster row ("Show <instance> in the roster").
  **Terminal** ("Open <instance> terminal on <machine>", "this computer" for a local member) is there
  only when the member is running and addressable. The list holds no disabled buttons.
- The **state** is a pill whose word carries it, never its colour: "Running" (running and addressable),
  "Stopped", or, in the attention tint, the roster's short label verbatim ("gone from X", "not reachable
  on X", "X not reached"), else `unknown` or `gone`. A member that can't be opened has the full reason
  (`openBlocked`) as the pill's title and description.
- Both buttons go to the member's deployment (its id answers the view that holds it), wait for the row
  by server and home (`handOff` in `views/spawn.mjs`, shared with the remote spawn), then open it or
  select and focus it (`ctx.showInRoster`).
- A remote deployment whose last read failed keeps its last-known members. Its machine card reads "not
  reached", in the warn colour, and carries the error as its head's title; its members' state says why
  (the roster's label, else `unknown`).

**On the board**, each card's foot sums these members up ([The Teams board](#the-teams-board)), and:
- `notReached` is said under the page head: "Not reached: <label>, …. Their members aren't shown until
  they answer." That status line follows every answer, even while the cards wait under the redraw
  barrier.
- A roster poll redraws the board only when who is in a team, or their state, changed, and never under
  the redraw barrier: an open form, a pending confirmation, a change in flight, or focus inside the
  board. The barrier is the board's alone: an open team page follows its own repaint rule.

**Where to run** (the spawn dialog, at the form's top level just above Relationship), in a view with
one deployment: "This computer", then each registered server (`/api/servers`). With a CLI that has
`servers-per-workspace` and `server-connect` it lists only the machines of the window's workspace and
ends with **Add a machine to this workspace…** ([desktop-machines.md](desktop-machines.md)). In a view
with two or more deployments the **Deployment** field replaces it (`renderer/spawn-deployment-field.mjs`;
see [the deployment model](desktop-deployment-model.md)).
It takes its disabled states from this route's `servers`, read for every view that holds a remote
deployment (a server's registered group may belong to another view than the one on screen), using the
registered group of each server: "(not registered)" when the server has groups but none is the
registration's, or "(not reached)". A server with no group in the view (before its first answer, or
running another workspace) stays enabled: nothing is guessed.
A server is never disabled for its souls: the roster lists only the souls spawned there before, not
those its workspace offers. The host's kernel refuses a soul it doesn't offer, and the dialog says
that refusal in its own words ("Couldn’t spawn on <server>: <message>"). With a server
chosen, the relation picker lists that group's rows (`/api/panel?ws=remote:<group>`): relations never
cross machines.

## Fixtures

`test/fixtures/team-model-v2/` holds **real captures** from the K1 kernel (oats
`feat/030-team-model`, commit in `provenance.json`). `capture-teams-v2.mjs` ran them on a scratch
Northwind build, using the Desktop's exact argv:
- the verbs and their real refusals;
- every other v2 document the Desktop reads (souls, workspace status, capabilities, inspect,
  preview, status, readiness).

`import-capture.mjs` imports them, with provenance and hashes.

`test/fixtures/team-model-3/` holds **real captures** from this repository's 0.38 kernel
(`capture-teams-3.mjs`, the commit in `provenance.json`), on a scratch Northwind built outside any
git tree, with the Desktop's argv: local teams closed (the default, then with local teams present)
and allowed, the verbs and their refusals, the removed soul-teams flags, and the souls, readiness
and preview team rows.

**Awaiting oats.aweb 1.17:** the messaging provider's teams document (`operation run
messaging:teams`). Until its capture exists, `team-model-v2-tolerance.test.mjs` reads the real
oats.aweb 1.16 capture (`workspace-v2/teams/teams-initial.json`), edited to K1's documented v2
shape. `provenance.json` records this under `awaiting`.
