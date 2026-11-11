# Knowledge and learning

How OATS agents keep what they learn, so that every new instance of a soul starts wiser than the last. This page describes our default approach, implemented by the official `oats.okf` knowledge capability. Other knowledge capabilities can adopt it, adapt it or work differently.

## Four kinds of value, four places

An experienced agent carries four kinds of value, and each belongs in a different place:

- **Reusable procedures and know-how** belong in skills and capabilities. How to run a release is a skill.
- **Lasting judgment and the larger picture** belong in the knowledge base. Why a release must verify the installed artifact is a lesson.
- **A detailed understanding of the current problem** belongs in the instance's working context.
- **Unfinished work and next steps** belong in the instance's own state. Which release check is still running is state.

Only the second goes into the knowledge base.

## Keep expertise, not a second description of the code

> **Knowledge is what makes an expert an expert in a subject or project. It is not a description of what lives in the code.**

A lesson is kept when both answers are yes:

1. Would a future instance of this soul act differently for knowing it?
2. Is it something the instance could not learn by simply reading the repository?

- **Kept:** decisions and their reasons, rejected alternatives, discoveries, research conclusions, design inspiration, and awareness of the larger situation.
- **Not kept:** code structure, file maps, ordinary task progress, or anything the repository already makes clear. A second copy of what the code says only grows stale.

## Souls divide the knowledge base

- The knowledge base is divided into areas, such as the release process, the kernel or the design system.
- Each area has exactly one owning soul. Its instances' lessons are proposed to that area, and other souls hand lessons for it to its owner. Keeping the base consistent is maintenance, done by a knowledge maintainer or a person.
- Other souls read an area when their work touches it, and link to it rather than copying it.
- So every agent starts with a well-defined context: the area its soul owns, and the few it reads. Every area lives in one place, owned by one kind of agent.
- Each instance of a soul keeps its own working context and state for its own piece of work.
- Adopting someone else's published soul does not send your learning back to its publisher.

## How learning flows

1. **Instances work and capture evidence.** Each one keeps notes on what it decided and discovered.
2. **An independent harvester judges what is worth keeping,** at set moments such as a pull request handed over or a task finished.
3. **The proposal is validated and delivered** through the knowledge base's acceptance process. For a Git-backed knowledge base that is a pull request, reviewed by a knowledge maintainer agent or a person.
4. **Future instances consult the accepted result.**

Working instances never rewrite the accepted knowledge base directly. An open pull request is not yet accepted knowledge, and a delivery receipt does not prove that a person approved it or that another instance has read it.

## Our default: oats.okf

- It uses **Open Knowledge Format**: readable Markdown concepts with metadata, links and history.
- A team shares its knowledge bases, one or more, divided among its souls as above.
- It needs explicit bindings and setup; not every step is automatic.

## Your own way

OATS provides the contracts, and the knowledge capability decides how knowledge works. With the right capability you can, for example:

- let new instances inherit a soul's accumulated expertise;
- let instances of one soul develop their own specialisations from a shared foundation;
- let a long-running instance keep its working understanding across many tasks;
- turn selected learning into shared knowledge after review.

A knowledge capability can organise knowledge per soul, per topic or per project, centrally or next to the soul definitions, as long as it actually supports the arrangement you choose. Messaging and tasks work the same way: OATS provides the contracts, and you choose how your team works through them.

## Expertise can evolve

- Souls can widen their scope, hand an area to a better-placed soul, merge, or split into more specialised souls.
- A deliberate split into new reusable specialisations is called **speciation**. A generalist that keeps handling UX work, for example, can give rise to a dedicated UX expert. The new expert owns the UX area, and the generalist consults it rather than duplicating it.
- These changes are proposed and reviewed. A busy period or a large pile of notes is not enough on its own, and no agent reshapes its own soul.

## Learn more

- [Knowledge, instances and evolving expertise](knowledge-theory.md): the full model, including long-running instances, harvesting, maintenance, hand-offs and cloning.
- [Knowledge operations](knowledge.md): how the knowledge capability is set up and run.
