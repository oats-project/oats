---
name: hand-off
description: Hand work, a question, a check or a finding to another role - by a message that wakes it, about a finished artefact at its exact reference - resolving the role to the instance already on the effort or a fresh one, and waiting with no deadline. Use whenever anything you made or need goes to someone else, and when you answer one.
---

IMPORTANT: after a compaction, reload this skill before you continue the step.

# Hand off

## What you hand over
Only finished artefacts, at an exact reference: a spec at its commit, a branch at its head,
a PR at its head, a release's contents with the head to tag. Never half a problem.

## To whom
Name the role (the platform expert, a developer for this repository, the maintainer of this
lane), then resolve it:
1. **On the effort.** The effort's record lists who is on it. One listed there that is
   running (`oats status`) gets it.
2. **None.** Start a fresh instance of that role's soul:
   - your developers and probes are your children (`/coordinate-developers`,
     `/send-a-probe`);
   - an owner for work outside your effort in your person's area (a finding's owner, say)
     is independent of you: `oats spawn <soul> --relation unrelated --purpose <slug>
     --task-file <message.md>`, your message as its task;
   - a role in another person's area, or the maintainer of their lane: ask that person's
     dispatcher to start it, with your message as the request it reads by its id
     (`/across-people`); where they have none, ask them;
   - a lane's maintainer: `/find-the-maintainer`. Never a second while one is active, even
     a stopped one.
3. **Its name.** Give each new instance a name no instance has had. Never reuse a retired
   instance's name.

## The message
One message, in the effort's thread with that role:
- first line: what you need, and what happens on yes;
- the artefact and its exact reference;
- what you checked and how, and what you didn't;
- the people's decisions it rests on, each as recorded (`DECISION by <person>, <link>:
  <their words>`);
- what you need back: a verdict, an answer, a build.

The forge records what happened: the PR, its reviews, its merge. It never carries the
hand-off: no label, no flag and no comment is the signal.

## Waiting
End your turn; the answer wakes you. No answer has a deadline, and nothing goes ahead by
default.
- **A child** you wait on gets its checkpoint, which watches for a stalled instance
  (`/coordinate-developers`, "Set a checkpoint before you wait").
- **Whenever something else wakes you,** look at what you wait on. A recipient that retired
  without answering gets the message again, through step 2. One that stopped: tell whoever
  can start it (its parent, or its person), and start no second maintainer.
- **A person:** set needs-input (`oats instance attention --message "<one line>"`) and
  clear it (`--clear`) when they answer. Never set a timer on a person.

## Answering one
Answer in the same thread, at the reference you were given. If it moved under you, say so
and answer at the new one.
