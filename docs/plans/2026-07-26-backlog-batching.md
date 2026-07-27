# Backlog batching — 2026-07-26

All 36 open issues grouped into 11 batches by **shared edit surface** and **hard ordering
constraints**, so a batch is one reviewer's context and usually one to three PRs.

The grouping criterion is not topical similarity. Two issues belong together when working them
separately means *editing the same block twice*, or when one issue's acceptance criteria cannot be
verified until another has landed. Batches that are merely thematic are called out as such.

Each batch is tracked by an `epic`-labelled issue (#52–#62) with its members attached as GitHub
sub-issues, so the hierarchy and progress roll up natively on the board.

Board fields (Priority, Effort, Status) live on the
[gaggiuino-mcp backlog](https://github.com/users/ljcl/projects/2) project, not on labels. The epic
Priority/Effort below is **already applied to the board** — it is a record, not a suggestion.

Those values are rolled up **from the children's own triage**, not invented: Priority is the most
urgent child (P1 beats P2 beats P3); Effort is the sum of child efforts (S=1, M=2, L=3) bucketed at
<=2 S, 3-5 M, >=6 L. All 36 child issues were already triaged by hand and were deliberately **not**
touched — their per-issue values are finer-grained than any batch rollup and stay authoritative.
`scripts/backlog-board-sync.sh` reproduces the epic values, as a fallback for sessions that cannot
reach the Projects API.

| Batch | Epic | Members | Priority | Effort |
| --- | --- | --- | --- | --- |
| 1 Typed tool contract | #52 | #20 #21 #23 #24 #31 | P1 | L |
| 2 Runtime hardening | #53 | #18 #22 #19 #25 #26 | P1 | L |
| 3 Upstream data layer | #54 | #30 #27 #28 #29 | P2 | L |
| 4 Prompts and resources | #55 | #32 #33 | P3 | S |
| 5 Design tokens | #56 | #42 #34 | P1 | S |
| 6 App shell | #57 | #44 #35 #40 | P1 | L |
| 7 Chart rendering | #58 | #41 #39 | P2 | M |
| 8 Accessibility | #59 | #36 #37 | P1 | M |
| 9 Test and coverage | #60 | #10 #43 | P3 | M |
| 10 CI and supply chain | #61 | #17 #49 #45 #46 #50 #38 | P2 | L |
| 11 Docs and hygiene | #62 | #47 #48 #51 | P2 | M |

---

## Batch 1 — Typed tool contract

**#20, #21, #23, #24, #31** · area:server · P1 · L

Every one of these rewrites the same two regions of `apps/server/src/server.ts`: the `TOOLS`
table (`:45-134`) and the `handleToolCall` dispatch wrapper (`:285-308`).

- #20 replaces hand-written JSON Schema with zod-derived input schemas — rewrites `TOOLS`
- #23 adds `outputSchema` + `structuredContent` — rewrites the same `TOOLS` entries and the
  wrapper's return shape
- #24 adds `annotations` and `title` — rewrites the same `TOOLS` entries again
- #21 turns 404s and malformed payloads into actionable results — the same wrapper's error path
- #31 is the protocol-level test that covers all four, and today `createServer` has zero coverage

Worked separately this is four passes over one 90-line block with three merge conflicts. Worked
together it is one schema refactor.

**Order:** #20 → #21 → #23 → #24 → #31.
#20 first because the zod schemas it introduces are what #23 mirrors on the output side.

---

## Batch 2 — Runtime hardening and operability

**#18, #22, #19, #25, #26** · area:server · P1 · L

All five concentrate on `apps/server/src/index.ts` and the transport construction, and together
they are the "safe to expose over a tunnel" story.

- #18 bumps `@modelcontextprotocol/sdk` to clear the hono / path-to-regexp advisories. It goes
  first because #19 needs the SDK's `enableDnsRebindingProtection` / `allowedHosts` options and
  #25 depends on transport lifecycle behaviour — bumping after either means re-verifying both.
- #22 fixes the hardcoded handshake version, and #26 wants that same version in its JSON
  `/health` payload. #26's body already defers to #22. One source of truth, done once.
- #19 (bearer auth, origin validation) and #25 (session cap, idle TTL, SIGTERM drain) both edit
  the fetch handler and the transport map — `index.ts:10`, `:41`, `:53-57`, `:78-94`, `:100`.

**Deadline note:** #18 is time-boxed by something outside our control. The weekly scheduled
`bun audit --audit-level=high` hard-fails (`ci.yml:8-9`, `:140`), so `main` goes red on the next
Wednesday cron whether or not anyone has picked this up.

**Order:** #18 → #22 → #19 → #25 → #26.

---

## Batch 3 — Upstream data layer and machine reads

**#30, #27, #28, #29** · area:server · P2 · L

All four are `apps/server/src/client.ts`. #30 rewrites the fetch plumbing itself (TTL+LRU cache,
retry 5xx-not-4xx, overall deadline); #27 and #28 add new endpoints that ride on that plumbing.
Adding endpoints first means writing them against a fetch path that is about to be replaced.

- #30 — cache immutable shots, stop the `view_shot_graph` double-fetch
- #27 — `list_recent_shots`, and give the app real ids instead of `main.tsx:126`'s `id - 1`
- #28 — read `/api/profiles/all` and `/api/settings` instead of trusting bundled YAML
- #29 — `select_profile`, **hard-blocked on #19** (Batch 2). It is the only write tool in the
  repo and must not ship before the endpoint is authenticated.

**Order:** #30 → #27 → #28, then #29 once Batch 2 has landed #19.

---

## Batch 4 — Prompts and resources surface

**#32, #33** · area:server · P3 · S

Both live in the ListPrompts / GetPrompt / ListResources handlers (`server.ts:310-398`).

#32 deletes the byte-identical duplicate of the dial-in guidance, makes prompt descriptions honor
`prompts.local.yaml`, and adds the missing ListResourceTemplates handler. #33 adds parameterized
workflow prompts on top. Writing new prompts into a surface #32 is about to restructure is the
wrong order.

**Order:** #32 → #33.

---

## Batch 5 — Design tokens and theming foundation

**#42, #34** · area:design-system · P1 · S

`packages/design-system/src/tokens.css` is the single file, and this batch is the prerequisite for
Batch 8.

- #42 collapses three hand-synced copies of the token values (`tokens.css`, the dead
  `tokens.ts` export, and a third literal in `stories/Tokens.stories.tsx`) into one source
