## Changed

- **An older Git is reported once per command, not once per repository.** On
  a Git older than 2.45, every cache a command started, or rebuilt from a
  partial cache, printed its own `oats: warning: git <version> cannot keep a
  partial cache (it needs 2.45); OATS fetches whole trees from <url>`, so an
  `oats onboard` on a fresh host opened on a run of identical warnings. A
  command now prints one line, however many repositories it fetches:
  `oats: warning: git <version> cannot keep a partial cache (it needs 2.45), so OATS fetches whole trees instead; a git of 2.45 or later removes this notice`.
  The fallback is unchanged: each cache still fetches whole trees and records
  `oats.fetch = full`. The notice for a server that does not serve partial
  fetches and the stale-lock notice are unchanged
  ([Workspaces](../workspaces.md)).
