/** Whether `actual` ({dev, ino, birthtimeNs?}, read now) is the directory `recorded` names.
 *  The inode is the identity: on one volume a different directory has a different inode.
 *  `dev` names the volume, and some volumes get a new one each time they are mounted, so
 *  after a reboot `dev` no longer matches: an APFS volume on macOS (#1261), a btrfs
 *  subvolume or an overlay mount on Linux (#1266). A changed `dev` drops the volume from
 *  the comparison, and what it opens is another volume showing the same inode number.
 *  The recorded birth time (a decimal string of ns; "0" where the volume has none) closes
 *  that gap. Birth time is not an identity: it closes only the gap a dropped `dev` opens.
 *  - darwin: an equal inode is enough, unless the record holds a birth time, which must
 *    then match too. A record without one, or with "0", is judged by the inode alone.
 *  - elsewhere: a changed `dev` is accepted only when the record holds a birth time other
 *    than "0" and it matches. Stricter than darwin on purpose: btrfs numbers every
 *    subvolume's inodes from the same start, so an equal inode alone says little, and Linux
 *    has no call that sets a birth time, so a copy gets a new one. A record without one,
 *    or with "0", needs `dev` and `ino` both to match.
 *  Still refused everywhere: another directory renamed into the path (another inode), and,
 *  where the birth time is checked, a copy or another volume's directory with the same inode.
 *  Accepted where `dev` is dropped: any filesystem mounted at the path that shows the recorded
 *  inode and birth time. A snapshot or block copy of the home's volume does (the home itself, at
 *  an earlier state), and so can one its own user mounts there (FUSE), who can rewrite the record anyway. */
export function sameDirectory(recorded, actual, platform = process.platform) {
  if (!recorded || !actual || recorded.ino !== actual.ino) return false;
  if (recorded.dev === actual.dev) return true;
  if (platform === "darwin") return recorded.birthtimeNs === undefined || recorded.birthtimeNs === "0" || recorded.birthtimeNs === actual.birthtimeNs;
  return typeof recorded.birthtimeNs === "string" && recorded.birthtimeNs !== "0" && recorded.birthtimeNs === actual.birthtimeNs;
}

/** Whether a refusal by sameDirectory is the one a reboot or remount causes and no exchange
 *  needs: the same inode on a volume whose `dev` changed, where the record holds no birth time
 *  (a spawn before 0.58.0) or "0" (a volume without birth times), so off darwin nothing
 *  confirms it is the same directory. The caller words that refusal for what to do about it. */
export function unconfirmedRemount(recorded, actual, platform = process.platform) {
  return platform !== "darwin" && !!recorded && !!actual && recorded.ino === actual.ino && recorded.dev !== actual.dev &&
    (typeof recorded.birthtimeNs !== "string" || recorded.birthtimeNs === "0");
}
