# FROZEN: Desktop UI rework, slice 5 (the New agent form)

Frozen on 2026-11-20 by Joan's decision (relayed by desktop-rework-lead): the work stops here, kept for later. The
Desktop may be replaced by a bb-based app; if not, resume from this branch. Delete this file in the first commit of
the resumed work.

## Where it stands

- Built to the spec (desktop-rework-lead's `briefs/spec-slice5-new-agent.md`): one sheet with Soul (filterable list over
  `quickOpenRows`), Task (Enter starts, Shift+Enter newline), Harness (claude · codex · pi, default marked), Where only
  with two or more machines; no name field (kernel suggest-name; an older kernel gets Name back with one dim line); no
  relation picker (D6); Advanced holds everything else and the full preview; a one-line preview under the fields; the
  sheet closes on Enter, the pending row's dot pulses, the followed terminal opens without input focus (the row keeps
  it). Alt+P (`app.quickOpenSouls`) opens the form on its soul list (`preselectSpawn({ soulFirst: true })`).
- Code: `packages/desktop/renderer/spawn-dialog.mjs` (form, `createSoulStep`), `spawn-soul-field.mjs` (new),
  `spawn-dialog-keys.mjs`, `views/spawn.mjs` (`hostSheet`, `focusSheet`, `openSoulStep`, `chooseSoul`), `shell.mjs`
  (`soulSpawn.open`, `app.quickOpenSouls`, the follow's open, `pendingSpawnRow`'s `.ctx-dot.starting`), `shell.css`,
  `quick-open.mjs` (`limit`, `soul` on rows), `desktop-terms.mjs` (`DESKTOP_NOUNS`, identical to slice 1's).
- Pinned acceptance tests: `packages/desktop/test/new-agent-form.test.mjs` (7), passing. Docs updated (docs/desktop.md,
  renderer README, desktop-keyboard.md, desktop-spawn-preview.md, desktop-machines.md) and
  `docs/release-notes/next/desktop-new-agent-form.md`.
- Linux tests runs on ~70 affected files were green at earlier heads except `file-shell-integration` and
  `shell-handoff`, fixed in c62be4378; run 44707887425 on c62be4378 was in flight at the freeze (check its result).
- Live check (headless Electron over CDP, private HOME/OATS_HOME_DIR/TMUX_TMPDIR) done at c62be4378's parent; the
  screenshots were in the developer's scratch, not in the repository.

## Open findings and their fix plans

- No review round has run: nothing found yet, nothing open from a reviewer.
- The lead never answered the developer's eight default choices (mail 71b4a0d5, 2026-11-19); they were built as
  proposed: Alt+P opens the form; Enter before the preview or the suggested name answered waits ("Checking…"/"Naming…");
  Enter in Task submits (today's dialog used Mod+Enter, still bound); the form stays hosted by Workspace › Souls (a
  free-standing sheet is slice 6 material); older-kernel naming fallback; Where only with 2+ machines, Add a machine in
  Advanced otherwise; keys unchanged except Relationship's Mod+4 removed; compact preview line plus the full preview in
  Advanced. Confirm them with the lead before the PR.
- The palette's "Souls: quick open…" row still opens Quick Open's old overlay; slice 4 (agents/redesign-overlays-developer)
  removes the overlay and adds "New agent: <soul>" rows calling `soulSpawn.open(soul)`. Whoever lands second sets
  `app.quickOpenSouls`'s run to `soulSpawn.open()` (agreed with slice 4).
- Two small edits in slice 4's `keybindings-editor.mjs` (the group label "New agent", the Most useful row "New agent:
  choose a soul"): reconcile with slice 4.

## What a resumer must do first

1. Rebase onto origin/main: slices 1 (6ddf5b75), 2 and 3a have landed. Expect conflicts in `views/spawn.mjs`
   (`closeSpawnModal`: keep 3a's `s.page.focusLaunch` return, add the soul-first dismiss), `shell.mjs` (`pendingSpawnRow`,
   `app.quickOpenSouls`, the foot), `desktop-terms.mjs` (identical), and the roster/shell-design tests.
2. Rerun the affected files through the hand-started Linux tests workflow (local: at most one or two files, uptime first).
3. Redo the live check on the rebased head (screenshots, light and dark).
4. Run the review loop: a fresh reviewer each round, on github-copilot/gpt-6.1-sol or github-copilot/claude-opus-5.5
   named explicitly, until a round finds nothing to fix. Then hand back to the lead; the PR (lane:product, maintainer
   joan-product-maintainer) records D6's supersession of the relation picker with Pepe's words.
5. The bb effort will want the session backend shown when it isn't tmux: Advanced's Session backend for the choice, the
   preview's facts for the result.
