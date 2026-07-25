---
name: backlog-sweep
description: >-
  Re-verify every open GitHub issue against the current codebase and fix what has
  gone stale. Use after an epic, breaking change, or wide refactor merges (those
  invalidate file/line references and premises in open issues), before planning a
  batch of backlog work, or when asked to triage the backlog. Covers verifying
  issue premises in code, updating bodies with dated triage footers, closing
  shipped work with evidence, and filing issues for gaps discovered on the way.
---

# Backlog sweep

Re-ground the issue backlog in the current code. Issues are written against a
snapshot of the repo; every epic, tool removal, or shell extraction that merges
afterwards silently invalidates file paths, line numbers, dependency notes, and
sometimes whole premises. This sweep finds and fixes that drift so the next
implementer isn't working from fiction.

Issues live in GitHub Issues and are triaged on the "gaggiuino-mcp backlog" Project
board (see CLAUDE.md "Backlog and issue tracking" for labels and board fields).

## When to run

- An epic, `feat!:` breaking change, or wide refactor just merged (the trigger
  that most reliably strands open issues).
- Before picking a batch of backlog work, so effort estimates rest on reality.
- On request ("triage the backlog", "is this issue still relevant?").

## Procedure

1. **Gather.** List all open issues, and skim recently closed ones — open issues
   cross-reference them ("coordinate with #N", "after #N lands"), and whether #N
   closed as *completed* or *not planned* changes what the open issue should say.
   Note recent merged PRs / releases since the last sweep for context.

2. **Verify each open issue against the code, not from memory.** For every claim,
   grep or read the referenced file:
   - File paths and line numbers ("`index.ts:256`", "in `main.tsx`") — refactors
     move code; shared extractions relocate it to another package entirely.
   - Existence claims ("no X exists", "nothing handles Y") — the gap may have
     been closed by an unrelated PR.
   - Dependency framing ("once #N lands", "blocked on #N") — the dependency may
     have shipped (issue is now unblocked) or been closed not-planned (the
     coordination point no longer exists).
   - Data sources and APIs the issue builds on — tools/endpoints get removed
     (e.g. the v2.0 read-tool removal) and the issue must point at what remains.
   - Scope drift — a feature that shipped since filing may have changed what the
     issue needs to cover (e.g. a new default view widening an a11y issue).

3. **Fix what's stale.**
   - **Update the body in place**, preserving the author's intent and structure,
     and append a dated footer explaining the change:
     `_Triage YYYY-MM-DD: <what changed and why>._` The footer is the audit
     trail; never silently rewrite someone else's issue.
   - **Round-trip caution:** issue bodies fetched via API tooling may come back
     HTML-entity-encoded (`&#34;`, `&#39;`) or truncated at inline HTML tags.
     Decode entities before re-writing. If the full original body cannot be read
     back faithfully, do **not** update it — leave a comment instead.
   - **Close only with evidence.** Fully-delivered work closes as *completed*
     with a link to the PR/commit that shipped it. Obsolete work closes as
     *not planned* with a short rationale (see #25 for the shape). When in
     doubt, update rather than close.

4. **File issues for gaps found along the way.** Sweeps surface real gaps —
   docs drift is the classic (README vs CLAUDE.md tool tables after a feature
   PR). File them with `type:*` / `area:*` labels; new issues auto-add to the
   board's Backlog column. Reference the PR that introduced the gap.

5. **Report and re-prioritise.** Summarize per issue: confirmed-fresh (with
   what was checked), updated (what changed), closed (with evidence), newly
   filed. The Project board's Status/Priority/Effort fields **are** writable by
   agents, so apply re-prioritisation (e.g. a newly unblocked issue) directly.
   Two paths, by session type:

   - **Local sessions** (gh CLI with `project` scope):
     `gh project item-edit --project-id PVT_kwHOABzAhM4BeYXa --id <item-id>
     --field-id <field-id> --single-select-option-id <option-id>`. Discover
     item/field/option ids with `gh project item-list 2 --owner ljcl --format
     json` and `gh project field-list 2 --owner ljcl --format json`.
   - **Cloud/iOS sessions** (no gh): the `github-projects` MCP server from
     `.mcp.json` (hosted GitHub MCP, projects toolset, auth via the
     `GH_MCP_PAT` env var in the cloud environment config). Hosted-build
     caveats: pass numeric field ids via the `fields` param
     (`field_names` is not deployed yet), and `update_project_item` needs the
     numeric `item_id` plus the option **id** (not name) for single-select
     values. Ids are discoverable at runtime via `list_project_fields`.

   Constants for this board: project number 2, owner `ljcl`, node id
   `PVT_kwHOABzAhM4BeYXa`, database id 24741338; field ids: Status
   (node `PVTSSF_lAHOABzAhM4BeYXazhYzCy0`, numeric 372443949), Priority
   (node `PVTSSF_lAHOABzAhM4BeYXazhYzCzg`, numeric 372443960), Effort
   (node `PVTSSF_lAHOABzAhM4BeYXazhYzCzk`, numeric 372443961); Status options:
   Backlog f75ad846, Ready a057814c, In progress 47fc9ee4, In review 2ba31d84,
   Done 98236657; Priority options: P1 fc38b480, P2 d2ef2472, P3 5197fbf4;
   Effort options: S ed6278ac, M c5c30106, L 7270adf2.

## Conventions

- One dated triage footer per sweep per issue; a later sweep appends its own.
- Keep acceptance criteria checkable — if a criterion shipped independently,
  tick or remove it in the update rather than leaving it ambiguous.
- Nothing in a sweep changes code. If a fix is trivial, still file the issue —
  the board is the record; a drive-by commit inside a triage session isn't.
