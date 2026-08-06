import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { mockServer } from "../test-setup";
import {
  type ClientMetadata,
  isPubliclyRoutable,
  redirectUriAllowed,
  resetClientCache,
  resolveClient,
} from "./clients";

/**
 * CIMD resolution, including the SSRF guard.
 *
 * `example.com` and `example.test` are used as the public hostnames: the first
 * resolves publicly, the second does not resolve at all, which is what makes it
 * a clean stand-in for "this hostname is not reachable" without depending on
 * anyone's DNS answering a particular way.
 */

const CLAUDE_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_CODE_ID = "https://claude.ai/oauth/claude-code-client-metadata";

afterEach(() => {
  resetClientCache();
});

describe("resolveClient", () => {
  it("accepts a self-referential document", async () => {
    const id = "https://example.com/client";
    mockServer.use(
      http.get(id, () =>
        HttpResponse.json({
          client_id: id,
          client_name: "Example",
          redirect_uris: ["https://example.com/cb"],
        }),
      ),
    );
    expect(await resolveClient(id)).toEqual({
      clientId: id,
      clientName: "Example",
      redirectUris: ["https://example.com/cb"],
    });
  });

  it("refuses a document that claims someone else's client_id", async () => {
    // The whole security property of CIMD. Without the self-reference check,
    // anyone who can host JSON anywhere can assert any client identity.
    const id = "https://example.com/impostor";
    mockServer.use(
      http.get(id, () =>
        HttpResponse.json({
          client_id: CLAUDE_ID,
          redirect_uris: ["https://evil.test/cb"],
        }),
      ),
    );
    expect(await resolveClient(id)).toBeUndefined();
  });

  it("refuses a document with no usable redirect_uris", async () => {
    const id = "https://example.com/empty";
    mockServer.use(
      http.get(id, () =>
        HttpResponse.json({ client_id: id, redirect_uris: [] }),
      ),
    );
    expect(await resolveClient(id)).toBeUndefined();
  });

  it("refuses a body that is not a JSON object", async () => {
    const id = "https://example.com/notjson";
    mockServer.use(http.get(id, () => HttpResponse.text("<html>nope</html>")));
    expect(await resolveClient(id)).toBeUndefined();
  });

  it("refuses a non-200", async () => {
    const id = "https://example.com/missing";
    mockServer.use(http.get(id, () => HttpResponse.json({}, { status: 404 })));
    expect(await resolveClient(id)).toBeUndefined();
  });

  it("refuses a document larger than the cap", async () => {
    const id = "https://example.com/huge";
    mockServer.use(
      http.get(id, () =>
        HttpResponse.json({
          client_id: id,
          padding: "x".repeat(128 * 1024),
          redirect_uris: ["https://example.com/cb"],
        }),
      ),
    );
    expect(await resolveClient(id)).toBeUndefined();
  });

  it("refuses a document whose content-length declares it too large", async () => {
    // Refused before the body is read, so a server that announces a huge
    // document does not get to stream it at us.
    const id = "https://example.com/declared-huge";
    mockServer.use(
      http.get(id, () =>
        HttpResponse.json(
          { client_id: id, redirect_uris: ["https://example.com/cb"] },
          { headers: { "content-length": String(1024 * 1024) } },
        ),
      ),
    );
    expect(await resolveClient(id)).toBeUndefined();
  });

  it("keeps a document with no client_name, and drops non-string URIs", async () => {
    // `client_name` is optional and never trusted anyway; a redirect_uris entry
    // that is not a string is dropped rather than crashing the login path.
    const id = "https://example.com/partial";
    mockServer.use(
      http.get(id, () =>
        HttpResponse.json({
          client_id: id,
          client_name: 42,
          redirect_uris: ["https://example.com/cb", 7, null],
        }),
      ),
    );
    expect(await resolveClient(id)).toEqual({
      clientId: id,
      clientName: undefined,
      redirectUris: ["https://example.com/cb"],
    });
  });

  it("refuses a document whose redirect_uris is not an array", async () => {
    const id = "https://example.com/notarray";
    mockServer.use(
      http.get(id, () =>
        HttpResponse.json({ client_id: id, redirect_uris: "https://x/cb" }),
      ),
    );
    expect(await resolveClient(id)).toBeUndefined();
  });

  it("refuses plain http", async () => {
    // No fetch is attempted, so msw's onUnhandledRequest never fires.
    expect(await resolveClient("http://example.com/client")).toBeUndefined();
  });

  it("refuses a client_id that is not a URL", async () => {
    expect(await resolveClient("not a url")).toBeUndefined();
  });

  it("caches a resolved document", async () => {
    const id = "https://example.com/cached";
    let fetches = 0;
    mockServer.use(
      http.get(id, () => {
        fetches += 1;
        return HttpResponse.json({
          client_id: id,
          redirect_uris: ["https://example.com/cb"],
        });
      }),
    );
    await resolveClient(id);
    await resolveClient(id);
    // /oauth/authorize is on the login path; re-fetching per attempt would put
    // an outbound round trip in front of every sign-in.
    expect(fetches).toBe(1);
  });

  describe("the SSRF guard", () => {
    it("refuses a client_id pointing at loopback", async () => {
      // /oauth/authorize takes client_id from the caller and this server
      // fetches it. Without the guard a stranger can aim it at the LAN.
      expect(await resolveClient("https://127.0.0.1/client")).toBeUndefined();
      expect(await resolveClient("https://localhost/client")).toBeUndefined();
    });

    it("refuses a client_id pointing at a private range", async () => {
      for (const host of ["10.0.0.1", "172.16.5.5", "192.168.1.1"]) {
        expect(
          await resolveClient(`https://${host}/client`),
          host,
        ).toBeUndefined();
      }
    });

    it("refuses link-local and the tailnet's own CGNAT range", async () => {
      // 169.254 is where a cloud metadata service lives; 100.64/10 is the
      // tailnet this server is very likely sitting inside.
      expect(await resolveClient("https://169.254.169.254/")).toBeUndefined();
      expect(await resolveClient("https://100.100.100.100/")).toBeUndefined();
    });

    it("refuses a hostname that does not resolve", async () => {
      expect(
        await resolveClient("https://nonexistent.invalid/client"),
      ).toBeUndefined();
    });
  });

  describe("the pinned fallback", () => {
    it("serves Claude's documents when the fetch fails", async () => {
      // There is a report of Anthropic's CDN answering 403 to a self-hosted
      // authorization server. An outbound dependency inside the login path of
      // a machine in someone's kitchen is a bad bet, so this degrades to
      // pre-registration keyed by the CIMD URL.
      mockServer.use(http.get(CLAUDE_ID, () => HttpResponse.error()));
      expect(await resolveClient(CLAUDE_ID)).toEqual({
        clientId: CLAUDE_ID,
        clientName: "Claude",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      });
    });

    it("serves Claude Code's document when the fetch fails", async () => {
      mockServer.use(
        http.get(CLAUDE_CODE_ID, () => HttpResponse.json({}, { status: 403 })),
      );
      expect((await resolveClient(CLAUDE_CODE_ID))?.redirectUris).toEqual([
        "http://localhost/callback",
        "http://127.0.0.1/callback",
      ]);
    });

    it("prefers the live document over the pin", async () => {
      // The pin is a fallback, not an override — a redirect_uri Anthropic adds
      // must work without waiting for a release here.
      mockServer.use(
        http.get(CLAUDE_ID, () =>
          HttpResponse.json({
            client_id: CLAUDE_ID,
            client_name: "Claude",
            redirect_uris: ["https://claude.ai/api/mcp/auth_callback_v2"],
          }),
        ),
      );
      expect((await resolveClient(CLAUDE_ID))?.redirectUris).toEqual([
        "https://claude.ai/api/mcp/auth_callback_v2",
      ]);
    });

    it("does not invent a pin for an unknown client", async () => {
      const id = "https://example.com/unknown";
      mockServer.use(http.get(id, () => HttpResponse.error()));
      expect(await resolveClient(id)).toBeUndefined();
    });
  });
});

