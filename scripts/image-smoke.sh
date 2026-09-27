#!/usr/bin/env bash
# Start a built image and check it serves what a host needs, before anything
# tags it. docker.yml runs this on every build leg; locally:
#
#   docker compose -f docker-compose.yml -f docker-compose.build.yml build
#   scripts/image-smoke.sh ghcr.io/ljcl/gaggiuino-mcp:dev
#
# The port is published rather than relying on the image's host networking, so
# this works on a Mac (where network_mode: host does not reach the host) as well
# as on a runner. Needs docker, curl and jq; runs no project code.
#
# What each check stands for, since every one of them has been verified only by
# hand before:
#   - healthy:        the HEALTHCHECK itself works, and the process starts at all
#                     under the runner's COPY set and .dockerignore.
#   - /health:        the HTTP server answers.
#   - server/discover: the MCP handler is mounted and serves the 2026-07-28
#                     revision.
#   - tools/list:     the advertised tools are exactly tool-contract.json's —
#                     a module missing from the image fails the import, not this
#                     comparison, but a wrong build would show up here.
#   - resources/read: the shot-graph bundle reached the image; the dist/ COPY is
#                     the one line a green build cannot vouch for.
set -euo pipefail

image="${1:?usage: image-smoke.sh IMAGE}"
port="${SMOKE_PORT:-18000}"
name="gaggiuino-mcp-smoke-$$"
# Override when the script runs from elsewhere than the checkout it tests
# (docker.yml's backfill builds an old tag with this script from main).
contract="${TOOL_CONTRACT:-$(cd "$(dirname "$0")/.." && pwd)/apps/server/src/tool-contract.json}"

fail() {
  echo "::error::image smoke test: $*" >&2
  exit 1
}

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- container logs ---" >&2
    docker logs "$name" >&2 2>&1 || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$name" -p "127.0.0.1:$port:8000" \
  --health-interval=2s --health-start-period=0s "$image" >/dev/null

health=starting
for _ in $(seq 1 30); do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$name")"
  case "$health" in
    healthy) break ;;
    unhealthy) fail "container reported unhealthy" ;;
  esac
  if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]; then
    fail "container exited"
  fi
  sleep 2
done
[ "$health" = healthy ] || fail "container not healthy after 60s (last: $health)"
echo "ok  container is healthy"

base="http://127.0.0.1:$port"
curl -fsS "$base/health" | jq -e '.status == "ok"' >/dev/null ||
  fail "/health did not report status ok"
echo "ok  /health"

meta='{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"image-smoke","version":"1"}}'

# mcp METHOD PARAMS [NAME] -> the JSON-RPC response body
mcp() {
  local method="$1" params="$2" name="${3:-}"
  local headers=(
    -H "Content-Type: application/json"
    -H "Accept: application/json, text/event-stream"
    -H "MCP-Protocol-Version: 2026-07-28"
    -H "Mcp-Method: $method"
  )
  [ -n "$name" ] && headers+=(-H "Mcp-Name: $name")
  curl -fsS -X POST "$base/mcp" "${headers[@]}" \
    -d "$(jq -cn --arg m "$method" --argjson p "$params" --argjson meta "$meta" \
      '{jsonrpc: "2.0", id: 1, method: $m, params: ($p + {_meta: $meta})}')"
}

mcp server/discover '{}' |
  jq -e '(.result.supportedVersions | index("2026-07-28")) and .result.capabilities.tools' >/dev/null ||
  fail "server/discover did not advertise 2026-07-28 with tools"
echo "ok  server/discover"

want="$(jq -r '[.[].name] | sort | join(",")' "$contract")"
have="$(mcp tools/list '{}' | jq -r '[.result.tools[].name] | sort | join(",")')"
[ "$have" = "$want" ] || fail "tools/list does not match tool-contract.json
  want: $want
  have: $have"
echo "ok  tools/list matches tool-contract.json ($(jq length "$contract") tools)"

uri="ui://shot-graph/app.html"
mcp resources/read "{\"uri\":\"$uri\"}" "$uri" |
  jq -e '.result.contents[0].text | length > 100000 and test("<html"; "i")' >/dev/null ||
  fail "resources/read $uri returned no app bundle"
echo "ok  resources/read $uri"
