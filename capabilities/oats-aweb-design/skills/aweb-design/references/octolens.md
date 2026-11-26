# Octolens: its taste

Read from the Octolens web app's source and its own written design guide, 26 Nov 2026. Nothing was run. The complete extraction is `full/octolens-principles.md`.

aweb looks like bb, not like Octolens. Take how Octolens behaves, not how it is drawn.

- Take: rules 1, 6, 7, 9, 10, 11 and 12 (structure by hairlines, one plain sentence, asking as an element on the page, nothing jumps, honest waiting, bounded lists, each piece owns its states).
- Take the idea, draw it with bb's tokens: rule 4 (quiet controls, one primary), rule 5 (only floating things are raised), rule 8 (the key beside its act).
- Don't take: rule 2 (its colours), rule 3 (its type sizes and font). bb's tokens decide those.
- The dock and the ask bar below are specs of shape and behaviour. Their colours, shadows and sizes become bb's tokens.

## Octolens's taste in twelve rules

1. **Hairlines and whitespace make the structure; no cards, no boxes inside boxes.** STATED `.claude/skills/app-design/SKILL.md:25-27`.
2. **One near-black ink on white, four greys for hierarchy, one purple accent kept for data and focus; colour is never the only signal.** STATED `SKILL.md:41-58,124`; OBSERVED `#0F172B` in 139 files.
3. **Small quiet type: 13px for everything you operate, 11px uppercase tracked labels, one 28-34px medium title or one 40px light number as the hero. Inter only.** STATED `SKILL.md:64-77`.
4. **Chrome is grey until you need it: ghost controls 28-32px high, at most one dark primary per surface.** STATED `SKILL.md:30-31`; OBSERVED `C/ui/app-design.tsx:21-26`.
5. **Only things that float are raised (composer, popover, tooltip, dock), each with a two-layer soft shadow; nothing else has a shadow.** STATED `SKILL.md:26-27,90-93`.
6. **Say it once, in one plain sentence; put the explanation behind an (i). Sentence case, no exclamation marks, no "AI-powered", no emoji.** STATED `SKILL.md:195-198,222`; `C/ui/app-design.tsx:58-60`.
7. **Asking is an object on the page: a white rounded composer with a grey scope chip, a borderless field and a round dark arrow; suggestions send in one click; the answer opens over the page carrying the page's scope.** STATED `SKILL.md:117-122`; OBSERVED `C/analytics/analytics-ask-bar.tsx:81-131`, `C/analytics/analytics-ask.ts:1-13`.
8. **Every key sits next to its action as a small grey keycap; Enter is the one primary, Esc is back-or-close, ? lists the keys; keys never fire while you type.** STATED (code doc) `C/onboard/setup/frame/keyboard.ts:8-21`; OBSERVED `C/onboard/setup/frame/wizard-actions.tsx:179-225`. Onboarding wizard only: see limits.
9. **Nothing jumps: a fixed footer, reserved slots, skeletons in the real shape, one layout in every state, a title that is the status while work runs.** STATED `C/onboard/setup/keywords-step.tsx:787-793`, `C/onboard/setup/sonar-frame.tsx:273-279`.
10. **Waiting is told truthfully: a live line that changes every 3 s, a step count and elapsed seconds, a 2px bar that never fakes a percentage, and after 8 s it admits it is slow.** STATED `C/onboard/setup/status-phrases.ts:2-7`, `C/assistant/assistant-working.tsx:4-13`.
11. **Lists are dense and bounded: 13px rows on hairlines, slate-50 hover, row actions revealed on hover or focus, names truncated with the full text in the title, "Show all N" instead of an endless list, tabular numbers.** STATED `SKILL.md:139-147,217`; OBSERVED `C/keywords/views/KeywordsTableView.tsx:764-765`.
12. **Each piece owns its four states and fails alone; unknown reads "unavailable" or a dash, never zero; an error is one calm line plus a retry; orange means "needs you", green only means "confirmed".** STATED `SKILL.md:200-210`; `C/onboard/setup/mcp-step.tsx:357-360`.

---

## The help dock and the ask bar, to redraw

## C1. The help dock

Source: `C/help-dock/help-dock.tsx` (180 lines, added 2026-11-20, commit `647ca730a`). Mounted once in the app shell, so it is on every signed-in page (`C/layout/menuLayout.tsx:15-16`).

Correction to the brief: it is not "search + ask". STATED: "the small pill in the bottom-right corner of every page in the app shell: Search ([cmd]K), Explore data ([cmd]J) and Support." (lines 4-5). "Explore data" is the ask entry.

```
                                                        viewport edge ->|
   +-----------------------------------------------------------+        |
   | (o) Search Ctrl K | (*) Explore data Ctrl J | (c) Support 2 |  20px |
   +-----------------------------------------------------------+        |
                                                              20px below
```

