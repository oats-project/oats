---
name: oats-tailor-workspace
description: >-
  Use when you are a workspace's setup expert, the workspace is new, and the
  getting-started skill has handed it over: turn OATS's defaults into this
  workspace's own coordination and knowledge capabilities for its use case,
  and a tasks capability beside a tracker it already uses, attach the person
  to the workspace's messaging account, tie the agents to the person where
  the messaging capability offers it, offer the approved channel route, and
  brief the person. Procedure only; the setup
  and config procedures it points to are oats.setup's, and the coordination
  practices it adapts with are oats.coordination-setup's. Part of
  oats.onboarding.
---

# Tailor a new workspace to its use case

OATS's defaults are a starting template, not the answer. This skill turns
them into the workspace's own capabilities, shaped by how this team already
works. Do the steps in order. Apply `oats.setup`'s briefing throughout: you
run each step, and the person types only secrets, logins and the installs
that capture their shell.
Talk to them in everyday words, as `/oats-setup-expert` says, in every
question and in the brief (step 6), and show them what they must act on
exactly, as it says.

## 1. Discover the use case

This is discovery, not configuration. Change nothing yet. Read:

- the hand-over, and the project itself (its repositories, their README and
  contributing docs);
- the tools already in use: the tracker, the knowledge system (a wiki, a docs
  repository, OKF), CI;
- how review and merge work on GitHub: who reviews, who merges, required
  checks, branch protection and rulesets (the reads in
  `/oats-workspace-config`, "Change a shared file");
- the size of the organization, and how many people will run agents;
- one repository or several;
- Slack, if it is connected and the person allows you to read it.

When you carry `oats.coordination-setup`, load `/adapt-to-the-organisation`
now: its reads (step 1) join these, and its questions (step 2) join this
round.

Then ask the person only what that leaves open, in one round.

## 2. Author the core capabilities

Author coordination and knowledge, and tasks when its rule below says so, as
plain capabilities of this workspace: `capabilities/<name>/` in a member
repository, committed by the briefing's rule for shared files. They are the workspace's own files, not
package pins, and they need no packaging. The manifest's shape is in the
installed kernel's `docs/capabilities.md`.

Copy each from OATS's default and adapt it to what step 1 found. Run **one
sub-agent per capability you author**, on the strongest model available
(one for the coordination capabilities together), each with step 1's
findings and its starting point:

- **Coordination**, from the engineering package `oats.engineering`
  (`oats.maintainer`, `oats.engineering-expert`, `oats.developer`,
  `oats.code-review`) as the template, adapted by
  `/adapt-to-the-organisation` (`oats.coordination-setup`): its roster of
  souls (`/design-the-roster`) and its landing rules (`/set-landing-rules`).
  Its reads and questions were step 1's. Here, design, and send each person
  their proposal card (a message to that person with your recommendation); on
  each yes, the sub-agent writes the coordination capabilities. Without
  `oats.coordination-setup`, adapt the template yourself. With or without
  it, the capabilities must cover:
  - the roles the roster keeps (`/design-the-roster`), or without it the
    template's four, adapted to their review and merge rules and to their
    size;
  - the Desktop's grouping (from OATS 0.69.2): a top-level agent is spawned
    without `--same-work`, a feature's agents with it, and each group has one
    colour (`oats instance color`, from OATS 0.67.0);
  - with several people, coordination across humans: taught to the agents,
    and explained to the people.
- **Knowledge**, from the knowledge theory (`oats.knowledge-theory`'s
  `/knowledge-capability-authoring`). If they use OKF, start from `oats.okf`;
  otherwise write a capability over what they already have. It must cover
  what is worth keeping (decisions, rejected alternatives, discoveries,
  lessons; never descriptions of the code), and that agents consult it before
  they act.
