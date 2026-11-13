// The did:key of the signing key aw keeps in a home's .aw/signing.key: aw saves an
// Ed25519 key as its 32-byte seed in an "ED25519 PRIVATE KEY" PEM block (aw
// awid/keys.go), and its did:key is "did:key:z" + base58btc(0xed 0x01 + the public
// key). Retire matches it against a certificate's member_did_key to tell the home's
// own registration from another identity's under the same alias (awebai/oats-aweb#240).
import { createPrivateKey, createPublicKey } from "node:crypto";

// PKCS#8 for an Ed25519 key, up to the 32-byte seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btc(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`), text = "";
  while (n > 0n) { text = BASE58[Number(n % 58n)] + text; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; text = `1${text}`; }
  return text;
}

/** The did:key of a signing key file's text, or undefined when it is not one aw wrote. */
export function didKeyOfSigningKey(pemText) {
  const m = /-----BEGIN ED25519 PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END ED25519 PRIVATE KEY-----/.exec(String(pemText ?? ""));
  if (!m) return undefined;
  const seed = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
  if (seed.length !== 32) return undefined;
  try {
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
    const pub = Buffer.from(createPublicKey(key).export({ format: "jwk" }).x, "base64url");
    return `did:key:z${base58btc([0xed, 0x01, ...pub])}`;
  } catch { return undefined; }
}