**Container** (line 170):
- `fixed bottom-5 right-5 z-40`: 20px (tw) from the bottom and right edges; below sheets, dialogs and popovers, which are z-50.
- `flex items-center gap-0.5`: buttons in a row, 2px (tw) apart.
- `rounded-xl` (Tailwind default 0.75rem = 12px (tw); this key is not overridden in the config).
- `border border-[#E4E4E7]`, `bg-white`, `p-[3px]`.
- Shadow: `0 1px 2px rgba(15,23,43,0.05), 0 4px 14px rgba(15,23,43,0.06)`.
- `role="toolbar"`, `aria-label="Search, data and support"` (168-169).
- Derived outer height: 30 + 3 + 3 + 1 + 1 = 38px. Width is content-driven.

**Button** (`dockButton`, line 45):
- `inline-flex h-[30px] items-center gap-[7px] whitespace-nowrap rounded-lg px-2.5`: 30px high, 7px between icon / label / hint, 10px (tw) side padding, radius 0.5rem = 8px (config).
- `text-[13px] font-medium text-[#0F172B]`.
- Rest: no fill. Hover: `hover:bg-slate-100` with `transition-colors`.
- Focus, pressed, disabled: **no class present** in `dockButton` (no `focus-visible:` rule). The browser default focus outline applies.
- Icon: Heroicons outline, `h-[15px] w-[15px]`, `strokeWidth={1.6}`, in the text colour (108, 128, 148). Search = magnifying glass; Explore data = sparkles; Support = oval chat bubble.

**Key hint** (`shortcutHint`, line 46): `<kbd>` with `hidden text-[11px] font-medium text-[#90A1B9] sm:inline`. No box, no border. Hidden below the `sm` breakpoint. Text: `[cmd]K` / `Ctrl K` and `[cmd]J` / `Ctrl J` (110, 130).

**Divider** between buttons (line 174): `h-4 w-px bg-[#E4E4E7]`, 16px (tw) tall, `aria-hidden`. Only between items, never at the ends.

**Unread count** on Support (151-156): `inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#18181B] px-1 text-[10px] font-semibold tabular-nums text-white`. Shown only when greater than 0; the button's `aria-label` becomes "Chat with support, N unread" (146).

**Labels**: "Search", "Explore data", "Support". Sentence case, no ellipsis.

**Behaviour**:
- Search: opens the global command palette (102-105).
- Explore data: `router.push("/me/analytics?explorer=open")`, which opens the Data Explorer overlay; the same from `[cmd]J` / Ctrl+J anywhere, with `preventDefault` (83-90, 122-125; `C/command-palette/command-palette-utils.ts:179-183`).
- Support: opens the support chat; the dock replaces the vendor's own launcher bubble and shows its unread count (11-14).
- `[cmd]K` is not bound here: "[cmd]K lives with the palette itself" (80).

**States**:
- Each button exists only if its feature is available: "Each button hides when its feature is unavailable; with nothing to show the dock renders nothing." (16-17, 94-161).
- The whole dock disappears while the support chat window is open, because "its own close button sits in this corner" (163-164).
- The Mac label is set after mount (67-71): first paint shows "Ctrl K".
- Motion on appear / disappear: **not found** (no animation class on the container).
- Dark mode: **not found** (no `dark:` classes).

**What it replaced**: the sidebar's "Search" row (line 7-8). The MOCKUP still shows the older idea: a full-width sidebar row "Search" with a bordered `[cmd]K` keycap (`docs/mockups/agents-page.html:351`).

## C2. The ask bar

Source: `C/analytics/analytics-ask-bar.tsx` (154 lines). STATED: "a Home-style composer whose scope chip shows the active range + keywords and whose right edge holds "Previous chats", then ONE row with two suggested questions and the "Connect your agent" link" (lines 27-33).

Correction to the brief: it is on the **Analytics** page, between the header and the stat row (`C/analytics/analytics-page.tsx:150-173`). The Insights page has none: "Not on Insights: the Analytics date picker and the ask bar." (`docs/insights/insights-page.md:262`). Insights only mounts the Explorer panel so deep links still open (`C/insights/insights-page.tsx:489-495`).

```
 +--------------------------------------------------------------------------+
 | [30 days . All keywords]  Ask about these numbers...    (c) Previous chats (^) |
 +--------------------------------------------------------------------------+
   12px
 ( What drove the biggest spike in the last 30 days? ) ( Which platform grew... )      (C)(G) Connect your agent ->
```

**The bar** (`<form>`, line 84):
- `mt-6`: 24px (tw) under the page header (cut from `mt-10`, `SKILL.md:35`).
- `flex items-center gap-2`; `rounded-2xl` (16px; the mockup writes `border-radius:16px`); `border border-[#E4E4E7]`; `bg-white`.
- Padding `py-2 pl-3 pr-2`, from `sm`: `pl-[18px]`.
- Shadow: `0 1px 2px rgba(0,0,0,0.05), 0 8px 28px rgba(9,9,11,0.06)`.
- Full width of the page column (max 1104px minus page padding).
- Derived height: 36 (input) + 8 + 8 + 2 = 54px.
- Focus style on the bar: **none in this file**. The Home composer adds `focus-within:border-[#CBD5E1]` (`C/assistant/assistant-composer.tsx:100`).
- `aria-label="Ask about this data"` (82).

