---
name: test-first
description: Write the test before the code, one slice at a time - first find and run the existing tests the change touches, then for each slice a test you watched fail for the expected reason, the least code that passes it, and the touched tests again; tests through public interfaces, expected values from an independent source, mocks only at system boundaries. Use before you write or change code with behaviour to test, and on every slice of it.
---

# Test first

The repository's own test conventions win where they differ from this skill. The spec's
acceptance tests go in unchanged (your briefing says so); this skill is for the tests you
write around them.

## 1. Find the tests the change touches, and run them
Before you change anything, find the existing tests that cover the code the change touches:
the tests beside it, the ones that import it, the ones CI runs for its paths. Run them, and
note which pass now. Knowing which tests a change affects cuts the regressions it causes far
more than an instruction to write tests first does, so this step comes before your first new
test. Run them again after every slice.
<!-- OATS: CI is the gate; the oats repository allows at most one or two test files locally and never its kernel or Desktop suites. -->
Within your briefing's host rules ("On the hosts you run on"): in the oats repository, run at
most one or two of those files locally, never a suite or a batch, and leave the rest to CI
on your pushed branch; name in your hand-back which ran where.

## 2. One vertical slice at a time
For each slice of the spec, in turn:
1. Write one test for one behaviour, named for that behaviour.
2. Run it and watch it fail, for the reason you expect: the behaviour is missing, not a typo
   or a broken import. A test that passes at once tests something that already exists, and
   a test you never saw fail proves nothing.
3. Write the least code that makes it pass, and nothing a later test might want.
4. Run it, then the tests from section 1. Fix the code, not the test.

Don't write all the tests first and then all the code: tests written ahead of the code pin
an imagined shape rather than the behaviour. Code you wrote before its test stays, but test
it now, and watch the test fail with the behaviour broken or removed before you trust it.

## 3. Tests worth keeping
- **Through public interfaces,** at the seams the spec or the code already has. A test that
  breaks on a refactor that keeps the behaviour is coupled to the implementation.
- **Expected values from an independent source:** a known-good literal, a worked example,
  the spec. Never computed the way the code computes them: such a test passes by
  construction and can never disagree with the code.
- **Mocks only at system boundaries** (the network, the clock, a paid service), never for
  your own collaborators, and never an assertion on the mock instead of the behaviour.
- **One behaviour per test.** A name with "and" in it is two tests.
- A test that is hard to write says the interface is hard to use (`/design-while-writing`).

Adapted from sources listed in THIRD-PARTY-NOTICES.md
