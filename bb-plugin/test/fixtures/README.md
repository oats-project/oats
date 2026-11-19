Pinned by the spec.
- `status.json`: `oats status --json` reduced to the fields the plugin reads, in the shape agreed
  with the kernel side (interface v2 4c909b5a36dfbc20): the design's seven sample agents on bb and
  one agent on tmux. Three need you (two claims; one of them also has a bb pending interaction).
- `threads.json`: what bb's `experimental_useSidebarThreads()` returns (field names recorded from
  bb-app 0.50.1), one thread per bb agent plus one thread that is no OATS agent.
The backend builder adds one recorded answer per other `oats` verb beside these.
