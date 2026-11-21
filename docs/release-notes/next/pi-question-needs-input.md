## Added

- **A pi agent's question raises needs-input.** Nothing set a claim when a pi
  instance waited on a dialog, so it read as running while it waited for a
  person, and a scheduled wake's Enter answered the dialog. The pi bridge
  (`@awebai/oats-pi`) now holds a waiting claim of producer `oats.pi`, reason
  `question`, for as long as a dialog an extension opened is open (a question
  tool's `select`, `confirm`, `input`, `editor` or custom screen), with the
  dialog's title as its message. `oats status`, `oats session inspect` and the
  Desktop show the instance as needing input, with the question, and a
  scheduled wake holds until the dialog is answered
  ([A held wake](../schedules.md#a-held-wake)). The claim clears when the
  dialog closes and when the session ends with it open. It works the same for
  a pi in a tmux pane and one a session provider runs in RPC mode, on pi
  0.84.4 and later, and needs the bridge updated in each pi folder
  ([upgrading](../upgrading.md)). No key or event is new: the claim is the one
  a failed turn already uses, and an open dialog is shown over a failed turn
  ([A pi dialog](../capabilities.md#oatscore-needs-input)). A pi home's
  `wakeHold` still reads `unknown`: the kernel can't see whether the bridge is
  loaded, and a screen of pi's own (its project trust prompt, a picker a
  person opened) has no claim.
