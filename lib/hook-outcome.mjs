// The lifecycle cleanup vocabulary belongs to the kernel (docs/capabilities.md).
// Missing metadata makes no claim of incomplete cleanup. An explicit refusal
// is complete only for the documented idempotent "nothing to delete" outcome.
export function hookCleanupComplete(meta) {
  return !(meta && typeof meta === 'object' && meta.retired === false && meta.reason !== 'nothing-to-delete');
}
