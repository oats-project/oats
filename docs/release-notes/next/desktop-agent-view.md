## Added

- **The agent view in the Desktop.** With an OATS that reports the agent's board (feature `instance-board`), an agent's terminal tab shows what the agent keeps in your view and what it asks you:
  - **Facts** above the terminal: `label · value unit`, "updated <time>", at most three shown and the rest folded, a sparkline once the view has read the history, and links shown as attributed text that open in your browser on a press. × or u hides a fact on this computer only, until its value changes.
  - **Questions** under the terminal, one at a time, with "question n of N", ‹ › and the dots, and a context fold (c opens it from the keyboard).
  - **Answering:** Alt+T (Ctrl+Alt+T in the Ctrl+Alt and Ctrl+Shift families, ⌘⌥T on macOS) moves the focus to the questions. A number puts `<id>: <option>` on the agent's input line, unsent, and your Enter in the terminal sends it. No bare digit is ever typed, and nothing is typed into a terminal that isn't on screen. While the agent's terminal shows a harness prompt (a live `permission` or `question` claim), the numbers are disabled and the zone says to answer the prompt there first.

  Without the feature the terminal tab and its waiting row are as before.
