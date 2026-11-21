## Added

- **Desktop: the Schedules form edits a schedule that launches on a session
  provider.** A new-agent schedule's **Session backend** now offers tmux and
  each session provider the chosen soul's capabilities supply (bb, where the
  soul has it), and **Edit** opens a schedule stored on one instead of sending
  you to the CLI; a save keeps the backend
  ([Scheduling agents and wake messages](../desktop.md#scheduling-agents-and-wake-messages)).
  - bb launches only in full mode: choosing it sets permissions to YOLO and
    the form says why. A schedule saved without it (with the CLI, say) is
    marked **Refused at each run** (`yolo: false`) or **Needs YOLO** (no
    `yolo`: refused unless its launch configuration sets it) in the list and
    on its page.
  - A wake to an agent on a session provider is edited as any wake. The form
    says it is sent as the session's input and never starts a stopped agent
    there.
  - An Edit that is still reading the soul's session backends is dropped by
    anything else that happens to the list meanwhile (a switch, a run, a
    Delete, a refresh, another workspace), so a late answer never brings back
    a form holding the old definition.
