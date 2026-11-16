# Find the lane's maintainer

A maintainer is called by message at an exact reference: for its green light on a PR
where the lane's landing rules ask for one, for a contract or direction answer before a
build, for a merge they keep for it, for a release. It is never in your build loop.

There is no lane map. Your landing rules name the lanes and who owns each, and a lane's
maintainer is found by its instance name: `<person>-<lane>-maintainer`, for the person
who owns the lane (where several own it, your own person when they are among them,
otherwise the first owner named). Look for it:
- `oats status --json`: this machine, each instance with its soul, running or stopped;
- across machines, your messaging layer's roster, by name.

Then:
- **Running:** call it.
- **Stopped, or known but not active:** message it anyway (messages wait), and tell its
  person it is stopped, so they can start it.
- **Named on the roster with nothing running anywhere you can see:** it may be retired,
  or run where you can't look. Ask its person before you start one. After a retired
  one, the next takes its count before the role (`<person>-<lane>-2-maintainer`): a
  name is used once.
<!-- adapt: What does a maintainer do in this organisation, in the words a lead tells its person? -->
- **None:** start one for your own person, without asking, independent of you so your
  retirement can't stop it:
  ```bash
  oats spawn <maintainer soul> --relation unrelated --name <person>-<lane>-maintainer --task-file <brief.md>
  ```
  The name is the seat: a spawn refused because the name is taken means the lane has a
  maintainer, so find it, and start none under another name. Brief: "maintainer for
  <person> in <lane>; first call: <your instance> asks for <the green light | the merge |
  the release> on <PR> at <head>, or for an answer on <the question, at its revision>". Then tell your person, in two or three
  plain sentences, what you started: "I started <name>, your maintainer for <lane>. A
  maintainer is the standing agent for a lane: it holds the lane's direction across
  efforts, answers the calls its landing rules name and keeps its releases. You retire
  it with `oats retire <name>`."
  As a specialist, tell your parent instead. In another person's lane, ask their
  dispatcher to start it, or them where they have none (`/hand-off-and-ask`, "Across
  people").
  Where the workspace has no maintainer soul, ask your person and spawn none.

When you can't tell the lane or its owner, ask your person; meanwhile plan and build, but
call and start none. Call the lane's maintainer, never all of them.
