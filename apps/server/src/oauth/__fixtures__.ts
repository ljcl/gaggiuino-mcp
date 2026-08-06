/**
 * Shared OAuth test fixtures.
 *
 * The passphrase hash is precomputed rather than derived per test: scrypt costs
 * ~36 ms by design, and a suite that hashes in every `beforeEach` spends most of
 * its wall clock proving a KDF is slow. `passphrase.test.ts` covers the derive
 * path properly; everything else just needs a hash that verifies.
 */

export const TEST_ISSUER = "https://box.tail1234.ts.net";
export const TEST_RESOURCE = `${TEST_ISSUER}/mcp`;
export const TEST_SECRET = "s".repeat(64);

export const TEST_PASSPHRASE = "test-passphrase";

/** `hashPassphrase(TEST_PASSPHRASE)`, generated once and pinned. */
export const TEST_PASSPHRASE_HASH =
  "scrypt$16384$8$1$jur2rat7Y4WQzZRvMWOMxw$OBICUBEVayExS_bcOdqCXAT9243K9KSNk3vOtOI9MuU";

export const TEST_OAUTH_ENV = {
  MCP_OAUTH_PASSPHRASE_HASH: TEST_PASSPHRASE_HASH,
  MCP_OAUTH_SECRET: TEST_SECRET,
  MCP_PUBLIC_URL: TEST_ISSUER,
};
