// First import of main: remove the operator override before any child environment is captured.
import { randomBytes } from 'node:crypto';
import { takeControlToken } from './control-token.mjs';
export const controlToken = takeControlToken(process.env, () => randomBytes(32).toString('hex'));
