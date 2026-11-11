## Fixed

- **A retire, a session start, a session restart and a stop apply whose
  caller went away no longer end as failures.** When the reader of `oats
  retire`, `oats session start`, `oats session restart` or `oats instance
  stop --apply` closed stdout or stderr before the answer was written (an
  ssh session that ended, a Desktop that quit), the act completed under
  the home's lifecycle claim and the process could then end with an
  unhandled `EPIPE` and exit status 1: a retire did, and so did a start
  that started the OATS tmux server, which writes a line on stderr while it
  acts. They now end with the act's own status, as `oats spawn` and `oats
  worktree add` do, and what could not be printed is dropped
  ([a caller that goes away](../desktop-cli-api.md#spawn-caller-gone)).
