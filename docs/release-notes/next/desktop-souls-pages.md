## Changed

- **Desktop: Souls, and a soul's page, read calmly** (the Desktop UI rework, slice 3a).
  - **Workspace › Souls** groups souls by where they come from (the workspace's
    repository first, then its other members, then each package) and lists each
    group in kind order: maintainers, experts, developers, operations, then the
    rest. The kind is read from the soul's name (`-maintainer`, `-expert`,
    `-developer`; a `setup`, `operator`, `admin` or `ops` word is operations):
    OATS reports no role of its own yet.
  - A card shows what the soul does, how many of its agents run and its kind.
    **v** (or **Grid** | **Table**) shows the same souls as a table: name, what
    it does, kind, agents running, harness · model, and whether it is ready
    here. Each window remembers its choice.
  - The card's **Spawn** button, **Group by Team** and **About souls** are gone.
    Start a new agent of a soul from its page (**New agent**), Quick Open or the
    palette.
  - A soul's page is one column: its harness and model, its teams (the editable
    list on this computer folds out under them), its knowledge, and **Ready**,
    or the one thing that stops a spawn here, with the detail and the soul's
    readiness checks under **Details**. Then its capabilities as one list of
    rows, core ones first with a dim **core** tag, each with where it comes from
    and one line of what it does. Then its two prompts as two tabs, **Soul
    instructions** and **Composed instructions**, each with its sections listed
    beside it, and its skills folded under **Skills**. The page no longer lists
    the soul's agents: the Souls grid and table count them.
