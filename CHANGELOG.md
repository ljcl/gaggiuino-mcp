# Changelog

## [3.0.0](https://github.com/ljcl/gaggiuino-mcp/compare/v2.0.0...v3.0.0) (2026-08-08)


### ⚠ BREAKING CHANGES

* **server:** measure temperature and pressure against the profile's own targets ([#152](https://github.com/ljcl/gaggiuino-mcp/issues/152))

### Features

* **server:** delegate token issuing to an external issuer with MCP_OAUTH_ISSUER ([#148](https://github.com/ljcl/gaggiuino-mcp/issues/148)) ([f87856c](https://github.com/ljcl/gaggiuino-mcp/commit/f87856ca343c8d633cdceef5b19f08afb98765f6))
* **server:** measure temperature and pressure against the profile's own targets ([#152](https://github.com/ljcl/gaggiuino-mcp/issues/152)) ([3438190](https://github.com/ljcl/gaggiuino-mcp/commit/343819048717412039150a69985e9eb438f5db84))
* **server:** populate phases[].events with measured pressure collapses ([#150](https://github.com/ljcl/gaggiuino-mcp/issues/150)) ([6bdb702](https://github.com/ljcl/gaggiuino-mcp/commit/6bdb7026e426be05a960effdd822794577dbf3e3))


### Bug Fixes

* **server:** evict the quietest session at the cap instead of answering 503 ([#126](https://github.com/ljcl/gaggiuino-mcp/issues/126)) ([f5bda09](https://github.com/ljcl/gaggiuino-mcp/commit/f5bda094e68e6544f07201e76bd2435674ff537c))
* **server:** make the consent token stateless so /oauth/authorize cannot be evicted ([#130](https://github.com/ljcl/gaggiuino-mcp/issues/130)) ([9a5728e](https://github.com/ljcl/gaggiuino-mcp/commit/9a5728e3b8b8c4091cc8e1c08bc6195c3b6edd27))
* **server:** segment shot phases by the same rule the chart uses ([#149](https://github.com/ljcl/gaggiuino-mcp/issues/149)) ([75c3261](https://github.com/ljcl/gaggiuino-mcp/commit/75c32617a245374571b26e198bf0590989ba37c6))

## [2.0.0](https://github.com/ljcl/gaggiuino-mcp/compare/v1.7.0...v2.0.0) (2026-08-07)


### ⚠ BREAKING CHANGES

* **server:** remove MCP_AUTH_TOKEN in favour of OAuth ([#123](https://github.com/ljcl/gaggiuino-mcp/issues/123))

### Features

* **server:** remove MCP_AUTH_TOKEN in favour of OAuth ([#123](https://github.com/ljcl/gaggiuino-mcp/issues/123)) ([2e9d04f](https://github.com/ljcl/gaggiuino-mcp/commit/2e9d04f80b82ac6157932408382973868f8d4ab0))

## [1.7.0](https://github.com/ljcl/gaggiuino-mcp/compare/v1.6.0...v1.7.0) (2026-08-06)


### Features

* **server:** add a built-in OAuth authorization server ([#118](https://github.com/ljcl/gaggiuino-mcp/issues/118)) ([6a07a91](https://github.com/ljcl/gaggiuino-mcp/commit/6a07a913ebd7e68348bb0a5867c8070dbab48be1))
* **server:** serve OAuth metadata and verify access tokens on /mcp ([#117](https://github.com/ljcl/gaggiuino-mcp/issues/117)) ([eb41bfc](https://github.com/ljcl/gaggiuino-mcp/commit/eb41bfc7f59750dc81b01ed0cbbd45a47b0e69b8))
* **server:** support the main-7889b7d firmware's new REST surface ([#104](https://github.com/ljcl/gaggiuino-mcp/issues/104)) ([7ad4500](https://github.com/ljcl/gaggiuino-mcp/commit/7ad450021fd66e31be27f6ce8245ccadff3649c6))


### Bug Fixes

* **deps:** bump @vitejs/plugin-react from 6.0.4 to 6.0.5 in the production-minor-patch group ([#96](https://github.com/ljcl/gaggiuino-mcp/issues/96)) ([c3cb658](https://github.com/ljcl/gaggiuino-mcp/commit/c3cb65860e1c7dd4f5f98c2f2c496ecd8970a264))

## [1.6.0](https://github.com/ljcl/gaggiuino-mcp/compare/v1.5.0...v1.6.0) (2026-07-31)


### Features

* **server:** package the dial-in workflows as prompts ([#87](https://github.com/ljcl/gaggiuino-mcp/issues/87)) ([0aa6e83](https://github.com/ljcl/gaggiuino-mcp/commit/0aa6e83816510b0ce6c0384ecde3ab7a171ae409))

## [1.5.0](https://github.com/ljcl/gaggiuino-mcp/compare/v1.4.0...v1.5.0) (2026-07-30)


### Features

* **server:** make the machine the source of truth for its own data ([#85](https://github.com/ljcl/gaggiuino-mcp/issues/85)) ([944f1ec](https://github.com/ljcl/gaggiuino-mcp/commit/944f1ec6b6b001dadcaa46f0af83244ebdf125e7))

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
