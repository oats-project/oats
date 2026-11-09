---
name: adapt-to-the-organisation
description: >-
  The onboarding pass that shapes OATS's coordination practices to one
  organisation, in one order: read and ask (in `/oats-tailor-workspace` step
  1's one round), design the roster and landing rules, propose each person's
  part as a card, and on each yes have one sub-agent write the workspace's
  coordination capabilities from OATS's template (or from the coordination an
  organisation already on OATS has). Load it at `/oats-tailor-workspace` step
  1, or when an organisation already running OATS asks to move to these
  practices. Part of oats.coordination-setup.
---

# Adapt to the organisation

The order is fixed: **ask, design, propose, write.** You hold the
conversation yourself. At onboarding, steps 1 and 2 belong in
`/oats-tailor-workspace` step 1, and steps 3 to 6 in its step 2. A **card** is
one message to one person: the question, the options with their effects, and
your recommendation.

1. **Read**, beside tailor step 1's reads:
   - each repository's own instructions (`AGENTS.md`, `CLAUDE.md`), dev skills
     and CI;
   - the forge's ownership settings (CODEOWNERS) and protection rules;
   - the landing facts in `/set-landing-rules` step 1: signed commits and
     whose account agents commit under, each repository's own pre-PR review,
     the release process and today's sign-offs;
   - any doc on how the organisation works;
   - for an organisation already on OATS, its souls, coordination
     capabilities and lane arrangements, and what its people say works and
     what hurts.
2. **Ask, in the same one round,** only what reading can't tell: what each
   person owns, what they want to decide themselves, and how they want to be
   reached. For someone who isn't there, ask the person onboarding what they
   know; what stays open goes in that person's card (step 4).
3. **Design**, without writing anything yet:
   - the roster (`/design-the-roster`);
   - the landing rules (`/set-landing-rules`);
   - with several people, the ownership record and the across-people rules.
     With one person, leave them out.
4. **Propose.** Send each person one card for their own part: the souls that
   touch their work, and the landing rules for their lanes. For a person you
   can't reach yet, give the person onboarding with you that card to pass on.
   It asks them to answer you. Until they answer, their lanes keep the default
   merge path of `/set-landing-rules` step 2, and the brief
   (`/oats-tailor-workspace` step 6) lists their part under what is open and
   who decides it.
5. **Write, on each yes.** Run one sub-agent for all the coordination
   capabilities together, so they agree with each other. Give it the agreed
   design and these rules:
   - **Start** from the template: the engineering package's release in the
     catalog (the installed kernel's `docs/official-catalog.md`), copied from
     its repository at that tag. For an organisation already on OATS, start
     from its own coordination capabilities instead.
   - **Keep** one capability per role the roster keeps, as in the template.
     Where the roster has a dispatcher and the template has no dispatcher
     capability, write its instructions from `/coordination-best-practices`,
     "Who stands, who is fresh".
   - **Take out** the template's assumptions this organisation doesn't share.
   - **Make the role skills agree with the landing rules:** who opens the PR
     (the developer's inject, the expert's landing skill), who merges, and
     when an expert finds or starts a maintainer.
   - **Give the landing rules and the ownership record one home,** a single
     skill in the expert's capability, which the other roles' texts point to.
     Write each rule's reason beside it. Where the workspace keeps a lane
     map, record the lane arrangements there too.
   - **Add run-and-test skills** only for repositories whose owners don't take
     them into the repository (`/design-the-roster`, step 4).
   - **Note** in each capability which template release it started from.
   A part whose owner hasn't answered is written later, the same way, on their
   yes.
6. **Record** each choice and its reason beside its rule (step 5), and say in
   the brief what was set up and what is still open.
