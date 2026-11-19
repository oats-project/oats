## Added

- **The Graph in the Desktop.** Home › Graph, or the palette's **Workspace: Graph**, shows who started whom and where each agent runs in one picture:
  - **Every machine is a column**, this computer first. A machine that isn't reached says so, and why, with **How to fix**.
  - **Agents hang under the agent that started them.** Each node has the roster's dot, the agent's name and its soul. A child doing its parent's work says **same work**. **You** sits above the agents a person started.
  - **A parent on another machine** is a dotted line between the columns, and the node says where it was started from.
  - **Keys.** ← → between machines, ↑ ↓ between agents, Enter opens the agent, **m** shows every agent in one field, **+** **−** zoom and **0** fits. A node's menu has Open terminal, Details, Open soul and Recent events….

  Two things the design shows aren't drawn yet, because OATS doesn't report them: a clock for an agent a schedule started, and a same-work label.

## Changed

- **Machines is the list of your computers.** Its List | Map switch is gone: the Map is now the Graph, a page of its own. ⌘1 / Ctrl+1 still opens Machines.
- **The Machines canvas's node popup is replaced** by Enter and the node's menu. Its deployment tabs are gone too: the Graph's columns name every machine.
