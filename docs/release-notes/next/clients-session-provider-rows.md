## Added

- **The Desktop and the TUI show an agent that runs on a session provider
  as OATS reports it.** A session provider is a session backend a capability
  supplies, in place of tmux. No released OATS reports such an agent yet;
  this is the clients' half, which goes first. For such an agent:
  - its state is the one OATS reports, and no client asks tmux about it;
  - Start, Restart, Stop and Retire are offered by its state, as for any
    agent;
  - it shows as needing input whenever OATS reports that it waits on you
    and it is not stopped, and the Desktop's Home lists it under Running
    while it runs;
  - there is no terminal to open. The clients say where it runs ("Runs in a
    bb thread; open it in bb.") and show the link the provider offers: the
    Desktop in the row's context menu, opened in your browser, and the TUI
    printed under the line after `Enter`. Neither opens, splits or restores
    a terminal tab for it;
  - the Desktop's instance panel and the row's tooltip name the backend and
    the provider's thread id.

  An agent in tmux, and one recorded on Herdr, read as before
  ([how the clients read `backend`](../desktop-cli-api.md#row-backend-clients)).
