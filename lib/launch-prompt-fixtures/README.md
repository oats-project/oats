# Development-channel confirmation tolerance list

`dev-channel-confirmation.json` is the list of Claude development-channel
confirmation wordings the launcher may confirm. `launch-prompt-fixtures.mjs`
loads and validates it; the controller (`launch-prompts.mjs`) sends its one
Enter only while the normalized screen EQUALS one `confirmation` entry's `text`.
It also holds the notice Claude shows when it ignores the development-channel
flag (`flag-ignored` entries), which ends a start with no key.

The engagement tests take the channel arguments from the pinned `oats.aweb`
mirror's `CLAUDE_CHANNEL_ARGUMENTS`. They check that the kernel engages for the
provider's development argument and stays disengaged for its approved argument,
so a provider argument change cannot silently bypass confirmation. The kernel
does not import the provider at runtime.

## Normalization, and only this

1. Split the captured screen into rows.
2. Drop rows made only of box-drawing characters (U+2500–U+257F) and whitespace.
3. Join the rest with single spaces, collapsing every whitespace run.
4. Trim.

This absorbs wrapping at any pane width, indentation and padding. Nothing else
is normalized: no case folding, no character removal, no pattern. Equality is
not a contains test, so anything else on the screen, a second prompt stacked
with it, another or a second channel, or the options in another order, is no
match. A pane too narrow for Claude to wrap at word boundaries (about 40
columns for this prompt) breaks words and is no match either.

## The notice block of a `flag-ignored` entry

When Claude ignores `--dangerously-load-development-channels` (channels are not
available for the account), it shows no confirmation and starts the session,
with a notice in its notices area. A `flag-ignored` entry is matched against a
**notice block**, never the whole screen:

1. Split the captured screen into rows.
2. A notice block is a maximal run of consecutive rows that each begin with `▎`
   (U+258E) in the first column.
3. Drop the `▎` from each row of the block, then normalize the block as above.

The entry matches when one notice block EQUALS its `text`. The controller
accepts it only on a screen with no question marker
(`lib/launch-prompt-completion.mjs`): a notice beside a question is a miss. Another plugin,
another wording, an extra row in the block (another notice stacked against it),
the text without the bar, or the text inside a longer row is no match. A notice
Claude keeps behind `N more notice hidden` is not on the screen, so it is no
match: that start blocks as an unknown screen.

## Entries

Each entry has `id`, `kind` (`confirmation` or `flag-ignored`), `text` (the
normalized confirmation, or the normalized notice block) and `provenance` (one
row per capture: `claudeVersion`, `platform`, `capturedAt`, `source`).
A `confirmation` entry also has `selected` (the option line that carries `❯`);
a `flag-ignored` entry has `input: "none"`: it takes no input, ever.
Loading refuses a `confirmation` entry whose `❯` does not occur exactly once
immediately before `1. `, or whose `selected` is not that line; a `flag-ignored`
entry without `input: "none"`, with any `❯` or a `selected`, or that does not name
`--dangerously-load-development-channels` once; and any entry whose text does not
name exactly one channel, `plugin:aweb-channel@awebai-marketplace`. A hand edit
that moves the selection fails the tests.

One entry today, `aweb-dev-channel-confirmation-1`: Claude 2.1.289 and 2.1.296
on darwin-arm64 and 2.1.296 on linux-arm64 render the same text. The raw
captures and their provenance are in `test/fixtures/launch-prompts/`
(`dev-channel-provenance.json`), each tested against the entry. The entry's
2.1.288 linux-x64 row is reported coverage, not a committed capture: the
oats#917 release review (5481510495) matched its own frames, which it keeps.

One `flag-ignored` entry, `aweb-dev-channel-flag-ignored-1`: Claude 2.1.296 on
darwin-arm64, captured in the oats#917 live run
(`claude-2.1.296-darwin-arm64-flag-ignored-80x24.txt`, the notice visible; the
same run's `…-flag-ignored-hidden-80x24.txt` is the notice hidden, negative
evidence).

