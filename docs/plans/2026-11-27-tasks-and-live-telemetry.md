# MCP Tasks and the live-telemetry decision

Re-run of `2026-08-04-live-telemetry-websocket-mqtt.md` against MCP Tasks
(`io.modelcontextprotocol/tasks`), for #306. That note names its own reopen
trigger — "a host-supported push primitive that reaches the model … the crux is
gone and this note should be re-run from the top" — and Tasks became generally
available in Claude and Claude Code on 2026-11-24. This note answers one
question: **does Tasks change the decision, and if so, what does it let this
server build?**

It is a decision document. #307 is the build, and it starts only if this note
says so.

## Sources, and how much of each was read

- The Tasks extension overview, <https://modelcontextprotocol.io/extensions/tasks/overview>,
  and the 2026-07-28 schema in `modelcontextprotocol/ext-tasks`
  (`schema/2026-07-28/schema.ts`). Read in full.
- Claude Code's MCP page, <https://code.claude.com/docs/en/mcp>, sections
  "MCP tasks for server authors" and "Automatic backgrounding". **Read only as a
  summary**: the page is ~180 KB and the fetch returned the task sections as
  model-extracted text, not verbatim. Every claim below about what Claude Code
  does comes from that summary and is marked so. Its "MCP tasks in the cloud",
  resume and per-request time-limit subsections were not read at all.
- Anthropic's announcement, <https://claude.com/resources/articles/skills-over-mcp-tasks-and-more>.
- A spike against `@modelcontextprotocol/server` 2.4.0 in this repo (below).

## What Tasks is, in the shape this server would use it

- A `tools/call` answers at once with `resultType: "task"`, a `taskId`, a
  `status` of `working`, `ttlMs`, and an optional `pollIntervalMs`.
- The host polls `tasks/get` with the `taskId`. That is the only place the
  result is delivered. Status text rides on `statusMessage`; there is no separate
  progress channel.
- States are `working`, `input_required`, `completed`, `failed` and `cancelled`;
  the last three are terminal. `tasks/cancel` is cooperative.
- Opt-in is per request, not per tool: the client declares the extension in each
  request's `io.modelcontextprotocol/clientCapabilities`, and a server **must
  not** return a task to a client that did not.

## 1. Does Tasks meet the reopen trigger?

**In part, and the part it does not meet is a host behaviour nobody has
checked.**

What it removes is the specific objection to the old note's Candidate 1,
shape 1 — "a tool that blocks until the shot ends". A shot runs 25–45 s, past
`overallTimeoutMs` (20 s) and past the point hosts abandon a call. With Tasks
the call does not block: it answers inside the per-request timer, and the host
polls for the result. That objection is gone.

What it does not obviously provide is the other half of trigger 2: a result that
reaches the model **without the user typing anything**. The sources say:

- Claude Code (summary): "the result arrives as a task notification when the
  call settles". The page does not say whether a notification starts a new model
  turn while the session is idle, or waits for the user's next message.
- claude.ai and the Claude apps: the announcement says Claude "keeps working and
  picks up the result when it's ready". Nothing says how the result reaches the
  model there.

That difference is the whole value of the feature. If a completed task wakes the
model, "I'm pulling a shot" gets an analysis the moment the shot is saved, with
no second message. If it waits for the next message, the user still has to come
back and ask — and `get_latest_shot_id` already answers that question in one
call. So the build is only worth its cost on a host that wakes the model, and
**that is the first thing to check on a live host** (see "Preconditions").

### What it does not revive

Tasks is a result that arrives later, not a stream. None of the old note's other
objections move:

- **A server-held WebSocket** is still 33% of a three-connection cap and a log
  firehose, now with a place to put one summary rather than frames.
- **An app-held WebSocket** is still blocked by mixed content (`ws://` from an
  HTTPS page) before anything else.
- **MQTT** still needs a broker this server cannot assume.
- **Mid-shot control** is still a non-starter: a model turn plus an approval
  prompt does not fit inside a 30 s shot.

