import { type PendingAuthorization } from "./codes";
import { SCOPE_READ, SCOPE_WRITE } from "./scopes";

/**
 * The consent page, and the only HTML this server serves outside the MCP App
 * bundle.
 *
 * Deliberately one inline string with inline CSS. `apps/server` has no
 * dependency on `@gaggiuino/design-system` and must not gain one — `turbo
 * boundaries` enforces the layering, and the server is not an `mcp-app`. If this
 * page ever grows a template engine, that is the signal it is doing too much,
 * not a reason to add one.
 */

/** Escape for HTML text and double-quoted attribute values alike. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0; padding: 1.5rem; display: flex; justify-content: center;
  background: #f6f6f7; color: #16161a;
}
main { width: 100%; max-width: 26rem; }
.card {
  background: #fff; border: 1px solid #d8d8dc; border-radius: 12px;
  padding: 1.5rem;
}
h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
p { margin: 0 0 1rem; }
.rp { font-weight: 600; }
ul { margin: 0 0 1.25rem; padding-left: 1.1rem; }
li { margin-bottom: 0.35rem; }
li.write { font-weight: 600; }
label { display: block; font-weight: 600; margin-bottom: 0.35rem; }
input[type=password] {
  width: 100%; padding: 0.6rem 0.7rem; font-size: 1rem;
  border: 1px solid #b6b6bd; border-radius: 8px; background: #fff; color: inherit;
}
button {
  width: 100%; margin-top: 1rem; padding: 0.7rem 1rem; font-size: 1rem;
  font-weight: 600; border: 0; border-radius: 8px;
  background: #16161a; color: #fff; cursor: pointer;
}
.warn {
  border-left: 3px solid #b8860b; padding: 0.6rem 0.8rem; margin: 0 0 1.25rem;
  background: #fdf6e3; font-size: 0.9rem;
}
.error {
  border-left: 3px solid #b3261e; padding: 0.6rem 0.8rem; margin: 0 0 1.25rem;
  background: #fdeceb; font-size: 0.9rem;
}
.muted { color: #55555c; font-size: 0.85rem; }
@media (prefers-color-scheme: dark) {
  body { background: #131316; color: #ececee; }
  .card { background: #1c1c20; border-color: #34343a; }
  input[type=password] { background: #26262b; border-color: #45454d; }
  button { background: #ececee; color: #131316; }
  .warn { background: #2b2413; }
  .error { background: #2d1a19; }
  .muted { color: #a0a0a8; }
}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><main class="card">${body}</main></body>
</html>`;
}

const SCOPE_DESCRIPTIONS: Record<string, { text: string; write: boolean }> = {
  [SCOPE_READ]: {
    text: "Read your shot history, machine status, settings and profiles",
    write: false,
  },
  [SCOPE_WRITE]: {
    text: "Change your machine — switch the active profile, and save new profiles to it",
    write: true,
  },
};

/**
 * Whether every declared redirect URI is a loopback address.
 *
 * The MCP spec calls this out: any local process can bind a port and claim to be
 * the client, so a loopback-only client deserves a louder page than a hosted one.
 */
export function isLoopbackOnly(redirectUris: string[]): boolean {
  if (redirectUris.length === 0) return false;
  return redirectUris.every((uri) => {
    try {
      const { hostname } = new URL(uri);
      // `[::1]` with the brackets, because that is what WHATWG `URL` reports
      // for an IPv6 host — `new URL("http://[::1]/cb").hostname` is `"[::1]"`,
      // and the unbracketed form does not parse at all. A bare `"::1"` check
      // is unreachable, which suppressed the warning for precisely the client
      // it was written to catch.
      return (
        hostname === "127.0.0.1" ||
        hostname === "localhost" ||
        hostname === "[::1]"
      );
    } catch {
      return false;
    }
  });
}

export interface ConsentPageOptions {
  /** Shown above the form after a failed attempt. */
  error?: string;
  loopbackOnly: boolean;
  request: PendingAuthorization;
  /** One-time token, bound to the parked request. */
  csrfToken: string;
}

export function renderConsentPage({
  csrfToken,
  error,
  loopbackOnly,
  request,
}: ConsentPageOptions): string {
  // The *host of the client_id URL*, never the `client_name` field. The metadata
  // document is self-asserted, so `client_name` is whatever its author typed —
  // the host is the part TLS and the self-reference check actually establish.
  // For the hosted Claude surfaces this renders `claude.ai`.
  const relyingParty = new URL(request.clientId).host;

  const scopes = request.scopes
    .map((scope) => {
      const described = SCOPE_DESCRIPTIONS[scope];
      const text = described?.text ?? scope;
      return `<li${described?.write ? ' class="write"' : ""}>${escapeHtml(text)}</li>`;
    })
    .join("");

  return page(
    "Authorize access to your Gaggiuino",
    `<h1>Authorize access</h1>
<p><span class="rp">${escapeHtml(relyingParty)}</span> is asking to connect to your Gaggiuino.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${
  loopbackOnly
    ? `<p class="warn">This client redirects to an address on this computer. Any program running locally can claim to be it — only continue if you just started a sign-in yourself.</p>`
    : ""
}
<p>It will be able to:</p>
<ul>${scopes}</ul>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request_token" value="${escapeHtml(csrfToken)}">
<label for="passphrase">Owner passphrase</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Allow access</button>
</form>
<p class="muted" style="margin-top:1rem">Close this page to refuse.</p>`,
  );
}

/**
 * An error page, for failures that happen before a `redirect_uri` is trusted.
 *
 * Anything rejected at that stage cannot be reported by redirecting — that is
 * the open-redirect the validation exists to prevent — so it has to be shown to
 * the person in front of the browser.
 */
export function renderErrorPage(heading: string, detail: string): string {
  return page(
    heading,
    `<h1>${escapeHtml(heading)}</h1><p class="error">${escapeHtml(detail)}</p>
<p class="muted">Nothing has been authorized. You can close this page.</p>`,
  );
}