## Adding a wording

A new Claude wording is a new entry, in a reviewed change, with the raw
capture (unedited `tmux capture-pane -p`, before any key; for a notice, of the
started session) and its provenance
committed under `test/fixtures/launch-prompts/` and a test that it matches.
Capture it the way the existing ones were: a private tmux socket, a throwaway
`CLAUDE_CONFIG_DIR` seeded only with completed onboarding, a dummy-key
approval, the offline channel gate (`cachedGrowthBookFeatures.tengu_harbor`)
and trust for an empty throwaway directory; a dummy key, no network after the
install, no key sent. The version string is the only kind of variation entries
may carry, and only where a captured wording contains one. Never widen an entry
into a pattern.

Folder-trust prompts are never confirmed. The captured trust screens in
`test/fixtures/launch-prompts/` are negative test evidence.

# Resume-confirmation entries

`resume-confirmation.json` lists the dialogs Claude may show when OATS resumes a
lost session (`claude --resume <id> -- '<notice>'`) and Claude asks how to resume
a long, inactive conversation (Pro/Max plans). `launch-prompt-fixtures.mjs`
loads and validates it (`validateResumeConfirmationEntries`,
`RESUME_CONFIRMATION_ENTRIES`, `matchResumeConfirmation`), and
`launch-prompt-resume.mjs` watches the resumed pane for it. OATS only
**reports** this dialog ("waiting for you to choose"): it never answers it, never
sends a key, and never sets or reads an undocumented Claude variable.

## Derived, not captured

No real capture of these dialogs exists. The entries are **derived** from
Claude's own strings: `claude-resume-cost-2.1.308` from the strings of the
Claude Code 2.1.308 binary, `claude-resume-conversation-documented` from Claude's
documentation (sessions page, "The 'Resume this conversation?' dialog") and the
2.1.304 changelog. Each provenance row says so (`source: "derived"`, the Claude
version, the evidence). A `note` may record context strings the dialog shows (its
title, body, a `Don't ask me again` option); they are never required to match.

## Matched by whole labels, not by equality

An entry is a list of option `labels`. It matches when **every** label appears
in the normalized screen (the same normalization as above) as a **whole label**:
an occurrence not preceded or followed by a letter or digit. So
`❯ 1. Resume from summary (instant, recommended)` matches the label
`Resume from summary`, and `Resume from summaryX` does not. One label of a pair
alone is no match. A label split across rows that each carry a side border
(`│`) does not normalize back to the label, and is no match.

A label match is acceptable here, where a `confirmation` entry keeps full-screen
equality, because of what a match does: a resume-confirmation match only
reports, so a false match costs a wrong "waiting" line, whereas a `confirmation`
entry gates a keystroke and stays exact.

Loading refuses an entry with a `selected` key, any `❯` anywhere (labels
included), an `input` other than `"none"`, a kind other than
`resume-confirmation`, fewer than two labels, an empty or not already normalized
label, or a provenance row without a `source`; ids are unique. The loaded entries
are frozen. The development-channel loader still refuses a `resume-confirmation`
kind in `dev-channel-confirmation.json`.

## The watcher

`watchResumeConfirmation` polls the pane through the launch transport's
`snapshot` for at most 20 s. A matching screen reports the entry at once. It
stops early once the screen has shown a working session (Claude's
running-session banner, or the notice echoed as the session's first turn) with
no match for the settle window (2 s): Claude shows the dialog on the first
message after resuming, so a session showing that message without the dialog has
passed it. A false early stop costs only a missing "waiting" line, never a key. A
snapshot that fails (pane gone, replaced, not exclusively owned) stops it as
unobservable; an unknown screen at the bound is not a block.

## Replacing a derived entry

When a real capture of a dialog exists, it replaces the derived entry in a
follow-up, reviewed change, with the raw capture (unedited
`tmux capture-pane -p`, no key sent) committed under
`test/fixtures/launch-prompts/` and a test that it matches.
