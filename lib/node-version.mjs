/** CLI startup's Node floor. No imports or effects: this must load before the kernel. */
export function nodeVersionFailure(found) {
  if (Number(found.split(".")[0]) >= 22) return null;
  return { schemaVersion: 1, ok: false, error: {
    code: "E_NODE_UNSUPPORTED",
    message: `oats needs Node.js 22 or later; this is Node.js ${found}`,
    details: { found, minimum: "22" },
  } };
}
