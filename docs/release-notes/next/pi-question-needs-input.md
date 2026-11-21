## Added

- **A pi agent's question raises needs-input, in every pi home.** Nothing set a
  claim when a pi instance waited on a dialog, so it read as running while it
  waited for a person, and a scheduled wake's Enter answered the dialog. The pi
  bridge (`@awebai/oats-pi`) now holds a waiting claim of producer `oats.pi`,
  reason `question`, for as long as a dialog an extension opened is open (a
  question tool's `select`, `confirm`, `input`, `editor` or custom screen),
  with the dialog's title as its message. `oats status`, `oats session inspect`
  and the Desktop show the instance as needing input, with the question, and a
  scheduled wake holds until the dialog is answered
  ([A held wake](../schedules.md#a-held-wake)). The claim clears when the
  dialog closes and when the session ends with it open. It reaches every pi
  home, a pi in a tmux pane and one a session provider runs in RPC mode alike,
  on pi 0.84.4 and later, and needs the bridge updated in each pi folder
  ([upgrading](../upgrading.md)). No key or event is new: the claim is the one
  a failed turn already uses, and an open dialog is shown over a failed turn
  ([A pi dialog](../capabilities.md#oatscore-needs-input)).
  - **The bridge clears only its own claim.** It records a mark while its claim
    stands, `<home>/.pi/oats-pi-claim.json`, naming the pi process that set it,
    and tells its claim by that mark, never by the claim's reason. A second pi
    in the home (a nested one, a subagent's session) no longer clears a live
    pi's claim at its first run, and never replaces its question. No other
    producer's claim is touched.
  - **A pi that died with its dialog open.** Its question is cleared when the
    home's next pi starts. With no pi to start it stays and holds the home's
    scheduled wakes, on a session provider until it is cleared: `oats instance
    waiting clear --producer oats.pi --home <home>`.
  - **What it does not cover.** A pi home's `wakeHold` still reads `unknown`:
    the kernel can't see whether the bridge is loaded, and a screen of pi's own
    (its project trust prompt, a picker a person opened) has no claim.
