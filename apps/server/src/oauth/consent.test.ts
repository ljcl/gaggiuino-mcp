import { describe, expect, it } from "vitest";
import { TEST_RESOURCE } from "./__fixtures__";
import { type PendingAuthorization } from "./codes";
import {
  type ConsentPageOptions,
  escapeHtml,
  isLoopbackOnly,
  renderConsentPage,
  renderErrorPage,
} from "./consent";

/**
 * The consent page is the one HTML surface a stranger's browser can reach, and
 * everything it renders arrives from a request: the `client_id` a caller chose,
 * the scopes it asked for, and a document the client wrote about itself. So the
 * assertions worth making here are about what the page refuses to believe and
 * what it refuses to emit raw.
 */

function request(
  overrides: Partial<PendingAuthorization> = {},
): PendingAuthorization {
  return {
    clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
    clientName: "Claude",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    resource: TEST_RESOURCE,
    scopes: ["espresso:read", "espresso:write"],
    state: "opaque-state",
    ...overrides,
  };
}

function render(overrides: Partial<ConsentPageOptions> = {}): string {
  return renderConsentPage({
    csrfToken: "parked-request-token",
    loopbackOnly: false,
    request: request(),
    ...overrides,
  });
}

describe("escapeHtml", () => {
  it("escapes every character that could close an attribute or open a tag", () => {
    expect(escapeHtml(`<img src="x" onerror='alert(1)'> & done`)).toBe(
      "&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt; &amp; done",
    );
  });

  it("escapes the ampersand before anything that produces one", () => {
    // Order is the whole correctness of the function: replacing `<` first
    // would turn the `&` of its own `&lt;` into `&amp;lt;` on the next pass.
    // The other direction is this one — text that already reads `&lt;` has to
    // survive as visible characters, not become a live tag.
    expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
  });
});

describe("isLoopbackOnly", () => {
  it("is true when every declared address is on this computer", () => {
    expect(
      isLoopbackOnly([
        "http://127.0.0.1:51763/cb",
        "http://localhost/callback",
      ]),
    ).toBe(true);
  });

  it("is false when any declared address is remote", () => {
    // The mixed case is the one that matters: a client with somewhere remote
    // to redirect to is a hosted client, and the warning's claim — that any
    // local program could be impersonating it — would be untrue of it.
    expect(
      isLoopbackOnly(["http://127.0.0.1/cb", "https://evil.test/cb"]),
    ).toBe(false);
  });

  it("is false for an address it cannot parse", () => {
    // A URI the parser rejects is not evidence of anything, and it certainly
    // cannot vouch for the whole list being local.
    expect(isLoopbackOnly(["not-a-url"])).toBe(false);
    expect(isLoopbackOnly(["http://127.0.0.1/cb", ""])).toBe(false);
  });

  it("recognises the bracketed IPv6 loopback", () => {
    // WHATWG URL keeps the brackets on an IPv6 host, so
    // `new URL("http://[::1]/cb").hostname` is "[::1]" and nothing reachable
    // through `new URL` ever yields a bare "::1". The comparison used to be
    // against the bare form, which made this branch dead code and suppressed
    // the warning for exactly the client it was written to catch.
    expect(isLoopbackOnly(["http://[::1]/cb"])).toBe(true);
    expect(isLoopbackOnly(["http://[::1]:9999/cb"])).toBe(true);
  });

  it("is false for a client that declares nothing", () => {
    // `every` on an empty array is vacuously true, which would have claimed
    // "these are all local" about a list with nothing in it. `clients.ts`
    // rejects a document with no `redirect_uris` so this is unreachable from
    // the flow, but a warning helper should not answer yes to a question it
    // was given no evidence for.
    expect(isLoopbackOnly([])).toBe(false);
  });
});

