// First import of the backend: retain the token before environment snapshots are made.
import { takeControlToken } from './control-token.mjs';
export const controlToken = takeControlToken(process.env);
