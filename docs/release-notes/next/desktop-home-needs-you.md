## Changed

- **Desktop: Home shows what needs you, and the Workspace page has its own row.** Home no longer
  lists the running agents, which the sidebar already shows
  ([Workspaces](../desktop.md#workspaces)).
  - **Needs you** comes first: each agent waiting on you, with its soul, its machine and its
    message, newest first. Eight show at most, then **Show all N**. With none, "Nothing needs you."
  - **One summary line** counts the rest: "24 agents · 21 running · 3 need you · 0 stopped".
  - **The workspace is one row of tiles**, each a button with its count: Agents, Souls,
    Capabilities, Teams, Machines and Automations (with the red dot while a run failed). They show
    without scrolling, even with eight agents waiting on you. The Graph tile is gone; Machines keeps
    its List and Map.
  - **The sidebar's pinned rows are Home, Workspace and Automations.** Opening any Workspace page
    (from a tile, the command palette, ⌘2 / Ctrl+2, or a soul's or capability's page) marks the
    Workspace row, no longer Home's, and the page's head says where you are, such as
    **Workspace › Souls**. Its palette command is now **View: Workspace**.
