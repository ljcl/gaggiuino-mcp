#!/bin/bash
# Probe a running server's OAuth discovery chain and /mcp security gate.
#
# Usage: ./scripts/test-auth.sh
#        BASE_URL=https://your-machine.tail-scale.ts.net ./scripts/test-auth.sh
#
# This is Anthropic's own diagnostic checklist, automated:
# https://claude.com/docs/connectors/building/troubleshooting#diagnostic-checklist
#
# RUN IT FROM OUTSIDE YOUR LAN. Every failure this catches — a well-known path
# that 404s, a 401 with no pointer, a redirect that drops the Authorization
# header — is a failure of the URL *as Claude reaches it*. Probing localhost
# tests a path no connector takes, and the one thing that most often breaks
# (MCP_PUBLIC_URL disagreeing with the URL the user typed) is invisible there.
#
# It needs `curl`. `jq` is used when present and skipped when not, so the
# status-code checks still run on a box without it.

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
# Trailing slashes make every path below double up.
BASE_URL="${BASE_URL%/}"
MCP_URL="$BASE_URL/mcp"

INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-auth.sh","version":"1.0"}}}'

pass=0
fail=0
skip=0

ok() {
  echo "  PASS  $1"
  pass=$((pass + 1))
}

bad() {
  echo "  FAIL  $1"
  [ $# -gt 1 ] && echo "        $2"
  fail=$((fail + 1))
}

note() {
  echo "  SKIP  $1"
  skip=$((skip + 1))
}

have_jq() { command -v jq >/dev/null 2>&1; }

# Body of a GET, or empty on any transport failure.
fetch() { curl -fsS --max-time 10 "$1" 2>/dev/null; }

status_of() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"
}

mcp_post() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$INIT_BODY" "$@"
}

# Read a JSON field, or "" when jq is missing or the field is absent.
field() {
  have_jq || return 0
  printf '%s' "$1" | jq -r "$2 // empty" 2>/dev/null
}

echo "Probing $MCP_URL"
case "$BASE_URL" in
  http://localhost*|http://127.0.0.1*|http://[::1]*)
    echo "  NOTE  This is a loopback URL. Discovery failures that only appear"
    echo "        over the real hostname will not show up here."
    ;;
esac
echo

# ---------------------------------------------------------------------------
echo "1. Health (must never require a credential):"
# The container HEALTHCHECK presents no token and no Origin.
[ "$(status_of "$BASE_URL/health")" = "200" ] &&
  ok "GET /health -> 200" ||
  bad "GET /health did not return 200" "Is the server running at $BASE_URL?"
echo

# ---------------------------------------------------------------------------
echo "2. Protected-resource metadata (RFC 9728):"
SUFFIXED="$BASE_URL/.well-known/oauth-protected-resource/mcp"
BARE="$BASE_URL/.well-known/oauth-protected-resource"

prm_suffixed=$(fetch "$SUFFIXED")
prm_bare=$(fetch "$BARE")

OAUTH_ON=0
if [ -n "$prm_suffixed" ]; then
  OAUTH_ON=1
  ok "GET /.well-known/oauth-protected-resource/mcp -> 200"
else
  if [ "$(status_of "$MCP_URL")" = "404" ]; then
    echo "  INFO  No metadata and no /mcp — is BASE_URL right?"
  fi
  bad "the path-suffixed well-known document is missing" \
    "Claude probes this first when the resource URL has a path. With no metadata to read it never learns where the authorization server is, and the connection fails with 'Couldn't reach the MCP server.' If OAuth is off, set MCP_PUBLIC_URL and MCP_OAUTH_SECRET."
fi

if [ "$OAUTH_ON" = "1" ]; then
  # Anthropic's checklist curls the bare form, so serving only one fails a
  # check that is meant to pass.
  [ -n "$prm_bare" ] &&
    ok "GET /.well-known/oauth-protected-resource -> 200" ||
    bad "the bare well-known document is missing"

  if have_jq; then
    resource=$(field "$prm_suffixed" '.resource')
    if [ "$resource" = "$MCP_URL" ]; then
      ok "resource matches the URL under test"
    else
      bad "resource is '$resource', not '$MCP_URL'" \
        "This must match what you type into Claude exactly, path included. A mismatch is silent: discovery succeeds, a token is issued, and every request then 401s. Fix MCP_PUBLIC_URL."
    fi

    if [ "$prm_suffixed" = "$prm_bare" ]; then
      ok "both well-known paths serve the same document"
    else
      bad "the two well-known documents differ"
    fi

    AS_ISSUER=$(field "$prm_suffixed" '.authorization_servers[0]')
    [ -n "$AS_ISSUER" ] &&
      ok "authorization_servers names $AS_ISSUER" ||
      bad "authorization_servers is empty"
  else
    note "jq not installed — cannot check resource or authorization_servers"
  fi
fi
echo

# ---------------------------------------------------------------------------
echo "3. Authorization server metadata:"
if [ "$OAUTH_ON" != "1" ]; then
  note "OAuth is not configured on this server"
elif ! have_jq; then
  note "jq not installed"
