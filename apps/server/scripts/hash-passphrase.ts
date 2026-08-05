import { createInterface } from "node:readline/promises";
import { hashPassphrase } from "../src/oauth/passphrase";

/**
 * Print a scrypt hash of the owner passphrase, for `MCP_OAUTH_PASSPHRASE_HASH`.
 *
 * A script rather than a documented one-liner because the one-liner is long
 * enough to be copied wrong, and getting it wrong means either a passphrase
 * nobody can use or — worse — a plaintext passphrase in `.env`.
 *
 * Read from stdin rather than `argv`, so the passphrase never reaches the shell
 * history or the process table where `ps` would show it.
 */

const rl = createInterface({ input: process.stdin, output: process.stderr });
const passphrase = await rl.question("Owner passphrase: ");
rl.close();

if (passphrase.trim().length < 8) {
  console.error("Refusing: use at least 8 characters.");
  process.exit(1);
}

// stdout carries only the hash, so `bun run hash-passphrase >> .env` works and
// the prompt above (on stderr) does not end up in the file.
console.log(`MCP_OAUTH_PASSPHRASE_HASH=${hashPassphrase(passphrase)}`);
