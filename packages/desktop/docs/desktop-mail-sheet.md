# An agent's mail

The Desktop shows an agent's own mail, received and sent, in one place: a
read-only sheet that slides in from the right over the panes, about 360 px
wide. Nothing else on the screen says anything about an agent's mail: new mail
draws no badge, no count and no notification. The Desktop UI rework's guide
(v6, "Mail: a sheet from the right") and Joan's call on v7 ("get rid of the
notice; just Alt+M, a sheet popping from the right") decided it.

## Opening it

- **Alt+M** (⌥⌘M on macOS; Ctrl+Alt+M in the Ctrl+Alt and Ctrl+Shift chord
  families), from every focus, a terminal's included: the agent of the
  focused roster row, else of the terminal tab shown (the leader's target).
  Pressed again, it closes the sheet. In a terminal Alt+M is Emacs's
  `back-to-indentation` and zsh's `copy-prev-shell-word`; the program still gets it from Esc, then m
  ([the collision table](desktop-keyboard.md)).
- The palette's **Agent: mail**, for the agent the palette was opened on.
- **Mail** in Details' Messaging & Teams section, shown when a messaging
  provider fills the agent's messaging layer.

Esc, the close button or a click on the scrim closes it, and focus goes back
where it was.

## What it shows

Newest first, as the messaging layer merges every identity of the agent (its
primary one and each joined team's). One item per message:

- **From** or **To** and the other party's alias; the team, when the agent reads
  more than one; how long ago (the exact time in its tooltip); the subject, or
  the thread's title when the subject is empty.
- The body, as plain text under "*sender* wrote:": a quote attributed to its
  sender, never markup, never a link. Six lines show until the item is
  expanded (a click on its head, or Enter or Space on it). Control characters
  and bidirectional overrides show as U+FFFD.
- What the provider says about it: **Encrypted** (an end-to-end encrypted body,
  decrypted with the agent's keys), **Not read by the agent yet**, **High
  priority**, **Unverified sender** or **Signature failed**.
- **Shortened**, when the body passed the 16 KiB bound and the provider cut it.
- "Older part of a long conversation shown; the newest messages can't be read
  yet.", once per conversation, where the provider could read only its oldest
  messages (aw's `mail show` reads oldest first).
- **Older mail**, at the end, while the provider has more: it reads the next
  page.

↑ and ↓ (Home, End) move between messages, and Tab stays inside the sheet. **r**
or the refresh button reads the mail again, keeping what was expanded.

## Reading never acknowledges

The sheet makes one kind of call: the messaging layer's own view operation,
`messaging:mail` (`mailApi: 1`, [docs/desktop-cli-api.md](../../../docs/desktop-cli-api.md)),
as `oats operation run messaging:mail --home <abs> --arg limit=50 [--arg cursor=…]
[--server <id>] --json`, through the backend's capabilities route, the one the
Teams card uses. The operation never acknowledges and never marks anything
read; an answer that says otherwise (`acknowledges` other than `false`) is
refused whole, and nothing is shown. The Desktop never runs aw and never reads
an agent's identity files.

It reads when the sheet opens, on Refresh and on Older mail, and at no other
time: never on the status poll and never in the background, since each read is
one aw call per identity, over the network. Every read carries the sheet's
lifetime (this agent, this workspace generation) and a serial, checked on
success and on rejection; a workspace change closes the sheet.

An agent on a registered server is read through it (`--server`), when this
computer's OATS can route operations there.

## When it can't

| What happened | What the sheet says |
|---|---|
| The agent's copy of its messaging layer predates the operation (`E_OPERATION_UNKNOWN`) | This agent's messaging is too old to show mail; stop it and upgrade it (`oats instance upgrade`), or start a new agent of its soul. |
| No messaging layer in the agent's home (`E_OPERATION_UNAVAILABLE`) | This agent has no messaging layer, so it has no mail. |
| This computer's aw is older than the provider needs (`E_AW_TOO_OLD`) | This computer's aw is too old to read mail: and the provider's own message, which names the version it needs. |
| One identity can't be read (`identities[].error`) | Mail from *team* can't be read: and its code; the rest of the mail shows. |
| A server's OATS can't run operations (`E_REMOTE_INCOMPATIBLE`) | The OATS on *server* is too old to read this agent's mail. |
| An answer outside the contract | The messaging layer answered mail this Desktop can't read. |
| The CLI is newer than this Desktop was tested with | The held-back notice; nothing is sent. |

## Where it lives

- `packages/client/mail-contract.mjs`: the answer's decoder (closed shapes, the
  bounds), the arguments of a read and the body's display lines. Shared: the
  Terminal UI renders the same sheet later.
- `renderer/mail-sheet.mjs`: the sheet, its words and its CSS.
- `renderer/shell.mjs`: the `instance.mail` action, the palette entry and the
  Details button's handler.
- CHORDS `mail` in `packages/client/keymap.mjs`: the chord, the Desktop's alone
  so far (the TUI skips it).
- `test/mail-sheet.test.mjs` pins the decoder, what the sheet shows, the
  states above, that it calls nothing but `messaging:mail` and never polls,
  and its latest-intent checks.
