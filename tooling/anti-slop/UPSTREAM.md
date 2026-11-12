# Anti-slop provenance and local adoption

- Source: https://github.com/dmmulroy/anti-slop
- Revision: [`13909c9e07590f5a85d93c62712259fe14a883f7`](https://github.com/dmmulroy/anti-slop/tree/13909c9e07590f5a85d93c62712259fe14a883f7), retrieved 2026-11-04.
- Copied manually: upstream `src/` (including all generic/Effect regression suites) and root `LICENSE`. Each downloaded file was verified against its Git blob SHA before copying. No upstream installer, skill installer, global hook, or synchronization script was executed.
- License: MIT; see `LICENSE`. The embedded ESLint Stylistic engine retains its separate MIT `src/vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md`.
- `upstream-files.json` records the original source/license Git blob hashes as the merge base for future updates. Fetch an update into a separate empty staging directory, review changes against this revision and the local adaptations below, then rerun the regressions and repository checks.

## Runtime and policy

The root exact `oxlint` and `@oxlint/plugins` versions match Vite+'s bundled 1.89.0 runtime. The upstream snapshot used 1.78.0; the copied RuleTester suites and actual Vite+ integration probes verify compatibility with the installed pair. Upgrade these packages together with Vite+, not independently.

`vite.config.ts` is the policy owner: all 18 generic rules, all five opt-in Effect rules (this project uses Effect v3), and native `oxc/no-accumulating-spread` are errors. `bun run lint:anti-slop` runs that same Vite+ lint configuration with warnings fatal. It is intentionally not a baseline or changed-lines-only scan. Existing diagnostics are failures requiring review, not authorization for concurrent product refactors.

The rules are AST/lexical-scope heuristics, not TypeScript, authorization, or architectural proofs. Effect diagnostics can mention APIs from a newer Effect major, such as `catchReason`; use the actual Effect v3 APIs and validated contracts rather than copying that suggestion literally.

The vendored source is excluded from general lint/format to preserve the reviewed snapshot and intentionally invalid fixture strings. It is still typechecked with the project's strict settings and covered by `bun run test:anti-slop`. Owned integration/configuration files remain linted. The integration probes verify exact runtime versions, complete rule registration, actual Vite+ rejection/acceptance, and nonzero exit behavior.

## Local source adaptations

1. `src/rules/require-readable-spacing-cli.test.ts`: replace the pnpm subprocess with Node and the installed local Oxlint CLI resolved from its package metadata. This avoids a pnpm dependency and does not execute a downloaded installer.
2. `src/shared/dictionary-types.ts`: use `unsafeMembers[0] ?? null` for the already nonempty intersection branch. This satisfies Hyori's `noUncheckedIndexedAccess` without an assertion or disabled check; behavior for a valid nonempty AST is unchanged.

## Owned TypeScript versus third-party JavaScript

Hyori's handwritten architecture configs/tests and shared PostCSS config use `.ts`, with Node 24+ native stripping and ESLint's explicit native-TS flag. `tooling/architecture/checker.d.ts` describes the consumed public contract of the separate Fernando JavaScript checker. That vendored checker's upstream `.js`, its dependencies, generated app `.output`/route/environment artifacts, and installed dependencies are not handwritten Hyori tooling and are not blindly renamed or rewritten.

The exact `tooling/artcraft/capabilities-v1/native-clock-probe/driver.js` lint/format exclusion preserves an executed Bun-generated evidence artifact. Its handwritten TypeScript source/preparer remain scanned. The authored-source gate permits only that exact retained path with its Bun-generated source header; `test:deployment` runs the byte-integrity regression. `PROVENANCE.md` beside the artifact records generation and frozen identities; `scripts/artcraft/native-clock-provenance.test.ts` verifies the executed bytes, receipt, and source witness. This is not an ArtCraft directory exemption or a rule/plugin change; format the owned TypeScript before generating a new independently retained proof, not the historical executable.
