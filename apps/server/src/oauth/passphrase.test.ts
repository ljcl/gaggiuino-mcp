import { describe, expect, it } from "vitest";
import { TEST_PASSPHRASE, TEST_PASSPHRASE_HASH } from "./__fixtures__";
import {
  hashPassphrase,
  isWellFormedHash,
  verifyPassphrase,
} from "./passphrase";

/**
 * Every assertion that reaches scrypt costs ~36 ms, which is the module's whole
 * point rather than a slow test. So the derive path is exercised deliberately
 * and each malformed-hash case is shaped to be refused before a key is derived.
 */

/** The fixture's own salt, so a malformed hash differs only in the named way. */
const SALT = TEST_PASSPHRASE_HASH.split("$")[4] as string;

describe("hashPassphrase", () => {
  it("produces a hash the same passphrase verifies against", () => {
    const stored = hashPassphrase("kitchen-passphrase");
    expect(verifyPassphrase("kitchen-passphrase", stored)).toBe(true);
  });

  it("salts every hash, so one passphrase has many encodings", () => {
    const first = hashPassphrase(TEST_PASSPHRASE);
    const second = hashPassphrase(TEST_PASSPHRASE);

    expect(first).not.toBe(second);
    // The work factor is the security claim: an N quietly reduced to something
    // cheap still round-trips, so nothing else in this file would notice.
    expect(first.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(verifyPassphrase(TEST_PASSPHRASE, first)).toBe(true);
    expect(verifyPassphrase(TEST_PASSPHRASE, second)).toBe(true);
  });
});

describe("verifyPassphrase", () => {
  it("verifies the passphrase the pinned fixture hash was made from", () => {
    // A failure here is the fixture being wrong, not this module: every other
    // OAuth suite logs in with TEST_PASSPHRASE against TEST_PASSPHRASE_HASH,
    // and a stale pin breaks them all somewhere far less obvious than here.
    expect(verifyPassphrase(TEST_PASSPHRASE, TEST_PASSPHRASE_HASH)).toBe(true);
  });

  it("rejects a passphrase that is not the one that was hashed", () => {
    expect(verifyPassphrase("not-the-passphrase", TEST_PASSPHRASE_HASH)).toBe(
      false,
    );
  });

  it("accepts either unicode form of the same passphrase", () => {
    // A precomposed é and an e followed by a combining acute are one
    // passphrase to the owner typing it; which one arrives is decided by their
    // keyboard and browser, not by them. Hence the NFKC pass in `derive`.
    const composed = "caf\u00E9-machine";
    const decomposed = "cafe\u0301-machine";
    expect(composed).not.toBe(decomposed);

    const stored = hashPassphrase(decomposed);
    expect(verifyPassphrase(composed, stored)).toBe(true);
    expect(verifyPassphrase(decomposed, stored)).toBe(true);
  });

  it("folds compatibility characters the way NFKC and not NFC does", () => {
    // NFC would satisfy the composed/decomposed case above just as well, so
    // this is the assertion pinning the normalisation `derive` declares.
    const stored = hashPassphrase("\uFB01rst-crack");
    expect(verifyPassphrase("first-crack", stored)).toBe(true);
  });

  it("refuses a stored value that is not in the scheme's shape", () => {
    // The stored hash is environment input and the login path is reachable by
    // anyone who can load the consent page, so a misconfiguration has to be a
    // refusal rather than an exception out of the consent POST.
    expect(verifyPassphrase(TEST_PASSPHRASE, "")).toBe(false);
    expect(verifyPassphrase(TEST_PASSPHRASE, TEST_PASSPHRASE)).toBe(false);
    expect(verifyPassphrase(TEST_PASSPHRASE, `scrypt$16384$8$1$${SALT}`)).toBe(
      false,
    );
    expect(
      verifyPassphrase(TEST_PASSPHRASE, `${TEST_PASSPHRASE_HASH}$extra`),
    ).toBe(false);
    expect(
      verifyPassphrase(
        TEST_PASSPHRASE,
        TEST_PASSPHRASE_HASH.replace("scrypt$", "argon2id$"),
      ),
    ).toBe(false);
  });

  it("refuses a stored hash whose parameters are not integers", () => {
    for (const stored of [
      TEST_PASSPHRASE_HASH.replace("$16384$", "$sixteen-k$"),
      TEST_PASSPHRASE_HASH.replace("$8$1$", "$eight$1$"),
      TEST_PASSPHRASE_HASH.replace("$8$1$", "$8$one$"),
    ]) {
      expect(verifyPassphrase(TEST_PASSPHRASE, stored)).toBe(false);
    }
  });

  it("refuses a stored hash with no key to compare against", () => {
    // `secretsMatch` reports two empty strings equal, so an empty key segment
    // is the one malformed hash that could otherwise verify a passphrase.
    expect(verifyPassphrase("", `scrypt$16384$8$1$${SALT}$`)).toBe(false);
  });

  it("refuses parameters scrypt itself would throw on", () => {
    // An N past the stated 64 MiB cap makes `scryptSync` throw rather than
    // return, and a login attempt is not the place to discover that.
    expect(
      verifyPassphrase(
        TEST_PASSPHRASE,
        TEST_PASSPHRASE_HASH.replace("$16384$", `$${2 ** 30}$`),
      ),
    ).toBe(false);
  });
});

describe("isWellFormedHash agrees with verifyPassphrase", () => {
  // The startup check must reject everything the verifier cannot use: a hash
  // accepted at startup yet unusable at login is exactly the failure the check
  // exists to prevent.
  const REAL = TEST_PASSPHRASE_HASH;
  const [, n, r, p, salt, key] = REAL.split("$") as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const MISTYPED = [
    ["a non-integer r", `scrypt$${n}$eight$${p}$${salt}$${key}`],
    ["a non-integer p", `scrypt$${n}$${r}$one$${salt}$${key}`],
    // `Number("")` is 0, which `Number.isInteger` accepts.
    ["an empty N", `scrypt$$${r}$${p}$${salt}$${key}`],
    ["a zero N", `scrypt$0$${r}$${p}$${salt}$${key}`],
    ["a negative N", `scrypt$-16384$${r}$${p}$${salt}$${key}`],
    ["an empty salt", `scrypt$${n}$${r}$${p}$$${key}`],
    ["a truncated key", `scrypt$${n}$${r}$${p}$${salt}$${key.slice(0, 20)}`],
  ] as const;

  it("rejects at startup everything the verifier cannot use", () => {
    for (const [label, stored] of MISTYPED) {
      expect(isWellFormedHash(stored), label).toBe(false);
      expect(verifyPassphrase(TEST_PASSPHRASE, stored), label).toBe(false);
    }
  });

  it("still accepts the real thing", () => {
    expect(isWellFormedHash(REAL)).toBe(true);
    expect(verifyPassphrase(TEST_PASSPHRASE, REAL)).toBe(true);
  });
});

describe("isWellFormedHash", () => {
  it("accepts a hash hashPassphrase produced", () => {
    expect(isWellFormedHash(TEST_PASSPHRASE_HASH)).toBe(true);
  });

  it("rejects the passphrase itself", () => {
    // The mistake this startup check exists for: MCP_OAUTH_PASSPHRASE_HASH set
    // to the passphrase. Accepted at startup it becomes a machine that refuses
    // every correct passphrase and explains nothing about why.
    expect(isWellFormedHash(TEST_PASSPHRASE)).toBe(false);
  });

  it("rejects a hash that is truncated, mislabelled or short of a key", () => {
    expect(isWellFormedHash(`scrypt$16384$8$1$${SALT}`)).toBe(false);
    expect(
      isWellFormedHash(TEST_PASSPHRASE_HASH.replace("scrypt$", "argon2id$")),
    ).toBe(false);
    expect(
      isWellFormedHash(TEST_PASSPHRASE_HASH.replace("$16384$", "$sixteen-k$")),
    ).toBe(false);
    // Under sixteen bytes is not a scrypt key at any parameters — the shape a
    // hash arrives in when a line-wrapped `.env` value was pasted in half.
    expect(isWellFormedHash(`scrypt$16384$8$1$${SALT}$c2hvcnQ`)).toBe(false);
  });
});
