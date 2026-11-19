## Changed

- **Desktop: the workspace's catalogue pages read as calm rows** (the Desktop UI rework, slice 3b).
  - **Capabilities** is one list. Core capabilities (knowledge, messaging, tasks) come first with a
    dim **core** tag, then the rest by name. Each row has the capability's name and who made it: a
    ✓ for one OATS publishes (a package pinned from the official catalog, or a capability of the
    OATS repository), else **by** its source. It also has one line of what it does, and a
    **default** tag on the workspace's defaults. One sentence above the list says what defaults are
    for. The sections, repository pills, colour tiles and two-letter marks are gone. A package's
    name and version are in Setup's Packages box.
  - **A capability's page** reads top to bottom: what it does, then its **Skills**. Enter on a
    skill opens the whole skill in the pane, and Esc returns. Commands, Settings, Triggers, Hooks,
    Used by, Comes from and Files are folded underneath. Nothing the page showed before is gone.
  - **Teams** names its two sections **Workspace teams** and **This computer's teams** (the teams
    in this computer's `oats-local.yaml`). Each says what it holds in one sentence, and its lists
    count your agents.
  - **Machines** opens on the list of the computers the workspace runs on. Each row says whether
    the computer is reachable, how many of your agents run on it, and its OATS version. Enter opens
    a machine, with Check and Remove. Its **Map** is the earlier Machines view.
  - **Setup** is its list only; its graph is gone. A member's **Details** (or **Why?**) opens its
    membership under its row.
  - **Connections** says what the GitHub connection is for.
