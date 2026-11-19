// OATS_SETTINGS is kernel-supplied JSON. Keep parser diagnostics fixed: the
// document can contain credentials and must never appear in an error envelope.
export function parseProviderSettings(env = process.env) {
  try {
    const settings = JSON.parse(env.OATS_SETTINGS ?? "{}");
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("not an object");
    return settings;
  } catch { throw new Error("OATS_SETTINGS must be a JSON object"); }
}
