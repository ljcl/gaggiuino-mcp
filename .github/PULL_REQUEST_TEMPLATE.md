<!--
PR title must be a Conventional Commit (feat:, fix:, chore:, docs:, ...).
Squash-merge makes the title the ONLY commit on main, and release-please
derives the release from it — a non-conforming title silently skips the
release. `feat:` bumps minor, `fix:` bumps patch, `feat!:` bumps major.
See AGENTS.md "Releases".
-->

## Summary

<!-- What changed and why? -->

Closes #

## Verification

- [ ] `bun run check` (or `bun run check:affected` on a branch) passes
- [ ] `bun run test:stories` passes for UI changes, if applicable
- [ ] Storybook sweep for UI changes (desktop + `claudeIosCard` viewport), if applicable
