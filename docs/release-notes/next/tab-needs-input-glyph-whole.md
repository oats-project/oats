## Fixed

- **The Desktop's Needs input mark shows whole on a terminal tab.** Since
  the tab's status dot moved after the name, the alert glyph that replaces
  it while an agent waits on you lost its right edge whenever it ended the
  tab's line: a long name with no branch, or a tab at its narrowest. The
  mark now has a 12px slot whichever state it shows, with the dot centred in
  it, so the glyph is never clipped and the name does not move when an agent
  starts or stops waiting. Terminal tabs are 5px wider at their narrowest
  (181px) to keep the room the name had; other tabs are unchanged.
