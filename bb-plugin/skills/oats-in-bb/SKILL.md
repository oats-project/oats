---
name: oats-in-bb
description: "How OATS agents appear in bb with the OATS plugin, and how to stop, start, restart, retire or spawn one so OATS and bb agree. Use when the person asks about an OATS agent shown in bb, when a thread is an OATS agent, or before stopping, archiving or deleting such a thread."
---

# OATS agents in bb

The OATS plugin shows this machine's OATS deployment inside bb. It draws and asks; it owns
nothing. Agents, their homes, their identities and their mail stay OATS's and aweb's. Every OATS
fact on screen comes from the `oats` CLI's `--json` answers, every bb fact from bb.

## What is on screen

- **The sidebar's thread list.** At the top, the workspace line (`<workspace> · <machine> ·
  N agents`), four rows (Souls, Capabilities, Teams, Machines) and "N need you". Then **Agents**:
  the deployment's agents that run in bb, as a tree, children under their parents. A row is the
  thread's title, the soul under it, and a dot: amber needs you, green working, hollow idle, grey
  stopped, red error or unreachable. `?` at the end means it waits on the person, `new` that the
  thread is unread. Then **Other threads**: every bb thread that is not an OATS agent, as usual.
- **Under an agent's thread header**, one line of chips: soul, instance, aweb alias, parent
  (a link when the parent runs in bb), number of children, home, and `OATS`, which opens the home.
- **The OATS home** (the Bot entry in bb's navigation, with a count when agents need the person;
  the same view is a tab in a thread's side panel): Needs you, Working, and Finished, not looked
  at. "Idle" is never "finished": bb cannot tell a settled agent from one that is waiting, so the
  plugin only reports what OATS reports.
- **Souls, Capabilities, Teams, Machines**: what `oats souls`, `oats capabilities`, `oats teams`
  and `oats server list` answer for this deployment.

A thread with no OATS agent behind it is an ordinary bb thread. An agent that runs on tmux is
listed on its soul's page, not in the tree.

## Stop, start, restart, retire: through OATS

Use the thread menu's **Stop agent (OATS)**, **Start agent (OATS)**, **Restart agent (OATS)**
and **Retire agent (OATS)**, or the `oats` CLI. They go through OATS, so a stopped agent stays
stopped and a retired one releases its home and identity. Stop and Retire show OATS's plan first
and ask once.

bb's own controls cannot be hidden, and they do not tell OATS:

- **bb's composer Stop** interrupts the turn only: OATS does not record the agent as stopped.
- **Archive and Delete** remove the thread from bb only. The agent's home stays; the agent leaves
  the tree and shows on its soul's page as "thread missing", with Start and Retire. Nothing is
  retired by deleting a thread.

So: to stop an OATS agent, use "Stop agent (OATS)". To remove one, use "Retire agent (OATS)".

## Spawning

A soul's page has the form: a name (lower-case letters, digits and dashes), a task, **Preview**
(what `oats spawn --preview` would do: modules, teams, launch, warnings, problems) and **Spawn in
bb** (`oats spawn --backend bb`), which opens the new agent's thread. A soul that cannot be
spawned shows OATS's reason instead of the form.

## Answering an agent

Answer in the agent's thread, as in any bb thread, or from the OATS home: a card under "Needs you"
shows the question, and the reply box at the bottom of the home page sends a message to the agent
you pick. That is bb's own send, as the person at the screen.

## When something is missing

If OATS cannot be read (no deployment found, `oats` not installed or failing, several machines and
none chosen), the sidebar shows one line saying what is missing, with Retry, and lists every bb
thread as usual. bb stays fully usable. The plugin's settings (Settings → Plugins → OATS) hold
the deployment directory, the path to `oats`, and the machine that holds the homes.

A refusal from OATS is shown with OATS's own code and message (`E_…`), unchanged: read it, it
names what to do.