describe("isPubliclyRoutable", () => {
  // Asserted directly as a table rather than only through DNS: this is the
  // list that decides whether a stranger's client_id can reach the LAN, and
  // driving every row of it through a real lookup is not possible.
  const PRIVATE_V4 = [
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "224.0.0.1",
    "255.255.255.255",
  ];
  const PUBLIC_V4 = [
    "1.1.1.1",
    "8.8.8.8",
    "160.79.104.1",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
  ];

  it("refuses every private, loopback, link-local and CGNAT v4 address", () => {
    for (const address of PRIVATE_V4) {
      expect(isPubliclyRoutable(address, 4), address).toBe(false);
    }
  });

  it("allows public v4 addresses, including the edges of each range", () => {
    // 172.15 and 172.32 bracket the /12; 100.63 and 100.128 bracket the /10.
    // An off-by-one here silently blocks or admits a whole network.
    for (const address of PUBLIC_V4) {
      expect(isPubliclyRoutable(address, 4), address).toBe(true);
    }
  });

  it("refuses a v4 address it cannot parse", () => {
    for (const address of ["1.2.3", "1.2.3.4.5", "a.b.c.d", ""]) {
      expect(isPubliclyRoutable(address, 4), address).toBe(false);
    }
  });

  it("refuses loopback, unique-local and link-local v6", () => {
    for (const address of [
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%eth0",
    ]) {
      expect(isPubliclyRoutable(address, 6), address).toBe(false);
    }
  });

  it("sees through a v4-mapped v6 address", () => {
    // ::ffff:10.0.0.1 is a private address wearing a hat; treating it as v6
    // and stopping there would wave it straight through.
    expect(isPubliclyRoutable("::ffff:10.0.0.1", 6)).toBe(false);
    expect(isPubliclyRoutable("::ffff:8.8.8.8", 6)).toBe(true);
  });

  it("allows public v6", () => {
    expect(isPubliclyRoutable("2606:4700:4700::1111", 6)).toBe(true);
  });
});

