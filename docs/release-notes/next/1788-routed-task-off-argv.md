## Added

- **`oats spawn <soul> --task-file -` reads the task from standard input**
  (feature `spawn-task-stdin`). A terminal on standard input is refused
  (`E_BAD_ARGS`).

## Fixed

- **A spawn through a server keeps the task off every command line.**
  `oats spawn <soul> --server <id>` with `--task` or `--task-file` put the
  whole task text in the remote command, so it was in the arguments of the
  local `ssh` process and of the server's `oats` for as long as each ran,
  readable by every user of either machine in the process list. The text
  goes on the ssh session's standard input, to the server's preview and to
  its spawn, and the remote command carries `--task-file -`
  ([a routed spawn's task](../servers.md#a-routed-spawns-task)). A task
  file over Linux's limit for one argument (128 KiB) is sent like any
  other.
- **A server that does not advertise `spawn-task-stdin` is refused a spawn
  with a task,** before any spawn is sent (`E_REMOTE_INCOMPATIBLE`): the task
  is never sent to it as an argument. Upgrade OATS on the server, or spawn
  without a task. A spawn without one is routed as before.
