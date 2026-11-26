# The voice: where it comes from

## Simplified Technical English

Aircraft manuals are written in ASD-STE100, Simplified Technical English. The European aerospace industry made it for maintenance manuals. The goal was safety: a technician who doesn't speak English as a first language must understand an instruction the first time, with no guessing.

It has two parts:
- A small approved vocabulary, about 900 general words, so one word means one thing.
- Writing rules: short sentences, active voice, one instruction per sentence.

## Why 80%

On 2 Oct 2026 Andrej Karpathy wrote that we will spend more and more time understanding what models write, not only generating it. His first suggestion: ask the model to write about 80% of the way to ASD-STE100.

Full STE is right for a runbook. For a normal explanation it reads stiff and robotic. At 80% the text stays plain and direct, and still reads like a person wrote it.

## The prompt, as published

    Explain this at about 80% of the way to ASD-STE100 Simplified Technical English.
    Use short sentences. Use active voice. One idea per sentence.
    Use simple, common words. Explain technical terms the first time they appear.
    Give steps in order, one action per step.

## Before and after

- Before: "It may be advisable to consider restarting the service prior to proceeding."
  After: "Restart the service. Then continue."
- Before: "It looks like something went wrong while trying to start your agent."
  After: "The agent didn't start. The model isn't available. Choose another model."
- Before: "Successfully stopped!"
  After: "Stopped."
- An agent to a person: "Done. I changed 3 files and the tests pass. One decision is yours: do we keep the old endpoint?"

## Where it works, and where it doesn't

Works: runbooks, steps, explaining code or errors, first drafts of docs, any answer someone has to check.
Doesn't: stories, opinion, marketing copy. The style is too flat.

## Two warnings

- Short sentences can hide an "it depends". Say the caveat.
- Readable is not the same as correct. A clean wrong answer convinces more than a messy one. The STE maintainers say AI text can look like STE without following it. Keep checking the facts.

## Sources

- "Karpathy's 80% Rule: I Made AI Write Like an Aircraft Manual", Trends 24/7, Medium, 16 Oct 2026. Read in full.
- Karpathy's own post of 2 Oct 2026: not read.
- ASD-STE100 itself: not read. The rules here are the ones the article gives.
