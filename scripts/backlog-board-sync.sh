#!/usr/bin/env bash
# Apply the 2026-07-26 backlog batching to the "gaggiuino-mcp backlog" project board.
#
# Adds the eleven epic issues to the board and sets their Status / Priority / Effort.
# Safe to re-run: `gh project item-add` returns the existing item when one is already
# on the board, and every field write is a set-to-this-value, not a toggle.
#
# Board fields live in Projects v2, which is GraphQL-only. This script exists as the
# local fallback for when an agent session cannot reach api.githubcopilot.com; the
# values below were applied to the board on 2026-07-27 and this reproduces them.
#
# Requires: gh authenticated with `project` scope
#           (gh auth refresh -s project -h github.com)
#
# Usage:
#   scripts/backlog-board-sync.sh            # apply
#   scripts/backlog-board-sync.sh --dry-run  # print what would change
#
# EPICS ONLY, deliberately. All 36 child issues were already triaged by hand
# (verified against the board on 2026-07-27) and their per-issue Priority/Effort
# is better than any batch-level rollup. There is no --children flag: its only
# possible effect would be to destroy that triage.
#
# The values below are rolled up FROM the children, not invented:
#   Priority = the most urgent child (P1 beats P2 beats P3)
#   Effort   = sum of child efforts (S=1, M=2, L=3) -> <=2 S, 3-5 M, >=6 L
# If child triage changes, re-derive rather than hand-editing these.

set -euo pipefail

OWNER="ljcl"
REPO="ljcl/gaggiuino-mcp"
PROJECT_NUMBER=2
PROJECT_ID="PVT_kwHOABzAhM4BeYXa"

FIELD_STATUS="PVTSSF_lAHOABzAhM4BeYXazhYzCy0"
FIELD_PRIORITY="PVTSSF_lAHOABzAhM4BeYXazhYzCzg"
FIELD_EFFORT="PVTSSF_lAHOABzAhM4BeYXazhYzCzk"

STATUS_BACKLOG="f75ad846"

# Single-select option ids, looked up via case rather than an associative array:
# macOS still ships bash 3.2, where `declare -A` does not exist and `([P1]=x)` is
# parsed as an arithmetic index, so `set -u` aborts on the unset variable P1.
# Keep this script bash-3.2 clean — do not reintroduce `declare -A`.
priority_option() {
  case "$1" in
    P1) echo "fc38b480" ;;
    P2) echo "d2ef2472" ;;
    P3) echo "5197fbf4" ;;
    *)  echo "" ;;
  esac
}

effort_option() {
  case "$1" in
    S) echo "ed6278ac" ;;
    M) echo "c5c30106" ;;
    L) echo "7270adf2" ;;
    *) echo "" ;;
  esac
}

# epic-number : priority : effort : label
BATCHES=(
  "52:P1:L:typed tool contract"
  "53:P1:L:runtime hardening and operability"
  "54:P2:L:upstream data layer and machine reads"
  "55:P3:S:prompts and resources surface"
  "56:P1:S:design tokens and theming foundation"
  "57:P1:L:app shell and host capabilities"
  "58:P2:M:chart rendering and comparison overlay"
  "59:P1:M:accessibility to the story-gate flip"
  "60:P3:M:test and coverage honesty"
  "61:P2:L:CI, release and supply chain"
  "62:P2:M:docs and repo hygiene"
)

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
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
  local pri_opt eff_opt
  pri_opt="$(priority_option "$priority")"
  eff_opt="$(effort_option "$effort")"
  if [ -z "$pri_opt" ] || [ -z "$eff_opt" ]; then
    echo "bad field mapping for #${number}: priority='${priority}' effort='${effort}'" >&2
    exit 1
  fi
  echo "  #${number} ${label} -> Priority ${priority}, Effort ${effort}"
  resolve_item "$number"
  set_field "$ITEM_ID" "$FIELD_PRIORITY" "$pri_opt"
  set_field "$ITEM_ID" "$FIELD_EFFORT" "$eff_opt"
}

echo "Syncing backlog batching to project ${PROJECT_NUMBER} (${OWNER})"
$DRY_RUN && echo "(dry run — nothing will be written)"
echo

for batch in "${BATCHES[@]}"; do
  IFS=":" read -r epic priority effort label <<<"$batch"

  echo "Epic #${epic} — ${label}"
  apply "$epic" "$priority" "$effort" "(epic)"
  # Epics start in Backlog; children keep whatever status they already have.
  set_field "$ITEM_ID" "$FIELD_STATUS" "$STATUS_BACKLOG"

  echo
done

echo "Done."
echo
echo "Not handled here — Projects v2 has no API for either:"
echo "  * the GHCR package visibility flip that #17 needs"
echo "    https://github.com/users/${OWNER}/packages/container/gaggiuino-mcp/settings"
echo "  * cross-epic ordering; see docs/plans/2026-07-26-backlog-batching.md"
