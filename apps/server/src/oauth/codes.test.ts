import { describe, expect, it } from "vitest";
import { TEST_RESOURCE } from "./__fixtures__";
import { createCodeStore, type PendingAuthorization } from "./codes";

/**
 * The clock is injected, so "sixty-one seconds later" is an assertion rather
 * than a wait. Expiry is `expiresAt <= now()`, which makes the TTL itself the
 * first instant an entry is gone.
 */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    advance(ms: number) {
      current += ms;
    },
    now: () => current,
  };
}

const CODE_TTL_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 64;

function request(
  overrides: Partial<PendingAuthorization> = {},
): PendingAuthorization {
  return {
    clientId: "https://claude.ai/api/mcp/auth_callback",
    clientName: "Claude",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    resource: TEST_RESOURCE,
    scopes: ["espresso:read", "espresso:write"],
    state: "opaque-state",
    ...overrides,
  };
}

describe("issue and redeem", () => {
  it("hands back everything the code was bound to", () => {
    const clock = fakeClock();
    const store = createCodeStore({ now: clock.now });
    const code = store.issue(request());

    // The token endpoint re-checks the PKCE challenge, the client and the
    // redirect URI against exactly this object, so nothing may be dropped.
    expect(store.redeem(code)).toEqual({
      ...request(),
      expiresAt: clock.now() + CODE_TTL_MS,
    });
  });

  it("mints a distinct, unguessable secret for every code", () => {
    const store = createCodeStore();
    const issued = new Set(
      Array.from({ length: 50 }, () => store.issue(request())),
    );

    expect(issued.size).toBe(50);
    for (const code of issued) {
      // 32 bytes of randomness, base64url. A code is a bearer credential for
      // the whole grant, so a short or predictable one is the entire attack.
      expect(code).toMatch(/^[\w-]{43}$/);
    }
  });

  it("returns undefined for a code it never issued", () => {
    expect(createCodeStore().redeem("not-a-code")).toBeUndefined();
  });

  it("spends a code even when the attempt that presented it fails", () => {
    // The token endpoint checks PKCE *after* redeeming, so a code presented
    // with a wrong verifier must still be gone — otherwise an attacker with a
    // stolen code can keep guessing the verifier against it.
    const store = createCodeStore();
    const code = store.issue(request());

    expect(store.redeem(code)).toBeDefined();
    expect(store.redeem(code)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("expires a code the moment its TTL is reached", () => {
    const clock = fakeClock();
    const store = createCodeStore({ now: clock.now });
    const live = store.issue(request());
    const dead = store.issue(request());

    clock.advance(CODE_TTL_MS - 1);
    expect(store.redeem(live)).toBeDefined();

    clock.advance(1);
    expect(store.redeem(dead)).toBeUndefined();
  });

  it("defaults its clock to the real one", () => {
    // A store built with no options still has to date its entries; a clock
    // stuck at zero would expire every code the instant it was issued.
    const store = createCodeStore();
    const code = store.issue(request());
    expect(store.redeem(code)?.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("remember and recall", () => {
  it("hands back the request the consent page was rendered for", () => {
    const clock = fakeClock();
    const store = createCodeStore({ now: clock.now });
    const token = store.remember(request());

    expect(store.recall(token)).toEqual({
      ...request(),
      expiresAt: clock.now() + PENDING_TTL_MS,
    });
  });

  it("mints a distinct, unguessable token for every parked request", () => {
    const store = createCodeStore();
    const first = store.remember(request());
    const second = store.remember(request());

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[\w-]{43}$/);
  });

  it("returns undefined for a token it never parked", () => {
    expect(createCodeStore().recall("not-a-token")).toBeUndefined();
  });

  it("recalls a parked request only once", () => {
    // The token is the CSRF defence for the consent form; a replayable one
    // would let a submission captured once be replayed forever. `authorize.ts`
    // re-parks under a fresh token after a wrong passphrase for this reason.
    const store = createCodeStore();
    const token = store.remember(request());

    expect(store.recall(token)).toBeDefined();
    expect(store.recall(token)).toBeUndefined();
  });

  it("holds a consent page for the full ten minutes", () => {
    const clock = fakeClock();
    const store = createCodeStore({ now: clock.now });
    const live = store.remember(request());
    const dead = store.remember(request());

    // Well past a code's sixty seconds: the owner is reading the page and
    // typing a passphrase, not following a redirect.
    clock.advance(PENDING_TTL_MS - 1);
    expect(store.recall(live)).toBeDefined();

    clock.advance(1);
    expect(store.recall(dead)).toBeUndefined();
  });
});

describe("codes and parked requests are separate", () => {
  it("will not redeem a consent token as an authorization code", () => {
    // The two secrets look identical and grant very different things: a CSRF
    // token is handed to a browser before any passphrase has been checked, so
    // redeeming one at /oauth/token would skip consent entirely.
    const store = createCodeStore();
    const token = store.remember(request());

    expect(store.redeem(token)).toBeUndefined();
    // And the failed probe must not spend the real entry either.
    expect(store.recall(token)).toBeDefined();
  });

  it("will not recall an authorization code as a parked request", () => {
    const store = createCodeStore();
    const code = store.issue(request());

    expect(store.recall(code)).toBeUndefined();
    expect(store.redeem(code)).toBeDefined();
  });
});

describe("bounds", () => {
  it("drops the oldest code once the cap is exceeded", () => {
    const store = createCodeStore();
    const issued = Array.from({ length: MAX_ENTRIES + 1 }, () =>
      store.issue(request()),
    );

    expect(store.size).toBe(MAX_ENTRIES);
    expect(store.redeem(issued[0] as string)).toBeUndefined();
    expect(store.redeem(issued[1] as string)).toBeDefined();
    expect(store.redeem(issued[MAX_ENTRIES] as string)).toBeDefined();
  });

  it("spends the cap on expired codes before live ones", () => {
    const clock = fakeClock();
    const store = createCodeStore({ now: clock.now });
    const abandoned = Array.from({ length: 10 }, () => store.issue(request()));
    clock.advance(30_000);
    const live = Array.from({ length: 54 }, () => store.issue(request()));

    clock.advance(31_000);
    store.issue(request());

    // Without the expiry pass the cap would be occupied by ten codes that can
    // never be redeemed again, and the store would be one issue away from
    // evicting a live one to make room for them.
    expect(store.size).toBe(55);
    expect(store.redeem(abandoned[0] as string)).toBeUndefined();
    expect(store.redeem(live[0] as string)).toBeDefined();
  });

  it("bounds codes and parked requests independently", () => {
    // A burst of authorization codes must not evict the consent page the owner
    // currently has open, so each map carries its own cap rather than sharing
    // one — which is why `size` can exceed MAX_ENTRIES.
    const store = createCodeStore();
    const token = store.remember(request());
    for (let i = 0; i < MAX_ENTRIES + 1; i += 1) store.issue(request());

    expect(store.recall(token)).toBeDefined();
  });

  it("drops the oldest parked request once the cap is exceeded", () => {
    const store = createCodeStore();
    const parked = Array.from({ length: MAX_ENTRIES + 1 }, () =>
      store.remember(request()),
    );

    expect(store.recall(parked[0] as string)).toBeUndefined();
    expect(store.recall(parked[MAX_ENTRIES] as string)).toBeDefined();
  });
});

describe("size", () => {
  it("counts codes and parked requests together", () => {
    const store = createCodeStore();
    expect(store.size).toBe(0);

    store.issue(request());
    store.remember(request());
    expect(store.size).toBe(2);
  });

  it("falls as entries are spent", () => {
    const store = createCodeStore();
    const code = store.issue(request());
    const token = store.remember(request());

    store.redeem(code);
    expect(store.size).toBe(1);
    store.recall(token);
    expect(store.size).toBe(0);
  });
});
