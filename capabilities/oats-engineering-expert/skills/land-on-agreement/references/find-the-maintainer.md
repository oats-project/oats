# Find the lane's maintainer

A maintainer is called by message at an exact reference: for its green light on a PR
where the lane's landing rules ask for one, for a contract or direction answer before a
build, for a merge they keep for it, for a release. It is never in your build loop.

<!-- OATS: OATS keeps its lane map: one entry per maintainer, one maintainer per person in each project lane and one for the whole release lane, and its maintainers keep the instance names they have. -->
Your landing rules point at the lane map, the pinned issue that names the lanes and who
owns each, with one entry per maintainer. Here a project lane has one maintainer per
person: the PR's is the one of your person in the PR's lane, every PR needs it, and it
brings in the second reader and the release lane. `lane:release` has one maintainer for
the whole project: a release, or a PR in that lane, goes to it whoever your person is.
Find it by its `active` entry on the map (for a project lane, your person's there), never
by a name pattern: OATS's maintainers keep the names they have. Then see whether it runs:
- `oats status --json`: this machine, each instance with its soul, running or stopped;
- across machines, your messaging layer's roster, by name.

Then:
- **Running:** call it.
- **Stopped:** message it anyway (messages wait), and tell its person it is stopped, so
  they can start it.
<!-- OATS: OATS keeps its lane map: a seat is its `active` entry there. -->
- **An `active` entry, or a maintainer of your person in that lane named only on the
  roster, with nothing running anywhere you can see:** it may be retired, or run where
  you can't look. Ask its person before you start one.
- **None** (no `active` entry for your person in that project lane, and none on the
  roster): start one for your own person, without asking, independent of you so your
  retirement can't stop it. Never in `lane:release`, which has one maintainer for the
  whole project: with none active there, ask your person, and start none:
  ```bash
  oats spawn <maintainer soul> --relation unrelated --name <person>-<lane>[-<count>]-maintainer --task-file <brief.md>
  ```
  A name is used once, so after a retired holder the next one carries a count before the
  role: `<person>-<lane>-2-maintainer`, then `-3-`. The name is the first of that family
  that no instance has had. The kernel doesn't refuse a retired instance's name, so check
  each in order before you spawn: `oats instance events <name>` lists a used name's
  events, a `retired` one among them, and says "no instance" for a name never used on
  this machine; a name the roster still lists is used too. A spawn refused because the
  name is taken means a holder is running or stopped: find it, and start none under
  another name. Brief: "maintainer for <person> in <lane>; first
  call: <your instance> asks for <the green light | the merge | the release> on <PR> at
  <head>, or for an answer on <the question, at its revision>; the lane map is <its
  link>". Then tell your person, in two or three
  plain sentences, what you started: "I started <name>, your maintainer for <lane>. A
  maintainer is the standing agent for a lane: it holds the lane's direction across
  efforts, gives its green light on every PR leads hand it, brings in the PR's second
  reader and the release lane's sign-off where the lane asks, merges where the lane map
  gives it the merge, and keeps its entry on the lane map. You retire it with
  `oats retire <name>`."
  As a specialist, tell your parent instead. In another person's lane, ask their
  dispatcher to start it, or them where they have none (`/hand-off-and-ask`, "Across
  people").
  Where the workspace has no maintainer soul, ask your person and spawn none.

When you can't tell the lane or its owner, ask your person; meanwhile plan and build, but
call and start none. Call the lane's maintainer, never all of them.
