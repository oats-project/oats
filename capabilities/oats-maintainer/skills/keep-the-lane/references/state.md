# The maintainer's state file

One file, rewritten on every full sweep and updated row by row between sweeps, in this
order. Keep it where your working state lives (your instance home, or wherever your soul
says), not in the repository. Empty sections stay, with "none", so a reader can tell
"nothing" from "not checked". Every call made to you (a green light, a merge, a question)
goes under "Waiting on me".

```markdown
# Maintainer state: <repositories>, lane <lane> (swept <date and time>)

## Waiting on me
| What | From | Since | Reference | Next action |
|---|---|---|---|---|

## Efforts in flight
| Effort | Lead expert | Asked by | Launched by (me / directly) | Since | Waiting for |
|---|---|---|---|---|---|

## Open PRs
| PR | Author | Head | CI | Agreements at this head | Hold: reason, scope | Next |
|---|---|---|---|---|---|---|

## Waiting on others
| What | Who | Since | Reference | Last asked |
|---|---|---|---|---|

## Overflow seat
Its instance name and its efforts, a line each; "none" when you have none.

## Release in flight
The release owner: the version, where the plan is, the release-prep PR, gates run and
still to run. Everyone else: the version, and which of your lane's PRs are in it.

## Decisions pending
| Question | Who decides | Asked | Recommendation |
|---|---|---|---|

## Follow-ups
The honest follow-up list: what, why, where it's tracked, owner.

## Since the last sweep
Merged (with SHAs), released, retired, decided, recorded in knowledge.
```

Rules:
- Exact references only: `repo#PR @ <sha>`, message ids, work items, tags. Never "the
  latest".
- A hold names its scope (which PR, which action) and who can lift it. The hold itself is
  recorded where the landing rules say; this file only says what you wait for because of
  it.
- What you merged or released appears once under "Since the last sweep", with the
  observed result (merge commit, CI on it, the published version), not the intent.
