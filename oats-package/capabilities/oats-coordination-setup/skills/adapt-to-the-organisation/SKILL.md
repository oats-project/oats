---
name: adapt-to-the-organisation
description: >-
  The onboarding pass that shapes OATS's coordination practices to one
  organisation, in one order: read and ask (in `/oats-tailor-workspace` step
  1's one round), design the roster and landing rules, propose each person's
  part as a card, and on each yes have one sub-agent write the workspace's
  coordination capabilities from the closest of OATS's coordination templates
  (or from the coordination an organisation already on OATS has). Load it at
  `/oats-tailor-workspace` step 1, or when an organisation already running
  OATS asks to move to these practices. Part of oats.coordination-setup.
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
4. **Propose.** The person onboarding with you approves the shared parts (the
   souls and the role capabilities everyone composes) and their own. Each other person (anyone
   who runs agents, owns a lane, or merges in one today) gets one card for what
   is theirs alone: their lanes' landing rules, their ownership entries, their
   dispatcher and their maintainer. Ask in it whether their repositories will
   carry run-and-test instructions (`/design-the-roster`, step 4).
   - For a person you can't reach yet, give the person onboarding with you that
     card to pass on. It tells them to answer, once they join, to their
     machine's setup expert, which reads the open part from the ownership
     record.
   - Until they answer, their lanes land as they do today
     (`/set-landing-rules` step 1): agents hand that person a PR at an exact
     head. Step 5 writes that interim rule, marked open, and their yes
     replaces it.
   - At onboarding, the brief (`/oats-tailor-workspace` step 6) lists their
     part under what is open and who decides it.
5. **Write, on each yes.** Run one sub-agent for all the coordination
   capabilities together, so they agree with each other. Give it the agreed
   design and these rules:
   - **Start** from the template closest to each group's way of working: one
     of OATS's template repositories, listed in the installed kernel's
     `docs/official-catalog.md` ("Coordination templates"), copied at its
     latest `template-v*` tag. Follow its `ADAPTING.md` in order. One
     organisation can start different groups from different templates, with
     one dispatcher for each person who wants one.
   - **Check the ids first,** as `ADAPTING.md` section 1 says: run
     `oats capabilities` and settle each id the template brings that is
     already listed, before copying anything. A pin of the frozen package
     `oats.engineering` is copied over, then removed by the template
     CHANGELOG's "From v1.18.0". An earlier copy of the template is taken up
     to the new release in place, never copied a second time. Anything else
     with the same id gets a new id in the copy, or that capability is left
     out. An organisation already on OATS with coordination of its own, not
     from a template, starts from those capabilities instead.
   - **Adapt each marker:** each `<!-- adapt: ... -->` comes out once its
     point is answered or keeps its default. A point that waits on a person
     who hasn't answered (step 4) keeps its marker until their yes; the
     markers left are the copy's open points.
   - **Keep** one capability per role the roster keeps, as in the template,
     plus one for each way of working whose skills differ, composed by that
     expert soul. Where the roster has a dispatcher and the template has no
     dispatcher capability, write its instructions from
     `/coordination-best-practices`, "Who stands, who is fresh".
   - **Take out** the template's assumptions this organisation doesn't share,
     and its standing gates unless the landing rules keep them: a sign-off
     before every merge, a final review of every PR, an expert that must find a
     maintainer before any PR.
   - **Keep the Desktop's grouping** (`/oats-tailor-workspace` step 2's list):
     a lead the dispatcher starts is top-level, a feature's agents share its
     work, and each group has one colour.
   - **Make the role skills agree with the landing rules:** who opens the PR
     (the developer's inject, the expert's landing skill), who merges, and
     when an expert finds or starts a maintainer.
   - **Give the landing rules and the ownership record one home:** one small
     capability of the workspace's own that every coordinating soul composes.
     Write each rule's reason beside it. A lane map, where the workspace keeps
     one, names who is active in each lane and points to that capability.
   - **Run-and-test:** where a repository's owners agreed to carry the
     instructions, propose them as a PR to that repository, by its rules;
     otherwise add a run-and-test skill to the workspace's developer
     capability.
   - **Copy the notices:** the template's `LICENSE` notice, and its
     `THIRD-PARTY-NOTICES.md` beside the copied capabilities while any skill
     that points to it stays.
   - **Record the release,** as `ADAPTING.md` section 4 says, so the next
     port is a diff: each copied capability keeps the template's sentence
     naming its release at the end of its `oats.json` description and
     numbers its `version` its own way from then on, and the host repository
     gets `capabilities/TEMPLATE-RELEASE`: the template, its release, the
     commit that tag points to, and the capabilities and souls copied.
   A part whose owner hasn't answered is written later, the same way, on their
   yes.
6. **Say** what was set up and what is still open: in the brief at
   onboarding, otherwise in your answer to whoever asked.
