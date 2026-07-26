#!/usr/bin/env bash
# Apply the 2026-07-26 backlog batching to the "gaggiuino-mcp backlog" project board.
#
# Adds the eleven epic issues to the board and sets their Status / Priority / Effort.
# Safe to re-run: `gh project item-add` returns the existing item when one is already
# on the board, and every field write is a set-to-this-value, not a toggle.
#
# Board fields live in Projects v2, which is GraphQL-only — the cloud Claude Code
# session that authored this batching could not reach it, hence this script.
#
# Requires: gh authenticated with `project` scope
#           (gh auth refresh -s project -h github.com)
#
# Usage:
#   scripts/backlog-board-sync.sh              # epics only (default)
#   scripts/backlog-board-sync.sh --children   # also stamp each epic's children
#   scripts/backlog-board-sync.sh --dry-run    # print what would change
#
# --children OVERWRITES any Priority/Effort already triaged on the 36 child issues.
# It is off by default for exactly that reason. Look at the board first.

set -euo pipefail

OWNER="ljcl"
REPO="ljcl/gaggiuino-mcp"
PROJECT_NUMBER=2
PROJECT_ID="PVT_kwHOABzAhM4BeYXa"

FIELD_STATUS="PVTSSF_lAHOABzAhM4BeYXazhYzCy0"
FIELD_PRIORITY="PVTSSF_lAHOABzAhM4BeYXazhYzCzg"
FIELD_EFFORT="PVTSSF_lAHOABzAhM4BeYXazhYzCzk"

STATUS_BACKLOG="f75ad846"
declare -A PRIORITY=([P1]=fc38b480 [P2]=d2ef2472 [P3]=5197fbf4)
declare -A EFFORT=([S]=ed6278ac [M]=c5c30106 [L]=7270adf2)

# epic-number : priority : effort : child issue numbers
BATCHES=(
  "52:P1:L:20 21 23 24 31"   # typed tool contract
  "53:P1:L:18 22 19 25 26"   # runtime hardening and operability
  "54:P2:L:30 27 28 29"      # upstream data layer and machine reads
  "55:P3:M:32 33"            # prompts and resources surface
  "56:P2:M:42 34"            # design tokens and theming foundation
  "57:P2:L:44 35 40"         # app shell and host capabilities
  "58:P2:M:41 39"            # chart rendering and comparison overlay
  "59:P2:L:36 37"            # accessibility to the story-gate flip
  "60:P3:M:10 43"            # test and coverage honesty
  "61:P2:M:17 49 45 46 50 38" # CI, release and supply chain
  "62:P3:S:47 48 51"         # docs and repo hygiene
)

DRY_RUN=false
WITH_CHILDREN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --children) WITH_CHILDREN=true ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

run() {
  if $DRY_RUN; then
    echo "    would: $*"
  else
    "$@" >/dev/null
  fi
}

# Add an issue to the board (or find its existing item). Sets ITEM_ID rather than
# echoing it — the progress output below would otherwise be captured along with it.
ITEM_ID=""
resolve_item() {
  local number="$1"
  if $DRY_RUN; then
    ITEM_ID="DRYRUN_ITEM_${number}"
    echo "    would: gh project item-add ${PROJECT_NUMBER} --url .../issues/${number}"
    return
  fi
  ITEM_ID="$(gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" \
    --url "https://github.com/${REPO}/issues/${number}" \
    --format json --jq '.id')"
}

set_field() {
  local item_id="$1" field_id="$2" option_id="$3"
  run gh project item-edit \
    --id "$item_id" \
    --project-id "$PROJECT_ID" \
    --field-id "$field_id" \
    --single-select-option-id "$option_id"
}

# Adds the issue to the board and stamps Priority + Effort. Leaves ITEM_ID set so
# the caller can apply further fields (Status, on epics).
apply() {
  local number="$1" priority="$2" effort="$3" label="$4"
  echo "  #${number} ${label} -> Priority ${priority}, Effort ${effort}"
  resolve_item "$number"
  set_field "$ITEM_ID" "$FIELD_PRIORITY" "${PRIORITY[$priority]}"
  set_field "$ITEM_ID" "$FIELD_EFFORT" "${EFFORT[$effort]}"
}

echo "Syncing backlog batching to project ${PROJECT_NUMBER} (${OWNER})"
$DRY_RUN && echo "(dry run — nothing will be written)"
$WITH_CHILDREN && echo "(--children: child Priority/Effort will be OVERWRITTEN)"
echo

for batch in "${BATCHES[@]}"; do
  IFS=":" read -r epic priority effort children <<<"$batch"

  echo "Epic #${epic}"
  apply "$epic" "$priority" "$effort" "(epic)"
  # Epics start in Backlog; children keep whatever status they already have.
  set_field "$ITEM_ID" "$FIELD_STATUS" "$STATUS_BACKLOG"

  if $WITH_CHILDREN; then
    for child in $children; do
      apply "$child" "$priority" "$effort" "(child of #${epic})"
    done
  fi
  echo
done

echo "Done."
echo
echo "Not handled here — Projects v2 has no API for either:"
echo "  * the GHCR package visibility flip that #17 needs"
echo "    https://github.com/users/${OWNER}/packages/container/gaggiuino-mcp/settings"
echo "  * cross-epic ordering; see docs/plans/2026-07-26-backlog-batching.md"