- **Tasks**, by the tasks default the getting-started skill wrote
  (`defaults.tasks` in `oats-workspace.yaml`, and the hand-over's Tasks
  line). One rule per case:
  - **aweb's task list by default** (no tracker found): with
    `oats.aweb-tasks`, keep it unless the person switches. Author no
    tasks capability.
  - **Beside a tracker** (`tasks: none`: GitHub issues, or another tasks
    tool): offer to make a tasks capability for their use case. Look first
    at how they work: their labels and states, who files issues and who
    closes them, and what agents may do there. Build it with the person, as
    this workspace's own capability (over `gh issue` for GitHub issues).
    You hold that conversation with the person yourself; a sub-agent only
    writes the files after it. Its manifest declares `"layer": "tasks"`
    (the installed kernel's `docs/capabilities.md`). For a tool the catalog has a provider for (`oats.jira`, `oats.linear`),
    copy that provider as the starting point, as above. It must expose what
    agents can operate, and say what stays with humans. On their yes, it
    replaces `none` as the tasks default. Don't leave `none` without asking,
    and don't pin a generic provider in its place. On their no, `none`
    stays, and step 6 says so.

  Never name a second tasks provider in a soul's `capabilities:` beside a
  default (`E_SLOT_CONFLICT`): the workspace's tasks capability goes in
  `defaults.tasks`.

Check each draft against step 1 before you commit it: our default's
assumptions that this team does not share come out.

Then the souls that use them: file shapes in `/oats-workspace-config`,
`soul.yaml` (v2). Name each capability with `{ from: <repo key> }` of the
member that holds it. After the change is on the default branch, sync and
check each soul by `/oats-onboarding` cards 6 to 8:

```bash
oats sync
oats souls --json
oats spawn <soul> --preview --json
```

This machine's `souls.launch."*"` (the getting-started skill sets it) wins
over a new soul's own `launch:`. For each new soul whose
`launch.declared.harness` in `oats souls --json` differs from that
default and is installed and logged in on this machine, give it its own
entry with its declared harness before its first spawn, by the row's
`key`, with `--model <its model>` when it names one, plan first (from OATS
0.53.0): `oats soul launch set <key> --harness <its harness> --plan`,
then without `--plan`. A declared harness that isn't installed here stays
under `'*'`, so the soul can run; tell the person.

## 3. Attach the person to the messaging account

This is a normal step, not an option. When getting started created the
workspace's messaging account for the workspace, without the person's
sign-in, that account belongs to nobody yet. Attach it to the person now.

- The act comes from the messaging capability's own skill. With aweb, the
  default, it is `/oats-aweb`'s "attach yourself to the account" step, from
  the `oats.aweb` release that ships it. It asks for the person's email
  address.
- The answer is one of three:
  - **Attached:** the account is theirs now.
  - **Waiting on their email:** tell them to check their mail and click the
    link in it. The account is theirs only once they have; until then, step
    6 reports it as waiting on them.
  - **Refused:** tell them what it says. The account stays unattached, and
    step 6 says so.
- Skip it when the person signed in to their own account at getting started:
  that account is already theirs.
- If the messaging capability's skill names no such step, say so in step 6,
  as information.

Until the account is theirs, say that the team is on a messaging account
created for the workspace. Never say it is the person's.

## 4. Tie the agents to the person, for human attribution

This is a normal step, not an option, where the messaging capability offers
it. It ties this deployment's agents to the person who runs them.

- **First, look for the step.** It comes from the messaging capability's
  own skill: with aweb, the default, `/oats-aweb`'s attribution step, from
  the `oats.aweb` release that ships it. If that skill names no such step,
  run nothing: no terminal step and no respawn. The deployment has no bound
  human, and its agents report attribution as `unknown`. Say so in step 6,
  as information, never as a failure: it comes with a later messaging
  release.
- **Also run nothing** when the person's aweb key is self-custodial (kept
  on their own computer behind a passphrase), or the account is not on
  aweb Cloud: neither has a click path. Say in step 6 that their agents
  stay unattributed and keep working.
- **What the step does, where it exists** (awebai/oats#1665): **agents run
  every command, and no agent holds the person's signing key**. The
  person's one act is a click: in their aweb dashboard, they approve the
  request you start. Before the click, tell them exactly what the page will
  show: the agent's address, the domain, this deployment's name and the
  key's fingerprint. They type no command and no passphrase for it.
- It needs the account to be theirs first (step 3, or their sign-in at
  getting started).
- Agents already running, you included, are attached in place: no respawn
  and no new identities. Agents spawned later carry the chain from the start.
- A declined or expired request leaves nothing signed. Report it to the
  person; never start another request on your own.

Until an agent actually carries a chain, never say the team or the agents
are bound or attributed. Once the account is theirs (step 3, or they
signed in at getting started), say that the team is on their account (with
aweb: "your aweb account").

## 5. The approved channel route

This is also a normal step. The getting-started skill left the harness's
development channel mode, which the kernel confirms at each start. Offer the
approved route: for Claude Code with aweb, `/oats-host-delivery`, "Claude
channel delivery (approved route)". Writing the managed-settings file needs
`sudo`, so the person runs it in their own terminal. Homes started before the
change keep development mode until they are respawned.

## 6. Brief the person

In the session, plainly:

- what each of their agents now does, one line each, and where that is
  written down, said plainly ("in your project on GitHub");
- how to work with the agents: who to talk to first, and how the roles hand
  work to each other;
- with several people, how coordination across humans will run;
- who merges in each of their lanes, and which decisions stay theirs;
- whether the account is theirs, waiting on their email, or unattached
  (step 3);
- whether their agents are tied to them yet (step 4); if not, why (it
  waits on a later messaging release, or their key or account has no click
  path), and that the agents keep working;
- beside a tracker, how their agents now use it, or that nothing connects
  them to it yet (step 2);
- what is open, and who decides it.
