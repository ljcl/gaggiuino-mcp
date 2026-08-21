import { logger } from "./logging";
import { advertisedPrompts, tryRenderPrompt } from "./prompts";
import {
  callTool,
  RESOURCE_TEMPLATES,
  RESOURCES,
  readResource,
  SERVER_CAPABILITIES,
  TOOLS,
} from "./server";
import { SERVER_NAME, SERVER_VERSION } from "./version";

/**
 * The modern era of the dual-era server: protocol revision 2026-07-28, served
 * statelessly, one POST per request, no `initialize` and no session.
 *
 * The 2026-07-28 revision removed the handshake and the `Mcp-Session-Id`
 * header; every request now carries its protocol version and client
 * capabilities in `_meta`, mirrored into HTTP headers so intermediaries can
 * route without parsing bodies. Its versioning page defines the split this
 * module implements: a request carrying modern per-request `_meta` is served
 * statelessly according to that revision, an `initialize` request selects
 * legacy semantics, and a dual-era server may serve both concurrently on the
 * same endpoint. The legacy half stays exactly what it was — the SDK transport
 * and the session registry — so nothing a 2025-era client depends on moves.
 *
 * Everything served here is the same object the legacy era serves: `TOOLS`,
 * `advertisedPrompts()`, `RESOURCES`, `SERVER_CAPABILITIES`. That is the
 * permission-grant rule extended across eras — the advertised surface is one
 * surface, and a host migrating eras must see byte-identical tools or its
 * stored grants silently drop.
 *
 * Two spec-reserved error codes are deliberately never emitted:
 *
 * - `-32021 MissingRequiredClientCapability`: this server requires no client
 *   capabilities. It never samples, never elicits, never lists roots — the
 *   MRTR pattern those would ride on has nothing here to carry.
 * - `-32002` (the pre-2026 resource-not-found): retired by this revision.
 *   An unknown resource is `-32602` Invalid Params here, while the legacy era
 *   keeps its historical answer.
 */

/**
 * The versions served statelessly. Deliberately *not* padded with the legacy
 * versions the SDK half negotiates: this list is what
 * `UnsupportedProtocolVersionError.data.supported` and
 * `DiscoverResult.supportedVersions` advertise, and both tell a modern client
 * "retry with per-request metadata under one of these" — advice that is a lie
 * for a version whose semantics require an `initialize` handshake.
 */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = ["2026-07-28"];

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/** Spec-allocated error codes (-32020..-32099 is the MCP-reserved sub-range). */
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const PARSE_ERROR_INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/**
 * How long a client may cache the cacheable results (`server/discover` and
 * the four list/read methods), and for whom.
 *
 * An hour, because everything under it is a module-level constant that changes
 * only on redeploy — the same fact behind the missing `listChanged` claims —
 * and an hour of staleness after a release is no worse than what legacy hosts
 * already do (cache indefinitely against a `listChanged` that never fires).
 *
 * `private`, not `public`, although nothing served is user-specific: the
 * documented deployment gates `/mcp` behind OAuth, and a scope that forbids
 * shared intermediaries from serving cached responses across authorization
 * contexts can never hand a gated answer to a caller the gate would refuse.
 * The only thing `public` would buy is shared-gateway caching, which is worth
 * nothing on a single-user espresso machine.
 */
const CACHE_TTL_MS = 3_600_000;
const CACHE_SCOPE = "private";

const CACHEABLE = { cacheScope: CACHE_SCOPE, ttlMs: CACHE_TTL_MS } as const;

/**
 * The methods whose `Mcp-Name` header is required, and where in the body the
 * value it must match lives.
 */
