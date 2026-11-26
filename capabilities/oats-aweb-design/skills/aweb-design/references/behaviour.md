# Behaviour: how aweb acts

aweb looks like bb. This file is not about the look. It is about how a screen acts: quiet, exact, nothing jumps. Every colour, size, radius and shadow below becomes a bb theme token.

## Ten rules

1. **Hairlines and white space make the structure.** No cards. No box in a box.
2. **Controls are quiet until you need them.** Ghost controls, 28 px high. One primary control per surface, at most.
3. **Only floating things are raised.** A composer, a popover, a tooltip, the dock. Nothing else has a shadow.
4. **Say a thing once, in one plain sentence.** The explanation goes behind an (i). Sentence case. No exclamation marks, no "AI-powered", no emoji.
5. **Asking is an element on the page.** A composer with a scope chip, a field and a round send button. A suggestion sends in one click. The answer opens over the page and keeps the page's scope.
6. **A key sits beside its act,** as a small grey hint. Enter is the one primary. Esc is back or close. Keys never fire while you type.
7. **Nothing jumps.** A fixed footer. Reserved space. A skeleton in the final shape. One layout in every state. While work runs, the title is the status.
8. **Waiting is told truthfully.** A live line that changes about every 3 s. A step count and the seconds so far. A thin bar that never fakes a percentage. After 8 s, say it is slow.
9. **Lists are dense and they end.** 28 px rows on hairlines. Row acts show on hover or focus. A long name is cut, and the full text is in the title. "Show all N", not an endless list. Numbers in tabular figures.
10. **Each piece owns its states and fails alone.** The states are loading, empty, error and ready. Unknown reads "unavailable" or a dash, never zero. An error is one calm line and "Retry". The status colour for "needs you" means only that.

## The dock

The dock is the main call on every page: the way to the aweb agent.

Shape:
- A small raised bar, fixed at the bottom right of the page. 20 px from both edges.
- It sits under sheets, dialogs and popovers.
- Buttons in one row, with a hairline between them. Never a hairline at the ends.
- Each button: an icon, a label, then its key as a grey hint. No box around the key.
- A count sits on a button only when it is above 0.
- Labels are sentence case, with no ellipsis.

Behaviour:
- A button exists only when its feature does. With nothing to show, the dock is not drawn.
- The dock hides while the thing it opens covers its corner.
- Each button's key works anywhere on the page.
- The dock is a toolbar for assistive technology, with a label that names what it holds.

## The ask bar

The ask bar asks about what the page shows.

Shape:
- One raised bar, the full width of the page column, under the page header.
- First, a scope chip. It is text, not a button: it reports the page's scope and doesn't change it. The page's own filters change the scope.
- Then a one-line field with no border. It is not focused when the page opens.
- Then "Previous chats": an icon and a label. The label hides on a narrow screen.
- Last, a round send button. It is disabled while the field is empty.
- Under the bar: one row with two suggestions. They are cut, not wrapped.

Behaviour:
- Enter or the send button sends. An empty question does nothing.
- Sending clears the field. The answer opens over the page, in a new chat, with the page's scope.
- A suggestion sends its text at once.
- Suggestions change between visits. They never change under the pointer.
- Draw nothing until you know which suggestions fit. Don't swap them after.
- Without the feature, the bar is not drawn.
- While a turn runs, the send button becomes Stop.
- A blocked bar says why in its placeholder.
- The composer has three sizes: a tall one to start, the bar on a page, a one-line one under a running chat. The field stays mounted when the size changes, so a draft survives.
