---
name: aweb-design
description: Design rules for every screen and every text of Agent Web (aweb). Use before you design or review a screen, a row, a dialog, a command or a key, and before you write text that a person or an agent will read.
---

# aweb design

## What you design

Agent Web, known as aweb, has two faces. Know which one you are designing before you start.

**The aweb app.** Our own app. We own its design.
- It looks like bb: bb's tokens, sizes and components. Anyone who wants another look makes a theme. See `references/bb.md`.
- It is moldable, like bb: a small core, and the user asks the aweb agent for the rest.
- It behaves quietly: exact, and nothing jumps. See `references/behaviour.md`.
- It is driven like Omarchy: by commands and keys. See `references/omarchy.md`.

**The bb extension.** aweb inside bb. We own no design there.
- It wears the theme the user already has in bb.
- We bring clean elements. We never set a colour, a font or a shape.

The same rules, the same commands and the same voice apply to both.

## The rules

1. **Simple.** People want a team of agents that works. They mostly don't care how it works. Show what they need, and nothing else. It should feel like magic.
2. **Curious people ask.** Anything deeper is one step away: the aweb agent, in the dock at the bottom right. Don't put the explanation on the screen.
3. **Little text.** Use a word only when the screen fails without it.
4. **Commands first, clicks too.** Every act is a command with a key. Every act also works with the pointer. Design the keyboard path first.
5. **Worst case first.** Design with 60 agents, long names, 37 automations and a full screen of text. A design that only works with tidy data is not a design.
6. **One question per page:** what does the person need to see here?
7. **Colour means state.** Use colour for an agent's status and for acts on an agent. Nowhere else. Few colours.
8. **Labels, not ids.** Show a soul by its label: "Code reviewer", not "code-reviewer". No hyphens. Never show "core".
9. **No decoration.** No invented icons, no grey boxes, no notes columns. Long text opens in a sheet on the right.
10. **Nothing moves under a reader.** New data never switches the tab or page someone is on.
11. **Focus never lands on a control that sends or acts** unless the person put it there.
12. **"New X" is a request.** New automation, soul, team or machine opens the aweb agent with the request already sent.

## Agents and threads

Talking to an agent is thread-based, in the aweb app and in bb.

- An agent talks to you the way agents talk to each other: by mail, in threads.
- It starts a new thread for every fresh question or topic. So you have many threads with one agent, each with one topic and one title.
- An agent can be terminal-based instead. Then you see its terminal and type in it.
- **One command always switches an agent to its terminal view.** Every agent has it, everywhere.