- #34 retargets the dark block from `.dark` — a class nothing applies — to the `data-theme`
  attribute `useHostStyles` actually sets

These come before any palette work because the six `--chart-*` values live **inside** that dead
`.dark` block (`tokens.css:89-94`). Reworking those values while the selector never matches means
the dark half of the change cannot be verified in a real host at all, and Storybook's
hand-wrapped `.dark` decorator will happily show it passing.

**Order:** #42 → #34.

---

## Batch 6 — App shell and host capabilities

**#44, #35, #40** · area:mcp-app · P1 · L

This grouping is not inferred — #44's own body says to extract the shell "while tackling #35 and
#40". The fetch/error/retry state machine (#35) and the fullscreen toggle (#40) are the shell's
reason to exist; extracting an empty shell first and filling it twice is pure rework.

- #44 — move ~150 lines of host plumbing out of `main.tsx` into `packages/ui`
- #35 — check `result.isError`, surface the server's message, add retry and a slow-fetch state
- #40 — `requestDisplayMode`, `downloadFile` export, debounced `updateModelContext`

**Order:** one piece of work, #44 as the container.

---

## Batch 7 — Chart rendering and comparison overlay

**#41, #39** · area:mcp-app · P2 · M · *depends on Batch 5*

Both are the comparison overlay in `ShotGraph.tsx` / `ChartTooltip.tsx`.

- #41 — real labeled phase regions from `profile.phases` (dropping the `MIN_GAP=4` inference),
  optional temperature series, and comparison series styled by dash rather than `opacity={0.45}`
- #39 — tooltip units, zero values, and comparison series that currently get filtered out entirely

Sequencing after Batch 5 matters more than it looks: `strokeDasharray` is **already** in use for
target lines (`"3 3"` at `:134`, `:189`; `"4 3"` at `:242`, `:256`). #41's comparison dashes and
#36's colorblind-safe non-color encoding are competing for the same small vocabulary in one file.
Decide the dash language once, in Batch 5's token work, or the second issue to land will
re-open the first.

---

## Batch 8 — Accessibility

**#36, #37** · area:design-system, area:ui · P1 · M · *depends on Batches 5, 6, 7*

