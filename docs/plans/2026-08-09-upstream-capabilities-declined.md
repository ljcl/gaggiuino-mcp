# Five upstream capabilities, assessed and declined

[mxkissnr/gaggiuino-local-profiler](https://github.com/mxkissnr/gaggiuino-local-profiler)
is a large, good, actively developed espresso project covering the same hardware
as this server — a Home Assistant profiler with a shot store, a scoring engine,
an analytics dashboard and a flavour taxonomy. Read in source on 2026-08-08 for
ideas that fit a stateless MCP server.

**Provenance and standing**, as in `docs/upstream/README.md`'s errata and the
sibling GaggiMate note: everything said below about *their* code comes from
reading that source, not from running it, and the reading was targeted rather
than exhaustive. Where this note says a thing is absent from their codebase, read
"was not found" rather than "does not exist". Claims about *this* repo are
verified against the code here.

Anyone who finds it will ask why this repo does not have its most visible
features. This note is the answer, so that starts from a decision rather than
from silence — the same instrument
`2026-08-04-live-telemetry-websocket-mqtt.md` already is for live telemetry.

**Filed as a decision note, not a feature issue.** The work here is writing the
reasoning down.

## Licensing, stated once

Upstream is GPL-3.0 and this repo is not. Everything below draws on *described
behaviour* — what a feature does, what its thresholds are, what protocol facts
it establishes — and takes no code. Where something was salvaged, it was
re-derived and re-measured here; the carve-outs say where.

## What was salvaged, and where it went

Two things in this batch were worth keeping, and both were carried rather than
declined:

- **Target-relative temperature and pressure deviation** — the rescuable half of
  the shot score. #134, merged in PR #152 as `tempDeviationC` and
  `pressureDeviationBar` on `OutcomeMetricsSchema`.
- **A precedence rule for contradictory taste symptoms**, channeling outranking
  taste — the one genuinely reusable idea near the flavour wheel. #136, shipping
  in this same batch, in the dial-in guidance's "Editing a Profile" section.

The line running through every decline below is the same one those two respect:
**report what was measured, and let the model judge it.**

## 1. The weighted 0–100 shot score

`lib/score.js` grades a shot from six weighted factors — pressure 25,
temperature 20, duration 20, brew ratio 20, extraction yield 20, channeling 15 —
normalised by the weights actually applied. It is genuinely well built, and it
is the single most tempting thing in their repo.

Two problems, and the second is the real one.

- **Two of six factors need data this server does not have.** Brew ratio and
  extraction yield both require the dose, and yield additionally requires a TDS
  reading. Neither is something the espresso machine knows; upstream gets them
  from a per-shot annotation form backed by SQLite. There is no store here and
  no per-shot user input.
- **The remaining four bake one person's taste into a number the model would
  report as a measurement.** The bands are opinions — 7–9.5 bar average, 25–35 s,
  ratio 1.8–2.5. A model told "this shot scored 62" treats 62 as a fact about
  the shot rather than as agreement with a particular preference, and the
  disagreement is invisible at the point of use. Their own code has the honest
  version of this: a bean's own recommended temperature and ratio *override* the
  generic bands when set — which is exactly the per-user calibration a stateless
  server cannot hold.

**Reopens if** the server ever acquires per-user calibration it can attribute —
at which point the thing to build is still not a score, but a comparison against
the user's own stated target.

## 2. The flavour wheel

A 111-node SCA/WCR-structured taxonomy in six languages, plus a 68-entry synonym
table and a three-stage matcher.

Declined because the consumer here is a language model, which already has this
vocabulary. Shipping a taxonomy so the model can look up "blackcurrant → berry →
fruity" solves a problem this server does not have. Their matcher exists to turn
free-text bean tags into sunburst chart nodes, and there is no sunburst here.

Worth recording as a **negative finding**, because it is the thing you would
expect to be there and was not found: no mapping from flavour notes to extraction
advice turned up anywhere in their codebase. The wheel is descriptive, not
diagnostic. So
"upstream has a flavour wheel" is not evidence that a taste taxonomy improves
dial-in advice — nobody has demonstrated that, there or here.

**Reopens if** a structured taste vocabulary turns out to be needed for
something other than display — which would have to be shown, not assumed.

## 3. The analytics dashboard

Calendar heatmap, weekday × hour grid, bean ranking with last-5-vs-previous-5
momentum, per-grinder and per-basket breakdowns, dial-in progression, origin
world map.

Three independent blockers, each sufficient:

- **The store.** Every panel reads their whole local shot history out of SQLite.
  This machine keeps a *bounded* history with holes, and `walkShotsBack` costs
  one request per shot against a device that serves one at a time and is
  switched off most of the day. A 365-day calendar is several hundred sequential
  requests to an ESP32 — the exact load the caching design exists to prevent.
- **The metadata.** Bean, grinder, grind setting, basket, dose — all
  user-entered, all with nowhere to live.
- **The surface.** A second MCP App re-pays the React + ext-apps bundle floor
  (~430 KB raw / ~103 KB gzip per
  `2026-07-27-shot-graph-bundle-budget.md`) and needs new tools, and the
  advertised tool list is a permission-grant key.

One piece was separable and was carved out rather than declined: their
`_tempStability` is a mean absolute deviation of measured from target
temperature, skipping samples where the target is zero. That needs one shot's
own datapoints and nothing else — it became `tempDeviationC` in #134. The
zero-target rule was kept for a reason re-derived here rather than inherited:
a target of 0 means the profile is driving flow instead, which is how Londinium
spends its first five seconds (65 of 191 samples). Upstream's own reason for the
rule is not recorded anywhere we read.

**Reopens if** the machine grows an authoritative history index served in one
request (already an upstream ask in the live-telemetry note) *and* somewhere
appears to put per-shot metadata. Both, not either.

## 4. The bean → starting-profile generator

Synthesises a profile skeleton from bean metadata — roast level, process,
recommended ratio — as a starting point for profile dial-in.

Declined on the same input problem as the score: bean metadata is user-entered
and unstored. And the alternative is already better than the feature. A model
with `get_dial_in_guidance` and `list_profiles` recommends among profiles the
machine actually holds, which is the answer that does not require inventing one
— and since #99 it can read a real profile definition and explain *why* it
recommends that one. Generating a skeleton would replace a grounded
recommendation with a guess.

**Reopens if** users turn out to want profiles that do not exist yet more often
than they want the right one of the profiles they have. Nothing suggests that.

## 5. Maintenance and burr-wear tracking beyond the machine's own log

Five services with dual shots/days thresholds and an 80% "due soon" gate, plus
cumulative grinder throughput since the last burr swap.

`get_maintenance_status` (#100) already reports the service log the machine
keeps itself, and AGENTS.md records why its schema describes the *shape* of a
service record rather than enumerating known services — so a firmware that
starts logging water-filter changes is carried through with no schema change.

Everything upstream adds on top is either a **threshold policy** — an opinion,
and one that belongs in guidance if anywhere — or **grinder state the espresso
machine has no knowledge of**. Burr wear in particular is about a device that is
not on the network and never will be.

**Reopens if** the firmware itself starts publishing due/overdue state. Then it
is a reading rather than an opinion, and it arrives through the existing schema
by design.

## The shape of all five

Four of the five decline for one of two reasons, and it is worth naming them
because the next tempting feature will be one or the other:

- **It needs a store or per-shot user input**, and this server has neither
  (score, dashboard, bean generator).
- **It is an opinion presented as a measurement** (score bands, maintenance
  thresholds). A model repeats a number as fact, so a threshold that encodes one
  person's taste is worse here than in a UI a human reads with their own
  judgement attached.

The flavour wheel is the exception, and it declines for the most useful reason
of all: the capability is already in the model.
