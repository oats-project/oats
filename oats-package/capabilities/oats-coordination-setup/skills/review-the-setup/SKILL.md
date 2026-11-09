---
name: review-the-setup
description: >-
  Change an organisation's coordination setup when a signal says it no longer
  fits (stalled hand-offs, unowned findings, an unreadable index, a recurring
  sub-area, a recurring can't-run, a lead with no merge path, a recurring
  card) by proposing the smallest change as a card. Use when such a signal
  reaches you, or when a person asks. Part of oats.coordination-setup.
---

# Review the setup

| Signal | Smallest change to propose |
| --- | --- |
| A hand-off waits on a recipient that is gone | Check that a hand-off to a role starts a fresh instance when nobody is on the effort; fix the instructions, not the people |
| Findings sit with no owner | Name an owner for that area, or route them to the lead expert |
| An expert's index no longer reads in one sitting | Split its knowledge into nodes, keeping one expert |
| Leads keep needing a way of working the expert doesn't have | A new expert soul for that way of working |
| Developers keep reporting the same thing they can't run | Repository instructions first, then a developer soul with that environment |
| A lead stacks PRs it can't land | Name a merge path for that lane (`/set-landing-rules`, step 3) |
| A maintainer keeps making the same special judgment | Write it into the landing rules |
| A person keeps answering the same kind of card | Move that decision into a rule or to the agents, with their yes |
| A person asks for a read they don't get | Add that agreement to their lane's landing rules |
| Two parts of the organisation keep drifting copies of one capability | Merge them into one capability they both compose |
| OATS's template has a release worth having | Read the template's CHANGELOG.md from the release `capabilities/TEMPLATE-RELEASE` records, port what fits by its `ADAPTING.md` section 6, and update that file and each ported capability's release sentence |

Propose each change as a card with your recommendation. Never add a station to
the path of every change.
