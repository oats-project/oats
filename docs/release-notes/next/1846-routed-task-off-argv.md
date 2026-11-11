## Upgrade

- **Upgrade hosts to keep tasks off their command line.** A spawn routed
  with `--server` keeps its task off every command line only on a host that
  runs this release. An older host still gets the task as an argument, and
  the spawn's answer warns that it was readable in both machines' process
  lists.

## Added

- **`oats spawn <soul> --task-file -` reads the task from standard input**
  (feature `spawn-task-stdin`). A terminal on standard input is refused
  (`E_BAD_ARGS`).

## Fixed

- **A spawn through a server that runs this release keeps the task off every
  command line.**
  `oats spawn <soul> --server <id>` with `--task` or `--task-file` put the
  whole task text in the remote command, so it was in the arguments of the
  local `ssh` process and of the server's `oats` for as long as each ran,
  readable by every user of either machine in the process list. The text
  goes on the ssh session's standard input, to the server's preview and to
  its spawn, and the remote command carries `--task-file -`
  ([a routed spawn's task](../servers.md#a-routed-spawns-task)). A task
  file over Linux's limit for one argument (128 KiB) is sent like any
  other.
- **A spawn with a task through a server that does not advertise
  `spawn-task-stdin` says where the task was readable.** Such a server gets
  the task as an argument, as before, and the answer's warnings gain one
  line: `remote oats <version> at <host> does not advertise
  spawn-task-stdin, so the task was passed as an argument, visible in this
  machine's process list (the ssh command) and the host's while the spawn
  runs; upgrade the host`.
