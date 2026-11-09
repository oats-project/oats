---
name: adapt-to-the-organisation
description: >-
  The onboarding pass that shapes OATS's coordination practices to one
  organisation: read first, ask each person only what reading can't tell, set
  up across-people coordination when there is more than one person, adapt
  OATS's coordination template (or the organisation's existing coordination)
  into the workspace's own, and propose it for each person's yes. Use inside
  `/oats-tailor-workspace` step 2 at onboarding, or when an organisation
  already running OATS asks to move to these practices. Part of
  oats.coordination-setup.
---

# Adapt to the organisation

At onboarding you hold this conversation yourself, folded into
`/oats-tailor-workspace` step 1's reads and its one round of questions. A
sub-agent only writes the capabilities from the design the people agreed.

1. **Read first** (at onboarding, step 1's reads cover this):
   - the workspace;
   - each repository's instructions, dev skills and CI;
   - the forge's ownership and protection settings;
   - any doc on how the organisation works;
   - for an organisation already on OATS, its souls, capabilities and lane
     arrangements, and what its people say works and what hurts.
2. **Ask each person once, briefly,** only what reading can't tell: what they
   own, what they want to decide themselves, and how they want to be reached.
   At onboarding these questions go in step 1's one round.
3. **One person or several.** With several people, include:
   - the ownership record (who owns which paths and lanes);
   - a dispatcher each who wants one;
   - the across-people rules.
   With one person, leave these out.
4. **Design** the roster (`/design-the-roster`) and the landing rules
   (`/set-landing-rules`).
5. **Adapt the template.** Start from the engineering package's capabilities,
   one per role, copied as this workspace's own. For an organisation already on
   OATS, start from the coordination capabilities it already has instead. Then:
   - take out the template's assumptions this organisation doesn't share;
   - make the role skills agree with the landing rules: who opens the PR (the
     developer's inject and the expert's landing skill), who merges, and when
     an expert finds or starts a maintainer;
   - write in the roster, the landing rules and, with several people, the
     ownership record;
   - add run-and-test skills only for repositories whose owners don't take them
     into the repository itself (`/design-the-roster`, step 4).
   Note in each capability which template version it started from, so a later
   template release can be read for what is worth taking.
6. **Propose** the whole setup to each person, for their own part, as one card
   with your recommendation. Apply each part on its owner's yes, and write the
   reason beside each rule in the capability. For a person you can't reach yet,
   give the person onboarding with you their card to pass on, and list it in
   the brief (`/oats-tailor-workspace` step 6) under what is open and who
   decides it.
