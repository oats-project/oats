---
name: find-the-maintainer
description: Find the maintainer a lane's landing rules need - the lane your work is in, the person who owns it, their active maintainer there on the lane map (running or stopped), or start one for them yourself when they have none, never a second while one is active, and tell your person in plain words what a maintainer is, what it is for and its name. Use when a landing rule needs a maintainer's read, merge, release or direction answer, or when anyone asks you to bring a lane's maintainer in.
---

IMPORTANT: after a compaction, reload this skill before you continue the step.

# Find the maintainer

A maintainer is called by message at an exact reference, where a lane's landing rules need
its read (of a PR, or of a contract change before it is built) or reserve its merge. It is
never a station every change passes, and you look for one only then.
<!-- OATS: on the lane map every PR has a maintainer and a second reader, and most lanes need the release lane's sign-off. -->
Here the landing rules need one on every PR: the maintainer of your person in the PR's
lane. Call that one; it brings in the second reader and the release lane.

1. **Your person, and the lane** your work is in. Your person is whoever your task is for;
   the lane comes from your landing rules (for a release, the release lane they name).
   Until you know both, call and start no maintainer: ask whoever gave you your task who
   your person is, and your person which lane; meanwhile plan and build.
2. **Whose lane:** the person who owns it, from your landing rules' ownership record. With
   one person, it is yours.
   <!-- OATS: a project lane has one maintainer per person; a PR's is the one of the effort's person (the lane map). -->
   Here a project lane has one maintainer per person: the PR's is your person's there.
3. **Their maintainer there:** the lane map's `active` entry for that person in that lane,
   with your messaging layer's presence (its roster; without one, the entry alone).
   - **Running:** hand it the PR at its head, or the question at its commit (`/hand-off`).
   - **`active` but not running:** message it anyway (messages wait), and tell its person it
     is stopped, so they can start it. An entry not updated for two weeks: ask its person
     whether it was retired; only they, or the map's keeper on their word, mark it `left`.
   - **None, or `left`:** have the needed one started for that person. For your own person,
     start it yourself, without asking: spawn your workspace's maintainer soul for them,
     independent of you and never as your child, so your retirement can't stop it:
     ```bash
     oats spawn <maintainer soul> --relation unrelated --purpose <person>-<lane>-<n> --task-file <brief.md>
     ```
     `<n>` is one more than the number of earlier maintainers for that person and lane (the
     map's `left` entries), so no instance takes a retired one's name. Brief: "maintainer
     for <person> in <lane>; first call: <your instance> asks for <a read | the merge> of
     <PR> at <head>" (or "<the release> of <what goes in> at <head>"), and where the lane
     map is. Right after, tell your person, in two or three plain sentences, what you
     started:
     "I started <name>, your maintainer for <lane>. A maintainer is the standing agent for
     a lane: it reads and merges what leads hand it, after the PR's second reader and, where
     the lane asks, the release lane's sign-off, and keeps the lane's entry on the lane map.
     It is there so one agent, not each lead, decides what lands, and you have one place to
     ask about the lane; you retire it with `oats retire <name>`."
     For another person, send their dispatcher that brief and ask it to start the
     maintainer, with your message by its id as the request it reads, as a dispatcher
     starts any role another person's agents ask for; where they have none, ask them
     (`/across-people`). If your workspace names no maintainer soul, ask your person and
     spawn none.
4. **No lane map:**
   - **Your landing rules link none** (a copy adapted without one): the lane owner has no
     maintainer on record. Go on as in step 3, "None, or `left`": the maintainer started
     creates the map in your tasks layer and adds its entry. Send its link to whoever keeps
     your landing rules (`/findings-and-blocks`), so it is written there.
   - **They link a map you can't read:** that is a block (`/findings-and-blocks`). Start no
     maintainer until you can read it: you couldn't tell whether one is active.

Never a second maintainer for a lane while one is active, even a stopped one. Call one
maintainer, the lane owner's, never all of them.
