// A control token belongs only to Desktop's main, server and development proxy.
// Keep this leaf free of imports: entry modules scrub their environment before loading other code.
export function withoutControlToken(env = process.env) {
  const child = { ...(env ?? process.env) };
  delete child.OATS_DESKTOP_TOKEN;
  return child;
}
