Pinned by the spec.
- `status.json`: `oats status --json` reduced to the fields the plugin reads, in the shape agreed
  with the kernel side (interface v2 4c909b5a36dfbc20): the design's seven sample agents on bb and
  one agent on tmux. Three need you (two claims; one of them also has a bb pending interaction).
- `threads.json`: what bb's `experimental_useSidebarThreads()` returns (field names recorded from
  bb-app 0.50.1), one thread per bb agent plus one thread that is no OATS agent.

The other files are one answer per other `oats` verb, as the kernel prints it (an envelope, except
`retire-apply.json`: a first guarded retire prints the receipt itself).
- Recorded from the real kernel (OATS 0.69.20, `--json`), reduced and with the machine's paths
  replaced: `souls.json`, `capabilities.json`, `teams.json` (plus one unmapped team, shaped as the
  reference documents it), `spawn-preview.json` (with `backend: "bb"` and one warning), the targets
  of `stop-plan.json`. In `souls.json`, `knowledge-harvester` is a member soul so that it agrees
  with `status.json`; the real package soul `oats.okf/knowledge-harvester` is beside it, with no
  agents, and `research-expert` and the unspawnable `oats.okf/knowledge-maintainer` are shaped rows.
- Shaped as docs/desktop-cli-api.md documents the answer, with the agreed `session` fields, since
  no kernel answers them for a bb home yet: `spawn.json`, `stop-apply.json`,
  `stop-apply-stale.json` (the `E_PLAN_STALE` refusal), `start.json`, `restart.json`,
  `retire-plan.json`, `retire-apply.json`, `servers.json`.
`container/fake-oats.mjs` prints them; the unit and live tests run the plugin against it.
