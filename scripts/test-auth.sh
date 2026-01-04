#!/bin/bash
# Test script for OAuth authentication
# Usage: ./scripts/test-auth.sh [token]

set -e

BASE_URL="${BASE_URL:-http://localhost:8000}"

echo "Testing Gaggiuino MCP OAuth endpoints"
echo "======================================"
echo "Base URL: $BASE_URL"
echo ""

# Test 1: Health check (should always work)
echo "1. Health check..."
curl -s "$BASE_URL/health" | jq .
echo ""

# Test 2: OAuth discovery
echo "2. OAuth discovery..."
OAUTH_RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/.well-known/oauth-authorization-server")
OAUTH_BODY=$(echo "$OAUTH_RESPONSE" | head -n -1)
OAUTH_STATUS=$(echo "$OAUTH_RESPONSE" | tail -n 1)
echo "   Status: $OAUTH_STATUS"
echo "$OAUTH_BODY" | jq .
echo ""

# Test 3: MCP endpoint without auth
echo "3. MCP endpoint (no auth)..."
MCP_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}}')
MCP_BODY=$(echo "$MCP_RESPONSE" | head -n -1)
MCP_STATUS=$(echo "$MCP_RESPONSE" | tail -n 1)
echo "   Status: $MCP_STATUS"
echo "$MCP_BODY" | jq . 2>/dev/null || echo "$MCP_BODY"
echo ""

# Test 4: MCP endpoint with auth (if token provided)
if [ -n "$1" ]; then
  echo "4. MCP endpoint (with auth)..."
  MCP_AUTH_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $1" \
    -d '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}}')
  MCP_AUTH_BODY=$(echo "$MCP_AUTH_RESPONSE" | head -n -1)
  MCP_AUTH_STATUS=$(echo "$MCP_AUTH_RESPONSE" | tail -n 1)
  echo "   Status: $MCP_AUTH_STATUS"
  echo "$MCP_AUTH_BODY" | jq . 2>/dev/null || echo "$MCP_AUTH_BODY"
else
  echo "4. Skipping authenticated test (no token provided)"
  echo "   Usage: $0 <bearer-token>"
fi

echo ""
echo "Done!"
