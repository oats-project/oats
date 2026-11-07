/** Tokens stay in the owning process; validation errors never include their value. */
export function requireControlToken(value) {
  if (typeof value !== 'string' || value.length < 32) {
    throw new Error('OATS_DESKTOP_TOKEN must be set to at least 32 characters');
  }
  // The token travels in an HTTP header. Refuse values that cannot travel unchanged.
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Error('OATS_DESKTOP_TOKEN must contain only visible ASCII characters');
  return value;
}

export function takeControlToken(env, mint) {
  const value = env.OATS_DESKTOP_TOKEN;
  delete env.OATS_DESKTOP_TOKEN;
  return requireControlToken(value === undefined && mint ? mint() : value);
}
