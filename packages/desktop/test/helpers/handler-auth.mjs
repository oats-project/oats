// For tests that evaluate the shipped HTTP handler (server/oats-web.mjs) in place, without a
// process: the free names its credential check reads, bound to a fresh test credential, and the
// header that carries it. The check itself is the real one (server/request-checks.mjs); the
// boundary is driven end to end over a socket in backend-request-checks.test.mjs.
import { randomBytes } from 'node:crypto';
import { bearerBytes, bearerMatches, sameFile, UNAUTHORIZED } from '../../server/request-checks.mjs';

export const HANDLER_SECRET = randomBytes(32).toString('base64url');
/** Spread into the handler's free names: BEARER (the expected header bytes), the comparison, the
 * refusal body, and no --token-file. */
export const handlerAuth = Object.freeze({ bearerMatches, BEARER: bearerBytes(HANDLER_SECRET), UNAUTHORIZED, sameFile, TOKEN_FILE: null });
/** `headers` with the credential, unless they carry an authorization of their own. */
export const authorized = (headers = {}) => (Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')
  ? headers : { ...headers, authorization: `Bearer ${HANDLER_SECRET}` });
