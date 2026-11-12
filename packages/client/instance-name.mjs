/** The instance-name rules of the clients. A typed name goes to `oats spawn --name` as typed, lowercased: nothing
 * is appended to it (the soul is shown beside the name). What to name an instance, `<descriptive>-<role>`, is
 * oats.core's rule (oats-souls "Name the instance"), never this module's.
 *
 * The grammar itself, the kernel's `--name` check (explicitInstanceName: a slug of at most MAX_INSTANCE_NAME
 * characters), is mirrored here for a client that must judge a name with no kernel call (the
 * Desktop's `--instance` launch argument, a spawn's suggested name); test/client-instance-name.test.mjs drives
 * the kernel's own check over the same cases.
 * DOM-free and import-free, with no module state. */

/** The kernel's longest instance name (its MAX_INSTANCE_NAME). */
export const INSTANCE_NAME_MAX = 64;
const INSTANCE_NAME = new RegExp(`^(?=.{1,${INSTANCE_NAME_MAX}}$)[a-z0-9]+(?:-[a-z0-9]+)*$`);

/** Whether `name` is one the kernel's `--name` check takes: lowercase letters and digits, single dashes between
 * them, at most INSTANCE_NAME_MAX characters. */
export function validInstanceName(name) {
  return typeof name === 'string' && INSTANCE_NAME.test(name);
}
