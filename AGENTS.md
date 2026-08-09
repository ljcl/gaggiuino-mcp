# Gaggiuino MCP Server

Remote MCP server for integrating a Gaggiuino espresso machine with AI tools.

## Architecture

- **Runtime**: Bun (TypeScript)
- **Transport**: Streamable HTTP on port 8000 (`/mcp` endpoint)
- **Deployment**: Docker container (any Docker host), exposed via HTTPS tunnel or reverse proxy
- **Monorepo**: Bun workspaces with Turborepo (`apps/*` + `packages/*`)

## Key Directories

- `apps/server/` - MCP server (tools, prompts, resources, client)
- `apps/storybook/` - Standalone Storybook app, serves stories from all packages
- `packages/shot-graph/` - React + Recharts MCP App for interactive shot graphs
- `packages/ui/` - Shared MCP app shell: host plumbing (`src/host/`) plus presentational components (AppShell, ErrorState, ToolbarButton, Legend, Skeleton, Tooltip)
- `packages/design-system/` - Shared design tokens, components, and host theme presets
- `packages/vite-config/` - Shared Vite config helpers for MCP Apps
- `packages/tsconfig/` - Shared TypeScript configurations
- `apps/server/src/data/profiles.yaml` - YAML profile documentation (not machine profiles)
- `apps/server/src/data/prompts.yaml` - System prompt for espresso dial-in guidance
- `apps/server/src/data/*.example-local.yaml` - Templates for user-specific overrides (copy to `*.local.yaml`)
- `docs/plans/` - Design docs and implementation plans
- `docs/upstream/` - Verbatim vendored copies of the Gaggiuino project's own API
  reference (`rest-api.md`, `websocket.md`, `MQTT.md`), plus the errata that
  corrects them

### The vendored reference, and its errata

`docs/upstream/` exists so `client.ts` can cite a stable path with line numbers
that do not move under it. Its README states the posture: **these documents
settle *existence* questions, not *shape* questions** — they are hand-written
and disagree with themselves about types.

Two rules govern it.

- **Never edit the vendored files.** Their value is that a refresh produces a
  reviewable diff, and every citation in `client.ts` is a line reference into
  them. Corrections go in the README's **Errata** section, or in `client.ts`'s
  not-called block when what is being prevented is a bad tool rather than a
  misreading.
- **Say where a correction came from.** The errata's current entries are drawn
  from a second, independently written implementation of the same protocols
  rather than from this repo's hardware, and the README says so at the top of
  the section. That is strong evidence about behaviour and it is not a
  specification; where the two disagree, hardware wins.

The entry most likely to matter later is that `websocket.md` claims three times
(L226, L299, L358) that **every** `c_*` command is acknowledged by `d_resp`, and
the profile commands answer with a data push instead. Profile *update* and
*delete* are WebSocket-only — there is no REST verb for either — so the next
person to design a WS write path is exactly the reader that claim would mislead.

## Agent Skills

Project-scoped Agent Skills are vendored under `.agents/skills/` and surfaced to Claude Code
via symlinks in `.claude/skills/`. Externally-sourced skills are tracked in `skills-lock.json`
(source + content hash); locally-authored skills are not locked.

- `mcp-authoring` — locally-authored, framework-neutral guidance for building and reviewing MCP
  servers and apps (primitives, tool schema design, MCP App UI, testing). Use it when changing
  server tools, resources, or the shot-graph MCP App.
- `backlog-sweep` — locally-authored procedure for re-verifying open GitHub issues against the
  current code and fixing drift. Run it after an epic, breaking change, or wide refactor merges.
- `bun` — Bun runtime, package manager, test runner, and bundler usage (well-known source).
- `github-actions-docs` — docs-grounded help for authoring GitHub Actions workflows (GitHub
  source). `.github/workflows/ci.yml` runs CI on every PR and main push, and the release and
  publish workflows (`release-please.yml`, `docker.yml`, `publish-mcp.yml`, `storybook.yml`)
  are all live — see CI and Releases below.

## MCP Tools

| Tool                    | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `get_status`            | Machine status (temp, pressure, weight)             |
| `get_latest_shot_id`    | Most recent shot: id **and** its outcome metrics    |
| `list_recent_shots`     | Bounded walk back through history, summaries only   |
| `get_shot_data`         | Structured shot summary (default for analysis)      |
| `get_shot_raw_data`     | Complete time-series datapoints                     |
| `view_shot_graph`       | Interactive chart (MCP App with UI resource)        |
| `list_profiles`         | Machine's profiles, merged with bundled docs        |
| `get_profile_info`      | One profile: the machine's own definition plus docs |
| `get_machine_settings`  | Boiler/steam/scale config as the firmware sends it  |
| `get_maintenance_status`| Descale/backflush service log the machine keeps itself |
| `select_profile`        | **Write.** Switch profile; needs OAuth configured   |
| `upload_profile`        | **Write, not idempotent.** Save a new profile; needs OAuth configured |
| `delete_profile`        | **Write, destructive, irreversible.** Needs the exact name too |
| `get_dial_in_guidance`  | Expert dial-in system prompt                        |

App-only (`visibility: ["app"]`, not advertised to the model): `get_shot_raw_json`
and `get_previous_shot_json`.

### The tool contract

`apps/server/src/tools.ts` holds one `defineTool(...)` entry per tool: zod input
schema, optional zod output schema, `title`, cold-model `description`,
annotations, and the handler. Nothing about a tool is declared twice.

- **Advertised schemas are generated, never hand-written.** `server.ts`'s
  `toJsonSchema` runs `z.toJSONSchema` over the same schema the dispatcher
  enforces — input schemas in `io: "input"` mode, output schemas in
  `io: "output"` mode. Do not add a literal JSON Schema to a tool.
- **`handleToolCall` is the only dispatch point.** It `safeParse`s the input
  before the handler runs, so handlers receive typed arguments and there are no
  `as string` casts. Invalid input returns an `isError` result naming the field.
- **Output schemas are enforced on the way out.** When a tool declares one, the
  handler's `structured` payload is `.parse()`d before it becomes
  `structuredContent`, so a handler that drifts from its schema fails loudly
  instead of shipping something the host will reject. `get_status`,
  `get_latest_shot_id`, `list_recent_shots`, `get_shot_data`, `list_profiles`,
  `get_profile_info`, `get_maintenance_status`, and `upload_profile` carry
  output schemas; the
  raw/UI/prose tools are text-only by design. `get_shot_raw_json` and
  `get_previous_shot_json` in particular must keep returning a JSON **text**
  block — the shot-graph app parses both with `readToolJson`
  (`packages/ui/src/host/toolResult.ts`).
  `get_machine_settings` is text-only *deliberately*: which knobs a firmware
  build exposes is its own decision, and a schema modelling the known ones would
  drop the field a user asking about a new setting is asking about.
  `get_maintenance_status` looks like the same case and is not, which is the
  distinction worth keeping: `maintenance.ts` derives the *list* of services
  from whatever `last<Service>Timestamp` keys arrived, so the schema describes
  the shape of one service record rather than enumerating the two that exist
  today. A firmware that starts logging water-filter changes is carried through
  with no schema change. Enumerate the services and it becomes the settings
  case, and the schema starts dropping things.
- **Annotations are honest, not decorative.** Every tool but three is
  `readOnlyHint: true`. `select_profile`, `upload_profile` and `delete_profile`
  carry `readOnlyHint: false`, because that flag is what a host keys an approval
  prompt on — claiming otherwise to dodge the prompt is the dishonest annotation
  the tests exist to catch. The other two flags separate the three writes from
  each other, and each distinction is load-bearing:

  - `upload_profile` is the only tool with `idempotentHint: false`.
    `POST /api/profile` mints a fresh id on every call, so a retried upload
    leaves a duplicate behind, and `idempotentHint` is what a host would key an
    automatic retry on. `destructiveHint: false` still holds for it — a create
    is additive, and REST offers no update or overwrite verb at all.
  - `delete_profile` is the only tool with `destructiveHint: true`, and the only
    one that **states no `idempotentHint` at all**. Absent is a third answer, not
    a synonym for `false`: deleting twice reaching the same end state depends on
    whether ids survive a delete, and the reference says nothing either way
    (rest-api.md L41-44 is three lines with no response body and no status
    codes). Claiming `true` invites a retry that could remove a *different*
    profile; claiming `false` asserts a non-idempotence nobody has observed.
    `server.test.ts` therefore checks three states, with `IDEMPOTENCE_UNSTATED`
    beside the other sets — a tool losing the hint by accident still fails.

  `openWorldHint` is true for every tool that reaches the machine and false for
  `get_dial_in_guidance`, now the only one that reads bundled YAML and nothing
  else — `list_profiles` and `get_profile_info` flipped to open-world when they
  started reading the machine's own inventory. `server.test.ts` names the write
  tools in a set rather than deriving them from the annotations under test, so a
  new write tool is a deliberate edit and a read tool that quietly loses
  `readOnlyHint` fails; `NON_IDEMPOTENT_TOOLS`, `IDEMPOTENCE_UNSTATED`,
  `DESTRUCTIVE_TOOLS` and `ALWAYS_PROMPT_TOOLS` sit beside it for the same
  reason. `http.test.ts` re-asserts all of it over the real transport, since
  `annotations` and `_meta` are exactly what a transport is free to drop — and it
  keeps its own copies on purpose, so one edit cannot satisfy both files.
- **Expected failures are results, not exceptions.** `errors.ts` defines the
  three upstream failure classes (`UpstreamUnreachableError`,
  `UpstreamHttpError`, `MalformedUpstreamError`) and `describeUpstreamError`
  turns each into text the model can act on — a 404 on a shot points at
  `get_latest_shot_id` by name. Only genuine bugs are allowed to throw.
- **Upstream payloads are validated at the client boundary.** `client.ts`
  parses every machine response with zod. The schemas are deliberately loose
  (unknown keys preserved, only crash-critical fields required) so a firmware
  revision cannot take the server down, but an empty array or a truncated body
  now fails with the offending path named instead of surfacing as
  `Cannot read properties of undefined` several modules later.

`resetClient(config?)` in `client.ts` is a labelled test seam: it drops the
cached client and applies the config to the next one, which is how tests
exercise the retry path without waiting out the real backoff.

### The upstream is one ESP32 on Wi-Fi

Three rules in `client.ts` follow from that, and each replaced something that
looked reasonable in isolation.

