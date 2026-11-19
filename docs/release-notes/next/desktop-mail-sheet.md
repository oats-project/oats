## Added

- **An agent's mail in the Desktop.** Alt+M (⌥⌘M on macOS), the palette's **Agent: mail** or **Mail** in Details opens the agent's own mail, received and sent, newest first, in a read-only sheet from the right. Each message shows who it is from or to, its subject and its body as plain text attributed to its sender, and whether it is encrypted, not read by the agent yet, high priority or from an unverified sender. **r** reads it again, **Older mail** reads further back, and Esc closes it ([An agent's mail](../desktop.md#an-agents-mail)).

  Reading it never acknowledges or marks anything read: the Desktop runs only the messaging layer's `messaging:mail` operation, and only when you open the sheet or ask it to read again. Nothing else on the screen shows an agent's mail. It needs an agent whose messaging layer has the operation; an older one says to upgrade it (`oats instance upgrade`) or start a new agent of its soul.