So the decision on transports stands. What Tasks opens is a REST-only shape the
old note never considered, because it needed a channel that did not exist.

## 2. What would a task poll, and how often?

The old note's Candidate 3 objection was polling `/api/system/status` from the
app while the ESP32 is busiest. A task can avoid most of that.

**The completion signal is `/api/shots/latest`, not the brew switch.**
`brewSwitchState` is the physical switch (`mockMachineStatusFromHardware`
carries it as a boolean). It says the user flipped the switch, not that the
machine has written the shot record, and on a profile whose stop condition ends
the pump the switch may stay on after the shot is over. The record appearing is
what "done" means to every other tool, so the task completes when the latest
shot id moves past the id it saw when it was created. The brew switch is not
needed at all.

**The server polls only when the host polls.** Nothing runs in the background:
each `tasks/get` makes at most one machine read. That keeps the
observed-not-probed rule — no timer loads the ESP32 — and it means a host that
stops polling, for any reason, stops the machine reads with it.

**The existing cache is the rate limit.** `/api/shots/latest` is cached for five
seconds (`LATEST_SHOT_TTL_MS`). A host polling faster than that is answered from
the cache, so the machine sees at most one request per five seconds per server,
whatever the host does. The task asks for `pollIntervalMs: 5000` to match.
Claude Code clamps the interval to 250–30,000 ms (summary), so the cache is
doing real work. A cache hit still must not call `recordUpstream("ok")`; nothing
here changes that rule.

**Cost:** about one small GET every five seconds while a task is open. A 40 s
shot plus the time to save it is roughly 10 requests to the smallest endpoint
the machine has. A transient failure (the 503 while it writes the shot to flash)
leaves the task `working`; it does not fail it.

**Not measured.** Whether `/api/shots/latest` answers promptly while a shot
runs, and how long after the pump stops the record appears, can only be measured
on hardware. The fake machine has no live state. Both are preconditions below.

## 3. Where does task state live?

**In the `taskId` itself.** The server is stateless and keeps nothing between
requests, so the task carries what it needs: the baseline shot id and the
creation time, sealed with an HMAC under a per-process key, the same pattern
`confirmation.ts` uses for `requestState`. Each `tasks/get` verifies the id,
reads the machine, and works out the status from scratch. There is no map to
bound, evict or lose.

Constraints this has to meet, from Claude Code (summary):

- A `taskId` is at most 128 printable ASCII characters with no spaces. A
  baseline id, a timestamp and a truncated base64url MAC fit in well under 64.
- Claude Code reads `-32602` from `tasks/get` as an unknown task, keeps asking
  for up to five minutes, then reports it unknown. A forged or expired id gets
  that answer.
- A restart changes the key, so every open task becomes unknown. For a task
  measured in minutes, that is the right failure: the user asks again, and
  `get_latest_shot_id` answers from history.

`tasks/cancel` needs almost nothing: a host that cancels stops polling, and with
lazy polling that alone stops the machine reads. A small bounded set of
cancelled ids lets a later `tasks/get` answer `cancelled`, as the spec expects.
Losing it on restart costs nothing, because the restart already made the task
unknown.

## 4. Who owns a task?

Not bound to the caller's principal, for the same reason `confirmation.ts`
gives: binding would protect nothing. The result is the latest shot's summary,
which any caller with a token can read through `get_latest_shot_id`, and the
`tasks/*` methods go through the same security gate as everything else. With
#278's single bearer token there is one principal anyway.

## 5. Which clients?

- **A client that declared the extension** gets a task.
- **Any other client** gets an `isError` result that says the tool needs a host
  with MCP tasks and points at `get_latest_shot_id`. Never a task: the spike
  below shows the SDK does not enforce this, so the server must.
- Claude Code already moves any MCP call that runs longer than two minutes to
  the background (summary). That does not help here: this server's calls finish
  or fail inside 20 s, by design.

The tool is new, so it re-keys no existing grant. It does appear on hosts without
tasks — `tools/list` never varies by client — which is why its description and
its refusal both name the alternative.

