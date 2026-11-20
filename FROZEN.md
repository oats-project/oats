# FROZEN: S2-D, the Desktop's agent view (Desktop UI rework, stage 2)

Frozen on 2026-11-20 by Joan's decision: the slice stops here and is kept for later. Today's Desktop may be
replaced by a bb-based app; if not, the work resumes from this branch.

## Where it stands
- Branch `agents/redesign-agent-view-developer`, built on main `e5b6c5ac4`. The last reviewed head is
  `31e2d5770`; this file is the only commit after it.
- Built ahead of the contract decision: `briefs/contract-d30-board.md` v4 (sha d0d0ff14b84a), in
  desktop-rework-lead's home. The kernel side is S2-K, PR #1998 (`agents/redesign-board-kernel-developer`),
  checked live against `cb423f6cd`.
- Complete to its spec, with the lead's decisions applied:
  - the facts strip, the terminal and the question zone in the agent's terminal tab, gated on `instance-board`;
  - answers typed through the tab's PTY lease, unsent;
  - the numbers disabled while a dialog claim is live;
  - the maintainer's four conditions on the `inspect --board` read;
  - F6 regions for keys, with no Alt+T and no leader row;
  - a layout budget that keeps the terminal visible.
- Review: four whole-change rounds, then three delta reads, all on Sol. The last delta read
  (2663653f5..31e2d5770) approved with no findings. No review finding is open.
- desktop-rework-lead had the hand-back at `31e2d5770`. VERIFIED was not given, and no PR exists.
- Live tier: checked against #1998's real CLI, with dark and light screenshots. They were in the developer's
  scratch space and are gone with its retirement; rerun the live check when resuming.

## Open items
- No open review findings.
- Linux tests: at `31e2d5770`, runs 44708052215 and 44708062816 passed; 44708073663 was still running at the
  freeze. Read its result, or rerun the affected files after the rebase.
- The PR description must say that `packages/desktop/renderer/instance-events-data.mjs` fixes a real Desktop
  bug. It checked `waitingOnYou` against the newest positive claim, not the kernel's #1502 rule (the newest
  claim that carries a message), and so refused answers where a harness's text-less claim followed one with
  text. The fix is pinned in `instance-events-data.test.mjs`.

## What a resumer does first
1. Rebase onto main. Expect conflicts in `renderer/shell.mjs` (slice 6a reshapes tabs; the agent view only
   touches `syncTabNeedsInput`, `closeTab` and `openTerminalTabInner`) and in `focus-regions.mjs` (slice 4).
   Read the contract's then-current version and #1998's merged shape against `packages/client/instance-board.mjs`.
2. Delete this file in its own commit.
3. Run one fresh whole-change review round (Sol or Opus, explicitly), since the rebase moves the base. Then hand
   back to the effort's lead for VERIFIED, and open a draft PR with the `hold` label until both sides decide the
   contract.
4. Rerun the live tier against the kernel's real CLI with a private HOME, OATS_HOME_DIR and TMUX_TMPDIR. A
   stand-in harness that echoes its input line shows the typed answer in the tmux pane.

## Where things are
- Shared rules: `packages/client/instance-board.mjs`.
- The view: `packages/desktop/renderer/agent-board.mjs`.
- Its link to the shell: `packages/desktop/renderer/agent-board-tabs.mjs`.
- Tests: `packages/desktop/test/agent-view*.test.mjs` and `instance-board.test.mjs`.
- Docs: `docs/desktop.md` ("The agent view: facts and questions"), `packages/desktop/docs/desktop-keyboard.md`,
  the renderer README and `docs/release-notes/next/desktop-agent-view.md`.
