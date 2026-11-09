---
name: direction-gate
description: Judge, when an author calls you, whether a change belongs where it is and moves the project the way its roadmap and recorded decisions say - a contract or structural question before it is built, or the direction part of a read your landing rules need. It is a call, never a gate every change passes. Consult the recorded decisions first, and record each new architectural call with its reason and the alternatives rejected; superseding a decision a human accepted needs that human's own confirmation. Use when an author asks you a contract, structural or direction question, before you decide one yourself, and in every read you are called for.
---

# Direction gate

An author calls it: an expert asks you, by message at an exact reference, before it builds
a contract or structural change, or a read your lane's landing rules need includes it.
Answer in that thread. It is never a gate every change passes: a change nobody brings you
lands on its lane's other agreements. In a read, run it against the full diff.

## Read before you judge
- **The recorded decisions:** your knowledge's accepted decisions, the living roadmap, and
  the coherence rules. Say whether your answer rests on an accepted decision or an open
  question.
- **The change as it is, not as it's described:** compare the PR's stated outcome with its
  full diff. "Fix" over a diff that adds a new surface is a direction question.

## Ask
1. **Does it belong here?** The right layer, module, package or repository; core or
   extension; code, configuration or docs. Name where it would belong if not here.
2. **Does it move the roadmap?** Forward, a small detour said out loud, or a pull in another
   direction (which needs a decision, not a merge).
3. **Is it a contract change?** Anything other people's code or configuration relies on: a
   public API, a config key, a file format, a message shape, an environment variable, a
   command's output. Decide before it's built who breaks, what they must change, and how
   the failure tells them (an error that names the fix, not a silent change). A
   correctness fix doesn't justify a new contract.
4. **Is it the simplest shape that fits?** No second way to do what the project already
   does one way; no new mechanism where an existing one stretches.
5. **Does it keep the coherence rules?** If not, either the change bends or the rule
   changes, explicitly and recorded.

## Outcomes
| Finding | Do |
|---|---|
| Fits | Say so in one line; in a read, go on with the other review gates. |
| Fits with changes | Say the change needed and why, with the decision or rule it rests on. |
| Needs a decision | Stop. Put the question to whoever decides it (your soul or human says who), with the options and your recommendation. Nothing is built or merged on it meanwhile. |
| Doesn't belong | Say where it would belong, and whether part of it can land here. |

## Record
- A new architectural or structural call: its reason and the alternatives rejected, in
  your knowledge. Supersede the decision it replaces; don't leave both standing.
- Superseding a decision a human accepted needs that human's own confirmation, cited
  exactly (the comment that says it, not the thread), before the knowledge change merges.
- A changed direction: update the living roadmap in place.
- A coherence rule you just enforced for the first time: write it down.
