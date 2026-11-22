## Fixed

- **Session: a directory-mode home on Linux starts after a reboot that gives
  its volume a new device number.** On btrfs (each subvolume gets a new
  device number at every boot) and on a remounted overlay, every
  directory-mode home refused `oats session start` after a reboot with
  "directory home was exchanged; restore the owned root before retrying
  start", though nothing was exchanged (#1266). A changed device number is now
  accepted when the root's inode and the birth time its spawn recorded both
  match, as macOS has done since 0.58.0, where the inode alone is enough when
  no birth time was recorded. Homes spawned since 0.58.0 record a birth time
  and start again with no change by hand. A Linux home whose spawn recorded
  none, or `0`, still needs its device number to match: spawn it again. A
  directory renamed into the home's or `work/`'s place is still refused
  ([`directory` work mode](../souls-and-instances.md#directory--independent-execution)).
