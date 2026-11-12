## Changed

- **OATS's own copy of the engineering template moves to template-v3.1.3:
  instances are named for their task and role, and no child runs below a
  model floor.** This changes the texts this workspace's own souls are
  composed from, not the kernel or any package.
  - Every instance a coordination text spawns is named `<task>-<role>` with
    `--name`: the task first, and last the role it plays in the effort (lead,
    developer, reviewer, helper, specialist, maintainer, dispatcher), never
    its soul, which the sidebar already shows. Five words at most, the role
    included. A name is used once: when it is taken, the task's part gets
    more specific, a later review round carries its number
    (`<change>-r2-reviewer`), and a retired maintainer's successor puts its
    count before the role (template-v3.1.2, template-v3.1.3).
  - The landing rules set a floor for the models children run on, OATS
    children and native subagents alike: a Claude model of the Opus tier or
    above, an OpenAI model of the Sol tier or above, and in any other family
    its strongest tier. The floor comes before model diversity, and it binds
    the model a child would actually launch on: a soul's default or a
    machine's `souls.launch` override below it is not used, and the parent
    tells its person once. The template leaves the floor to each
    organisation; this is OATS's answer (template-v3.1.3).

  A running instance keeps the texts it was spawned with; a new spawn takes
  these. `capabilities/TEMPLATE-RELEASE` records the release and its commit.
  The catalog's rows for the research and the scientific research templates
  move to template-v2.1.2, which carry the same two changes.
