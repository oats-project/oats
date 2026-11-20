// A node:test reporter for the root run (scripts/run-tests.mjs). It shows a person nothing: the
// reporter they read is the other one. It also records skipped real-aw tests,
// which fail the root gate as missing native-path evidence. It reads what each test file wrote to its stderr and stdout,
// as the run received it, and writes one JSON line to its destination for every line that holds
// `oats: warning:`. The root run fails when there is one.
//
// Test output is pristine (awebai/oats#910): an expected warning is captured and asserted by the
// test or by its fixture, never left in the output. What reaches a file's output is what its
// worker wrote, and what a child wrote whose stderr or stdout the worker gave it as its own. A line
// a child wrote into a pipe the test reads is the test's, and never comes here.

/** What marks a warning of the kernel or the CLI. */
export const WARNING_MARK = "oats: warning:";

export default async function* unassertedWarnings(source) {
  const unfinished = new Map(); // a file's stream → its last line, when it has no newline yet
  const found = (file, stream, line) => `${JSON.stringify({ file, stream, line })}\n`;
  for await (const event of source) {
    // Native aw regressions are real-path evidence only when they run. Keep
    // platform skips separate; a missing native binary/fixture fails the gate.
    if (event.type === "test:pass" && event.data.skip && /^real[- ]aw\b/i.test(event.data.name)) {
      yield `${JSON.stringify({ kind: "skipped-real-aw", file: event.data.file ?? "(a file the run did not name)", name: event.data.name })}\n`;
    }
    if (event.type !== "test:stderr" && event.type !== "test:stdout") continue;
    const stream = event.type.slice("test:".length), file = event.data.file ?? "(a file the run did not name)";
    const key = JSON.stringify([file, stream]);
    const lines = `${unfinished.get(key) ?? ""}${event.data.message}`.split("\n");
    unfinished.set(key, lines.pop());
    for (const line of lines) if (line.includes(WARNING_MARK)) yield found(file, stream, line);
  }
  for (const [key, line] of unfinished) if (line.includes(WARNING_MARK)) yield found(...JSON.parse(key), line);
}