else
  # RFC 8414 first, then the OIDC fallback: most hosted identity providers
  # (Auth0, Okta, Entra, Keycloak, Supabase) only serve the latter.
  as_doc=$(fetch "${AS_ISSUER%/}/.well-known/oauth-authorization-server")
  as_where="RFC 8414"
  if [ -z "$as_doc" ]; then
    as_doc=$(fetch "${AS_ISSUER%/}/.well-known/openid-configuration")
    as_where="OpenID Connect"
  fi

  if [ -z "$as_doc" ]; then
    bad "the authorization server publishes no metadata" \
      "Tried both /.well-known/oauth-authorization-server and /.well-known/openid-configuration at $AS_ISSUER. If it is behind a WAF, check it is reachable from Anthropic's egress range 160.79.104.0/21."
  else
    ok "authorization server metadata found ($as_where)"

    if [ "$(field "$as_doc" '.code_challenge_methods_supported | index("S256")')" != "" ]; then
      ok "advertises PKCE S256"
    else
      bad "code_challenge_methods_supported does not list S256" \
        "Claude sends code_challenge_method=S256 on every authorization request, and the spec says a client MUST refuse to proceed if this is absent."
    fi

    cimd=$(field "$as_doc" '.client_id_metadata_document_supported')
    none=$(field "$as_doc" '.token_endpoint_auth_methods_supported | index("none")')
    registration=$(field "$as_doc" '.registration_endpoint')
    if [ "$cimd" = "true" ] && [ -n "$none" ]; then
      ok "advertises CIMD (flag + \"none\"), so no client registration is needed"
    elif [ -n "$registration" ]; then
      ok "advertises a registration_endpoint (dynamic client registration)"
    else
      bad "Claude cannot work out how to register" \
        "It selects CIMD only when client_id_metadata_document_supported is true AND \"none\" is in token_endpoint_auth_methods_supported. With one of those missing and no registration_endpoint, it has no path. (flag=$cimd, none=${none:-absent})"
    fi
  fi
fi
echo

# ---------------------------------------------------------------------------
echo "4. The 401 that starts the flow:"
headers=$(curl -s -D - -o /dev/null --max-time 10 -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$INIT_BODY" 2>/dev/null)
code=$(printf '%s' "$headers" | awk 'NR==1{print $2}')
challenge=$(printf '%s' "$headers" | tr -d '\r' | grep -i '^www-authenticate:' | cut -d' ' -f2-)

if [ "$OAUTH_ON" != "1" ] && [ "$code" = "200" ]; then
  echo "  WARN  POST /mcp succeeded with no credential — this server is open."
  echo "        Set MCP_PUBLIC_URL, MCP_OAUTH_SECRET and MCP_OAUTH_PASSPHRASE_HASH"
  echo "        before exposing it beyond your LAN."
elif [ "$code" = "401" ]; then
  # A WWW-Authenticate on a 200 is not honoured, so the status is load-bearing.
  ok "unauthenticated POST /mcp -> 401"
  if [ -z "$challenge" ]; then
    bad "the 401 carries no WWW-Authenticate header" \
      "This is the failure behind claude-ai-mcp#410: claude.ai web and mobile give up, while Claude Code connects to the same URL because it probes .well-known as a fallback."
  else
    case "$challenge" in
      *resource_metadata=*) ok "the challenge carries resource_metadata" ;;
      *) bad "WWW-Authenticate has no resource_metadata parameter" "Claude has nothing to follow." ;;
    esac
    case "$challenge" in
      *scope=*) ok "the challenge carries scope" ;;
      *) bad "WWW-Authenticate has no scope parameter" \
           "Claude will then request everything in scopes_supported, producing a broader consent prompt than the request needs." ;;
    esac
  fi
else
  bad "unauthenticated POST /mcp returned $code, expected 401"
fi
echo

# ---------------------------------------------------------------------------
echo "5. Redirects (an Authorization header does not survive a cross-host hop):"
location=$(curl -s -D - -o /dev/null --max-time 10 "$MCP_URL" 2>/dev/null |
  tr -d '\r' | grep -i '^location:' | cut -d' ' -f2- | head -1)
if [ -z "$location" ]; then
  ok "the MCP URL does not redirect"
else
  target_host=$(printf '%s' "$location" | awk -F[/:] '{print $4}')
  base_host=$(printf '%s' "$BASE_URL" | awk -F[/:] '{print $4}')
  if [ "$target_host" = "$base_host" ]; then
    ok "redirects, but stays on $base_host"
  else
    bad "redirects to a different host ($target_host)" \
      "The Authorization header is dropped on a cross-host redirect. This is the usual cause of 'works in MCP Inspector or Claude Code but not claude.ai' — apex-to-www canonicalisation in front of the server is the common way to hit it."
  fi
fi
echo

# ---------------------------------------------------------------------------
echo "6. Origin validation:"
origin_status=$(mcp_post -H "Origin: https://evil.example")
if [ "$origin_status" = "403" ]; then
  ok "cross-origin POST /mcp rejected (403)"
else
  bad "cross-origin POST /mcp returned $origin_status, expected 403" \
    "Is MCP_ALLOWED_ORIGINS set to '*' or to this origin?"
fi
echo

# ---------------------------------------------------------------------------
echo "$pass passed, $fail failed, $skip skipped"
if [ "$fail" -ne 0 ]; then
  echo
  echo "If a connector still fails after these all pass, Anthropic's"
  echo "troubleshooting page asks for the ofid_ reference ID shown with the"
  echo "error — that is what turns a report into something traceable."
fi
[ "$fail" -eq 0 ]