const NAMED_METHODS: Record<string, "name" | "uri"> = {
  "prompts/get": "name",
  "resources/read": "uri",
  "tools/call": "name",
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function metaOf(body: JsonRecord): JsonRecord {
  return asRecord(asRecord(body.params)?._meta) ?? {};
}

function modernVersionOf(body: JsonRecord): string | undefined {
  const version = metaOf(body)[META_PROTOCOL_VERSION];
  return typeof version === "string" ? version : undefined;
}

/**
 * Decide which era a POST body belongs to.
 *
 * The versioning spec keys the split on the request, not the connection: a
 * request carrying modern per-request `_meta` is modern, an `initialize` (or
 * anything session-shaped) is legacy. Three signals mark a request modern, and
 * each exists for a different broken-but-modern client:
 *
 * - The `_meta` protocol version key. The definitive marker; no legacy client
 *   ever sends a reserved `io.modelcontextprotocol/*` request key.
 * - A modern `MCP-Protocol-Version` header on a body missing the key. Routing
 *   it here means the client gets the modern `HeaderMismatch` error it can
 *   act on, rather than the legacy path's "no valid session ID".
 * - A modern-only method name. `server/discover` is the stdio-era probe; a
 *   client sending it malformed still deserves a modern-shaped answer,
 *   because a non-modern error is precisely what tells a dual-era *client* to
 *   fall back to `initialize` against this server — which would be wrong.
 *
 * Arrays are never modern: the 2026-07-28 body is a single request or
 * notification, and JSON-RPC batches belong to the legacy era that allowed
 * them.
 */
export function isModernRequest(req: Request, rawBody: unknown): boolean {
  const body = asRecord(rawBody);
  if (!body) return false;
  if (modernVersionOf(body) !== undefined) return true;
  const headerVersion = req.headers.get("mcp-protocol-version");
  if (
    headerVersion !== null &&
    MODERN_PROTOCOL_VERSIONS.includes(headerVersion)
  ) {
    return true;
  }
  return (
    body.method === "server/discover" || body.method === "subscriptions/listen"
  );
}

type RequestId = string | number;

function idOf(body: JsonRecord): RequestId | null {
  const { id } = body;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function serverInfoMeta(): JsonRecord {
  return {
    [META_SERVER_INFO]: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

/**
 * A modern result: `resultType` is required on every result in this revision,
 * and `serverInfo` rides in `_meta` so the client learns who answered without
 * any prior connection state — the stateless replacement for the
 * `initialize` result's `serverInfo`.
 */
function resultResponse(id: RequestId, payload: JsonRecord): Response {
  return Response.json({
    id,
    jsonrpc: "2.0",
    result: {
      _meta: serverInfoMeta(),
      resultType: "complete",
      ...payload,
    },
  });
}

/**
 * A modern JSON-RPC error, carried on the HTTP status the spec assigns it:
 * 400 for validation failures (header mismatch, unsupported version, invalid
 * params), 404 for an unknown method — the body's `-32601` is what
 * distinguishes that 404 from a legacy HTTP+SSE server that does not host the
 * endpoint at all. Every one is logged: a silent 4xx leaves a half-migrated
 * client indistinguishable from an unreachable server, the same argument the
 * security gate's `security.rejected` makes.
 */
function errorResponse(
  status: number,
  id: RequestId | null,
  code: number,
  message: string,
  data?: JsonRecord,
): Response {
  logger.warn("modern.rejected", { code, reason: message, status });
  return new Response(
    JSON.stringify({
      error: { code, ...(data ? { data } : {}), message },
      id,
      jsonrpc: "2.0",
    }),
    { headers: { "Content-Type": "application/json" }, status },
  );
}

/**
 * Undo the transport's Base64 sentinel encoding for header values that cannot
 * ride as plain ASCII (`Mcp-Name: =?base64?...?=`). Servers MUST decode before
 * comparing against the body — a profile named in Unicode arrives encoded.
 */
function decodeHeaderValue(value: string): string {
  if (value.startsWith("=?base64?") && value.endsWith("?=")) {
    const encoded = value.slice("=?base64?".length, -"?=".length);
    return Buffer.from(encoded, "base64").toString("utf8");
  }
  return value;
}

function headerMismatch(id: RequestId | null, detail: string): Response {
  return errorResponse(400, id, HEADER_MISMATCH, `Header mismatch: ${detail}`);
}

/**
 * Serve one modern-era request. The caller has already parsed the body,
 * checked Origin/Host, authenticated, and run the scope gate — auth stays an
 * HTTP status in every era.
 */
export async function handleModernRequest(
  req: Request,
  rawBody: unknown,
): Promise<Response> {
  // `isModernRequest` vouched for the shape; this narrows it for TypeScript.
  const body = asRecord(rawBody) ?? {};
  const id = idOf(body);
  const { method } = body;

  if (typeof method !== "string") {
    return errorResponse(
      400,
      id,
      PARSE_ERROR_INVALID_REQUEST,
      "Invalid Request: method is required",
    );
  }

  // A notification (no id) is acknowledged and dropped: the modern core
  // defines no client-to-server notification over Streamable HTTP — even
  // cancellation is the closing of the response stream — and the transport's
  // answer to an accepted notification is a bodiless 202. Header requirements
  // for notification POSTs are explicitly undefined in this revision, so none
  // are enforced.
  if (!("id" in body)) {
    return new Response(null, { status: 202 });
  }
  if (id === null) {
    // JSON-RPC ids must be strings or numbers; unlike base JSON-RPC, null is
    // banned outright in MCP.
    return errorResponse(
      400,
      null,
      PARSE_ERROR_INVALID_REQUEST,
      "Invalid Request: id must be a string or number",
    );
  }

  // Header–body validation, in the transport spec's own order: the mirrored
  // headers exist so intermediaries can route without parsing bodies, and a
  // disagreement between the two sources of truth is a security hazard, not a
  // nit — a gateway rate-limiting on the header while this server executes
  // the body value is the confusion the 400 exists to stop.
  const headerVersion = req.headers.get("mcp-protocol-version");
  const bodyVersion = modernVersionOf(body);
  if (headerVersion === null) {
    return headerMismatch(id, "MCP-Protocol-Version header is required");
  }
  if (bodyVersion === undefined || headerVersion !== bodyVersion) {
    return headerMismatch(
      id,
      `MCP-Protocol-Version header value '${headerVersion}' does not match body _meta value '${bodyVersion ?? "(absent)"}'`,
    );
  }

  if (!MODERN_PROTOCOL_VERSIONS.includes(bodyVersion)) {
    // The retry signal for version selection: a modern client picks from
    // `supported` and re-sends. Legacy versions are deliberately absent from
    // that list — see MODERN_PROTOCOL_VERSIONS.
    return errorResponse(
      400,
      id,
      UNSUPPORTED_PROTOCOL_VERSION,
      "Unsupported protocol version",
      {
        requested: bodyVersion,
        supported: [...MODERN_PROTOCOL_VERSIONS],
      },
    );
  }

  const methodHeader = req.headers.get("mcp-method");
  if (methodHeader === null) {
    return headerMismatch(id, "Mcp-Method header is required");
  }
  if (methodHeader !== method) {
    return headerMismatch(
      id,
      `Mcp-Method header value '${methodHeader}' does not match body method '${method}'`,
    );
  }

  const params = asRecord(body.params) ?? {};

  const namedField = NAMED_METHODS[method];
  if (namedField) {
    const nameHeader = req.headers.get("mcp-name");
    if (nameHeader === null) {
      return headerMismatch(id, `Mcp-Name header is required for ${method}`);
    }
    const bodyName = params[namedField];
    const decoded = decodeHeaderValue(nameHeader);
    if (typeof bodyName !== "string" || decoded !== bodyName) {
      return headerMismatch(
        id,
        `Mcp-Name header value '${decoded}' does not match body value '${typeof bodyName === "string" ? bodyName : "(absent)"}'`,
      );
    }
  }

  // Required on every request; an empty object is a valid answer ("no
  // optional capabilities") but an absent one is a malformed request.
  if (asRecord(metaOf(body)[META_CLIENT_CAPABILITIES]) === undefined) {
    return errorResponse(
      400,
      id,
      INVALID_PARAMS,
      `Invalid params: _meta['${META_CLIENT_CAPABILITIES}'] is required on every request`,
    );
  }

  switch (method) {
    case "server/discover":
      return resultResponse(id, {
        ...CACHEABLE,
        capabilities: SERVER_CAPABILITIES,
        supportedVersions: [...MODERN_PROTOCOL_VERSIONS],
      });

    case "tools/list":
      return resultResponse(id, { ...CACHEABLE, tools: TOOLS });

    case "tools/call": {
      // The Mcp-Name validation above already proved `params.name` is a
      // string — it is the value the header had to match.
      const args = asRecord(params.arguments) ?? {};
      // `callTool` never throws: expected failures are `isError` results the
      // model can act on, and genuine bugs come back as logged error results —
      // the same contract the legacy handler has.
      return resultResponse(id, await callTool(params.name as string, args));
    }

    case "prompts/list":
      return resultResponse(id, { ...CACHEABLE, prompts: advertisedPrompts() });

    case "prompts/get": {
      // A prompt has no `isError` channel in any era: a bad request is a
      // JSON-RPC error, which is what a host needs to put the missing field
      // back in front of the user. The refusal arrives as a value — this
      // dispatcher deliberately reads nothing off a caught exception into a
      // response, so a genuine bug propagates instead of leaking its
      // internals as an "invalid params" answer. The Mcp-Name validation
      // already proved `params.name` is a string.
      const outcome = tryRenderPrompt(
        params.name as string,
        asRecord(params.arguments) as Record<string, string> | undefined,
      );
      if ("invalid" in outcome) {
        return errorResponse(400, id, INVALID_PARAMS, outcome.invalid);
      }
      return resultResponse(id, {
        messages: [
          { content: { text: outcome.text, type: "text" }, role: "user" },
        ],
      });
    }

    case "resources/list":
      return resultResponse(id, { ...CACHEABLE, resources: RESOURCES });

    case "resources/templates/list":
      return resultResponse(id, {
        ...CACHEABLE,
        resourceTemplates: RESOURCE_TEMPLATES,
      });

    case "resources/read": {
      // `Mcp-Name` validation above already proved `params.uri` is a string.
      const read = await readResource(params.uri as string);
      if ("missing" in read) {
        // -32602, not the retired -32002: this revision renumbered resource
        // not found onto Invalid Params.
        return errorResponse(400, id, INVALID_PARAMS, read.missing);
      }
      return resultResponse(id, { ...CACHEABLE, ...read });
    }

    case "subscriptions/listen":
      return handleListen(id, params);

    default:
      // 404 with -32601 in the body: the status tells an intermediary, the
      // code tells a client this is a modern server that lacks the method —
      // as opposed to a legacy HTTP+SSE server's bare 404, which is the
      // signal to fall back to another transport entirely.
      return errorResponse(
        404,
        id,
        METHOD_NOT_FOUND,
        `Method not found: ${method}`,
      );
  }
}

/**
 * `subscriptions/listen` replaced the GET stream, `resources/subscribe`, and
 * the list-changed capabilities with one opt-in stream — and this server has
 * nothing to put on it. Every list it serves is a module-level constant, which
 * is the same fact behind `SERVER_CAPABILITIES` claiming no `listChanged`.
 *
 * So the honest answer is the spec's own teardown sequence, immediately: an
 * acknowledgement whose honoured set is empty (the spec has the server omit
 * every requested type it does not support), then the graceful-close result.
 * The alternative — holding a socket open per client to never send anything —
 * costs a connection slot and tells the client nothing the empty
 * acknowledgement has not already said.
 */
function handleListen(id: RequestId, params: JsonRecord): Response {
  if (asRecord(params.notifications) === undefined) {
    return errorResponse(
      400,
      id,
      INVALID_PARAMS,
      "Invalid params: notifications is required",
    );
  }
  const subscriptionMeta = { [META_SUBSCRIPTION_ID]: id };
  const acknowledged = {
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: {
      _meta: subscriptionMeta,
      // Empty on purpose: no requested type is supported, and the spec says
      // unsupported types are omitted from the honoured set.
      notifications: {},
    },
  };
  const closed = {
    id,
    jsonrpc: "2.0",
    result: {
      _meta: { ...serverInfoMeta(), ...subscriptionMeta },
      resultType: "complete",
    },
  };
  return new Response(
    `data: ${JSON.stringify(acknowledged)}\n\ndata: ${JSON.stringify(closed)}\n\n`,
    {
      headers: {
        "Content-Type": "text/event-stream",
        // Tells reverse proxies (nginx) not to buffer SSE; without it events
        // sit in a proxy buffer instead of reaching the client.
        "X-Accel-Buffering": "no",
      },
    },
  );
}
