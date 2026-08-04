# Vendored upstream API reference

`rest-api.md` and `websocket.md` in this directory are verbatim copies of the
Gaggiuino project's own API documentation, retrieved **2026-08-04** from:

- https://github.com/GAGGIUINO/gaggiuino.github.io/blob/master/docs/rest-api/rest-api.md
- https://github.com/GAGGIUINO/gaggiuino.github.io/blob/master/docs/rest-api/websocket.md

They are vendored rather than linked so `client.ts` can cite a stable path with
line numbers that do not move under it, the same reasoning that puts
externally-sourced Agent Skills under `.agents/skills/` with a lockfile.

## How to read them

**These documents settle *existence* questions, not *shape* questions.** They are
hand-written, and they demonstrably disagree with themselves about types — the
same field is a JSON string in one section and a boolean in another
(`lcdDarkMode` at rest-api.md L283 vs L118; `forcePredictive` and
`hwScalesEnabled` at L330-331 vs L117), and the CORS note at L532 ("All
endpoints include `Access-Control-Allow-Origin`") is contradicted twenty
lines earlier at L528. Four of the endpoints this server calls have no response
example at all.

So the loose zod schemas at `client.ts`'s upstream boundary are **policy, not
drift**, and this reference is not evidence for narrowing one. What it is good
for: which endpoints exist, which methods they take, what a field means, and
which ones this server has deliberately decided not to call.

## Refreshing

Re-download both files, then re-run the audit in issue #102 — the point of
vendoring is that a diff here is reviewable. Every citation in `client.ts` is a
line reference into these files, so a refresh that moves lines means those
citations need re-checking.

`docs/` is in `release-please-config.json`'s `exclude-paths`, so refreshing
these files cannot cut an empty release on its own.
