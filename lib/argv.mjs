/** lib/argv.mjs — how the kernel reads `--flag=value` (docs/desktop-cli-api.md "Flag syntax"): the CLI's
 *  dispatch expands its argv here once, and a process answering reads (lib/reader.mjs) expands each request's
 *  argv here, so both give a malformed flag the same E_BAD_ARGS. Kernel-private, not exported from `./core`.
 *  Dependency-free. */

/** The kernel's switches: a value never rides one (`--yolo=false` must not turn yolo on). */
const KERNEL_SWITCHES = new Set(["allow-child-spawns", "apply", "background", "board", "check", "clear", "composed-skills", "delete-branch", "discard-worktree", "dry-run", "ephemeral", "force", "help", "host", "if-absent", "install-oats", "instructions", "json", "keep-dir", "keep-env", "no-background", "no-child-spawns", "no-default", "no-launch", "no-recursive", "no-yolo", "plan", "policy", "preview", "print", "related-work", "replace", "run-source", "same-work", "self", "skills", "suggest-name", "verbose", "yes", "yolo"]);
/** `--flag=value` is `--flag value`: every kernel reader (flag(), valueFlag(), the onboard and
 *  routed-command loops) then applies the spaced form's validation to it. `problem` is an empty
 *  `--flag=`, a switch given a value, or a value that is itself an option (`--model=--yolo`):
 *  expanded, it would be a flag token every reader sees, which the spaced form can never carry. */
/** Free-text flags whose inline value may start with `--` (`--message=--deploy failed`). Such a
 *  value is kept out of argv, where it would read as a flag (`--message=--clear` must not
 *  clear), and flag() answers it from `inline`. */
const INLINE_TEXT_FLAGS = new Set(["message"]);
/** Free-text flags whose inline value is always kept whole, the empty one included:
 *  `--description=` clears a trigger's or schedule's description. */
const INLINE_WHOLE_FLAGS = new Set(["description"]);
/** A word that is a switch everywhere but one form, where it takes a value: `oats instance board ask
 *  --clear <id>` (feature instance-board). There, `--clear=<id>` is `--clear <id>`. */
const VALUE_IN_FORM = [{ words: ["instance", "board", "ask"], name: "clear" }];
export function expandInlineValues(argv) {
  const out = [];
  const valued = new Set(VALUE_IN_FORM.filter((f) => f.words.every((w, i) => argv[i] === w)).map((f) => f.name));
  const inline = new Map();
  let problem;
  for (const a of argv) {
    const eq = a.indexOf("=");
    if (!a.startsWith("--") || eq <= 2) { out.push(a); continue; }
    const name = a.slice(2, eq), value = a.slice(eq + 1);
    if (INLINE_WHOLE_FLAGS.has(name) || (INLINE_TEXT_FLAGS.has(name) && value.startsWith("--"))) { inline.set(name, value); out.push(`--${name}`); continue; }
    problem ??= KERNEL_SWITCHES.has(name) && !valued.has(name) ? `--${name} takes no value (got ${a})` : value === "" ? `--${name}= needs a value` : value.startsWith("--") ? `--${name}= takes a value, not an option (got ${a})` : undefined;
    out.push(`--${name}`, value);
  }
  return { argv: out, problem, inline };
}

/** A flag's value in an expanded argv (`args`, `inline`: expandInlineValues's): its free text from `inline`, the word
 *  after it, `true` when it has none (the next word is absent, empty or another flag), undefined when it is not given.
 *  The first `--name` wins. */
export function flagValue(args, inline, name) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && inline.has(name)) return inline.get(name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : undefined;
}