## 6. SDK: the spike

Against `@modelcontextprotocol/server` 2.4.0, on the low-level `Server`, behind
`createMcpHandler` (the shape `http.ts` uses):

- A `tools/call` handler that returns `resultType: "task"` with the task fields
  goes out on the wire as a task. The SDK adds an empty `content: []` and leaves
  the rest alone.
- `tasks/get` and `tasks/cancel` register with the three-argument
  `setRequestHandler`, the same way `skills/list` does, and the SDK stamps
  `resultType: "complete"` on their answers.
- The SDK already checks `Mcp-Name` against `params.taskId` for the three
  `tasks/*` methods (SEP-2663).
- **The SDK does not check the capability.** It returned a task to a client that
  had not declared the extension. The server has to refuse that itself.
- There is no 2026-07-28 tasks receiver in the SDK; `@modelcontextprotocol/ext-tasks`
  covers the 2025-11-25 revision only. The server writes the three handlers
  itself. That is small: the state is in the id, so each handler is a verify, one
  read and a shape.

## Decision

**Build #307, behind two preconditions, as a REST-only task.**

The old decision — no live telemetry over WebSocket or MQTT — **stands
unchanged**. What changes is that one REST-only feature now has a channel:
`wait_for_shot`, a task that completes when the next shot is saved and returns
the same summary `get_latest_shot_id` would. It needs no new transport, no
background loop and no stored state, and it costs the machine about one request
every five seconds while it is open.

### Preconditions, checked before the build is merged

1. **On a live host, a completed task reaches the model without a user message.**
   Check Claude Code (local) and claude.ai, the owner's main surfaces. If neither
   wakes the model, decline #307: it would only duplicate `get_latest_shot_id`,
   and this note's reasoning should be recorded as the reason.
2. **On hardware, `/api/shots/latest` answers during a shot, and the record
   appears within a known time after the pump stops.** If the endpoint stalls or
   503s for most of a shot, the poll rate needs another look before anything
   ships.

### Shape #307 should take

- A new read tool, `readOnlyHint: true`, `openWorldHint: true`.
- `taskId` = baseline shot id + creation time + HMAC, under 128 characters.
- `tasks/get` reads `/api/shots/latest` through the existing 5 s cache. Moved
  past the baseline: `completed`, with `get_latest_shot_id`'s text and
  `structuredContent`. Not yet: `working`, with elapsed time in `statusMessage`.
  Past ten minutes: `failed`, saying no shot was saved — a shot shorter than
  5 s is not recorded, which is the usual reason.
- `pollIntervalMs: 5000`, `ttlMs` ten minutes.
- `tasks/cancel` acknowledges and records the id in a small bounded set.
- A client without the extension gets the refusal described in 5.
- `SERVER_CAPABILITIES` declares the extension, and every method it implies is
  answered (AGENTS.md "Answer every method the advertised capabilities imply").

### Rejected

- **A background poller per task.** It loads the ESP32 on a timer, which the
  caching layer exists to prevent, and keeps polling after a host gives up.
  Lazy polling costs nothing when nobody is waiting.
- **An in-memory task map.** It needs bounds, eviction and a story for restarts,
  and it buys nothing a signed id does not.
- **Polling `brewSwitchState` for completion.** The switch is not the shot
  record, and it adds a second endpoint to the busy window.
- **Refusing to build until Tasks streams frames.** That is a different feature
  (live curves), and the transport objections to it are untouched. The useful
  thing — "tell me when it's done" — does not need frames.

## What would change this decision

- **Precondition 1 fails** on every host the owner uses: decline #307, and amend
  this note with what each host did.
- **A host gains a push into model context mid-turn.** That is trigger 2 in
  full. Re-run the old note's crux, because frames would then have somewhere to
  go.
- **The ESP32 turns out to serve `/api/shots/latest` badly during a shot.**
  Re-measure the interval before shipping, or poll only after the pump stops.