**Scope chip** (lines 86-91), first item:
- A `<span>`, not a button: it reports the scope, it does not change it. The page's own filters (top right of the header) are the controls.
- `hidden ... sm:inline`: absent on phones.
- `shrink-0 whitespace-nowrap rounded-md bg-[#F4F4F5] px-2 py-[3px] text-xs text-[#314158]`. `text-xs` = 0.8125rem here (`tailwind.config.ts:34`). No border, no icon.
- Text (line 66): `[range] [mid] [keywords]`. Range: "30 days" or "Sep 1 [en] Sep 30". Keywords: "All keywords", the single keyword's name, or "N keywords" (`C/analytics/analytics-filters.ts:306-329`). It never grows past those three forms.

**Field** (lines 95-102):
- `<input type="text">`, one line: `h-9 min-w-0 flex-1 border-0 bg-transparent text-[15px] text-[#0F172B] outline-none placeholder:text-[#71717A]`.
- Placeholder: "Ask about these numbers[...]".
- A visually hidden label "Ask about this data" (92-94).
- Not auto-focused.

**"Previous chats"** (lines 106-122):
- `inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1.5 text-[13px] font-medium text-[#314158] hover:bg-slate-50 hover:text-[#0F172B]`.
- Icon: two chat bubbles, `h-4 w-4`, `strokeWidth={1.75}`.
- The label is `hidden sm:inline`: icon-only on phones, with `aria-label` and `title` "Previous chats".
- Opens the Explorer with no question, on its list of saved conversations (`C/analytics/analytics-ask.ts:41-48`).

**Send** (lines 123-130):
- `flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#18181B] text-white disabled:opacity-40`: a 32px black circle.
- Icon: up-arrow, `h-4 w-4`, `strokeWidth={2.2}` (heavier than every other icon).
- Disabled (40% opacity) while the field is empty or only spaces. `aria-label="Ask"`.
- Hover: none here; the Home composer's send has `hover:bg-[#27272A]` (`C/assistant/assistant-composer.tsx:175`).
- On Home the same slot turns into a Stop square while a turn streams (`assistant-composer.tsx:158-166`), and stays solid black even when empty: "the mockup's resting state; it only greys out when the whole box is blocked" (172-173). Both behaviours are shipped; they differ.

**The row under the bar** (lines 134-151):
- `mt-3 flex flex-wrap items-center gap-2 lg:flex-nowrap`.
- Two suggestion pills: `min-w-0 truncate rounded-full border border-[#E4E4E7] px-3 py-1.5 text-left text-[13px] text-[#3F3F46] hover:bg-slate-50`. No icon. On one line from `lg`; they truncate rather than wrap.
- Right end, `ml-auto shrink-0`: the "Connect your agent" link: two overlapping 22px grey circles holding 13px and 12px logos (the second has a 2px white ring and `-ml-1.5`), the words in 13px medium `#314158`, a 14px right arrow (`C/analytics/connect-agent-link.tsx:40-51`).

**Behaviour**:
- Enter in the field or the circle submits. An empty question does nothing (`C/analytics/analytics-ask.ts:33-35`).
- Submit clears the field and navigates to the same page with `explorer=open&prompt=<text>` plus the current `time` and `kw`; the Data Explorer opens over the page, starts a new chat, sends the question with that scope, and removes `prompt` from the URL (`analytics-ask-bar.tsx:46-61`; section 5.4).
- A suggestion pill sends its text at once (143).
- Suggestions: two, drawn from a pool of 12 with one random seed per visit: "the suggestions rotate between visits ... but don't reshuffle under the user's cursor" (43-45). `{range}` in a question is replaced by the active range. Questions that need competitors appear only if competitors are tracked, and nothing is drawn until that is known, "so drawing earlier would swap the pair" (67-68).
- Without the assistant feature, the bar is not rendered and only the link row remains (32-33, 80, 138).
- If the bar throws, it vanishes silently (`C/analytics/analytics-page.tsx:152`).

**The two other shipped variants of the same composer** (`C/assistant/assistant-composer.tsx:10-16,99-142`):
- `hero` (Home start): a textarea of 3 rows, 15px, padding `px-4 pb-1 pt-4`, the composer shadow; footer row `pb-2.5 pl-2.5 pr-2.5 pt-1` with the two outlined scope pills on the left (`h-7 rounded-full border border-[#E4E4E7] px-2.5`, 14px icon + value) and the send circle on the right. Grows to `max-h-40`.
- `dock` (under a running chat): 1 row, 14px, the flat 1px shadow, the send circle alone.
- Both: `rounded-2xl border border-[#E4E4E7] bg-white`, `focus-within:border-[#CBD5E1]`. "The variant only changes classes: the textarea stays mounted across the flip, so a draft survives it."
- Blocked state: field disabled at 60% opacity, placeholder states the reason, send at 40%.

---
