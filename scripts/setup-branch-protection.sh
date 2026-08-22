#!/usr/bin/env bash
# Apply branch protection and repo settings for gaggiuino-mcp.
# Safe to re-run. Requires: gh authenticated with admin on the repo, repo already public,
# and the required status contexts below to have run at least once (so they exist).
#
# Required contexts and what each one stops from merging:
#   check     ci.yml        lint, test, typecheck, build, knip, boundaries
#   docker    docker.yml    a PR that breaks the image build
#   pr-title  pr-title.yml  a non-Conventional-Commit PR title, which squashes
#                           onto main as an unparseable subject and silently
#                           skips the release
set -euo pipefail

REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
echo "Configuring: ${REPO}"

# 1. Enable repo-level auto-merge (required for the Dependabot auto-merge workflow).
gh api -X PATCH "repos/${REPO}" -F allow_auto_merge=true >/dev/null
echo "  - auto-merge enabled"

# 2. Pin squash-merge commit titles to the PR title. release-please parses the
#    squashed commit subject; anything else silently skips releases.
gh api -X PATCH "repos/${REPO}" \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY >/dev/null
echo "  - squash merge pinned to PR_TITLE"

# 3. Set GitHub Pages build source to GitHub Actions (idempotent; ignore if already set).
gh api -X POST "repos/${REPO}/pages" -f build_type=workflow >/dev/null 2>&1 ||
  gh api -X PUT "repos/${REPO}/pages" -f build_type=workflow >/dev/null 2>&1 ||
  echo "  - Pages: already configured or needs manual enable in Settings > Pages"

# 4. Branch protection on main.
#    - require the "check", "docker" and "pr-title" statuses to pass (strict / up to date)
#    - require a PR before merging, 0 approvals (solo maintainer can self-merge)
#    - block force pushes and deletions; require conversation resolution
gh api -X PUT "repos/${REPO}/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - >/dev/null <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["check", "docker", "pr-title"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
echo "  - branch protection applied to main"

echo "Done. Verify: gh api repos/${REPO}/branches/main/protection --jq '.required_status_checks'"
