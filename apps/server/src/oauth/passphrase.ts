import { randomBytes, scryptSync } from "node:crypto";
import { secretsMatch } from "../mcpAuth";

/**
 * The owner's passphrase, stored as a scrypt hash in the environment.
 *
 * This is the case `secretsMatch` explicitly is not: a human-chosen secret,
 * held at rest, where an attacker who reads the environment could otherwise run
 * a dictionary against it. So it gets a real KDF with a real work factor, and
 * the plaintext never appears in configuration.
 *
 * It costs ~100 ms per verification, which is the point. That cost is why the
 * consent POST is rate-limited per remote address and why nothing on the
 * `/mcp` hot path goes anywhere near this.
 *
 * A passphrase rather than a hardware token or a delegated login because it is
 * the only mechanism that behaves identically behind Tailscale Funnel,
 * cloudflared, ngrok and a plain reverse proxy — and because a machine in a
 * kitchen should not require its owner to hold a GitHub account.
 */

/** Encoded as `scrypt$N$r$p$salt$hash`, all base64url. */
const SCHEME = "scrypt";
const N = 16_384;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/** `N=16384, r=8` needs 128*N*r = 16 MiB; the default cap is lower on some
 *  builds, so it is stated rather than hoped for. */
const MAX_MEM = 64 * 1024 * 1024;

function derive(
  passphrase: string,
  salt: Buffer,
  params: ScryptParams,
): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, params.keyBytes, {
    N: params.N,
    maxmem: MAX_MEM,
    p: params.p,
    r: params.r,
  });
}

interface ScryptParams {
  N: number;
  keyBytes: number;
  p: number;
  r: number;
}

/** Hash a passphrase for storage. Used by `scripts/hash-passphrase.ts`. */
export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = derive(passphrase, salt, { N, keyBytes: KEY_BYTES, p: P, r: R });
  return [
    SCHEME,
    N,
    R,
    P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

interface ParsedHash {
  key: Buffer;
  params: ScryptParams;
  salt: Buffer;
}

/**
 * Split a stored hash into its parts, or `undefined` if it is not usable.
 *
 * **This is the single definition of "well formed", and it has to stay that
 * way:** startup validation (`isWellFormedHash`) and login (`verifyPassphrase`)
 * must accept exactly the same hashes, otherwise a mistyped value passes
 * startup and surfaces as a baffling wrong-passphrase error. The individual
 * checks carry their own reasons below.
 */
function parseHash(stored: string): ParsedHash | undefined {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== SCHEME) return undefined;
  const [, rawN, rawR, rawP, rawSalt, rawKey] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const params = {
    N: Number(rawN),
    keyBytes: KEY_BYTES,
    p: Number(rawP),
    r: Number(rawR),
  };
  // Every one of these is positive-and-integral, not merely integral: `N: 0`
  // parses fine and then throws inside `scryptSync`.
  for (const value of [params.N, params.r, params.p]) {
    if (!Number.isInteger(value) || value < 1) return undefined;
  }

  const key = Buffer.from(rawKey, "base64url");
  // Exactly `KEY_BYTES`, not "at least something". Reading the length from the
  // stored value instead would let a truncated key silently downgrade the
  // comparison to however many bytes survived.
  if (key.length !== KEY_BYTES) return undefined;

  const salt = Buffer.from(rawSalt, "base64url");
  if (salt.length === 0) return undefined;

  return { key, params, salt };
}

/**
 * Check a passphrase against a stored hash.
 *
 * Returns false for anything malformed rather than throwing: the stored value
 * comes from the environment and the presented value from a form, so both are
 * inputs. A malformed *stored* hash is a misconfiguration, and `isWellFormedHash`
 * has already refused to start the server with one.
 */
export function verifyPassphrase(passphrase: string, stored: string): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return false;

  let derived: Buffer;
  try {
    derived = derive(passphrase, parsed.salt, parsed.params);
  } catch {
    // An N large enough to blow the memory cap is a refusal, not a crash on
    // the login path.
    return false;
  }

  // Both sides are re-encoded from bytes rather than compared as stored text,
  // so a hash transcoded to standard base64 somewhere along the way still
  // matches instead of presenting as a permanently wrong passphrase.
  return secretsMatch(
    derived.toString("base64url"),
    parsed.key.toString("base64url"),
  );
}

/**
 * Validate a stored hash at startup, so a typo is not discovered at login.
 *
 * Exactly the predicate `verifyPassphrase` applies — anything this accepts,
 * that can use.
 */
export function isWellFormedHash(stored: string): boolean {
  return parseHash(stored) !== undefined;
}
