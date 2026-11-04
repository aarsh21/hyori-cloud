# Architecture acceptance

The vendored `../fernando-lint` is Fernando's executable adoption profile and regression suite, including its lockfile. Its original implementation is kept separate from Hyori configuration. Parent-authorized audit maintenance may update that lockfile without changing checker semantics. Oxlint/Oxfmt remain the primary general lint/format tools; this supplementary ESLint profile retains type-aware architecture and React Compiler diagnostics.

## Owners and coverage

`eslint.config.ts` registers the actual portable feature, SDK React, app/HTTP host and design-system source roles. DOM keyboard synchronization is confined to the explicitly listed DS host adapter. A directory name grants no implicit effect allowance. `tsconfig.json` supplies resolution through owned facades so aliased/re-exported effects and known transports remain detectable.

- Portable feature hooks/components: effects and raw/registered transports are rejected.
- Generic DS: product imports and protocol markers are rejected.
- Registered SDK React/host files: intentional synchronization owners, still subject to React diagnostics. The explicit `@hyori-cloud/ui/theme` host adapter owns next-themes, its pre-paint script, browser preference persistence, OS/storage subscriptions and hydration-safe consumption; the app root alone mounts its provider. The boundary gate rejects next-themes imports outside that adapter. Portable appearance controls remain effect-free.
- Query views retain ordinary data-first guards. Upload task/entry presentations and cloud-section dispatch are explicitly registered finite workflow presenters; ordinary Query status checks are not treated as a universal state machine.
- The pinned React hooks recommended preset supplies React Compiler diagnostics. The actual build transform and compiler log remain separate app-owned evidence.

`boundaries.ts` checks deliberate workspace exports/dependencies, cross-package source/alias escapes, package-to-app reachback, portable-feature vendor imports, and the resolved runtime/declaration graphs of the vanilla SDK and client-safe RPC entry. This is a focused graph check, not a claim that every hard-boundary rule in the skill has shipped. Reflection, computed loader paths, arbitrary semantic protocol wrappers and complete export-condition packaging remain review work.

## Query gate

`query-gate.json` is an executable, reviewed contract. The vendored CLI verifies the public React entry and required exports, then runs four non-no-op fixtures:

1. `packages/client-sdk/tests/compile.tsx`: public root/React consumption, a feature hook, ordinary/Suspense resources, typed cache keys, mutation defaults, helper provenance, and negative kind/input cases.
2. `packages/client-sdk/tests/query.test.tsx`: real TanStack providers, observers and mutations; shared cache under SDK/Query composition, route replacement, isolated caches, exact versus prefix invalidation, central mutation policy, and retained-data refresh failure. HTTP/storage are explicit fakes.
3. `packages/client-sdk/tests/second-client.test.ts`: a non-React public SDK consumer exercising chunk sequencing, bounded retry, pause/checkpoint/reselection/resume, server cancellation, terminal failure and retry, schema validation, disposal and streamed download against the explicit fake API. The consumer contains no upload sequencing algorithm.
4. `evolution.ts`: a temporary declaration-only API fixture adds a new operation. Public SDK/RPC/Query/types acquire it without a client edit. New state and error variants reject incomplete handlers. Temporary files are removed and production declarations remain unchanged.

The profile's own accepted/rejected fixtures establish checker behavior. `profile.test.ts` adds adopted-repository regressions through the actual owned React facade, plus explicit host, transport, DS and workflow roles. `upload-queue.test.ts` verifies bounded portable queue admission and retained resume checkpoints. Product fixtures establish the assertions above. Neither proves live SurrealDB/RustFS, actual browser/app bootstrap behavior, provider subscription fan-out under the compiled app, or measured performance. Packed-artifact optional-peer isolation is a separate required gate below. Report the evidence separately and preserve failures as failures.

## Packed-artifact gate

`bun run check:artifacts` runs `packed-consumer.ts` under pinned Bun 1.4.4, locally and in CI. It is intentionally independent of `evolution.ts`, whose temporary source mappings and workspace symlinks establish evolution only.

- Pack actual SDK/API/core/lib packages using `bun pm pack --ignore-scripts`. Their `files`, exports, private import maps, runtime declaration and rewritten workspace dependency versions are the real tarball contents, not a synthetic SDK manifest or bundled stand-in. New owned transitive packages must be added to the packed set rather than silently copied as sources.
- Create two fresh temporary projects outside the workspace. Unpack owned artifacts and physically copy the already-installed third-party dependency closures, resolving each dependency from its owner and preserving conflicting versions in nested package directories. Do not install, fetch, upload or run package lifecycle scripts. Optional platform dependencies are included only if already installed; optional adapter peers are omitted unless selected by the React consumer. This tests local artifact consumption, not registry/package-manager installation behavior.
- The vanilla project has TypeScript and Node-compatible ambient declarations as consumer development tools, but no React/runtime types, React Query, icons or web frameworks anywhere in its physical dependency tree. Run its actual public SDK import, declaration-derived RPC/query, codecs and disposal with an explicitly fake Fetch capability. Strict typecheck retains public input/output inference and rejects wrong types. `skipLibCheck` is **false**, the tsconfig has no extends or paths, and every TypeScript input must resolve physically inside the consumer. Symlinks, inherited ancestor `node_modules` and env files are rejected.
- Require real nonzero failures for the React adapter's runtime/type imports without peers, a private SDK source import, and removal of the packed core dependency from both runtime and type resolution. These fail for matching resolution diagnostics, not an unrelated compiler error. Expected-error type assertions additionally reject inference degradation.
- The React project explicitly supplies the SDK's declared optional React/React Query/React-type peers. Import `./react`, typecheck inferred resource/consumer-hook/provider props, and execute derived Query options through the actual owned Query facade. This does not mount providers or claim app bootstrap evidence; the app-owned runtime fixture remains separate.

Both consumers use the [documented Bun source-artifact contract](../../packages/client-sdk/README.md#local-artifact-contract). Child processes receive a narrow environment, disable Bun env loading/auto-install, and have bounded timeouts. Tarballs and consumers are removed in a `finally` block. No running services or secret configuration are needed. Direct Node execution, browser/native distribution compatibility, registry installs, IDE/bundle benchmarks and real-service authorization/durability are outside this gate.
