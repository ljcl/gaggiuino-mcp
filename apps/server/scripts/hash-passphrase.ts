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
//
// **Single-quoted, and that is not cosmetic.** The hash is
// `scrypt$16384$8$1$<salt>$<hash>`, so it contains `$16384`, `$8` and `$1` —
// which read as variable references to a shell and to anything that
// interpolates an env file. Single quotes are the one form that suppresses
// substitution everywhere this value travels; docker compose, dotenv loaders
// and shells all strip them back off. A leading newline guards the other half
// of the same footgun: appending with `>>` onto a file whose last line has no
// trailing newline would otherwise splice this onto the end of that line.
console.log(`\nMCP_OAUTH_PASSPHRASE_HASH='${hashPassphrase(passphrase)}'`);
