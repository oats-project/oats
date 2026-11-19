## Changed

- **Desktop: starting an agent is one short form, New agent, done by keyboard.** Choose a soul, say the task, press Enter. The form is a sheet over a dim backdrop with **Soul** (a list with each soul's description: type to filter, ↑↓, Enter), **Task** (several lines: Enter starts the agent, Shift+Enter is a new line), **Harness** (Claude Code, Codex or Pi, the soul's default marked and chosen) and, only with two or more machines, **Where**. ⌘P / Alt+P and the sidebar's Spawn instance open it on the soul list; a soul's card or page opens it on that soul, in Task.
  - There is no name field: the agent is named from its task by the kernel's suggest-name, and the sidebar shows that name on the new row. With an OATS that can't name from the task, the Name field is back in the form, with one line saying why.
  - Everything else the spawn can set is in **Advanced**, a dim link under the fields (⌘7 / Ctrl+7): model, the kernel name, the work area and base branch, teams, Run in background, permissions, launch configuration, messaging identity, session backend, the recurring wake-up, Add a machine, and the full **What will be created**. One line under the fields says what will be created in short, and the agent starts only against the preview for exactly what is on screen.
  - On Enter the sheet closes at once. The new row's dot pulses until the agent runs (still, with reduced motion), and its terminal opens beside it without taking the keyboard: the row keeps the focus.
  - The button is **Start**, and the shortcuts editor lists the form's keys under **New agent** ([desktop.md](../desktop.md)).

## Removed

- **Desktop: the spawn dialog's Relationship picker.** A spawn from the Desktop is top-level; agents make their own children (decision D6 of the Desktop UI rework). Its key, ⌘4 / Ctrl+4, is free. A spawn that a kept draft would have related to another agent reopens top-level.
