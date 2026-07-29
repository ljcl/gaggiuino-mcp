# Changelog

## [1.4.0](https://github.com/ljcl/gaggiuino-mcp/compare/v1.3.0...v1.4.0) (2026-07-29)


### Features

* **mcp-app:** label phase regions, chart temperature, and fix the tooltip ([#83](https://github.com/ljcl/gaggiuino-mcp/issues/83)) ([0085fd7](https://github.com/ljcl/gaggiuino-mcp/commit/0085fd77403a0d2764a848b4c440c78cc963ef9d))

## [1.3.0](https://github.com/ljcl/gaggiuino-mcp/compare/v1.2.0...v1.3.0) (2026-07-28)


### Features

* **ui:** make the chart palette colorblind-safe and flip the a11y story gate ([#79](https://github.com/ljcl/gaggiuino-mcp/issues/79)) ([a715255](https://github.com/ljcl/gaggiuino-mcp/commit/a71525587dfa2653a8887858e20b5829022fc2cb))


### Bug Fixes

* **server:** keep host permission grants from silently expiring ([#82](https://github.com/ljcl/gaggiuino-mcp/issues/82)) ([33248a8](https://github.com/ljcl/gaggiuino-mcp/commit/33248a8e2767f11b7ebc2430c86c0fcb77d333d0))

## [1.2.0](https://github.com/ljcl/gaggiuino-mcp/compare/v1.1.0...v1.2.0) (2026-07-28)


### Features

* **server:** harden the runtime for exposure over a tunnel ([#75](https://github.com/ljcl/gaggiuino-mcp/issues/75)) ([9bd8c96](https://github.com/ljcl/gaggiuino-mcp/commit/9bd8c962d237bc1f5dddc1afa2f05729ce347d14))


### Bug Fixes

* **server:** answer every discovery method and make the origin allowlist work ([#78](https://github.com/ljcl/gaggiuino-mcp/issues/78)) ([acc2fbc](https://github.com/ljcl/gaggiuino-mcp/commit/acc2fbcfc34f49a93ae45c1f9afad1a3b7092929))

## [1.1.0](https://github.com/ljcl/gaggiuino-mcp/compare/v1.0.1...v1.1.0) (2026-07-27)


### Features

* **docker:** consume published GHCR image in docker-compose ([#68](https://github.com/ljcl/gaggiuino-mcp/issues/68)) ([b577284](https://github.com/ljcl/gaggiuino-mcp/commit/b577284b32ff48bbfa67121bc9e8b2a5498f2b1a))
* **mcp-app:** extract shared app shell with error, retry, and host capabilities ([#72](https://github.com/ljcl/gaggiuino-mcp/issues/72)) ([e1f27de](https://github.com/ljcl/gaggiuino-mcp/commit/e1f27de8a9d99e31ca2e7faf8348e5ade026903b))


### Bug Fixes

* apply dark tokens under data-theme and derive token docs from tokens.css ([#70](https://github.com/ljcl/gaggiuino-mcp/issues/70)) ([a7c4f5c](https://github.com/ljcl/gaggiuino-mcp/commit/a7c4f5c1769e0306eaba8981cd92eb7b3c5caf0f))
* **deps:** bump recharts from 3.10.0 to 3.10.1 in the production-minor-patch group ([#64](https://github.com/ljcl/gaggiuino-mcp/issues/64)) ([51871ae](https://github.com/ljcl/gaggiuino-mcp/commit/51871ae79c0c7a519f99ca44fbe9b86bb84a1b14))
* enforce tool schemas with zod at a single dispatch point ([#67](https://github.com/ljcl/gaggiuino-mcp/issues/67)) ([f6d72e0](https://github.com/ljcl/gaggiuino-mcp/commit/f6d72e0f2eb511c975a14324faab7fc41b4090a5))

## [1.0.1](https://github.com/ljcl/gaggiuino-mcp/compare/v1.0.0...v1.0.1) (2026-07-25)


### Bug Fixes

* **deps:** bump the production-minor-patch group with 8 updates ([#12](https://github.com/ljcl/gaggiuino-mcp/issues/12)) ([bcd4253](https://github.com/ljcl/gaggiuino-mcp/commit/bcd42535b582214e740ecaa2fca57d9d63e79afc))
* **deps:** sync bun.lock with the merged production dependency bumps ([#16](https://github.com/ljcl/gaggiuino-mcp/issues/16)) ([12bda0c](https://github.com/ljcl/gaggiuino-mcp/commit/12bda0c4c6718fafc6da207b8bc6ac3756092666))
