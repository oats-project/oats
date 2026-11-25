## Changed

- **A due wake starts a stopped agent on a session provider too** (#2122,
  KP-1). A scheduled wake whose home OATS stopped now starts that home at
  its due minute on a session provider as on tmux, under the same guards (a
  launch slot, the home's lifecycle claim, the due minute only), and
  delivers its message once the session runs. Before, on a provider, the
  wake was refused (`E_SESSION_NOT_RUNNING`) and stayed pending until a
  person started the home. **A wake that starts a stopped agent starts a
  fresh conversation, on both backends**: a plain start from the home's
  `TASK.md`, then the wake's message; the earlier conversation stays
  readable and is not carried on. A provider home whose session is lost
  (gone without an OATS stop, or stopped with the host) is still not
  started by a wake: its resume brings it back
  ([schedules.md](../schedules.md#kinds)).
