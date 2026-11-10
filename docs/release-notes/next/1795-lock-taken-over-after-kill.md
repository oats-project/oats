## Fixed

- **A lock left by a command that was killed no longer stops the commands
  after it.** The locks of the host scheduler (`~/.oats/schedules/host.lock`,
  `registry.lock`, a deployment's `scope.lock`), of the server registry
  (`~/.oats/servers.lock`), of this computer's deployments list
  (`~/.oats/config/deployments.lock`) and of a deployment's `oats-local.yaml`
  (`.agents/locks/local.lock`) were directories that nothing but their holder
  removed: a tick or a command killed with SIGKILL, by the out-of-memory
  killer or by a reboot left its lock behind, and every later command
  answered `E_SCHEDULER_BUSY` (or `E_SERVERS_BUSY`, `E_DEPLOYMENTS_BUSY`,
  `E_LOCAL_BUSY`) until someone deleted the directory by hand, so the
  per-minute scheduler stopped for good after one killed tick. Each lock is
  now a file that names its holder by pid and start time, and the next command
  takes over a lock whose holder is gone. A holder that is still running is
  never taken over. Three cases still need the operator, and the message says
  which it found and names the path: a lock file whose record is unreadable
  (remove the file), a holder that cannot be told to be running or gone
  (check that pid by hand, then remove the file), and a lock directory written
  by an earlier kernel, which is never removed for you (remove the directory
  once no older oats is running) ([Schedules](../schedules.md#files)).