describe("renderConsentPage", () => {
  it("names the host of the client_id and never the self-asserted client_name", () => {
    // The reason this file exists. The metadata document is written by whoever
    // is asking for access, so `client_name` is a free-text field an attacker
    // fills in; the host is the part TLS and the CIMD self-reference check
    // actually establish. Showing the name is handing over the branding.
    const html = render({
      request: request({
        clientId: "https://evil.test/meta",
        clientName: "Totally Trustworthy Bank",
      }),
    });

    expect(html).toContain("evil.test");
    expect(html).not.toContain("Totally Trustworthy Bank");
  });

  it("keeps a non-default port, which is part of who the client is", () => {
    expect(
      render({ request: request({ clientId: "https://evil.test:8443/meta" }) }),
    ).toContain("evil.test:8443");
  });

  it("escapes a client_id host that carries markup characters", () => {
    // `"` and `&` are legal in a host for a special scheme — the URL parser
    // accepts `https://ev"il&co.test/` — so the one string on the page that
    // looks like it came from a parser is still attacker-authored.
    const html = render({
      request: request({ clientId: 'https://ev"il&co.test/meta' }),
    });

    expect(html).toContain("ev&quot;il&amp;co.test");
    expect(html).not.toContain('ev"il&co.test');
  });

  it("escapes the CSRF token into the hidden input's value attribute", () => {
    const html = render({ csrfToken: `"><script>alert(1)</script>` });

    expect(html).toContain(
      '<input type="hidden" name="request_token" value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">',
    );
    expect(html).not.toContain("<script");
  });

  it("posts to /oauth/authorize carrying the token as request_token", () => {
    // `handlePost` recalls the parked request by exactly this field name; a
    // renamed input turns every submission into "this page has expired", and a
    // changed action turns the form into a cross-site POST.
    const html = render({ csrfToken: "parked-request-token" });

    expect(html).toContain('<form method="post" action="/oauth/authorize">');
    expect(html).toContain(
      '<input type="hidden" name="request_token" value="parked-request-token">',
    );
  });

  it("collects the passphrase in a password field", () => {
    expect(render()).toContain(
      '<input id="passphrase" name="passphrase" type="password"',
    );
  });

  it("warns about local impersonation only for a loopback-only client", () => {
    // Any local process can bind a port and claim to be the client, so the
    // owner is the only one who can tell whether they started this sign-in.
    expect(render({ loopbackOnly: true })).toContain(
      "Any program running locally can claim to be it",
    );
    expect(render({ loopbackOnly: false })).not.toContain(
      "Any program running locally",
    );
  });

  it("shows a failed attempt above the form", () => {
    const html = render({ error: "That passphrase was not correct." });

    expect(html).toContain(
      '<p class="error">That passphrase was not correct.</p>',
    );
    expect(html.indexOf('class="error"')).toBeLessThan(html.indexOf("<form"));
  });

  it("renders no error block on the first attempt", () => {
    expect(render()).not.toContain('class="error"');
  });

  it("escapes an error message", () => {
    const html = render({ error: '<img src=x onerror="alert(1)">' });

    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
  });

  it("describes the write scope in prose and marks it for emphasis", () => {
    // The one scope that changes the machine is also the one a person skims
    // past, so it carries its own class; and an owner cannot consent to
    // "espresso:write" — only to what it lets the client do.
    const html = render({ request: request({ scopes: ["espresso:write"] }) });

    expect(html).toContain(
      '<li class="write">Change your machine — switch the active profile, and save new profiles to it</li>',
    );
    expect(html).not.toContain("espresso:write");
  });

  it("describes the read scope without the write emphasis", () => {
    const html = render({ request: request({ scopes: ["espresso:read"] }) });

    expect(html).toContain(
      "<li>Read your shot history, machine status, settings and profiles</li>",
    );
    expect(html).not.toContain('class="write"');
  });

  it("shows a scope it has no description for rather than dropping it", () => {
    // A scope added to `scopes.ts` and forgotten here would otherwise be
    // granted invisibly: the page would list two things and authorize three.
    // The raw identifier is a poor line of prose and a far better bug report.
    expect(
      render({
        request: request({ scopes: ["espresso:read", "grind:write"] }),
      }),
    ).toContain("<li>grind:write</li>");
  });

  it("escapes a scope string it falls back to showing raw", () => {
    const html = render({
      request: request({ scopes: ["<script>alert(1)</script>"] }),
    });

    expect(html).toContain("<li>&lt;script&gt;alert(1)&lt;/script&gt;</li>");
    expect(html).not.toContain("<script>");
  });

  it("asks search engines not to index it", () => {
    // The page lives on whatever public URL the tunnel gives it and holds the
    // form the owner's passphrase is typed into.
    expect(render()).toContain(
      '<meta name="robots" content="noindex, nofollow">',
    );
  });
});

describe("renderErrorPage", () => {
  it("escapes the heading everywhere it lands, the title included", () => {
    const html = renderErrorPage("<script>alert(1)</script>", "Detail.");

    expect(html).toContain(
      "<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>",
    );
    expect(html).toContain("<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>");
    expect(html).not.toContain("<script>");
  });

  it("escapes the detail, which quotes the caller's own parameters back", () => {
    // This is the reflected-XSS sink of the whole server: `authorize.ts` builds
    // these strings by interpolating the `client_id` and `redirect_uri` query
    // parameters, and it does so precisely on the paths where they have *not*
    // been validated yet.
    const html = renderErrorPage(
      "Redirect address not registered",
      `https://evil.test/"><script>alert(1)</script> is not one of the addresses this client declares.`,
    );

    expect(html).toContain(
      "https://evil.test/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(html).not.toContain("<script>");
  });

  it("says plainly that nothing was authorized", () => {
    // This page is reached instead of a redirect, so nothing else will ever
    // tell the person how the flow ended.
    expect(renderErrorPage("Unknown client", "Detail.")).toContain(
      "Nothing has been authorized",
    );
  });
});
