// First import of main: remove the operator override before any child environment is captured.
import { randomBytes } from 'node:crypto';
import { takeLaunchControlToken } from './control-token.mjs';
const launchToken = (() => {
  try { return takeLaunchControlToken(process.env, () => randomBytes(32).toString('hex')); }
  catch (error) { console.error(`oats-desktop: ${error.message}`); process.exit(1); }
})();
export const { token: controlToken, reuseAllowed } = launchToken;
