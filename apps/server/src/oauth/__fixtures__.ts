import { type ExternalIssuer } from "./externalIssuer";
import { type AuthServerConfig, type DelegatedOAuthConfig } from "./metadata";

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

/**
 * A self-issuing `OAuthConfig`, in one place, so a type change is a one-file
 * edit.
 *
 * `issuer` and `publicOrigin` are the same value here precisely because that is
 * what the built-in authorization server means — the delegated mode is the one
 * that separates them, and its tests set them apart deliberately.
 */
export const TEST_OAUTH_CONFIG: AuthServerConfig = {
  issuer: TEST_ISSUER,
  passphraseHash: TEST_PASSPHRASE_HASH,
  publicOrigin: TEST_ISSUER,
  resource: TEST_RESOURCE,
  secret: TEST_SECRET,
};

/** An external issuer, deliberately on a different host with a path. */
export const TEST_EXTERNAL_ISSUER = "https://idp.example.test/realms/home";

/**
 * A delegated `OAuthConfig`. `verify` is injected rather than a real
 * `createExternalIssuer`, so a test that only cares about routing or metadata
 * never touches discovery.
 *
 * The stub is required rather than defaulted here on purpose: this file is
 * production-adjacent enough to be in the coverage set, and a default nobody
 * invokes is an uncovered function sitting in `src/`. Callers keep their own.
 */
export function delegatedConfig(
  external: ExternalIssuer,
): DelegatedOAuthConfig {
  return {
    external,
    issuer: TEST_EXTERNAL_ISSUER,
    publicOrigin: TEST_ISSUER,
    resource: TEST_RESOURCE,
  };
}