- **Immutable things are cached; live readings are not.** `cache.ts` is a
  bounded TTL+LRU store with an injected clock. Completed shots get ten
  minutes — the machine writes a shot record once and never revises it — and
  `/api/shots/latest` gets five seconds, enough to fold the burst one question
  makes without pinning a stale id. `/api/system/status` is deliberately
  uncached: every value it reports is instantaneous and its own description
  promises the caller a fresh reading. Rendering one graph used to fetch the
  same shot twice (tool summary, then the app's `get_shot_raw_json`), which a
  comparison overlay turned into four round trips for two shots that had
  already finished.
- **A cache hit must never call `recordUpstream("ok")`.** `/health` answers "is
  the machine up *now*", and remembering a shot it sent ten minutes ago is not
  evidence that it is. Getting this backwards makes the endpoint claim a
  machine is up long after it was switched off, which is the one question it
  exists to answer.
- **5xx is transient, 4xx is not.** Every HTTP status used to short-circuit the
  retry loop on the reasoning that the machine had given a definitive answer —
  true of a 404, false of the 503 a microcontroller webserver returns while it
  is busy writing a shot to flash. `isRetriableStatus` covers 5xx, 408, and 429,
  and when retries run out on an HTTP error the `UpstreamHttpError` is thrown
  rather than an `UpstreamUnreachableError`: a machine that answered 503 three
  times is reachable and faulty, which is different advice to give the user.

There is also an **overall deadline** (`overallTimeoutMs`, 20s) on top of the
per-attempt timeout, because three attempts at 10s plus 1.5s and 3s of backoff
is ~34s — past the point most hosts abandon a tool call, so the model got a
timeout with no message instead of "the machine may be powered off". A retry
whose backoff will not fit in the remaining budget is not made at all: skipping
the wait and retrying immediately is just hammering a machine that has already
failed.

`perform()` is the retry loop and takes a `BodyReader`, which is what lets
`selectProfile` POST without `.json()` running over an ack whose format is a
firmware detail — parsing it would turn a successful selection into a failure
and then retry it.

**A write this server performs invalidates the cache the write invalidated.**
`createProfile` drops `/api/profiles/all` in a `finally`, not on success, and the
failure path is the reason. The TTL cannot cover this: thirty seconds is "edited
on the machine, so do not serve it too long", and a write *this* server made
starts its staleness at a moment the TTL never sees. When an upload fails
ambiguously — a 5xx, or a connection that dropped after the request left — the
tool tells the caller to check `list_profiles` before trying again, because a
second upload creates a second profile. Answering that check from a pre-upload
snapshot reports a landed write as missing and walks the caller straight into the
duplicate `maxAttempts: 1` exists to prevent. Both directions have tests, and
both fail without the eviction.

### Shot ids have gaps

`history.ts` owns the walk back through history, and it exists because `id - 1`
is a guess. Gaggiuino keeps a bounded history, a deleted shot leaves a hole, and
after shot #1 the arithmetic asks for shot #0. Both the app's "compare previous"
button and `list_recent_shots` go through `walkShotsBack`, which absorbs 404s as
gaps, stops at id 1, and — because every probe is a request to the machine —
spends at most `MAX_GAP_PROBES` misses before giving up. Running off the end of
retained history is the normal case and looks exactly like a run of 404s.

Anything that is *not* a 404 propagates. A partial list that quietly dropped the
shots a broken machine could not serve would be indistinguishable from a
complete one.

### An event is a measurement, and its threshold is measured too

`events.ts` fills the `events` array `get_shot_data` has always advertised and
always returned empty. It detects one thing so far — pressure falling faster
than the profile asked for — and everything about how it is written follows from
two rules.

**Report what was measured, never what it means.** An event reads
`pressure fell 2.8 bar in 1.1s from 11.5s while the target held at 9.0 bar`. It
does not say "channeling". The model calling this tool has
`get_dial_in_guidance` in context and is the thing qualified to draw that
conclusion; a threshold in a server is not, and a diagnostic that names a cause
it cannot know is one the user stops believing the first time it is wrong.

**The threshold is derived from real curves, not inherited.** The idea comes
from `mxkissnr/gaggiuino-local-profiler`, which flags a drop of more than 1.5
bar between two *adjacent* samples. That number is not portable: it has no
window, so its sensitivity moves with the sample interval, and upstream feeds
the same constant both ~10 Hz recorded shots and 1 Hz live-accumulated ones. On
this machine's ~0.15 s cadence it works out at ~10 bar/s — about twice what the
pump does when a shot *ends*, so it would essentially never fire. The shipped
rule is **2.5 bar/s sustained over at least 0.5 s**, which is ~3× the worst
target-steady fall measured across three real captures on two profiles
(0.67, 0.83 and 0.86 bar/s). The minimum window is doing as much work as the
rate: a single noisy sample pair on a Zer0 plateau reaches 2.58 bar/s on its
own, and half a second is at least three samples at this cadence.

Four gates decide whether a window counts, and **each was kept because a real
capture fails without it**:

- `targetPressure` must be **commanded** at both ends. It is `0` while a profile
  drives flow instead, which is how Londinium spends its first five seconds —
  and reading `0` as "a steady target of zero" turns the fill-to-extraction
  handover into a 4.0 bar/s collapse on every shot.
- The target must not have **moved**. Zer0 steps its target 6 bar → 2.5 mid-shot
  and the pressure obediently follows.
- The fall must **begin** from a pressure that was tracking its target, which is
  what rejects the tail of that step: the decay takes ~2.5 s, runs at 2.2 bar/s
  — only 12% under the threshold — and can undershoot the new target on the way.
- The fall must **end** below the target.

They overlap deliberately, and the docblock says which regime each one is the
only defence for, because three of the four survive being deleted individually
against the current suite.

The series' **final sample is never a window end**. A shot finishing dumps
pressure at 5.8 bar/s, twice the threshold; that is the stop condition being
met, not the puck failing.

Overlapping windows **merge into one event**. A fall lasting a second trips
every window along the way, and a model handed nine events describes nine
problems.

`normalize.ts` exists as of this work: `SCALE_BY_10` and `normalizeValue` used
to live in `analysis.ts`, which `events.ts` cannot import without a cycle. This
file is what AGENTS.md already claimed was there.

**There is deliberately no flow-based event**, and
`docs/plans/2026-08-08-flow-based-extraction-events.md` records why so the
question does not get re-asked from scratch. The short version is that the pump
hides it: in a pressure-targeted phase the machine answers falling puck
resistance by pushing more flow, so resistance only becomes visible once the
pump stops being able to compensate — and that is a pressure deviation, which
the collapse detector already reports. Measured against the same captures, a
`pressure / pumpFlow` resistance proxy falls 42%/s on a *good* shot and does not
agree in direction between two consecutive good ones, so there is no room to put
a threshold anywhere.

### A spread is not an accuracy

`tempStability` answers "did the boiler wobble" and nothing else, so a shot held
rock steady three degrees cold reads as `stable`. `tempDeviationC` and
`pressureDeviationBar` answer the question a dial-in conversation actually asks
— **did the machine hit what the profile asked for** — as a mean absolute
deviation from the machine's own target series. Both are `null` when no target
was commanded, never `0`: "asked for nothing" and "was perfect" are different
answers.

Two rules carried over from `events.ts`, for the same reasons:

- **A target of `0` means the profile is not driving that quantity**, not that
  it asked for zero. Londinium spends its first five seconds there — 65 of its
  191 samples — and averaging them in reports a shot as several bar off target
  for doing exactly what it was told.
- **The bands are the machine's, not a person's.** Upstream's equivalent falls
  back to a generic 90–96 °C window when a shot has no target. That fallback is
  deliberately *not* carried over: it encodes one person's taste as a machine
  reading, and this server reports measurements and lets
  `get_dial_in_guidance` supply the opinion.

Deliberately a plain mean over every commanded sample, transitions included.
Excluding half a second either side of each target change was measured against
both captured shots and moved the answer from 0.99 to 0.88 bar and from 1.12 to
0.98 — not enough to justify the extra rule.

**This is the change that cost permission grants.** `OutcomeMetricsSchema` is the
advertised output of three tools — `get_shot_data`, `get_latest_shot_id` and
`list_recent_shots` — so adding two fields re-keyed all three. Numeric rather
than prose was chosen knowing that: `list_recent_shots` returns an array of these
records, and a trend across shots is only readable if the values are numbers.

`ShotDatapointsSchema` gained `targetTemperature` in the same change. Real
machines send it — verified on the firmware serving shot #347 — and
`SCALE_BY_10` had listed it all along, so the parsed type was missing a field
the normalizer already knew about.

### The machine owns what exists; the YAML owns what it means

`profileCatalog.ts` joins `/api/profiles/all` to `data/profiles.yaml` on the
profile's name. Before it, `list_profiles` served curated documentation as if it
were the machine's inventory: a profile the user built never appeared, one they
deleted still did, and dial-in advice could recommend switching to something
that was not there.

Three cases, and the widened `ProfileOutput` schema exists for the second:

- **On the machine, documented** — everything filled in.
- **On the machine, undocumented** — real and selectable, every documentation
  field `null`. A schema that still required `description`/`type`/`targetRatio`
  would force the merge to drop exactly the profiles the user cares most about.
- **Documented, not on the machine** — listed last with `onMachine: false`, so
  nothing recommends loading it without saying so first.

When the machine cannot be reached the catalog degrades to the documentation and
sets `source: "documentation"`, with `note` carrying the *upstream's own*
diagnostic rather than a generic "unavailable". `onMachine` is then `null`, not
`false` — this server did not check, and saying it did would be the same class of
lie the split exists to fix.

### Deleting is four gates, and each stops a different mistake

`delete_profile` is the only tool here that destroys anything, and the endpoint
behind it — `DELETE /api/profile-select/{id}` — differs from the *selector* by
HTTP verb alone. It sat on `client.ts`'s not-called list until #105 for exactly
that reason. What made it shippable is that reaching it is now deliberate at
four independent points, and no two of them fail together:

- **The scope gate**, inherited rather than written: `PROTECTED_TOOLS` derives
  from `readOnlyHint === false`, so the tool joined the `espresso:write` set
  with no gating code. This is the gate that keeps *strangers* out, and it is
  the one that does nothing about the model — the owner has to grant
  `espresso:write` for `upload_profile` to work at all.
- **An exact-name echo.** `confirm_name` must equal the profile's name under a
  strict `===`. Deliberately *not* run through `findCatalogEntry`, which trims
  and lowercases and matches id-or-name — routing the confirmation through it
  would let `zer0` confirm `Zer0` and the check would be theatre. Both the
  machine's spelling and the documented one are accepted, because for a
  documented profile `entry.name` is the YAML's and the machine's may differ in
  case; `CatalogEntry.machineName` exists to carry the second, on the interface
  only, so `ProfileOutput`'s `z.object` strips it and no grant moves.
- **A refusal to delete the selected profile**, read live from
  `/api/system/status`'s `profileId` — undocumented upstream, but captured off
  real hardware and already arriving through the loose client schema. That
  endpoint is deliberately uncached, so the guard is never answered from a
  snapshot. It **fails closed**: an unreadable status refuses the delete.
  An *absent* `profileId` does not, and the asymmetry is the point — a failed
  read is transient, while a firmware that never reports the field would refuse
  forever, making the tool useless rather than safer.
- **`requiresUserInteraction`**, so no stored allow rule can spend the other
  three silently.

`websocket.md` L247 says `c_del_prof` is "rejected if it's the active one" —
corroboration that the firmware treats this as a hazard, and **not** authority
for the REST verb, which documents no refusal and no error codes at all. The
server declines rather than discovering the machine's behaviour in production.

**`maxAttempts: 1`, and the reason is worse than `createProfile`'s.** The
reference says nothing about whether ids are reused or renumbered after a
delete, so a retried DELETE whose first attempt landed could remove a
*different* profile. An upload's worst case is a duplicate the user deletes;
this one's is silent loss they cannot attribute. `selectProfile`'s docblock
pre-registered the obligation — "a future write that is not idempotent must not
inherit this loop without saying so" — and this is that write.

The eviction in `finally` drops **two** keys, where `createProfile` drops one: a
create has no prior definition cached and a delete does, so
`/api/profile/{id}` goes too. Leaving it would let `get_profile_info` serve the
full definition of a profile that no longer exists, which reads as the delete
having silently failed.

`describeDeleteFailure` exists because `errors.ts`'s `profileIdFromPath` matches
this path **regardless of method**, so the generic 404 branch names
`select_profile` — advice for the wrong verb, and wrong about what happened. A
404 on a delete is genuinely ambiguous between "already gone" and "this firmware
has no delete endpoint", and the text says both rather than picking.

### The machine is also the authority on what a profile *does*

`GET /api/profile/{id}` serves a profile's full definition — phases, targets,
stop conditions, recipe — and `get_profile_info` reads it into `definition`
(`profileDefinition.ts`). That is what turned "on the machine, undocumented"
from a row of nulls into a real answer: a profile the user built themselves now
describes itself.

Four things about it are load-bearing.

- **The definition is echoed, not translated.** Same key names, same units,
  milliseconds and all, and upstream's `switchToManuaFlowCtrl` misspelling
  preserved. The reference says the `POST /api/profile` body is *"Same shape as
  the `GET /api/profile/*` response"*, so **this field is `upload_profile`'s
  input** — "take the profile that works, soften the preinfusion, upload it" is
  the actual workflow, and this is the only place a model can get a profile that
  works. A normalized dialect (`timeSec`, `waterTemperatureC`) reads better and
  means a model copies `rampSec: 5` back into `time` and uploads a
  five-millisecond ramp, which the machine accepts — the reference fills
  malformed fields with zero-value defaults rather than rejecting them. All the
  humanising happens in `formatProfileDefinition`, in the prose.
- **The output schema is loose for the same reason the client boundary is.** A
  strict `z.object` emits `additionalProperties: false`, so a phase field a
  future firmware adds would be dropped from `definition` — and a model that
  edited and re-uploaded that definition would silently delete it from the
  user's machine. Same failure `get_machine_settings` is text-only to avoid.
- **`list_profiles` deliberately does not fetch definitions.** N profiles would
  be N sequential round trips to a device that serves one request at a time.
  `tools.test.ts` asserts zero requests to `/api/profile/:id` from that tool.
- **A 404 there is ambiguous** between firmware that predates the endpoint and a
  profile deleted since the list was read — the machine does not distinguish
  them. So it is handled in `profileDefinition.ts`, naming both causes, rather
  than falling through to `describeUpstreamError`'s bare-404 text, which asserts
  the firmware explanation as fact. `errors.ts` gains no per-endpoint branch.

`definition` lives on `ProfileDetailOutput`, an extension of `ProfileOutput`
rather than a widening of it: `list_profiles` shares that schema, and widening
in place would re-key two host permission grants instead of one.

### The advertised surface is a permission-grant key

A host stores "always allow" against a tool's advertised identity, not against
the connector as a whole. So anything that changes what `tools/list` says can
silently drop the grant and put the user back on a permission prompt for every
call — the failure mode where Claude on iOS keeps asking despite the connector
being set to allow. On a server that redeploys often, this is the mechanism most
likely to make a self-hosted connector worse behaved than a directory one.

The churn worth guarding is rarely deliberate. Nobody renames a tool by
accident, but the advertised JSON Schema is **generated** — `z.toJSONSchema` over
the same zod schemas the dispatcher enforces — so a routine `zod` or
`@modelcontextprotocol/sdk` bump can reshape every input schema in the server
without a line of this repo's code changing.

`apps/server/src/tool-contract.json` is that surface, committed;
`toolContract.ts` normalizes it (keys sorted, so a cosmetic reordering does not
fail) and `server.test.ts` compares the live list against it. Regenerate with
`bun run generate-tool-contract` — deliberately. **The diff is the list of grants
every existing installation is about to lose**, so review it as a breaking change
and land it with a release the user can re-grant against. It is excluded from
Biome (like `*.schema.json`) so the file stays byte-for-byte what the generator
writes.

Three more invariants are asserted separately, because a regenerated contract
would otherwise absorb them silently:

- **Only `delete_profile` sets `_meta["anthropic/requiresUserInteraction"]`.**
  That flag falls through to the permission prompt in every mode, the host offers
  no "don't ask again", and an existing allow rule does not skip it. This was a
  blanket prohibition, justified as *"nothing here warrants it — every tool
  reads"*. `delete_profile` does not read, and every property that makes the flag
  a cost for a read tool is the point for a delete that cannot be undone. So the
  rule became `ALWAYS_PROMPT_TOOLS`, a named set, rather than being deleted: the
  prohibition still holds for every other tool, and the set is written out rather
  than derived from `destructiveHint`, because a tool picking the flag up
  silently is the regression worth catching. `http.test.ts` re-asserts it over
  the transport — `_meta` is as droppable as `annotations`, and this flag is the
  only thing keeping a stored allow rule from letting a delete through
  unprompted.
- **No capability claims `listChanged`** (or `resources.subscribe`). Every list
  this server serves is a module-level constant. `listChanged` is a promise to
  tell the host to re-fetch, and a re-fetch is what re-keys the cached tools a
  grant is stored against.
- **Annotations survive the real transport.** `server.test.ts` asserts them over
  an in-memory pair; `http.test.ts` asserts them again on a `tools/list` that
  crosses `WebStandardStreamableHTTPServerTransport`, because `annotations` and
  `_meta` are exactly the fields a transport or SDK version is free to drop, and
  a tool arriving without `readOnlyHint` is read as write/destructive and prompts
  on every call.

Everything else behind that symptom lives on the host: per-tool (not just
per-connector) approval settings, in-chat connector toggling, and an open
persistence bug in Claude's connector layer. This server can only make sure it
is not the cause.

### Answer every method the advertised capabilities imply

`createServer()` declares `tools`, `prompts`, and `resources`, and a host
enumerating the server calls **everything** those capabilities cover — including
`resources/templates/list`, which the spec's own resource message-flow puts
directly after `resources/list`. That handler was missing, so the request fell
through to the SDK default and came back `-32601 Method not found`; a host that
treats a JSON-RPC error mid-discovery as a failed discovery abandoned the whole
pass, tools included. This is what made "Refresh tools list" fail in the Claude
connector settings while the already-cached tools kept working.

The rule generalises: adding a capability to `createServer()` means registering
every request handler that capability implies, not only the ones this server has
data for. An empty list is a valid answer; `-32601` is not.

## MCP Prompts

| Prompt                  | Arguments (required in bold)              | Purpose                                            |
| ----------------------- | ----------------------------------------- | -------------------------------------------------- |
| `espresso_shot_analyst` | —                                         | The dial-in guidance as a system prompt            |
| `dial_in_new_bag`       | **bean**, roast_level, dose_g, target     | First shots on a coffee: profile, then one variable |
| `diagnose_last_shot`    | **taste**, changed                        | Read the shot just pulled against how it tasted    |
| `choose_profile`        | **roast_level**, drink, notes             | Pick a profile the machine actually holds          |

`prompts.ts` mirrors the tool contract: one `definePrompt(...)` per prompt, and
`renderPrompt` is the only place a prompt is rendered — it `safeParse`s the
arguments before the render function runs, so a render function receives typed
values and never re-checks presence. Four things follow from that shape.

- **The advertised `arguments` array is generated, never hand-written.**
  `promptArguments` runs the same `z.toJSONSchema` path the tool schemas use over
  the schema `renderPrompt` enforces, so a name, description, or required flag
  cannot drift from what is actually accepted. Every schema is a **string**
  schema, because strings are all the protocol carries; `prompts.test.ts` asserts
  that, since a number-accepting schema would advertise a shape no host can send.
- **A prompt has no `isError` channel.** A tool answers a bad call with a result
  the model can read; `prompts/get` has only the JSON-RPC error, which is also
  what a host needs in order to put the missing field back in front of the user.
  So `renderPrompt` throws where `handleToolCall` returns. Both render the
  offending fields through `formatFieldIssues` in `errors.ts` — same list of
  fields, different closing advice, because "check the input schema" is advice for
  a model and not for a person filling in a form.
- **Blank and absent are the same argument.** Hosts render prompt arguments as
  form fields and an untouched field arrives as `""`, so a required argument
  trims to `.min(1)` and an optional one transforms `""` back to `undefined`.
  An optional argument the user skipped then renders its *fallback instruction*
  rather than vanishing ("Dose: not stated — use the recommended dose for the
  profile you pick"), because a dropped line leaves the model free to invent a
  number a tool could have told it.
- **The workflow plans live in code, not `prompts.yaml`.** What they contain is a
  numbered plan naming *this server's own tools*, so a local override could point
  a step at a tool that does not exist — `prompts.test.ts` checks every backticked
  name in a plan against `TOOLS_BY_NAME` for exactly that reason, and skips
  `espresso_shot_analyst` because its text is user-editable. The part a user
  genuinely wants to tune is already `user_context` in the YAML, and every plan
  picks it up by calling `get_dial_in_guidance` in step 1 instead of restating it.

### One template, two surfaces

`guidance.ts` renders the dial-in guidance, and `get_dial_in_guidance` and the
`espresso_shot_analyst` prompt both call it. They used to interpolate the same
template independently, in two files, with the same pair of `.replace()` calls —
so a placeholder added to `prompts.yaml` would be substituted on one surface and
left raw on the other. `server.test.ts` asserts the two are byte-identical.

Both surfaces exist on purpose and neither is redundant: a **prompt** is
user-invoked, so a model that decides mid-conversation it needs the guidance
cannot reach one — that is what the tool is for. The tool therefore keeps
returning the whole document rather than a pointer to the prompt, and the ~7KB is
the price of the expertise it was asked for.

The prompt's advertised **description** comes from the loaded template, not a
literal. It was hardcoded in the ListPrompts handler, which made a
`prompts.local.yaml` override the loader honours everywhere else invisible on the
one surface a host shows the user. That is also why `advertisedPrompts()` is a
function rather than a module constant like `TOOLS` — the list is built per
request so a local override stays authoritative.

### The loop had no termination condition

The dial-in prompts told the model to change one variable and re-pull, and said
nothing about **how far**, **which way after a reversal**, or **when to stop** —
so a model suggests "a bit finer" indefinitely, oscillates around the target
because nothing shrinks the step after an overshoot, and never says "this is
dialled in".

`ADJUSTMENT_POLICY` in `prompts.ts` is that missing policy, spliced into
`dial_in_new_bag` and `diagnose_last_shot`. **It is text, not state, and that is
the whole reason it fits here.** The obvious implementation is a session object
holding the round history, and there is nowhere to put one — no database, no
persisted user state, and the session TTL evicts anything in memory. None of it
is needed: the round history *is* the conversation and the model already has it.
What was missing was the policy for reading it, so this adds no tool, no schema,
and re-keys no permission grant.

Three details are load-bearing:

- **A `const`, not a function.** `apps/server`'s coverage gate is
  `functions: 100`, so a helper reached from only one render would fail the
  build outright. Shared rather than written into each plan twice, because two
  copies of a numeric rule drift.
- **A collapsed shot is excluded from direction-finding**, and the text names
  what the model will actually *see* — an event beginning `pressure fell` — not
  an internal concept. `phases[].events` is `string[]` with no discriminator
  field, so there is nothing else to key on. The converse is stated too: no
  event is not proof the puck held, and a shot whose profile names no phases
  produces no events at all because `extractPhaseSummary` returns before the
  detector runs.
- **The numbers are defaults, not the server's opinion.** Band, dose and grinder
  resolution are equipment-specific, which is what `user_context` already exists
  to override.

### Which field to move, and the two levers that do nothing

`get_profile_info` reads a profile and `upload_profile` writes one; what did not
exist was the middle — which field to change for which symptom. The
"Editing a Profile" section of `prompts.yaml` is that table, and it is in the
YAML rather than the plans because it is durable domain knowledge that every
plan already picks up by calling `get_dial_in_guidance` in step 1.

**The upstream table it came from could not be used as written, and that is the
part worth remembering.** Its paths are `preinfusion.stopConditions.time`,
`ramp.target.end`, `decline.target.time` — and there is no `preinfusion`, `ramp`
or `decline` key anywhere in the wire format. `phases` is a flat **array**, and
`phases[i].name` is *absent* on nearly every real profile because profiles built
on the machine's own screen carry no phase names. So the table addresses phases
by `type` and target shape, and says to read `definition.phases` first. Shipping
the dotted paths verbatim would have produced exactly the confidently-wrong edit
the section exists to prevent.

Two rows were corrected rather than copied, for the same reason:

- **`recipe.ratio` does not stop the shot.** It is informational and the machine
  does not enforce it, so the upstream "watery → lower the ratio" lever changes
  documentation and not coffee. The field that actually ends a shot on yield is
  `globalStopConditions.weight`.
- **`restriction` has no documented unit**, so no value can be advised for it —
  but the guidance says *preserve* it rather than zero it, and that correction
  is worth knowing about because the same mistake was in this repo already.
  `profileShape.ts` cited `websocket.md` L221 ("both always send `0`") as
  evidence about a phase's `restriction`. L221 is about
  **`ProfileManualDto.restriction`** — the live `BREW_MANUAL` setpoint, a
  different message (L213-216). Nothing says a *phase's* restriction is unused,
  and `formatProfileDefinition` records the opposite from observation: a real
  lever profile sets it on sixteen of its nineteen phases. Telling a model the
  field is always zero invites it to normalise a lever profile's restrictions
  away while editing one field. Fixed in `profileShape.ts` at the same time.

Every stated range sits inside `ProfileUploadInput`'s own bounds — guidance that
recommends a value the server then rejects is worse than none. The units section
repeats `profileShape.ts`'s central trap on purpose: **nothing in a profile is
scaled by 10 while the shot time-series is**, and the machine fills malformed
fields with zero-value defaults rather than rejecting them.

**Phases are located by shape, and deliberately not by `target.start`.** The
obvious rule — a ramp is a phase whose `target.end` exceeds its `target.start` —
fails twice on this repo's own fixtures: `start` is optional and most real phases
omit it (meaning "continue from the previous phase"), and where it *is* present
it is often `0`, which makes a 3-bar preinfusion look like a ramp and invites the
model to push it to 5+ bar. The rule compares against the **previous phase's**
`target.end` instead, excludes the first phase from being the ramp, and says to
check `type` before touching `target.end` — whose unit is bar on a `PRESSURE`
phase and ml/s on a `FLOW` one, with nothing anywhere to reject the wrong one.

## MCP App (Shot Graph)

https://modelcontextprotocol.io/docs/extensions/apps

The `view_shot_graph` tool renders an interactive Recharts chart in MCP-compatible hosts.

- Uses `@modelcontextprotocol/ext-apps` SDK with React hooks (`useApp`, `useHostStyles`)
- Bundled as single HTML file via `vite-plugin-singlefile` (~1MB)
- Served as MCP resource at `ui://shot-graph/app.html`
- Calls `get_shot_raw_json` (app-only visibility) to fetch data after render
- Supports shot comparison overlay; "Compare previous" calls
  `get_previous_shot_json`, which resolves the real previous id server-side
  rather than subtracting one from the current one

### The series registry

`SERIES` in `shot-graph/src/constants.ts` describes every stroke the chart can draw
— data key, metric, label, unit, colour, dash, axis, and `isComparison` — and
`ShotGraph.tsx` renders from it rather than from ten hand-written `<Line>` blocks.

It exists because a comparison series used to be identified by a `"(cmp)"` substring
in its *display name*, matched independently by the tooltip (to filter them out), the
chart (to fade them), and the legend (which spelled the suffix out four times). The
suffix is now only ever a label; nothing parses it, and `SERIES_BY_KEY` is how a
recharts tooltip payload entry finds out what it is.

Two consequences worth keeping:

- **Areas and goal lines declare `tooltipType="none"`.** That is what lets the tooltip
  key off `dataKey` instead of sniffing names for "Area"/"Goal" — they never reach the
  payload at all.
- **Series set `isAnimationActive={false}`.** Recharts animates a line by rewriting
  `stroke-dasharray` every frame, and when the line already carries a dash it tiles the
  pattern across the whole path to do it: a 1800px path dashed `"1 3"` becomes a
  ~900-entry attribute string, rebuilt per frame, per line. It also means the rendered
  attribute never equals the declared pattern, so the encoding the accessibility story
  measures would not be the one the browser is holding.

Phase regions come from `phases.ts`, which segments on target-series transitions and
lets `profile.phases.length` bound the count — the same rule `apps/server`'s
`extractPhaseSummary` uses, so the chart and `get_shot_data` name the same phases. It
replaced an inference that de-duplicated boundaries with a magic `MIN_GAP = 4` seconds
and then threw the phase *names* away.

**That sameness is now asserted rather than intended, because for a while it was
only half true.** Both files detected candidates identically; only `phases.ts` ever
*bounded* them, so on a real two-phase shot `get_shot_data` reported seven phases —
five typed `"UNKNOWN"`, three of zero duration — while the chart drew two. The claim
sat in this file and in `phases.ts`'s own docblock the whole time, which is the
argument for the test rather than for a third careful reading: `analysis.test.ts`
runs both implementations over `londiniumShot33`/`32` and compares count and
boundaries. They are the shots `packages/shot-graph` already shipped for its
stories, reachable from `apps/server` through the package's `./fixtures` export, and
they matter because the divergence was invisible at `mockShotData`'s five points at
ten-second spacing. Anything that re-forks the two rules fails there. Recharts hoists every `Label` into a shared
z-index layer at the SVG root, which is why the labels carry `PHASE_LABEL_CLASS`: they
do not stay inside their own `.recharts-reference-area` group.

Temperature is a fifth metric, off by default (`hiddenByDefault` in `METRICS`, surfaced
as `DEFAULT_HIDDEN_SERIES`), on its own degrees axis. That axis is hidden on mobile, and
when it *is* shown the chart's negative right margin has to give way — recharts stacks
it outboard of the weight axis, and at `-30` its tick labels lay out past the right edge
of the SVG and get clipped, leaving an axis that reserves width and shows nothing.

### The app shell (`packages/ui`)

Host plumbing lives in `packages/ui/src/host/` so a second espresso view (steam
dashboard, shot trends) starts from the shell rather than a copy of `main.tsx`.
`main.tsx` is now composition: parse tool input, fetch, render.

| Module | Responsibility |
| --- | --- |
| `useHostRoot` | `useApp` + `useHostStyles`, tool-input parsing, host-context tracking, mobile/desktop detection |
| `useServerToolData` | Fetch/slow/ready/error/retry state machine over `callServerTool` |
| `useDisplayMode` | `requestDisplayMode`, gated on the host's `availableDisplayModes` |
| `useModelContextSync` | Debounced, deduplicated `updateModelContext` |
| `toolResult.ts` | `readToolJson` / `describeToolError` — the only place a tool result is read |
| `download.ts` | `canDownloadFiles`, `downloadTextFile`, `toCsv` |
| `layoutMode.ts` | Pure mobile-detection signals, unit-tested |

Three rules the shell exists to enforce:

- **Never invent an error message.** `readToolJson` throws `ServerToolError`
  carrying the server's own text, and `describeToolError` passes it through
  untouched. The server writes its diagnostics to be actionable ("the machine
  may be powered off"); replacing them with "Failed to load shot data" throws
  that away.
- **Every host capability is gated before it is offered.** Fullscreen renders
  only when `availableDisplayModes` includes it; export only when the host
  advertises `downloadFile`. A button that silently does nothing is worse than
  no button.
- **Components stay presentational.** `AppShell`, `ErrorState`, and
  `ToolbarButton` take props, not an `App`, so Storybook renders every state
  and the hooks stay the only thing that touches the host.

`useHostRoot` seeds host context from `app.getHostContext()` on connect as well
as from `host-context-changed`. This is load-bearing: hosts send
`availableDisplayModes` in the initialize result and may never send it again,
so an app that only listens for the notification never offers fullscreen.

## Design tokens and theming

`packages/design-system/src/tokens.css` is the **single source of truth** for token
values. Nothing restates them: `src/tokens.ts` parses the stylesheet (`?raw`) into
`DESIGN_TOKENS` / `TOKEN_GROUPS`, and the Colors and Token Reference stories render
from that, so the docs cannot drift from what ships. There is deliberately no
`COLORS`/`CHART_COLORS` constant object — that was a hand-synced third copy and it
is gone. `shot-graph/src/constants.ts` references the tokens as `var(--chart-*)`
strings, which is the one indirection that stays.

Dark mode is keyed on **`[data-theme="dark"]`**, the attribute
`@modelcontextprotocol/ext-apps` sets on `documentElement` (`applyDocumentTheme`,
called by `useHostStyles` with `hostContext.theme`). It is not a `.dark` class —
nothing in the stack applies one, which is why the dark palette used to be dead code
in every real host.

`hostContext.theme` is optional, so a second copy of the dark block lives under
`@media (prefers-color-scheme: dark)` on `:root:not([data-theme="light"])` for hosts
that never send a theme. CSS cannot share one block between a selector and a media
query, so those two blocks are hand-duplicated — `assertDarkRulesAgree()` fails the
Token Reference story if they drift, naming the offending token.

Two gates run as Storybook `play` functions in `bun run test:stories`, because what they
assert is what the *browser* resolves a token to — design-system's own `vitest run` covers
the palette maths and nothing that needs a DOM (see Test coverage below):

- **Token Reference** asserts the dark blocks agree, that every dark override exists
  in `:root`, and that the table renders a row per token.
- **Colors** (`Light` and `Dark`) asserts the *browser* resolves every token to the
  value the stylesheet declares for that theme. This is the regression test for the
  dead-selector bug: point the dark block at anything the host does not set and the
  `Dark` story fails with the computed light value.

The Storybook decorator in `apps/storybook/.storybook/preview.tsx` sets `data-theme`
and `color-scheme` on `documentElement`, mirroring `applyDocumentTheme`. Do not
reintroduce a wrapper element — a hand-applied class makes dark stories pass while
every real host renders light.

### The chart palette contract

`--chart-*` carries an accessibility contract that a plain colour edit can silently
break, so it is measured rather than asserted in a comment. `packages/design-system/src/color.ts`
provides the maths (WCAG contrast, Machado 2009 CVD simulation, CIEDE2000) — itself asserted
against published reference values by `color.test.ts`, since a threshold check cannot tell a
correct number from a plausible wrong one — and the **Shot Graph/Chart accessibility** story
(`Light` and `Dark`) enforces two rules against what the *browser* resolves, so a host
overriding `--chart-*` is measured too:

1. Every stroke clears **3:1** against `--color-background-primary` (WCAG 1.4.11).
2. Every pair of strokes from *different* metrics is separable, either by colour under
   a protan **and** deutan simulation (≥17 ΔE00) or by a different dash pattern. Goal
   lines are exempt against their own metric — resembling it is the point.

**Colour alone cannot carry the series, and the second rule is not negotiable because
of it.** Under protan/deutan the palette collapses to roughly two hue poles plus
lightness; measured, `--chart-flow` and `--chart-weight-flow` land ~3 ΔE00 apart once
simulated, and a search over the full sRGB gamut only beats that by pushing one series
to a near-black navy. Pattern is what actually separates that pair, which makes
`SERIES_DASH` in `shot-graph/src/constants.ts` load-bearing rather than stylistic. That
file is the single home for the whole `strokeDasharray` vocabulary — series, goal lines,
comparison overlays, and chart furniture — because separate concerns kept laying claim
to it.

**The story's stroke list is derived from `SERIES`, not restated.** That matters most
for the comparison overlay: a comparison stroke carries its metric's colour, so the only
thing separating `weightFlowCmp` from `pumpFlowCmp` is the dash `comparisonDash` builds
for it — one long dash, then the metric's own rhythm. Deriving the pattern rather than
picking one flat comparison dash is what keeps the contract satisfiable; a single shared
pattern would put that pair back on the same dash *and* ~3 ΔE00 apart. Hand-listing the
strokes is how a new series ships unmeasured.

Two comparison strokes do share a dash — `pressureCmp` and `pumpFlowCmp`, both derived
from solid primaries. They are the pair whose colours are furthest apart, so rule 2 is
satisfied by colour. That is the contract working, not a gap in it.

Gating is on protan and deutan only. Tritanopia is ~0.01% of people and every blue/green
pairing collapses under it, so including it would reject any palette using both; the
story still renders the simulated swatches for review.

The legend draws each series' dash in its swatch. That is the encoding's key — drop it
and a viewer who cannot separate two series by hue has no way to read the chart.

## Data Format

Gaggiuino API returns values scaled by 10 (e.g., pressure 91 = 9.1 bar). The `normalize.ts` module handles conversion:
- `SCALE_BY_10`: pressure, pumpFlow, targetPressure, targetPumpFlow, weightFlow, temperature, shotWeight
- Time is in 10ths of seconds (350 = 35.0s)

## Test coverage

Plain `bun run test` no longer computes coverage — it is opt-in via `bun run test:coverage`
(`turbo run test:coverage`), which writes each package's `coverage/coverage-summary.json`.

`apps/server` is the only package with a coverage threshold, defined in `apps/server/vitest.config.ts`
(`coverage.thresholds`). Each `bun run test:coverage` run can rewrite those threshold numbers
upward as coverage improves — that is the ratchet working, not drift. If a run dirties
`vitest.config.ts`, commit the new numbers; never hand-edit them.

### The ratchet is a script, not `autoUpdate`

`scripts/coverage-ratchet.ts` raises the thresholds, and the root `test:coverage` script is what
calls it — after turbo has run the suites. Vitest's own `coverage.thresholds.autoUpdate` used to
do this and is deliberately off, for two reasons that both showed up as failing builds.

- **It wrote the measured percentage rounded to nearest, so a threshold could land above what the
  run that wrote it had just measured.** That is how PR #87 got
  `Coverage for lines (98.09%) does not meet global threshold (98.1%)` from a config written sixty
  seconds earlier: 98.1 was 98.09 rounded up, and no state of the tree could ever reach it. The
  error blames the code ("you reduced coverage") when the fix is to discard a generated file, and
  `autoUpdate` only ever raises, so nothing brings it back down. The script **floors** to a tenth
  of a point instead, which makes `threshold ≤ measured` an invariant of every write.
- **It ran wherever coverage ran, CI included.** The script is invoked only from the root npm
  script; CI calls `turbo run test:coverage` directly, so a CI run checks the committed thresholds
  and can never mutate them.

Running `bun run test:coverage` twice on an unchanged tree writes at most once — the second run
floors to the number already committed. If you ever do hit a threshold you did not set,
`git checkout apps/server/vitest.config.ts` and re-run.

Coverage no longer depends on whether `apps/server/src/data/*.local.yaml` exists. `loader.ts`'s
override-merge branches used to execute *only* when one of those gitignored files was present, so a
dev machine measured ~2 points above what CI could reach and a ratcheted commit failed every
subsequent run on `main` — which happened, on the first CI run this repo ever did. The merge is now
`mergeProfileOverrides` / `mergePromptOverrides`, pure functions taking the overrides rather than
reading them, and `readLocalOverrides` is exported so a test can point it at a temp directory. Both
sides of every branch are covered by `loader.test.ts` regardless of what is on disk. Keep it that
way: a test that writes a real `*.local.yaml` into `src/data/` would clobber a contributor's own
equipment configuration and put the disk back in the coverage number.

`packages/ui`, `packages/design-system`, and `packages/shot-graph` are **intentionally
unthresholded**. Their coverage is the story render path measured by `bun run
test:stories:coverage` (see Storybook below), not per-package unit coverage. Do not "fix" this by
adding empty test files just to get a `coverage/` directory — there is nothing to threshold there.

Where an assertion lives depends on what it needs, not on which package it is in:

- **Anything a browser has to resolve** goes in a story `play` function so it runs under
  `test:stories`. The token invariants in `packages/design-system` are the case that defines
  the rule — they assert what the *browser* computes for a token, which no headless runner can
  answer. The same goes for component behaviour: the retry loop in `ErrorState` and the
  visibility callback in `ShotGraph` are `play` functions for exactly this reason.
- **Pure functions with no DOM** run under a plain `vitest run`. `packages/ui` and
  `packages/shot-graph` each have one, covering `layoutMode`, `toolResult`, `download`, `csv`,
  `contextSummary`, and `a11y` (the generated chart name and description). This is not a second
  test runner — it is the same vitest the story tests and `apps/server` already use, just without
  a browser it has no reason to boot.

  `packages/design-system` is in that list too, since #81. It used to be recorded here as the
  exception — pure, but tested only through the Chart accessibility story because "the thing
  worth asserting is what a *browser* resolves `var(--chart-*)` to." That reasoning was
  incomplete rather than wrong: there are **two** things worth asserting about `color.ts`, and
  only one of them needs a browser. Whether the palette clears its thresholds depends on what
  the browser resolves, and the story still owns it. Whether the *ruler* is accurate does not
  depend on a browser at all, and the story structurally cannot answer it — it only ever asks
  "is this past the threshold?", so it cannot tell a correct 20 from a buggy 20.

  `color.test.ts` therefore lives next to the code it measures, and design-system has a
  `test` script. Putting those assertions in `packages/shot-graph` instead — the other option
  on #81, and a smaller diff since it already has a vitest project and already imports
  `@gaggiuino/design-system/color` — would have picked the package by what was convenient
  rather than by what the assertion needs, which is the one thing this section says not to do.

None of them has a `test:coverage` script, so none produces a `coverage/` directory and the
unthresholded rule above still holds — adding a `test` script to design-system did not change
that. What does *not* belong anywhere is a jsdom harness for components: if it renders, it
belongs in a story.

### The ruler is asserted, not just the readings

`color.test.ts` checks the maths the chart palette gate depends on, because a gate that
compares numbers against a threshold cannot notice that the numbers are wrong. Two of its
groups are worth not weakening:

- **`deltaE2000Lab` is asserted against the Sharma, Wu & Dalal (2005) reference set.** That set
  is published as *Lab* pairs and reaches values no sRGB colour can produce, which is why
  `deltaE2000` was split into an sRGB entry point and the Lab formula underneath — the
  reference data cannot reach the branches any other way. Those branches are the point: dropping
  the mean-hue wraparound, flipping the `rT` sign, or dropping the `G` factor each leave the
  formula returning plausible numbers, and each is caught by a different subset of the pairs.
- **`simulateCvd` is pinned to where the three sRGB primaries land**, not only to grey
  invariance. A *transposed row* — the failure #81 names — permutes coefficients whose sum is
  unchanged, so greys still map to themselves and the swatch table still looks fine. Six
  expected triples pin all eighteen coefficients in their correct positions. The projection
  test (simulating an already-simulated colour is a no-op) is the principled statement of the
  same property, but it is a ΔE00 tolerance rather than an equality, because gamut clamping
  makes it inexact — it misses a transposed *blue* row that the primary pin catches.

Every assertion above was verified to fail for the right reason by mutating the implementation
before landing. If you change the palette maths and a reference value fails, the reference value
is not the thing to edit.

### `.env.example` is checked against the code that reads it

`envExample.test.ts` asserts that every variable the server reads is documented in the
repo-root `.env.example`, and that the template's own values still parse to the defaults the
code declares. It exists because PR #75 added four variables, updated README, AGENTS.md,
SECURITY.md, `server.json`, `turbo.json`, and `docker-compose.yml` — and missed the one file
the deployment path tells users to copy. Nothing failed; it took a backlog sweep to notice
(#77). A variable missing from that template is one most users never learn exists, and in that
case it was the auth token standing between a tunnelled `/mcp` and the public internet.

Two things about it are deliberate:

- **The variable list is scanned out of `src/*.ts`, never written down.** The test greps for
  `env.NAME`, which covers both `process.env.NAME` and the injected
  `Record<string, string | undefined>` that `loadServerConfig` and `loadSecurityConfig` take.
  A hand-maintained list would be the same thing that drifted, moved one file over.
  `turbo.json`'s `globalPassThroughEnv` looks like a tempting source and is not one — it also
  carries the two `PLAYWRIGHT_*` build variables, so using it would need an exclusion list,
  which is a hand-maintained list again. The check runs in **both** directions: a documented
  variable nothing reads fails too, so a removed knob cannot linger in the template.
- **It lives in `apps/server` rather than in a root script**, against the pull of `.env.example`
  being a root file, because the assertions worth making are `loadSecurityConfig` /
  `loadServerConfig` / `parseLogLevel` actually returning an open `/mcp`, empty allowlists, and
  the declared defaults. A root script could only re-state those values, which is the same
  duplication the first rule exists to avoid.

That placement is what makes **`.env.example` in `globalDependencies` load-bearing rather than
tidiness**. Package task inputs cannot name a root file, so without it a PR touching only
`.env.example` — precisely the #77 shape — leaves `@gaggiuino/server#test` out of
`turbo run test --affected` and the gate never runs. Verified by measuring it: with the entry
removed, an otherwise-clean tree with a dirty `.env.example` reports
`@gaggiuino/server#test affected: false`; with it, `true`. The cost is that every task's cache
key now moves when `.env.example` does, which is a file that changes about twice a year.

`packages/design-system`'s `tsconfig.json` includes `stories` as well as `src` — the parser in
`tokens.ts` and the stories that consume it are both type-checked in CI. Since #81 it also has a
`test` script (`color.test.ts`), but still no `test:coverage`.

`bun run coverage:summary` (`scripts/coverage-summary.ts`) globs every `apps/*/coverage/coverage-summary.json`
and `packages/*/coverage/coverage-summary.json`, plus `coverage-stories/coverage-summary.json` when
present, into one markdown table. Packages without a report (no tests, or coverage not run) are
simply absent from the table. It also diffs against a `coverage-baseline/` directory when one
exists. `.github/workflows/ci.yml`'s `check` job restores that baseline from cache before calling
this script and re-saves it after main pushes, so PR job summaries show deltas vs `main`.

## Verification sweep

Run this gate before declaring a task complete or opening a PR.

```bash
bun run check              # lint + test + typecheck + build + knip + boundaries + size (Turborepo)
bun run check:affected     # same, scoped to packages affected by the diff
bun run knip               # Dead code / unused export analysis
bun run test:stories       # Every story renders in headless Chromium (needs Playwright browsers)
docker compose -f docker-compose.yml -f docker-compose.build.yml build   # Image builds from current sources
```

## Commands

```bash
bun install               # Install all deps (workspace-aware)
bun run build             # Build all packages (via Turborepo)
bun run build:affected    # Build only packages affected by the diff
bun run test              # Run all tests (via Turborepo)
bun run test:coverage     # Run tests with coverage (apps/server only has thresholds)
bun run coverage:summary  # Aggregate coverage-summary.json reports into a markdown table
bun run size              # Assert the MCP App bundle size budget (--strict to require the artifact)
bun run test:stories      # Run every Storybook story as a Vitest browser-mode smoke test
bun run test:stories:coverage # Same, plus render-path coverage into coverage-stories/
bun run typecheck         # TS across every workspace package
bun run typecheck:affected # Typecheck only packages affected by the diff
bun run lint               # Biome, repo-wide (NOT `turbo run lint` — infinite loop)
bun run lint:fix           # Biome, applying fixes
bun run boundaries         # turbo boundaries (tag-based layering check)
bun run check              # lint + test + typecheck + build + knip + boundaries + size
bun run check:affected     # same, scoped to packages affected by the diff
bun run dev                # Dev mode (via Turborepo)
bun run storybook          # Storybook on port 6006 (via Turborepo)
bun run build-storybook    # Static Storybook build to apps/storybook/storybook-static/
bun run shots --list       # List story ids
bun run shots <id>...      # Screenshot stories to PNGs under gitignored story-shots/
bun run fake-machine       # Serve recorded /api/* payloads on :8080 (--port N); no hardware needed

# Server only
cd apps/server
bun run start        # Start server
bun run dev          # Watch mode
bun run test         # Run server tests

# Rebuild the shot-graph MCP App single-file HTML
cd packages/shot-graph
INPUT=app.html bunx vite build

# Regenerate JSON schemas (after changing Zod schemas in loader.ts)
cd apps/server
bun run generate-schemas

# Regenerate the advertised tool contract (needed after any intended change to
# a tool's name, title, description, annotations, _meta, or schemas — the diff
# is the list of host permission grants the change invalidates)
cd apps/server
bun run generate-tool-contract

# Docker — default compose pulls ghcr.io/ljcl/gaggiuino-mcp; the override builds from source
docker compose up -d                                                     # published image
docker compose -f docker-compose.yml -f docker-compose.build.yml build   # local build
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
docker compose logs -f
```

## Turborepo

A `topo` transit node in `turbo.json` makes `test` and `typecheck`
cache-invalidate when upstream JIT packages change source. JIT packages
(`ui`, `design-system`) export raw TypeScript; only `shot-graph` produces a
build artifact (the single-file HTML bundle via Vite). The server has no build
step.

`test` and `test:coverage` also depend on `^build`. This is load-bearing, not
belt-and-braces: `server.ts` resolves `@gaggiuino/shot-graph/app.html` at module
load, and that export points at `dist/`, so `apps/server`'s tests cannot even
import the module until shot-graph has been built. Without the dependency,
`turbo run test build` is free to start `test` first and fail on a clean
checkout.

Biome runs as a root task (`//#lint`) — fast enough not to need decomposing.
Knip runs as a root task (`//#knip`) too: it is a whole-graph dead-code
analyzer, not something that decomposes per-package. `.github/workflows/ci.yml` runs knip as
part of the turbo `check` job, plus an informational JSON summary into the job summary.

The `react`, `test`, and `turborepo` lint domains are active and were verified
firing (`useJsxKeyInIterable`, `noFocusedTests`, `noUndeclaredEnvVars`).
`nursery.preset` is set to `recommended` but grants **no** rules under Biome
2.5.4 — a nursery rule such as `noImpliedEval` stays silent under the project
config and only fires via `--only`. Nursery rules appear to be opt-in by name
regardless of preset, which is reasonable for unstable rules. The key is kept
for forward compatibility, but do not read it as nursery coverage: there is
none. Enable a specific nursery rule by naming it explicitly if you want it.

Storybook uses co-located stories: story files in `packages/` are excluded from
the root `build` inputs (`!**/*.stories.{ts,tsx,mdx}`) so story edits do not
bust unrelated build caches.

Package boundaries are enforced via `turbo boundaries`. Five tags: `app`,
`mcp-app`, `shared-ui`, `design-system`, `config`. Apps cannot cross-import,
mcp-apps cannot cross-import, `design-system` sits at the bottom. There is no
`shared-data` tag — `normalize.ts` lives in `apps/server`, not a shared package.

Do NOT change root `lint` to `turbo run lint` (infinite loop).

## Docker

Built via `turbo prune @gaggiuino/server --docker`. The build stage uses
`--filter=@gaggiuino/server^...` to build only the server's workspace
dependencies (the shot-graph MCP App), excluding the server itself since it is
JIT. The runner is distroless and runs as UID 65534 with no shell.

The server resolves the MCP App at runtime via
`createRequire(...).resolve("@gaggiuino/shot-graph/app.html")`, so the package
must declare an `./app.html` export and a `dist/` build output, and the runner
stage must `COPY` that `dist/` explicitly.

The turbo version installed in the toolchain stage is read from root
`package.json`, so a Dependabot turbo bump cannot drift from the image. The Bun
base image version is pinned separately in the two `FROM oven/bun:` lines and is
watched by Dependabot's docker ecosystem (`.github/dependabot.yml`). Those pins
must stay equal to root `package.json`'s `packageManager`, which is what CI
installs Bun from — a skew means the tests run on a different runtime than the
one that ships. Dependabot only bumps the image side, so `ci.yml`'s **Bun
version skew** step fails the build when the two disagree; fix it by bumping
`packageManager` to match.

`*.local.yaml` is excluded from the build context — those files carry personal
equipment configuration and must never be baked into a published image. Users who
want them mount them read-only over `/app/apps/server/src/data/`; the commented
`volumes:` block in `docker-compose.yml` is the template.

### Compose files

`docker-compose.yml` consumes the published image
(`ghcr.io/ljcl/gaggiuino-mcp:${GAGGIUINO_MCP_TAG:-latest}`) and has no `build:` key, so a
fresh host runs the server without a checkout. `docker-compose.build.yml` is the override
that adds `build:` back for local source builds; it tags the result `:dev` and sets
`pull_policy: build` so compose can never silently substitute a pulled image for one you
meant to build. Keep the two files' service name in sync — the override merges by service
name, and a rename breaks the build path silently.

Deliberately **not** an auto-loaded `docker-compose.override.yml`: that would make every
`docker compose up` on a checkout build from source, which is the behaviour this change
moves away from.

### Verifying the image locally

`docker-compose.yml` uses `network_mode: host`, which works as intended on a
Linux Docker host but does **not** publish the port to the host on macOS
(Docker Desktop runs containers in a VM). On a Mac, `curl
http://localhost:8000/health` fails even when the container is perfectly
healthy — do not read that as a broken image. Check the container's own view
instead:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker inspect --format '{{.State.Health.Status}}' gaggiuino-mcp   # -> healthy
docker exec gaggiuino-mcp /usr/local/bin/bun --eval \
  'fetch("http://localhost:8000/health").then(r=>console.log(r.status))'
```

The runner has no shell, so `docker exec ... /bin/sh` fails by design; exec the
bun binary directly (it is the image's ENTRYPOINT) as above.

## CI

`.github/workflows/ci.yml` runs two jobs on every pull request against `main`, every push to
`main`, and a weekly schedule.

- **`check`** — checkout, the composite `.github/actions/setup` action (Bun, Turborepo cache,
  `bun install --frozen-lockfile`), a **Bun version skew** guard asserting root
  `package.json`'s `packageManager` matches the Dockerfile's `oven/bun` base tags, then
  Biome as a dedicated step outside turbo
  (`bun run lint --reporter=github`) so its GitHub reporter's `::error`/`::warning` annotations
  land inline on the PR diff — a turbo task-name prefix would stop GitHub parsing them. PRs then
  run `turbo run test typecheck build knip --affected` plus `turbo boundaries`; pushes to `main`
  run the same tasks unscoped (full check). Both continue with Playwright Chromium setup,
  `turbo run test:stories:coverage`, `turbo run test:coverage`, a coverage-baseline restore/publish
  (`coverage:summary` into the job summary, with a delta vs the cached `main` baseline), a baseline
  save on `main` pushes, the bundle size budget, and an informational knip JSON summary into the
  job summary.
- **`audit`** — `bun audit --audit-level=high`. Advisory (`continue-on-error`) on PRs and `main`
  pushes, since most findings are transitive deps with no local fix; hard-failing on the weekly
  `schedule` trigger so new advisories still surface between PRs.

### Bundle size budget

`scripts/bundle-size.ts` asserts raw and gzip ceilings on
`packages/shot-graph/dist/app.html` — the body re-sent as the `ui://shot-graph/app.html`
resource on every render — and prints a markdown table for the job summary. Budgets sit
~10% over the measured size; raising one is a deliberate one-line diff.

Two details are load-bearing. It runs **outside turbo** so the markdown reaches the job
summary without a task-name prefix on every line (same reason Biome does). And the CI step
builds shot-graph explicitly before calling it with `--strict`, because the PR path runs
`--affected` and would otherwise skip the build — the default is lenient so
`check:affected` does not fail locally, but a gate that silently no-ops in CI is not a gate.

Why recharts is not being replaced, with the measured per-dependency split, is recorded in
`docs/plans/2026-07-27-shot-graph-bundle-budget.md`.

### Required status checks

Branch protection requires three contexts, applied by `scripts/setup-branch-protection.sh`:
`check` (ci.yml), `docker` (docker.yml), and `pr-title` (pr-title.yml).

`docker` is an aggregate job that reports the matrix build's result rather than the build
legs themselves — a matrix job's status context embeds its parameters (`build (linux/amd64,
ubuntu-latest)`), so requiring those directly would leave protection waiting forever on a
context that stops reporting the day a runner label changes. It passes on `skipped`, which
is the docs-only PR case the `changes` path filter exists to produce.

`pr-title` runs on `pull_request_target`; its check run still attaches to the PR head SHA,
so requiring it works (verified against the live API).

Only `GITHUB_TOKEN` is required for `ci.yml` itself. Docker publishing (`docker.yml`),
release-please (`release-please.yml`), and the MCP registry publish (`publish-mcp.yml`) are
live — see Releases below. So is the Storybook Pages deploy (`storybook.yml`): the repo is
public and Pages builds from Actions, so a red run there is a real regression to chase.

## Storybook

`apps/storybook` renders co-located stories: story files live next to their component in
`packages/shot-graph/src` and `packages/ui/src`, plus standalone docs-style stories in
`packages/design-system/stories`. `main.ts` registers `@storybook/addon-mcp`,
`@storybook/addon-vitest`, `@storybook/addon-a11y`, and `@storybook/addon-docs`.

### Story smoke tests

Every story also runs as a Vitest browser-mode smoke test: `bun run test:stories` locally, cached
as the `//#test:stories` turbo root task (inputs: story/package sources and the Storybook config).
`.github/workflows/ci.yml`'s `check` job runs this on every PR and main push. The root
`vitest.stories.config.ts` (deliberately not `vitest.config.ts` — vitest searches parent
directories for a config, so a default-named root config would hijack `apps/server`'s bare
`vitest run`) defines a single `storybook` project via `@storybook/addon-vitest`'s `storybookTest`
plugin and renders each story in headless Chromium (Playwright). The project's `test.dir` must
stay at the repo root: the addon pins the project root to `apps/storybook` (configDir's parent)
but resolves the co-located story globs against `test.dir`, and with the two misaligned no story
files are found. Needs Playwright browsers (`bunx playwright install chromium --with-deps`).
Browser resolution: `launchOptions.executablePath` comes from
`resolveChromiumExecutablePath()` (`scripts/playwright-chromium.ts`), which returns `undefined` —
a no-op — whenever Playwright's own pinned build is installed (the normal case, local or CI). It
only resolves a path in sandboxes that ship a *different* pre-installed Chromium and block the
download (`PLAYWRIGHT_BROWSERS_PATH`/`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` pass through turbo for
this).

`bun run test:stories:coverage` runs the same smoke tests plus v8 render-path coverage of every
`packages/*` source the stories execute in the browser, writing `coverage-stories/coverage-summary.json`
(cached as `//#test:stories:coverage`, gitignored). The `storybookTest` addon pins the project root
to `apps/storybook`, so `coverage.allowExternal: true` in `vitest.stories.config.ts` is
load-bearing — without it every `packages/*` file is "external" and the report is empty. Plain
`bun run test:stories` stays coverage-free for fast local runs.

Each story also runs a per-story accessibility check via `addon-a11y`'s Vitest integration (axe-core),
visible in Storybook's Accessibility panel and in each test's reporting output. `preview.tsx` sets
**`a11y: { test: "error" }`**, so a violation *fails* `bun run test:stories` rather than being
recorded and passed over — the addon's own default is `"todo"`, which does the latter. The gate
covers **every** story in the repo, design-system docs stories included.

Practically, this means a new story cannot ship an unlabelled control, and it also means the
Storybook canvas is part of the contract: the preview decorator paints `document.body` with
`--color-background-primary` unconditionally. Scoping that to "only when a host theme is active"
left the dark stories drawing dark-mode text on Storybook's white canvas, which axe correctly
reported at 1.05:1 across four story files. A host always supplies a background; the canvas has to
model that or every dark story reports contrast failures that do not exist in production.

Two of the fixes made to clear the gate are worth not re-breaking:

- **De-emphasis is a colour step, never stacked opacity.** `opacity: 0.6` over
  `--color-text-secondary` composites to 3.4:1 and over `--color-text-tertiary` to 2.3:1; the
  legend's hidden and comparison states were worse, at 1.7:1 and 2.7:1. Comparison headers and
  legend states now step down to `--color-text-tertiary` at full strength (4.8:1 light, 4.7:1
  dark) instead.
- **The chart wrapper is `role="group"`, not `role="img"`.** Recharts renders the legend's toggle
  buttons *inside* `ResponsiveContainer`, and `img` makes its whole subtree presentational — which
  hides those buttons from assistive tech and trips axe's `nested-interactive` rule. The chart is
  interactive (`accessibilityLayer` gives the plot keyboard traversal), so `group` is also the
  honest description.

There is intentionally **no pixel-level visual-regression gate**.

### Story screenshots

`bun run shots --list` prints every story id; `bun run shots <id>...` renders one or more to PNGs
under the gitignored `story-shots/` directory (`scripts/story-shots.ts`). It builds (or reuses) a
static Storybook and drives headless Chromium via Playwright, sharing the same
`resolveChromiumExecutablePath()` fallback as the story smoke tests. Useful flags: `--width`/`--height`,
`--dark`, `--hover <selector>` (with `--hover-at x,y`), `--globals`, and `--url` to shoot a running
`bun run storybook` dev server instead of the static build.

These are **look-at-it artifacts for visual review, never committed baselines** — there is
deliberately no pixel-level visual-regression gate (see above), so nothing diffs these PNGs against
a prior run. They exist so a human or an agent without a reachable browser tab can see what a story
actually renders.

### Autodocs

`@storybook/addon-docs` generates a **Docs** page for every component from its stories, JSDoc, and
react-docgen prop table, enabled with the `autodocs` tag applied project-wide.

Placement is load-bearing: the tag must be a literal named export in the project's own
`apps/storybook/.storybook/preview.tsx` (`export const tags = ["autodocs"]`) — Storybook merges
named preview exports with the default `definePreview(...)` export, but the docs indexer only
picks up project tags declared there, not tags nested inside the `definePreview` call itself. The
addon is registered in both `main.ts` (manager UI) and the `definePreview` `addons` array (docs
rendering), mirroring how `addon-a11y` is wired.

### Agent access

- Storybook ships a Model Context Protocol server (via `@storybook/addon-mcp`)
  with story, docs, and test tools. The endpoint is pre-wired in `.mcp.json`:
  `storybook` at `http://localhost:6006/mcp` (while `bun run storybook` runs).
- The `main` Storybook is hosted on GitHub Pages at
  https://ljcl.github.io/gaggiuino-mcp/ (`storybook.yml`) for browsing; it is a
  static build with no MCP endpoint.

`storybook.yml` deploys on every push to `main` that touches `packages/**`,
`apps/storybook/**`, `bun.lock`, root `package.json` or `turbo.json`, the composite
setup action, or the workflow itself. It is live and green, so a failed Pages deploy
is a real regression to chase, not an expected state. It also carries a
`workflow_dispatch` trigger, so a transient Pages failure can be retried without
pushing a dummy commit.

`apps/storybook` depends on `@gaggiuino/ui` even though nothing in that workspace
imports it: Storybook finds ui's stories by directory glob in `main.ts`, and the
dependency is what puts ui in turbo's `build:storybook` task graph. Without it a
ui-only merge cache-hit and redeployed the previous `storybook-static` — the change
never reached Pages. `knip.config.ts` carries a matching `ignoreDependencies` entry,
and `apps/storybook/turbo.json` uses the repo's `dependsOn: ["topo", ...]` JIT pattern.

## Running without the machine

`bun run fake-machine` serves recorded `/api/*` payloads so the server has
something to talk to. `GAGGIUINO_URL=http://localhost:8080 bun run dev` then
gives a working `get_status`, `list_profiles`, `get_profile_info`,
`get_maintenance_status`, and two real ~190-sample captures for `get_shot_data`
and `view_shot_graph`. `/health` flips to `machine.state: "ok"` after the first
tool call, and fills `machine.versions` only once something reads `/api/settings`
— which is the observed-not-probed design being visible rather than asserted.

**It is split across two files, and the split is the whole design.**

- `apps/server/src/__fixtures__/fakeMachine.ts` — payloads and a pure
  `routeFakeMachine(method, pathname)`. Under `src/`, so it is type-checked, in
  the coverage set, and reachable from a test.
- `scripts/fake-machine.ts` — a port and a listener, nothing else. At the
  **repo root**, which is what keeps it out of the image: `apps/server/Dockerfile`
  copies `apps/server/src`, `apps/server/scripts` and `packages/shot-graph/dist`,
  and root `scripts/` is never in the build context. Putting it in
  `apps/server/scripts/` — the intuitive home, next to `generate-schemas.ts` —
  would have shipped it in every published image.

Three rules keep it honest, and each replaced something easier:

- **Recorded, not invented.** A hand-written fake serves the types we *expect*,
  agrees with our schemas by construction, and proves nothing. The status payload
  is the repo's one hardware capture (decimal strings, real booleans); settings,
  profile definitions and maintenance come from the vendored reference; the shots
  are real captures reached through `packages/shot-graph`'s `./fixtures` export.
  `/api/profiles/all` is the one route with no recorded body anywhere — the
  reference gives it one line and no example — so its docblock says outright that
  its shape is `MachineProfileSchema`'s and its ids are the sparse set observed
  while verifying #105, rather than letting it look as recorded as the rest.
- **Validated by the real client, not by a restated schema.** `fakeMachine.test.ts`
  mounts the route table as one msw handler and drives `createClient` over it, so
  every payload goes through `jsonReader` → `safeParse` → `MalformedUpstreamError`.
  Parsing with the schemas directly would prove much less: only two are exported,
  and `MachineSettingsSchema` / `MachineMaintenanceSchema` are `z.looseObject({})`
  and accept anything — so those two are asserted through their tools instead.
  It mounts at `MACHINE_URL` rather than an invented host because `MACHINE_URL` is
  read once at module load, so an env var set inside a test arrives far too late
  for `handleToolCall`.
- **Writes are refused with a 501, not acknowledged.** The fake holds no state, so
  a faked `select_profile` is contradicted by the next `list_profiles`. Declining
  is the honest answer and it is what keeps this stateless — the moment it grows a
  mutable profile list it has become a second server.

Shot ids are offset by `FAKE_SHOT_ID_BASE` (900,000,000). The machine numbers
shots small and sequentially, so a fixture shot sharing an id with a real one is
one that can be mistaken for the user's in a conversation or a bug report. The
gap between the two synthetic ids is deliberate too: it makes `walkShotsBack`
absorb 404s rather than walk a tidy contiguous run.

**It does not replace hardware.** It cannot reproduce the 503 an ESP32 returns
while writing a shot to flash, its one-request-at-a-time serialisation, the
WS-only profile update path, or a firmware revision's type inconsistencies. The
value is confined to process-level and in-host paths — which are real, since the
MCP App had never been rendered in a real host without a machine.

Landing it also removed the test scaffolding from the published image. The runner
`COPY`s all of `apps/server/src`, so every `*.test.ts`, every `__fixtures__` file
and `test-setup.ts` were shipping — unreachable at runtime (msw is a
devDependency the runner never installs) but present. `.dockerignore` now excludes
them, which is what makes "the fake never ships" true of its payloads and not just
its executable.

## Testing the MCP endpoint

```bash
# Health check
curl http://localhost:8000/health

# Initialize session
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}}'
```

## Environment Variables

| Variable              | Default                  | Description                                       |
| --------------------- | ------------------------ | ------------------------------------------------- |
| `GAGGIUINO_URL`       | `http://gaggiuino.local` | Gaggiuino machine URL                             |
| `PORT`                | `8000`                   | Server port                                       |
| `HOST`                | `0.0.0.0`                | Bind address                                      |
| `MCP_PUBLIC_URL`      | _(unset)_                | Public https origin, no path. With `MCP_OAUTH_SECRET`, enables OAuth and is advertised as the `resource` |
| `MCP_OAUTH_SECRET`    | _(unset)_                | ≥32-char signing key for self-issued tokens; keep it stable across restarts |
| `MCP_OAUTH_PASSPHRASE_HASH` | _(unset)_          | scrypt hash for the consent page. Required when the built-in AS runs; `bun run hash-passphrase` |
| `MCP_OAUTH_ISSUER`    | _(unset)_                | External issuer to delegate to. Resource-server-only mode; refuses the two above |
| `MCP_ALLOWED_ORIGINS` | _(empty)_                | Browser origins allowed on `/mcp`; `*` allows any |
| `MCP_ALLOWED_HOSTS`   | _(empty)_                | `Host` values to accept; empty disables the check |
| `LOG_LEVEL`           | `info`                   | `debug`/`info`/`warn`/`error`/`silent`            |

Adding a variable here means adding it to `.env.example` too — that is the file users copy,
and `envExample.test.ts` fails the build if the two disagree in either direction. See
AGENTS.md ".env.example is checked against the code that reads it".

## The HTTP surface

`index.ts` is bootstrap only — read the environment, serve, wire the signals —
which is why it stays out of the coverage set. Everything it delegates to is
covered:

- `http.ts` — `createFetchHandler({ security })` returns a `fetch` plus the live
  session map. Tests drive it with real `Request` objects and never bind a port.
- `mcpAuth.ts` — `loadSecurityConfig` / `checkRequest` / `describeSecurity`,
  plus `handlePreflight` / `corsHeaders`. `checkRequest` returns the `Response`
  to send, or `undefined` to proceed.
- `mcpSession.ts` — the bounded, expiring transport registry. Generic over a
  minimal `ClosableSession`, and its clock is injected, so its tests assert
  "after 31 minutes of silence" without a timer or a wait.

Five things about the gate are load-bearing:

- **`/health` is routed before it.** The container HEALTHCHECK presents no
  credential and no `Origin`; a liveness probe that needs a token reports the
  token's health.
- **Origin is checked before the token.** Otherwise the 401/403 split tells an
  unauthenticated cross-origin prober whether authentication is configured at
  all.
- **An absent `Origin` always passes.** Non-browser clients (Claude Desktop,
  `curl`) send none, so the empty default allowlist blocks exactly the
  browser-initiated cross-origin case and nothing else. That is what lets the
  default be deny-all without breaking every install.
- **An allowed origin gets CORS headers, not just a pass.** Clearing
  `checkOrigin` is half a cross-origin request; without
  `Access-Control-Allow-Origin` on the way back the browser discards a response
  the server was happy to send, so `MCP_ALLOWED_ORIGINS` allowed an origin that
  still could not talk to the server. `handlePreflight` answers `OPTIONS` (which
  used to 405), and `Access-Control-Expose-Headers: mcp-session-id` is
  mandatory — it is not CORS-safelisted, and a Streamable HTTP client that
  cannot read it has no session to continue with. Preflights settle *before*
  the token check, because a browser sends `OPTIONS` with no `Authorization`
  header by design; they still require an allowlisted Origin.
- **Every rejection is logged** (`security.rejected`, with method, origin, and
  status). Silent 401s and 403s made the two failures an operator actually hits
  indistinguishable from the server being unreachable.

Validation runs as middleware in `fetch` rather than through the transport's
`enableDnsRebindingProtection` / `allowedHosts` / `allowedOrigins` options:
those are all `@deprecated` as of SDK 1.30.0 in favour of external middleware,
and doing it here rejects a request before the body is read or a transport is
allocated.

`secretsMatch` hashes both values before `timingSafeEqual`. That is not
decoration — `timingSafeEqual` throws on a length mismatch, and the obvious
guard (`a.length !== b.length`) leaks the secret's length. Two HMAC-SHA256
digests are always 32 bytes, and the key is random per call and discarded, so
the digest is evidence only within the call and cannot be password storage —
which is what CodeQL keeps mistaking it for. With `MCP_AUTH_TOKEN` gone its
only caller is `verifyPassphrase`, which passes the two scrypt outputs it has
just derived; that makes "do not put a KDF in here" easier to argue, not
harder, since one has already run.

`scripts/test-auth.sh` is the **OAuth discovery probe**, and it is meant to run
from **outside the LAN**. It automates Anthropic's own diagnostic checklist: both
well-known documents, `resource` matching the URL under test, the authorization
server's metadata (RFC 8414 with the OIDC fallback) advertising S256 and either
CIMD or a `registration_endpoint`, a `401` carrying `resource_metadata` and
`scope`, no cross-host redirect, and origin validation. Probing localhost tests a
path no connector takes, and the failure that bites most often — `MCP_PUBLIC_URL`
disagreeing with the URL the user typed — is invisible there. `jq` is optional;
the status-code checks still run without it.

### OAuth, and why an auth refusal is not a tool result

**OAuth is the only credential.** `MCP_AUTH_TOKEN` was a control the owner could
not use: the connector is added at the account level so it works on claude.ai,
Desktop and iOS, and on a personal plan the "Add custom connector" dialog
exposes only an OAuth Client ID and Secret — there is no request-header field,
and a local stdio bridge cannot run on iOS. The token could never leave the
client, so the two write tools were permanently refused on the one deployment
this repo is built for. It went in 2.0.0, and `authenticate` now has one
credential path rather than a precedence rule between two.

**Its removal shipped behind a one-release tombstone, now itself removed
(#114).** Through 2.0.x, `loadServerConfig` kept reading `env.MCP_AUTH_TOKEN`
solely to throw a `ConfigError` while it had a value, because a hard delete
would have been silent in the only direction that matters: an unread variable
is an ignored variable, so a deployment that gated `/mcp` with the token —
which is what the README told those users to do — would have come up open on
the next image pull with nothing in the log. The major version was not the
protection either, because `docker.yml` publishes `latest` on every
default-branch push and `docker-compose.yml` defaults to it, so the documented
deployment received the change before a 2.0.0 tag existed; refusing to start is
what made it visible. With the tombstone gone, nothing reads the variable — a
value still set today is somebody's stale `.env` line, and the only remaining
mention in code is the unauthenticated-startup warning, which names the removal
so that log line explains itself. The `.env.example` entry and `turbo.json`
pass-through left with the tombstone, in the same commit, because
`envExample.test.ts` requires template and code to agree in both directions.

`oauth/` holds the resource-server half: `metadata.ts` (RFC 9728 document and the
`WWW-Authenticate` challenges), `tokens.ts` (sign/verify), `scopes.ts`, and
`scopeGate.ts`. OAuth is on when **both** `MCP_PUBLIC_URL` and
`MCP_OAUTH_SECRET` are set; either alone is a `ConfigError` at startup, because
silently falling back is how somebody exposes a tunnel believing it is gated.

Five things are load-bearing.

- **An authentication failure is an HTTP status, never an `isError` result.**
  This is the documented exception to "expected failures are results, not
  exceptions" and to "`handleToolCall` is the only dispatch point", and it is a
  protocol fact rather than a style choice: a `200` carrying `isError: true`
  produces **no auth prompt at all** — Claude passes the text to the model as a
  tool result and moves on. Turning the 401 or the 403 back into an `isError`
  would be correct by house style and would silently break the connector.
- **The scope gate therefore lives in `handleMcp`, before
  `transport.handleRequest`.** Once a tool handler is running its return value is
  already destined to be wrapped in a `200`. The protected set is *derived* from
  `annotations.readOnlyHint === false`, so a new write tool inherits the gate;
  `scopeGate.test.ts` pins the derived set so the inheritance stays visible.
- **Both scopes are named on an `insufficient_scope` 403**, never just the
  missing one — scopes from an earlier step-up are not reliably carried forward,
  and the value is cached per user per server for about fifteen minutes.
- **The well-known routes sit ahead of the gate, beside `/health`.** A document a
  client fetches *in order to* authenticate cannot itself require
  authentication. They are not mounted at all while OAuth is unconfigured, so an
  existing install is unchanged.
- **`MCP_PUBLIC_URL` never comes from the `Host` header.** It is what an access
  token's `aud` is checked against, and `Host` is attacker-controlled. Audience
  comparison goes through the SDK's `checkResourceAllowed` rather than a string
  equality, because Claude sends the RFC 8707 canonical form, which need not be
  byte-identical to what the user typed.

The 401's `resource_metadata` pointer is the part that actually fixes the
reported failure: without it claude.ai web and mobile fail against a URL Claude
Code connects to happily, because Claude Code probes `.well-known` as a fallback
and the hosted surfaces rely on the header.

### The built-in authorization server

`/oauth/authorize`, `/oauth/token` and
`/.well-known/oauth-authorization-server`, mounted by `oauth/router.ts` — a
factory, so codes, failed-attempt counters and refresh generations belong to a
handler rather than a process and two tests cannot see each other's state.

`codes.ts` holds authorization codes and nothing else. Filling it requires the
passphrase, which is what makes its cap survivable — see the consent-token entry
below for the store that did not have that property.

**It is small because of CIMD.** The `client_id` *is* a URL; `/oauth/authorize`
fetches it, checks the document is self-referential, and checks `redirect_uri`
against its `redirect_uris`. No client registry, no `POST /register`, no client
secret. Claude only picks CIMD when the metadata advertises **both**
`client_id_metadata_document_supported: true` **and** `"none"` in
`token_endpoint_auth_methods_supported`; lose either and it goes hunting for a
`registration_endpoint` that deliberately does not exist. A test asserts the
pair, because `OAuthMetadataSchema` is what serialises the document and a schema
that dropped the flag would fail silently.

Things worth not re-breaking:

- **The two Claude documents are pinned as a fallback**, used only when the live
  fetch fails, and which path was taken is logged. The live document still wins,
  so a redirect URI Anthropic adds works without a release here.
- **`resolveClient` refuses anything that does not resolve publicly.** The
  `client_id` comes from the caller and this server fetches it, so without the
  guard a stranger aims it at the LAN. Loopback, RFC 1918, link-local
  (`169.254`, where cloud metadata lives) and `100.64/10` — the tailnet this
  server is probably inside — are all refused.

  **The tests assert the call count, not the return value**, because every
  `toBeUndefined()` in that file is satisfied equally by a guard that blocks the
  fetch and by one that fetches first and discards the result — and only one of
  those is a guard. Two tests stub DNS so a *hostname* resolves privately (an IP
  literal never exercises the resolve-then-decide path at all) and assert `fetch`
  was never called; one of them splits the answer public-then-private, which is
  what `every` is for and what a `some` would wave through. Both were verified to
  fail for the right reason by mutating the implementation before landing.

  `resolvesPublicly`'s docblock carries a dated **accepted residue**: it resolves
  the hostname and `fetch` resolves it again, so a short-TTL record can answer
  public for the check and private for the connection. Accepted because the fetch
  is https-only (which already excludes the plain-http LAN targets that motivate
  the threat), the response is never echoed, and the deployment is single-user.
  Closing it needs a custom undici dispatcher pinning the connection to the
  resolved address — **explicitly out of scope**, and recorded so a future reader
  treats it as a decision rather than an open action.
- **Loopback redirect URIs ignore the port, everything else is exact.** RFC 8252
  §7.3 requires it for the IP literal, and Anthropic's guidance extends it to
  `localhost`, because Claude Code declares `http://localhost/callback` and then
  binds an ephemeral port. The exemption must not leak to remote hosts.
- **No RFC 9207 `iss` on the authorization redirect.** One self-hosted server
  correlated adding it with Anthropic's backend ceasing to call `/token` at all.
  Unconfirmed, and not worth testing on the owner's own connector.
- **`/oauth/token` reads `application/x-www-form-urlencoded`.** A JSON-only body
  parser answers 415 and the flow dies at the last step. Errors are RFC 6749
  codes — `invalid_grant`, never a custom one — because Claude's refresh
  handling keys on them.
- **Refresh tokens rotate**, and the new one is returned in the response that
  supersedes the old one. Replay detection is an in-memory generation counter,
  which is **bounded detection and not revocation**: a restart forgets it. A
  deliberate weakening for a single-user server, named in the code so it is not
  quietly undone.
- **Every signed thing is domain-separated by HKDF `info`**, so a refresh token
  can never be replayed as an access token and a consent token can never be
  redeemed as either, even though one secret mints all three. `signToken` and
  `verifyToken` are typed against `BearerTokenKind` rather than `TokenKind`, so
  the split is a compile error as well as a different key. The separation test
  asserts the *reason* is `bad-signature`, not merely that the token was refused:
  a consent payload carries no `aud`/`iss`/`sub`, so it fails `decodeClaims` as
  `malformed` whatever key signed it — meaning a bare `ok: false` passes just as
  happily when the two share one key, which is the thing being tested.
- **The consent page's `request_token` is stateless, and that is an availability
  fix rather than a style choice.** It used to be a key into a bounded map that
  `GET /oauth/authorize` filled *before* checking any credential, so anyone who
  could reach that route could park 65 requests, evict the consent page the owner
  had open, and turn their submit into "this page has expired" (#119). The GET
  path never consults the rate limiter — deliberately; a page that has asked for
  nothing yet should be free — so the flood was unmetered. Raising the cap moves
  the number without changing the shape, so the store went instead:
  `signConsentToken` HMACs the pending authorization plus an expiry under a third
  HKDF `info`, and there is nothing left to evict.

  This is the same bounded-map question `mcpSession.ts` answers the opposite way,
  and the difference is the recovery path, not the capacity. An evicted MCP
  session gets the spec's 404 and re-handshakes on its own; an evicted consent
  page gets a dead end and a human who has to start over. Eviction is survivable
  there and *is* the attack here.

  **The stated cost is that a consent token is no longer single-use**, so a
  captured submission can be replayed inside its TTL. Acceptable, and the reason
  is worth keeping: the token carries no authority on its own, the passphrase is
  checked on every submission, and a submission an attacker captured *contains*
  that passphrase — so single-use never protected against the one attacker it
  looked like it did. A replay yields a fresh authorization code, and the code is
  where single-use actually lives. `jti` is in the payload so a seen-set could
  restore it later without putting a store back on the unauthenticated path — and
  it is what makes the retry page's token differ from the one just submitted,
  which would otherwise be byte-identical on a fast clock.

  `verifyConsentToken` rebuilds the `PendingAuthorization` field by field rather
  than spreading the payload. The store it replaced got that wrong in the quiet
  direction: `recall` was declared to return a `PendingAuthorization` and actually
  handed back the map entry with the store's own `expiresAt` still attached.
- **An unrecognised scope is dropped, not refused.** Claude appends
  `offline_access`; refusing the whole request over a scope this server does not
  model would break the flow it exists for.

The consent page (`oauth/consent.ts`) shows the **host of the `client_id` URL**,
never the self-asserted `client_name` — the host is the part TLS and the
self-reference check actually establish, and `client_name` is whatever the
document's author typed. `apps/server` has no dependency on
`@gaggiuino/design-system` and must not gain one; if the page grows a template
engine, that is a signal it is doing too much.

`MCP_OAUTH_PASSPHRASE_HASH` is **mandatory** whenever the built-in authorization
server runs — an unauthenticated consent page hands a token to anyone who finds
the URL, so it is a startup failure rather than a degraded mode. It is the one
place a real KDF belongs: scrypt to derive, `secretsMatch` to compare.

### Delegating to an external issuer

`MCP_OAUTH_ISSUER` puts the server in **resource-server-only mode**: the
built-in AS does not mount, protected-resource metadata advertises the external
issuer, and `externalIssuer.ts` verifies RS256/ES256 tokens against the issuer's
JWKS. Unset, nothing changes — the built-in AS is still the default.

**The rename is the change.** `OAuthConfig.issuer` used to mean two things at
once — this server's public origin *and* the token issuer — which was invisible
while they were the same string. They are now `publicOrigin` and `issuer`, and
the distinction is load-bearing in one place above all: `metadataUrl` builds the
401's `resource_metadata` pointer, and building it from `issuer` would send a
client to the *IdP* for a document only this server publishes, breaking the exact
discovery path that header exists to fix. Rule of thumb: anything describing
*this server* takes `publicOrigin`, anything describing *who mints tokens* takes
`issuer`.

`OAuthConfig` is a **discriminated union** on `external`, not one interface with
optional fields. That is what lets `authenticate` reach `config.oauth.secret` in
the built-in branch without a `?? ""` fallback — which would have quietly
verified tokens against an empty key — and it makes `asAuthServer` a one-line
narrowing instead of a cast.

Five things in `externalIssuer.ts` are load-bearing:

- **The algorithm allowlist is a security control.** Only RS256 and ES256 reach a
  key import, and the check happens *before* the key lookup. That is what makes
  algorithm confusion unreachable: an attacker who signs `HS256` with the
  issuer's public key — which is public by design — presents an `alg` this server
  will not look up at all. `alg: "none"` dies in the same branch. A test asserts
  no network call is made for such a token, because the ordering is the property.
- **A `kid` miss may refetch, but not on demand.** Rotation has to work without a
  restart, so an unrecognised `kid` refetches the JWKS — and unauthenticated
  callers reach that path, since a token is checked before anything knows it is
  real. `REFETCH_COOLDOWN_MS` bounds it to one refetch a minute, turning a flood
  of random `kid`s into a no-op.
- **The discovery document's own `issuer` is checked** (RFC 8414 §3.3). Without
  it a redirect, or a typo landing on another tenant, silently substitutes a
  different key set for the one the operator named.
- **RFC 8414 inserts its well-known segment before the issuer's path; OIDC
  appends after.** For `https://idp/realms/home` those are genuinely different
  URLs, not a suffix apart, and Keycloak and Authentik issuers always carry a
  path. `parseIssuerUrl` therefore permits a path where `parsePublicUrl` rejects
  one, and normalises the trailing slash once so `iss` compares byte-for-byte.
- **No private-address guard, deliberately** — the opposite of `clients.ts`. A
  `client_id` arrives from the caller, so fetching it is an SSRF sink; this
  arrives from the operator's own environment, and pointing it at Authentik on
  the LAN or a tailnet is the intended deployment.

`MCP_OAUTH_SECRET` and `MCP_OAUTH_PASSPHRASE_HASH` alongside `MCP_OAUTH_ISSUER`
are a **startup failure, not an ignored setting**. Both belong to the AS that no
longer mounts, so a deployment carrying them holds a belief about this server
that is false, and silently dropping them is how that belief survives to the day
it matters.

`authenticate` and `checkRequest` are async now, because fetching a key is. One
consequence worth keeping: `checkRequest` no longer evaluates `authenticate` as a
default argument, so Origin and Host are checked *first* and a cross-origin probe
can never make this server call out to its IdP.

`writeToolDisabled` (`tools.ts`) answers only the third state — no authorization
server configured at all — and with the shared secret gone it is a single check
on `oauth` rather than a question about which of two credentials is present.
That state must stay an `isError`: a 401 pointing at metadata that does not
exist produces Anthropic's documented "Couldn't reach the MCP server."

### Session lifetime

Sessions expire on an idle TTL (30 min) and are capped (64). The two are not
redundant: the TTL reclaims sessions whose client vanished without a DELETE — a
dropped tunnel, a restarted host — and the cap bounds anything that outruns it.

**The cap evicts rather than refuses, and `reserve()` therefore always
succeeds.** It used to answer 503 over the cap, which read as prudent and was
not: Claude opens a fresh session per tool call and never sends a DELETE — five
`session.opened` records in forty seconds with no `session.closed` between them,
observed on the real deployment once `describeInitiator` made it visible.
Nothing that arrived inside the 30-minute TTL is sweepable, so ~64 tool calls in
half an hour ended a working conversation, and the advice that 503 carried
("retry shortly") is another `initialize` — the thing that filled the map.

What makes eviction survivable is the 404 rule below: an evicted client's next
request gets the spec's own re-handshake signal and recovers on its own, where a
503 on `initialize` has no recovery at all. That asymmetry is the argument, not
the raw capacity number — the cap now bounds *memory* rather than conversation
length. `reserve()` still sweeps first, because reclaiming a client that is
genuinely gone always beats closing one that is merely oldest, and it evicts by
**least recently seen** rather than oldest-opened, so the session doing the work
is the last to go.

Three details are load-bearing. `evict()` deletes each entry before calling
`close()`, because the real transport's `onclose` calls straight back into
`delete` — closing first means mutating the map mid-iteration. Each `close()` is
individually caught, so one transport that refuses to die does not strand the
rest. And the eviction walks a **snapshot** of ids sorted by `lastSeen` rather
than re-finding the oldest in a `while`: it frees more than one slot when a cap
lowered between restarts has left the map over the new ceiling, and a finite
list cannot spin the way a loop conditioned on `sessions.size` could if an entry
ever failed to leave the map. `maxSessions` is clamped to at least 1 so
`reserve()`'s promise stays total. All have tests named after the failure.

That shape was also chosen against the coverage rule: the obvious version —
`while (size >= cap)` around a `leastRecentlySeen()` that returns
`string | undefined` — needs a guard for an `undefined` that `cap >= 1` makes
unreachable. Restructuring removed the dead branch rather than paying for it, or
worse, weakening the threshold to accommodate it.

`onEvicted` reports `idle` or `capacity`, and the distinction is the diagnostic:
a run of `capacity` evictions is the signature of a host that is not reusing its
sessions, which is a different problem from clients going away.

`index.ts` handles **SIGTERM as well as SIGINT** — `docker stop` sends SIGTERM,
so handling only SIGINT meant the container was killed after the grace period
with every session still open. It stops the listener before draining, so nothing
lands on a transport that is closing.

**An unrecognised session id is a 404 on every method**, and the distinction
from 400 is the whole point: 404 is the Streamable HTTP spec's signal that a
session is gone and the client should re-handshake with `initialize`. GET and
DELETE used to answer 400 — "your request is malformed" — for an expired session
as well as a missing header, and no client recovers from that by re-handshaking,
so a session the idle TTL reclaimed stranded its client instead of prompting a
reconnect. 400 now means only what it says: the `Mcp-Session-Id` header is
absent.

That rule carries more weight than it used to: it is what the capacity eviction
above is built on. Closing a live session is only acceptable because its client
gets a 404 and re-handshakes, so anything that softened this back toward a 400
would turn every eviction into a stranded client.

### Logging, health, and startup validation

`logging.ts` writes one JSON object per line to stderr, each with an `event`
name (`tool.call`, `session.opened`, `security.unauthenticated`,
`config.invalid`, …). The level resolves **lazily on first use**, not at module
load — that is what lets `test-setup.ts` call `setLogLevel("silent")` and have
it apply regardless of import order. `createLogger` takes an injectable sink and
clock so `logging.test.ts` asserts whole records without capturing stderr; the
tool-call assertions in `server.test.ts` deliberately spy on the real
`console.error` instead, so the default sink stays in the loop.

Every tool call is one record with `tool`, `durationMs`, and `outcome`. On an
expected failure it also carries `reason` — the same actionable text the model
got, because a bare `"error"` throws away the only useful part. A genuine bug
logs `tool.error` at error level with the stack.

`session.opened` carries `client`, `clientVersion`, and `protocolVersion`, read
from the `initialize` request itself rather than the server's later
`oninitialized` callback so they are known when the session id is minted. An
opaque uuid answered neither question an operator has when a host misbehaves:
which client is this, and is it re-handshaking every turn or reusing a session?
One `session.opened` per turn from the same client name is the signature of a
host that threw its session away — which is worth knowing before blaming this
server for a connector that keeps re-prompting.

`/health` returns JSON (`buildHealth` in `health.ts`) and **stays 200 while the
machine is unreachable**. That is load-bearing: the container HEALTHCHECK reads
the status code, and the espresso machine is switched off most of the day.
Upstream state is a field, never the status code.

`machine.state` and `machine.versions` are observed from the requests the server
already makes (`recordUpstream` / `recordVersions` in `client.ts`), not from a
probe — the upstream is an ESP32
on Wi-Fi and a timer-driven ping would load the one device the caching work in
#30 is trying to spare. So an unused server honestly reports `unknown` and
`versions: null`. Any HTTP response counts as reachable, including a 404: it
proves the network path works. `resetClient` clears both observed values along
with the client, so one test's failed fetch cannot leak into the next.

The versions come out of the `/api/settings` aggregate the server already
fetches, which is why `GET /api/settings/versions` stays on `client.ts`'s
not-called list. `buildHealth` is **synchronous**, and `health.test.ts` asserts
it: fetching inside it would put the client's 20s overall timeout inside a probe
whose Docker `HEALTHCHECK --timeout=10s` fires first, so three consecutive
failures would restart a container whose only problem is that the espresso
machine is switched off — 2,880 requests a day to read a field that changes when
the user flashes firmware. The "a cache hit must never `recordUpstream("ok")`"
rule does not extend to versions: a version string is a fact about the machine,
not a claim that it is answering now.

`buildHealth` **projects** the three documented fields rather than spreading the
observed object. `MachineVersions` is loose — correctly, at the client boundary —
but `/health` is unauthenticated so the container's HEALTHCHECK can reach it, and
a spread would publish whatever key a future firmware adds under `versions`
without anyone deciding it should be public.

`config.ts` validates `PORT` and `GAGGIUINO_URL` before the port is bound and
names the offending variable. `PORT` previously went through a bare `Number()`
with no NaN guard, and `GAGGIUINO_URL` was never parsed — a missing `http://`
surfaced much later as a failed fetch blamed on the machine being offline.

## Backlog and issue tracking

Improvements and changes are tracked as GitHub Issues and triaged on the
"gaggiuino-mcp backlog" Project board (https://github.com/users/ljcl/projects/2).

- Labels: `type:*` mirrors Conventional Commit types (feat, fix, perf, refactor,
  docs, test, chore, ci); `area:*` maps to monorepo packages (server, mcp-app,
  ui, design-system, ci-release, docker, repo).
- Priority (P1/P2/P3), Effort (S/M/L), and Status live as Project board fields,
  not labels, so triage data is not duplicated across two systems.
- Link PRs with `closes #N`; the PR title is the Conventional Commit that
  release-please turns into a release.
- After an epic, breaking change, or wide refactor merges, run the
  `backlog-sweep` skill.

### Editing the project board

- **Local sessions**: `gh project` commands. Discover ids with
  `gh project item-list 2 --owner ljcl --format json` and
  `gh project field-list 2 --owner ljcl --format json`.
- **Cloud and iOS sessions**: the `github-projects` MCP server from `.mcp.json`
  (auth via `GH_MCP_PAT`): `projects_list` / `projects_get` / `projects_write`,
  with the operation named in a `method` parameter. Field names
  (`field_names: ["Status"]`), single-select option names
  (`updated_field: {"name": "Status", "value": "Ready"}`), and
  `item_owner`+`item_repo`+`issue_number` item addressing all work — the
  numeric ids below are needed only by the gh CLI path.

Board constants: project number 2, owner `ljcl`, node id `PVT_kwHOABzAhM4BeYXa`,
database id `24741338`.

| Field | Node id | Numeric id | Options |
| --- | --- | --- | --- |
| Status | `PVTSSF_lAHOABzAhM4BeYXazhYzCy0` | `372443949` | Backlog `f75ad846`, Ready `a057814c`, In progress `47fc9ee4`, In review `2ba31d84`, Done `98236657` |
| Priority | `PVTSSF_lAHOABzAhM4BeYXazhYzCzg` | `372443960` | P1 `fc38b480`, P2 `d2ef2472`, P3 `5197fbf4` |
| Effort | `PVTSSF_lAHOABzAhM4BeYXazhYzCzk` | `372443961` | S `ed6278ac`, M `c5c30106`, L `7270adf2` |

## Releases

Releases are automated by release-please (`.github/workflows/release-please.yml`).

- PRs are squash-merged, so the **PR title becomes the only commit on `main`**. The PR
  title therefore must be a Conventional Commit, or release-please sees no releasable
  change and silently skips (the run still reports success). The `pr-title.yml` workflow
  enforces this on every PR, and the repo squash setting is pinned to `PR_TITLE` so the
  title is always what lands. Branch commits can be messy; only the PR title matters.
- Use Conventional Commits: `fix:` gives a patch bump, `feat:` a minor bump,
  `feat!:` or a `BREAKING CHANGE:` footer a major bump. `chore:`, `docs:`, `refactor:`,
  and `ci:` are valid titles but produce no release.
- release-please opens a `chore: release X.Y.Z` PR that bumps root `package.json`,
  the top-level `server.json` version, and `CHANGELOG.md`. (The OCI package tag inside
  `server.json` is NOT templated — `publish-mcp.yml` stamps it from the git tag at
  publish time, since release-please's json updater cannot rewrite part of a string.)
- Merging that PR pushes the `vX.Y.Z` tag (via the `RELEASE_PLEASE_PAT` secret), which
  triggers `docker.yml` to publish `ghcr.io/ljcl/gaggiuino-mcp:X.Y.Z` and `:X.Y`, and
  `publish-mcp.yml` to publish `server.json` to the MCP registry via GitHub OIDC.
  The registry proves image ownership by pulling the GHCR image and checking its
  `io.modelcontextprotocol.server.name` label (set in `apps/server/Dockerfile`, must
  match `name` in `server.json`); `publish-mcp.yml` therefore polls GHCR until
  `docker.yml`'s manifest exists before publishing.
- That GHCR wait distinguishes three states, and the distinction is the whole point.
  The **existence** poll is authenticated (GHCR creates packages private even under a
  public repo, so an unauthenticated poll answers `unauthorized` forever and times out
  blaming a Docker run that succeeded). Once the manifest exists, a second request with
  an **anonymous** pull token decides: 200 proceeds, 401/403 fails immediately telling
  you to make the package public, 404 retries briefly for tag propagation. Package
  visibility is UI-only — GitHub exposes no REST endpoint for it.
- Published manifests carry supply-chain attestations: an SPDX SBOM and max-mode
  provenance per architecture from BuildKit, plus a Sigstore-signed provenance statement
  for the multi-arch index pushed to GHCR as a referrer. Verification commands are in
  `SECURITY.md`.
- Manual `git tag vX.Y.Z` still works as a fallback; both `docker.yml` and
  `publish-mcp.yml` trigger on `v*` tags regardless of how they are created.
- Commits that only touch `docs/`, `.agents/`, or `.claude/` are excluded from release
  parsing (`exclude-paths` in `release-please-config.json`), so a mislabeled `fix:` on a
  planning doc cannot cut an empty release. A commit touching excluded and non-excluded
  paths still counts.
- Dependabot uses `fix(deps):` for production npm deps and Docker base images (they ship
  inside the published image, so a bump must cut a patch release to reach users) and
  `chore(deps)`/`chore(ci)` for dev tooling and GitHub Actions (no shipped artifact, no
  release). The npm groups are split by dependency-type so one grouped PR never mixes
  the two prefixes.
- To force a specific version, land an empty commit on `main` with a `Release-As` footer
  (`git commit --allow-empty -m "chore: force release" -m "Release-As: X.Y.Z"`); the
  release PR retargets on the next run. `release-please.yml` also has a
  `workflow_dispatch` trigger for re-running after a transient failure or a Release-As
  commit without pushing anything.
