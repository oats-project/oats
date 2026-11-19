// What the plugin accepts as an argv element, checked before any process starts. Inputs are
// untrusted: bb's API has no login, and any client of the server can call the plugin's RPC.
import { codes, err, ok, type Result } from "./result.js";

/** The kernel's instance-name rule, as contract.ts pins it. */
export const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The kernel's idempotency-key rule (docs/desktop-cli-api.md "Lifecycle: stop and retire"). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A plan or decision revision: the kernel's are 24 hex characters. */
export const REVISION = /^[A-Za-z0-9]{1,128}$/;

const invalid = (message: string): Result<never> => err(codes.invalidInput, message);

export function checkInstance(instance: string): Result<string> {
  return INSTANCE_NAME.test(instance)
    ? ok(instance)
    : invalid(`"${instance}" is not an instance name: lower-case letters, digits and dashes, starting with a letter or a digit, at most 63 characters`);
}

export function checkKey(key: string): Result<string> {
  return IDEMPOTENCY_KEY.test(key) ? ok(key) : invalid("the idempotency key must be 1 to 128 characters of A-Z, a-z, 0-9, '.', '_', ':' and '-', starting with a letter or a digit");
}

export function checkRevision(revision: string): Result<string> {
  return REVISION.test(revision) ? ok(revision) : invalid("the plan revision must be the one the kernel's plan named");
}

/** A home is the absolute path the kernel's status named; it is one argv element after `--home`. */
export function checkHome(home: string): Result<string> {
  return home.startsWith("/") && !home.includes("\0") ? ok(home) : invalid("the home must be the absolute path the kernel named");
}

/** A soul must be one `oats souls` lists: nothing else reaches the argv. */
export function checkSoul(soul: string, known: readonly string[]): Result<string> {
  return known.includes(soul) && !soul.startsWith("-") ? ok(soul) : invalid(`"${soul}" is not a soul \`oats souls\` lists for this deployment`);
}