The two issues that together clear the bar for flipping `a11y.test` from `"todo"` to `"error"`.

- #36 — colorblind-safe series palette passing 3:1 in both themes, plus non-color encoding
- #37 — aria labels, `aria-pressed` on legend toggles, `:focus-visible`, `role="status"` and
  `prefers-reduced-motion` on Skeleton, chart title/desc, contrast on opacity-stacked text

Both dependencies are real. #36 needs Batch 5 (see above — the dark values are unverifiable
until the selector is fixed and the copies are collapsed). #37 touches Legend and Skeleton in
`packages/ui` plus the chrome in `main.tsx` that Batch 6 relocates into that same package —
doing the aria work first means doing it twice.

This is the one batch whose acceptance is a CI gate change, so it wants to be last.

---

## Batch 9 — Test and coverage honesty

**#10, #43** · area:server, area:mcp-app · P3 · M

Thematic rather than same-file, but they share a goal: make the coverage number mean something.

- #10 — remove the `*.local.yaml` foot-gun that lets a dev machine ratchet thresholds above what
  a clean CI checkout can ever reach (this already broke `main` once)
- #43 — the first unit tests under `packages/` at all, covering `normalize.ts`'s divide-by-ten
  scaling and timestamp-keyed merge, and wiring shot-graph into `turbo run test`

Independent of each other; batched because they are one reviewer's context.

---

## Batch 10 — CI, release and supply chain

**#17, #49, #45, #46, #50, #38** · area:ci-release, area:docker · P2 · L

All six are `.github/` config, each individually small. Two sub-threads:

*Publish path* — #17 (the GHCR wait polls unauthenticated, so a first publish always times out)
and #49 (no SBOM or provenance on the published manifests).

*Workflow rot* — #45 (Docker and pr-title checks were built as gates but never added to branch
protection), #46 (`build:storybook` misses `@gaggiuino/ui` in its task graph, so a ui-only merge
redeploys stale Pages), #50 (Dependabot does not watch the composite action's pins), #38 (no
bundle size budget on the 1MB app.html).

**Owner action required:** #17 cannot be fully closed from CI. GitHub exposes no REST endpoint for
package visibility — someone has to flip
`https://github.com/users/ljcl/packages/container/gaggiuino-mcp/settings` to Public by hand, then
re-run the failed `publish-mcp.yml` for `v1.0.1`.

---

## Batch 11 — Docs and repo hygiene

**#47, #48, #51** · area:repo · P2 · M

No code. One PR, mechanical.

- #47 — purge "later phase" and "cannot succeed yet" claims from AGENTS.md/CLAUDE.md. Worth
  doing early and cheaply: the `:330-333` text actively instructs agents to dismiss real Pages
  deploy failures as expected, which makes Batch 10's #46 harder to see.
- #48 — README still clones `your-username/gaggiuino-mcp` and documents a Storybook script that
  does not exist
- #51 — Bun version skew between `packageManager` and the Docker base, `.env.local` unignored,
  unnamed LICENSE holder

---

## Ordering across batches

```
11 (docs)  ──────────────────────────────── independent, do anytime
10 (CI)    ──────────────────────────────── independent
 9 (tests) ──────────────────────────────── independent

 2 (hardening) ──┬──> 3 (data layer, #29 gated on #19)
                 └──> 1 (tool contract)          [#18's SDK bump first]

 4 (prompts)   ──────────────────────────── independent of 1-3

 5 (tokens) ──┬──> 7 (chart) ──┐
              └───────────────┬┴──> 8 (a11y, gate flip)
 6 (shell) ──────────────────┘
```

Only three hard blocks exist; everything else is a "cheaper this way" ordering:

| Blocked | Blocked by | Why |
| --- | --- | --- |
| #29 | #19 | A write tool over an unauthenticated tunnel |
| #36 | #34 | Dark palette is unverifiable while the selector is dead |
| #37 | #44 | Aria work lands on chrome that #44 relocates |

## Suggested start order

1. **#18** — the only issue with an external deadline (weekly cron goes red)
2. **Batch 11** — cheap, and #47 removes doc text that misleads agents about #46
3. **Batch 2** then **Batch 1** — the exposure story, then the contract that rides on it
4. **Batch 5 → 6 → 7 → 8** — the frontend chain, in that order
