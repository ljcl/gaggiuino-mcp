#!/bin/bash
# Probe a running server's /mcp security gate.
#
# Usage: ./scripts/test-auth.sh [bearer-token]
#        BASE_URL=https://your-machine.tail-scale.ts.net ./scripts/test-auth.sh "$MCP_AUTH_TOKEN"
#
# This exercises bearer auth and origin validation as implemented in
# apps/server/src/mcpAuth.ts. The server does not implement OAuth and advertises
# no discovery document, so there is nothing at /.well-known to probe.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
TOKEN="${1:-}"

INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-auth.sh","version":"1.0"}}}'

pass=0
fail=0

# probe <description> <expected-status> [extra curl args...]
probe() {
  local description="$1" expected="$2"
  shift 2
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "$status" = "$expected" ]; then
    echo "  PASS  $description ($status)"
    pass=$((pass + 1))
  else
    echo "  FAIL  $description — expected $expected, got $status"
    fail=$((fail + 1))
  fi
}

mcp_post() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$INIT_BODY" "$@"
}

echo "Probing $BASE_URL"
echo

echo "Health endpoint (must never require a credential):"
probe "GET /health" 200 "$BASE_URL/health"
probe "GET /health from a foreign origin" 200 -H "Origin: https://evil.example" "$BASE_URL/health"
echo

echo "Origin validation:"
status=$(mcp_post -H "Origin: https://evil.example" ${TOKEN:+-H "Authorization: Bearer $TOKEN"})
if [ "$status" = "403" ]; then
  echo "  PASS  cross-origin POST /mcp rejected (403)"
  pass=$((pass + 1))
else
  echo "  FAIL  cross-origin POST /mcp — expected 403, got $status"
  echo "        Is MCP_ALLOWED_ORIGINS set to '*' or to this origin?"
  fail=$((fail + 1))
fi
echo

echo "Bearer auth:"
status=$(mcp_post)
if [ -n "$TOKEN" ]; then
  if [ "$status" = "401" ]; then
    echo "  PASS  unauthenticated POST /mcp rejected (401)"
    pass=$((pass + 1))
  else
    echo "  FAIL  unauthenticated POST /mcp — expected 401, got $status"
    echo "        Is MCP_AUTH_TOKEN set on the server?"
    fail=$((fail + 1))
  fi

  status=$(mcp_post -H "Authorization: Bearer $TOKEN")
  if [ "$status" = "200" ]; then
    echo "  PASS  authenticated POST /mcp accepted (200)"
    pass=$((pass + 1))
  else
    echo "  FAIL  authenticated POST /mcp — expected 200, got $status"
    fail=$((fail + 1))
  fi

  status=$(mcp_post -H "Authorization: Bearer ${TOKEN}x")
  if [ "$status" = "401" ]; then
    echo "  PASS  wrong token rejected (401)"
    pass=$((pass + 1))
  else
    echo "  FAIL  wrong token — expected 401, got $status"
    fail=$((fail + 1))
  fi
else
  if [ "$status" = "200" ]; then
    echo "  WARN  POST /mcp succeeded with no token — this server is unauthenticated."
    echo "        Set MCP_AUTH_TOKEN before exposing it beyond your LAN, then"
    echo "        re-run: $0 \"\$MCP_AUTH_TOKEN\""
  else
    echo "  INFO  POST /mcp returned $status with no token."
    echo "        Looks gated. Re-run with the token to check it end to end:"
    echo "        $0 \"\$MCP_AUTH_TOKEN\""
  fi
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
