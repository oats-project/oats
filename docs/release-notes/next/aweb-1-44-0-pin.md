## Changed

- **OATS pins oats.aweb 1.44.0** (from 1.43.0). Floors are unchanged: OATS >=0.68.0, aw >=1.36.33, tested aw 1.36.58. What a deployment must change:
  - **`oats aweb setup --install-aw` installs the tested aw (1.36.58) by default,** where it installed the newest aw 1.x. Pass `--aw-version <v>` to keep another.
  - **Bare API-key setup refuses before `aw init`** in an existing root that belongs to another team, or that lists memberships while no team is configured. Point `settings.oats.aweb.roots[<team>]` at the intended team's root, or at a fresh `.aweb-roots/<label>` directory, or configure the team first, then retry. A root with confirmed empty membership still bootstraps.
  - **`oats aweb setup --create` and `setup --join` without a token check only their own selected root.** An unreadable default root no longer blocks them, which reverses 1.43.0's interim refusal. They now refuse when their selected root's membership is unreadable or belongs to another team. Invited `setup --join` still reads the default root.

  Setup also names the source of the root it uses. Registry admission stays explicit through command formatting and retire cleanup. aw JSON answers with trailing stdout text are refused. Running instances keep the module they were spawned with: respawn them, or move a stopped one with `oats instance upgrade`, to take 1.44.0.
