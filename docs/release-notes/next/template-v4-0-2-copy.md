## Changed

- **OATS's own copy of the engineering template moves to template-v4.0.2.**
  The two patch releases fix how a lane's maintainer is found and started.
  The copy takes them in, adapted to the lane map, where a lane's maintainer
  is still its `active` entry. This changes the texts this workspace's own
  souls are composed from, not the kernel or any package contract.
  - **A refused spawn means the seat is held.** When `oats spawn` refuses a
    maintainer's name because it is taken, a holder is running or stopped.
    The dispatcher, the expert and the maintainer each find it and start
    none under another name.
  - **A new maintainer gets a name no instance has had.** The kernel accepts
    a retired instance's name. So before starting one, the dispatcher and
    the expert check each name of the family in turn with
    `oats instance events <name>`, and the maintainer's launch-work says to
    do the same. A name the roster still lists counts as used.
  - **A maintainer named only on the roster is asked about first.** Such a
    name may be retired or running elsewhere. The dispatcher, the expert and
    the maintainer ask their person before starting another.
  - **The dispatcher handles the expert's other cases too.** In another
    person's lane, it asks their dispatcher, or that person. Where the
    workspace has no maintainer soul, or it can't tell the lane or its
    owner, it asks its person. In each case it starts none.
- **The maintainer soul's OATS review skill agrees with `pr-review`.** It
  names the four gates for the release lane's sign-off as well as for a PR
  with no lead, and the green light's read of the whole diff.
- **The official catalog** lists template-v4.0.2 as the engineering
  template's latest release.