describe("redirectUriAllowed", () => {
  const hosted: ClientMetadata = {
    clientId: CLAUDE_ID,
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  };
  const loopback: ClientMetadata = {
    clientId: CLAUDE_CODE_ID,
    redirectUris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  };

  it("matches a hosted redirect exactly", () => {
    expect(
      redirectUriAllowed("https://claude.ai/api/mcp/auth_callback", hosted),
    ).toBe(true);
  });

  it("refuses a different path on the same host", () => {
    expect(redirectUriAllowed("https://claude.ai/api/mcp/other", hosted)).toBe(
      false,
    );
  });

  it("refuses a different host", () => {
    expect(redirectUriAllowed("https://evil.test/cb", hosted)).toBe(false);
  });

  it("ignores the port on loopback, per RFC 8252", () => {
    // Claude Code declares a portless localhost URI and then binds an
    // ephemeral port, so an exact match rejects every real attempt.
    expect(
      redirectUriAllowed("http://localhost:61234/callback", loopback),
    ).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:8910/callback", loopback)).toBe(
      true,
    );
  });

  it("still requires the path and scheme to match on loopback", () => {
    expect(redirectUriAllowed("http://localhost:61234/evil", loopback)).toBe(
      false,
    );
    expect(
      redirectUriAllowed("https://localhost:61234/callback", loopback),
    ).toBe(false);
  });

  it("does not extend the port exemption to a remote host", () => {
    // The exemption exists for loopback only. Applying it generally would let
    // any port on claude.ai receive a code.
    expect(
      redirectUriAllowed(
        "https://claude.ai:8443/api/mcp/auth_callback",
        hosted,
      ),
    ).toBe(false);
  });

  it("refuses a redirect_uri that is not a URL", () => {
    expect(redirectUriAllowed("not a url", hosted)).toBe(false);
  });

  it("skips a declared URI the client document got wrong", () => {
    // The document is fetched from elsewhere, so its redirect_uris are input.
    // One unparseable entry must not throw, and must not match anything.
    const broken: ClientMetadata = {
      clientId: CLAUDE_ID,
      redirectUris: ["not a url", "https://claude.ai/cb"],
    };
    expect(redirectUriAllowed("https://claude.ai/cb", broken)).toBe(true);
    expect(redirectUriAllowed("https://evil.test/cb", broken)).toBe(false);
    // Not even against its own malformed twin: the requested URI is parsed
    // before the exact-string branch is reached, so a non-URL cannot match a
    // non-URL. That ordering is what stops the string comparison being a way
    // past the scheme and host checks.
    expect(redirectUriAllowed("not a url", broken)).toBe(false);
  });
});
