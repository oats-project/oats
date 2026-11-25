// One error type for everything the provider refuses or cannot do. `code` is the word the
// kernel relays; the message says what happened and, where an effect may have happened
// anyway (a tell or a spawn whose answer was lost), says that too.
export class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

/** An outcome the provider cannot tell: an effect (a spawn, a tell) may have happened.
 *  It is never answered as a refusal, which says "nothing happened": the call ends with
 *  no answer and a nonzero exit, which the kernel reads as a failed call whose outcome is
 *  uncertain, and compensates (after a launch, it stops whatever runs in the home). */
export class InDoubt extends Error {
  constructor(message) {
    super(message);
    this.name = "InDoubt";
  }
}

export function fail(code, message) {
  return new ProviderError(code, message);
}

export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The kernel relays 500 characters of a message. Every message that leaves the provider is
// cut to fit, at this one place; a message that may be long puts its remedy and its
// counts before its list.
const MESSAGE_MAX = 480;
export const bounded = (text) => { const line = String(text); return line.length > MESSAGE_MAX ? `${line.slice(0, MESSAGE_MAX - 1).replace(/[\ud800-\udbff]$/, "")}…` : line; };
/** "a, b and 3 more": the first names of a list, with a count of the rest. */
export const someOf = (names, max = 6) => (names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`);

/** A verb's refusals carry that verb's own code: any other ProviderError is recoded to
 *  it, keeping its message. Anything that is not a ProviderError is a bug, and rethrown. */
export function recode(code, error) {
  if (!(error instanceof ProviderError)) throw error;
  return error.code === code ? error : fail(code, error.message);
}
