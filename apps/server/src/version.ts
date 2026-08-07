/**
 * The released version, advertised in the MCP `initialize` handshake and in the
 * `/health` payload.
 *
 * release-please rewrites the literal below on every release: the
 * `x-release-please-version` annotation is wired up as a `generic` extra-file in
 * `release-please-config.json`, so the release PR that bumps root
 * `package.json` bumps this line in the same commit.
 *
 * It is a compile-time constant rather than a read of `package.json` on
 * purpose. The distroless runner has no shell and a pruned workspace tree, so a
 * runtime file read would be one more path assumption to get wrong for no gain
 * — and `version.test.ts` asserts this literal still matches root
 * `package.json`, which is the manifest release-please actually tracks. If the
 * annotation ever stops firing, that test fails instead of the handshake
 * quietly freezing at whatever version last shipped.
 */
export const SERVER_VERSION = "2.0.0"; // x-release-please-version

/** The server name advertised in the handshake, and the MCP registry's key for it. */
export const SERVER_NAME = "gaggiuino-mcp";
