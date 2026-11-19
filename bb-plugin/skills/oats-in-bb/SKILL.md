---
name: oats-in-bb
description: Use when working with OATS agents shown in bb by the OATS plugin - stopping, starting, restarting or retiring an OATS agent from bb, spawning one from a soul's page, reading the sidebar tree and the "needs you" list, or when the plugin shows "No OATS deployment found", "oats was not found" or "choose a machine".
---

# OATS agents in bb

The OATS plugin (plugin id `oats`) shows this machine's OATS agents in bb. Each agent is one bb
thread; the plugin adds who it is and lets a person act on it through OATS. It owns nothing: the
agents, their homes, identities and mail are OATS's and aweb's.

## Rules

- **Stop an OATS agent with "Stop agent (OATS)"** in the thread's menu, never with bb's own Stop,
  Archive or Delete. Only the OATS stop records the agent as stopped, so it stays stopped; bb's own
  buttons leave OATS thinking the agent should run.
- **Start, Restart and Retire** are in the same menu. Stop and Retire show the kernel's plan and
  ask once. Retire removes the agent's home; its work tree and branch are kept unless the plan says
  otherwise.
- **A thread archived or deleted in bb** takes the agent out of the tree. Nothing is retired: the
  agent shows on its soul's page as "thread missing", with Start and Retire.
- **Spawn** from a soul's page (Souls, pick a soul, name, task, Preview, Spawn in bb). The name is
  lower-case letters, digits and dashes. The new agent opens in its own thread.
- **Answer an agent in bb**: in its thread, or on the OATS home's "Needs you" cards. A card
  answers in place where the question has plain choices (a permission: Allow once or Deny; a
  question with options; pi's confirm and select); anything richer has Open. The plugin never types
  into an agent for you.
- A kernel refusal is shown with the kernel's code and message (`E_…`), unchanged: act on what it
  says.

## Where things are

- Sidebar: the workspace line, Souls, Capabilities, Teams, Machines, "N need you", then the agents
  as a tree (children under parents), then bb's other threads.
- Under an agent's thread header, one line of chips: soul, instance, aweb alias, parent (a link
  when the parent runs in bb), number of children, home, and `OATS`, which opens the home.
- OATS home (the Bot entry in bb's navigation, with a count when agents need you; the same view is
  a tab in a thread's side panel): Needs you, Working, Finished and not looked at. On the page, a
  reply box sends a message to the agent you pick, through bb's own send.
- A row's end: `?` when the agent waits on you, `new` when its thread is unread.
- An agent that runs on tmux is listed on its soul's page, not in the tree.
- Dots: amber needs you; green working; hollow grey idle; grey stopped; red error or unreachable.
  "Idle" means the kernel does not say the agent is working: it may be waiting or done.

## When the plugin shows one line instead of the tree

| Line starts with | Do |
|---|---|
| No OATS deployment found | open a bb project inside the deployment, or set the directory: `bb plugin config oats set deployment <dir with oats-local.yaml>` |
| oats was not found | install OATS on that machine, or `bb plugin config oats set oatsBin <absolute path to oats>` |
| This bb server has N machines | `bb plugin config oats set host <machine name or id>` |
| an `E_…` code | the kernel refused `oats status`: run `oats status` in the deployment and fix what it says |

bb itself keeps working in every one of these cases: its threads are listed as usual.

## Commands

```sh
bb plugin list                        # is "oats" running?
bb plugin config oats                 # its settings: deployment, oatsBin, host
bb plugin logs oats -n 50             # what it logged
bb plugin reload oats                 # reload it (any oats it was running is stopped)
bb plugin rpc call oats snapshot      # what it reads: the deployment and its agents, or the failure
bb settings ui set sidebar.threadListProvider oats/agents    # when another plugin took the sidebar
```