The agent tree:
- Children are collapsed by default. A collapsed parent shows how many agents are under it.
- Every row keeps its agent type (the soul's label).
- One small plain dot per row for state. No state word.

## Needs you

An agent that waits for you is the most important thing on any screen.

- Say it wherever people look: the tree, the thread, the home.
- Let them answer right there.
- Answering works like Claude Code: the question, then numbered choices, a key for each, and a way to type something else. See `references/claude-code-input.md`.
- Give easy access to know more: one step opens the thread at the question, with what led to it.

## Commands and keys

These work in the aweb app and in bb.

1. Every act is one named command. No act is only a button.
2. One key opens the list of everything: commands, agents, places.
3. Every list filters as you type.
4. One key shows all keys. Choosing a line runs it.
5. The same keys everywhere: Up, Down, Enter (act), Esc (back or close), Left (out), Right (in), Tab (next section), Delete (remove).
6. Letters are mnemonics. Digits jump to the nth place. Arrows are directions.
7. Each modifier means one thing. Plain: go or act. Shift: reverse, or one level up. Alt: the variant.
8. One cursor. Keyboard, hover and focus draw the same highlight.
9. Focus is always visible. A list opens with its first row selected.
10. A destructive act starts from a key on the selected row. Confirm in place: Enter confirms, Esc cancels.
11. Feedback is two to four words. Then it leaves.
12. Everything a key does, a click does too.

Check: walk the design with the keyboard only. Then walk it with the pointer only. Both must reach every act.

## Voice

This is the voice of everything aweb writes: skills, screen text, the aweb agent, and every agent by default.

Write about 80% of the way to Simplified Technical English, the language of aircraft manuals. Plain and direct, but still a person talking. More in `references/voice.md`.

1. Short sentences.
2. Active voice. Say who does it.
3. One idea per sentence.
4. Simple, common words.
5. One word, one meaning. No synonyms for the words below.
6. Explain a technical term the first time.
7. Steps in order, one action per step.
8. The value, not the adjective: "28 px", not "small".
9. The result first. The reason if it helps.
10. Say "it depends" when it does. Say "I don't know" when you don't.

The other 20%: contractions, "you", a longer sentence when splitting hurts, warmth where it fits. No filler and no hype.

Words:
- **agent**: one running instance. Not "bot", "worker" or "session".
- **soul**: the type of an agent.
- **thread**: one conversation on one topic.
- **needs you**: the agent is waiting for your answer.
- **stop, start, restart, retire**: the four acts on an agent.
- **automation**: a schedule or a trigger that starts an agent.
- **workspace**: one team of agents and its setup.
- **aweb**: the product. Its full name is Agent Web. Write "aweb", lower case.
- **aweb agent**: the agent that changes the workspace for you. Never "expert".
- **command**: a named act.

## The aweb app

**Look** (`references/bb.md`)
- bb's look: almost no colour, flat surfaces, 13 px text, 28 px rows, hairlines.
- Every colour, radius and font comes from a theme token. Never a literal value.
- A theme is one file. People who want another look (Omarchy, herdr, their own) make a theme. We don't build looks.
- What a key opens just appears. Other motion is under 300 ms.

**Structure** (`references/bb.md`)
- Ship a small core: the agent tree, threads, needs you, automations, the workspace.
- Everything is a slot: a page, a panel tab, a row mark, a command, a key.
- The user asks the aweb agent for a page, a panel or a command, and the app adds it.
- Our pages use the same slots as theirs. The design must hold when a user has added 20 things we never saw.

**Behaviour** (`references/behaviour.md`)
- Hairlines and white space make the structure. No box in a box.
- Say a thing once, in one sentence. The explanation goes behind an (i).
- Asking the agent is an element on the page: the dock at the bottom right.
- Reserve the space. Show a skeleton in the final shape.
- While people wait, say what is happening. Never a fake percentage.
- A list has a limit: "Show all N".
- Unknown is a dash, not zero. An error is one line and "Retry".

## The bb extension

Details in `references/bb.md`.

1. No colour, font, radius or shadow of our own. bb's theme tokens only.
2. Use bb's component wherever bb has one: composer, dialog, menu, tabs, row, tooltip, palette.
3. Needs you is a small dot in the theme's status colour. One mark, at the end of the row.
4. Lists are bb's hairline rows, with the facts aligned in columns. No header row.
5. bb's sizes: 13 px text, 28 px rows and controls, 14 or 16 px icons.
6. bb's text style: sentence case, verb first, no full stop on a label.
7. Don't replace bb's title bar, side panel, toasts or focus ring.
8. Every aweb command is in bb's own palette, with a key the user can change.
9. Check on three themes: bb light, bb dark, one custom.

## Reference screens

`references/reference-screens.md` links a live prototype of the bb extension and lists the elements already approved. Start from those. Ignore the prototype's colours.

## How to work

1. Show the worst case first, then the calm case.
2. Walk it with the keyboard only, then with the pointer only.
3. Deliver a live prototype people can click. They comment on the page.
4. For bb: ask the bb lead "can bb do this?" before you show it. It answers with proof.
5. End every design with what you left out.

## References

- `references/voice.md`: where the voice comes from, with before and after.
- `references/omarchy.md`: Omarchy's command-first way: what bb doesn't give.
- `references/bb.md`: bb in 20 rules, what gives a foreign screen away, what a plugin can and can't do.
- `references/behaviour.md`: how aweb acts, in 10 rules, the dock and the ask bar.
- `references/claude-code-input.md`: how Claude Code asks for input.
- `references/reference-screens.md`: the prototype and the approved elements.
- `references/full/`: the complete extractions, every rule with its file and line.
