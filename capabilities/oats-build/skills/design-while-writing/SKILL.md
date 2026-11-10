---
name: design-while-writing
description: Keep code well shaped while you write it, on every slice - deep modules behind small interfaces, the deletion test, no seam with a single adapter, an interface designed twice before you choose, the contract first and additive changes for anything another surface uses, thin slices that touch only what the spec needs, and structural and behavioural changes in separate commits. Use while you write or change code, on each slice and not once.
---

# Design while writing

Guidance makes a first draft cleaner, but it doesn't stop code eroding over the changes that
follow. So apply this on every slice, not once at the start.

## 1. The shape of a module
- **Deep modules behind small interfaces:** much behaviour behind an interface a caller
  learns quickly. The interface is everything a caller must know: types, invariants, error
  modes, ordering, cost. An interface nearly as large as its implementation is a
  pass-through.
- **The deletion test:** imagine deleting the module. If the complexity vanishes with it, it
  was a pass-through; if it reappears in every caller, it earns its place.
- **One adapter is a hypothetical seam.** Add an interface or a seam only where something
  varies across it now (two implementations, a test double at a real boundary), never for a
  future that may not come.
- **Design it twice.** For a new interface, sketch two different shapes before you choose,
  and compare what each asks callers to learn and where change will land.
- Accept dependencies rather than create them; return results rather than change shared
  state.

## 2. Contracts other surfaces use
- **Contract first:** for an interface another surface uses (an API, a command, a file
  format, an event), write the contract (types, errors, examples) before the implementation.
  A change to one is your expert's call (your briefing says so).
- **Every observable behaviour becomes a contract** once someone depends on it: error text,
  ordering, timing. Expose only what you mean to keep.
- **Additive over breaking:** add a field, a parameter or a version rather than change one.
- Validate input once, at the boundary, and trust it inside.

## 3. Thin slices
- One slice at a time, each complete, tested and committed before the next (`/test-first`).
  More than about 100 lines without running the tests is a sign to stop and test.
- Touch only what the spec needs. Something worth improving outside it is a line in your
  hand-back, not a change.
- **Never mix structural and behavioural changes in one commit.** A rename, a move or an
  extraction goes in a commit of its own, with the tests green before and after, so each
  commit is easy to review and to revert.
- Keep the tree building at every commit.

Adapted from sources listed in THIRD-PARTY-NOTICES.md
