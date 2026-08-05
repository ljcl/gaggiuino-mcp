import { lookup } from "node:dns/promises";
import { createCache } from "../cache";
import { logger } from "../logging";

/**
 * Client Identifier Metadata Documents (CIMD), which is why this server needs
 * no client registry.
 *
 * The `client_id` *is* a URL. At `/oauth/authorize` the server fetches it,
 * checks the document is self-referential — its own `client_id` field equals the
 * URL it was served from — and checks the requested `redirect_uri` against the
 * document's `redirect_uris`. There is no `POST /register`, no client table, and
 * no client secret to store, which is what keeps the whole authorization server
 * inside one container with no volume.
 *
 * Claude only picks CIMD when the authorization-server metadata advertises both
 * `client_id_metadata_document_supported: true` and `"none"` in
 * `token_endpoint_auth_methods_supported`. If either is missing it goes looking
 * for a `registration_endpoint` that deliberately does not exist.
 */

/** A parsed, validated client metadata document. */
export interface ClientMetadata {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
}

/**
 * The hosted Claude surfaces, pinned.
 *
 * Used only when the live fetch fails. There is a report that Anthropic's CDN
 * answers 403 when a self-hosted authorization server fetches these from
 * datacenter IPs (anthropics/claude-ai-mcp#540); a home tunnel is a different
 * egress and it fetches fine from here, but an outbound HTTP dependency inside
 * the login path of a machine in someone's kitchen is a bad bet. This is
 * pre-registration keyed by the CIMD URL, which is what it should degrade to.
 *
 * Verified live 2026-08-05: both documents return 200 and are self-referential.
 */
const PINNED: Record<string, ClientMetadata> = {
  "https://claude.ai/oauth/claude-code-client-metadata": {
    clientId: "https://claude.ai/oauth/claude-code-client-metadata",
    clientName: "Claude Code",
    redirectUris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  },
  "https://claude.ai/oauth/mcp-oauth-client-metadata": {
    clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
    clientName: "Claude",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  },
};

/** Claude allows ten seconds for the whole authorize step; this is its share. */
const FETCH_TIMEOUT_MS = 3_000;

/** A client metadata document is a few hundred bytes. */
const MAX_DOCUMENT_BYTES = 64 * 1024;

const DOCUMENT_TTL_MS = 60 * 60 * 1000;

const documents = createCache<ClientMetadata>({ maxEntries: 32 });

/** Reset the cached documents. Test seam, mirroring `resetClient`. */
export function resetClientCache(): void {
  documents.clear();
}

function ipv4IsPrivate(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a = 0, b = 0] = parts;
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n)))
    return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 is Tailscale's own CGNAT range. A client_id pointing into the
  // tailnet is not a legitimate client, and this fetch runs on a host that can
  // reach it.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function ipv6IsPrivate(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  if (normalized === "::1" || normalized === "::") return true;
  // fc00::/7 (unique local) and fe80::/10 (link local).
  if (/^f[cd]/.test(normalized)) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  // ::ffff:a.b.c.d — an IPv4 address wearing a hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return ipv4IsPrivate(mapped[1]);
  return false;
}

/**
 * Refuse to fetch anything that resolves off the public internet.
 *
 * `/oauth/authorize` takes `client_id` from the caller and this server fetches
 * it, so without this a stranger can point it at a printer's admin page. The
 * response is never echoed back, but blind SSRF against a home LAN is still
 * worth closing.
 */
export function isPubliclyRoutable(address: string, family: number): boolean {
  return family === 6 ? !ipv6IsPrivate(address) : !ipv4IsPrivate(address);
}

async function resolvesPublicly(hostname: string): Promise<boolean> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return false;
  }
  if (addresses.length === 0) return false;
  // `every`, not `some`: a hostname with one public and one private answer is
  // a DNS-rebinding setup, and the private answer is the one that matters.
  return addresses.every(({ address, family }) =>
    isPubliclyRoutable(address, family),
  );
}

function parseDocument(
  clientId: string,
  body: unknown,
): ClientMetadata | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const doc = body as Record<string, unknown>;
  // Self-reference is the whole security property of CIMD: the document has to
  // claim the URL it was served from, or anyone who can host JSON anywhere can
  // assert any client identity.
  if (doc.client_id !== clientId) return undefined;
  if (!Array.isArray(doc.redirect_uris)) return undefined;
  const redirectUris = doc.redirect_uris.filter(
    (uri): uri is string => typeof uri === "string",
  );
  if (redirectUris.length === 0) return undefined;
  return {
    clientId,
    clientName:
      typeof doc.client_name === "string" ? doc.client_name : undefined,
    redirectUris,
  };
}

async function fetchDocument(
  clientId: string,
): Promise<ClientMetadata | undefined> {
  const response = await fetch(clientId, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return undefined;

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_DOCUMENT_BYTES) return undefined;
  const text = await response.text();
  // Checked again after reading: `content-length` is a claim, not a promise,
  // and a chunked response does not carry one at all.
  if (text.length > MAX_DOCUMENT_BYTES) return undefined;

  try {
    return parseDocument(clientId, JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Resolve a `client_id` URL to its metadata, or `undefined` if it is not usable.
 *
 * Order is live fetch, then the pinned table, and which path was taken is
 * logged — an operator debugging a failed login needs to know whether the
 * network or the document was the problem.
 */
export async function resolveClient(
  clientId: string,
): Promise<ClientMetadata | undefined> {
  const cached = documents.get(clientId);
  if (cached) return cached;

  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;

  if (await resolvesPublicly(url.hostname)) {
    try {
      const fetched = await fetchDocument(clientId);
      if (fetched) {
        documents.set(clientId, fetched, DOCUMENT_TTL_MS);
        logger.debug("oauth.client_resolved", { clientId, via: "fetch" });
        return fetched;
      }
      logger.warn("oauth.client_fetch_rejected", { clientId });
    } catch (error) {
      logger.warn("oauth.client_fetch_failed", {
        clientId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    logger.warn("oauth.client_not_public", { clientId });
  }

  const pinned = PINNED[clientId];
  if (pinned) {
    documents.set(clientId, pinned, DOCUMENT_TTL_MS);
    logger.info("oauth.client_resolved", { clientId, via: "pinned" });
    return pinned;
  }
  return undefined;
}

/**
 * Whether a redirect URI is one this client declared.
 *
 * Exact match for everything except loopback, where the port is ignored: RFC
 * 8252 §7.3 requires that for the IP-literal form, and Anthropic's guidance is
 * to apply the same to `localhost` even though §8.3 discourages it — Claude Code
 * declares `http://localhost/callback` and then binds an ephemeral port.
 */
export function redirectUriAllowed(
  requested: string,
  client: ClientMetadata,
): boolean {
  let candidate: URL;
  try {
    candidate = new URL(requested);
  } catch {
    return false;
  }
  return client.redirectUris.some((declared) => {
    if (declared === requested) return true;
    let known: URL;
    try {
      known = new URL(declared);
    } catch {
      return false;
    }
    // `[::1]` with the brackets — WHATWG `URL` keeps them on an IPv6 host, so
    // a bare "::1" comparison never fires. Failing closed here rather than
    // open, but a client declaring the IPv6 loopback would still be rejected.
    const loopback =
      known.hostname === "127.0.0.1" ||
      known.hostname === "localhost" ||
      known.hostname === "[::1]";
    if (!loopback) return false;
    return (
      candidate.protocol === known.protocol &&
      candidate.hostname === known.hostname &&
      candidate.pathname === known.pathname
    );
  });
}
