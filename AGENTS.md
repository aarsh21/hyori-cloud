# Hyori Cloud

## Product direction

Build a Nextcloud alternative with React and TanStack Start, a Rust application backend with PostgreSQL and Better Auth Rust, and RustFS for file/object storage. The Rust/PostgreSQL rewrite is authorized; replace the legacy backend without deleting existing deployment data or silently dropping product capabilities. Use shadcn/ui and Tailwind CSS for the interface. Use `README.md` and `packages/api/README.md` for implementation coverage and known limits; approved product scope is not evidence of completion.

## Design is a core requirement

Aim for Emil Kowalski's level of design engineering: restrained visuals, excellent defaults, precise typography and spacing, and cohesive interactions. Polish is part of feature completion, not a later pass.

- Use shadcn/ui for standard interface patterns. Add missing components to `packages/ui` as needed, reuse shared primitives and Tailwind tokens, and build product-specific composites from them rather than recreating standard controls. Preserve existing shared customizations when adding components.
- Design loading, empty, error, success, focus, hover, and pressed states alongside the happy path.
- Make keyboard and touch interactions first-class; preserve accessible semantics, visible focus, and reduced-motion preferences.
- Motion must clarify state or provide feedback. Keep frequent actions immediate, keyboard-triggered actions unanimated, and occasional transitions short and interruptible. Prefer transform and opacity for motion.
- Before interface implementation or review, on any model, read `DESIGN.md`; it sets the visual language and motion rules.
- Run the local React Doctor check for UI changes. `doctor.config.json` owns scan scope and privacy settings; keep remote scoring and dependency-report uploads disabled unless the user approves them. Report its diagnostics separately from functional tests.

## Images and web assets

From any agent, use the Codex CLI to source, generate, or edit product images and web assets: illustrations, photos, favicons, social cards. An agent already running in Codex uses its own image capability. Standard controls and interface glyphs stay with `packages/ui` and its shared icon set. Art direction follows `DESIGN.md`.

- Confirm capability from the installed CLI (`codex --help`, `codex features list`) before choosing commands. If the CLI, its sign-in, its image capability, or host permission to run it is missing, report that and wait for direction rather than switching tools.
- Share with Codex only what the task needs. Keep user files, credentials, and private data out of prompts and attachments unless the user approves that input.
- Ship only assets whose license permits redistribution in a self-hosted product, and report each asset's source and license, or that it was generated.

## Performance is a core requirement

Optimize both measured and perceived speed. A polished interface must remain responsive as libraries and transfers grow.

- Define representative workloads and measurable performance budgets before making performance claims; agree on target devices and deployment conditions.
- Bound work: paginate data access, virtualize large rendered collections where needed, index actual query patterns, and avoid N+1 requests.
- Keep file transfers and expensive processing off the UI's critical path. Prefer streaming and bounded concurrency over whole-file buffering or unbounded parallel work.
- Give immediate feedback. Use optimistic updates only with explicit failure recovery and reconciliation.
- Load expensive previews and secondary features on demand; evaluate dependency and bundle costs.
- Profile affected user journeys when changing a hot path. Report measured results and remaining bottlenecks rather than calling unmeasured code fast.
- Preserve authorization, data integrity, and durability while optimizing.

## Rust implementation

For Rust implementation or review, product invariants and the repository's architecture rules take precedence over generic idioms. Verify compiler and thread-safety claims against the actual toolchain.

## Architecture: Fernando Rojo's product engineering

Architecture decisions must follow Fernando Rojo's product-engineering approach. For architecture, API/SDK design, or React feature boundaries, load `fernando-product-engineering` and follow its adoption contract and affected references before implementation. Report an unavailable skill rather than silently skipping its requirements.

- **Consumer-first contracts:** Design the public API/SDK call site before the UI. Rust feature APIs own wire schemas and operation metadata; derive TypeScript runtime codecs, types, RPC, SDK, and Query consumption mechanically. Run `contracts:check` when changing that boundary. The Rust rewrite supersedes Effect-specific no-codegen/backend recipes, not the skill's ownership and consumption requirements.
- **Server-owned behavior:** Keep authorization, domain rules, and orchestration behind documented product operations. UI and SDK consumers must not reconstruct backend workflows.
- **Owned boundaries:** Inject narrow capabilities at their composition owner, encapsulate vendor dependencies, and consume packages through deliberate public exports. Keep vanilla core/SDK code separate from React and host adapters.
- **Composable React:** Apps own bootstrap and shared infrastructure; features compose owned state, hooks, and design-system components. Follow the skill's cache, provider, effect, and state-rendering requirements.
- **Vertical-slice completion:** Implement only the foundation needed by the current outcome, then verify its real end-to-end path. Enforce affected architecture rules with executable checks and report functional and architecture evidence separately.

## Feature discovery

For scope, feature planning, or architecture decisions, read `docs/product.md`. It distinguishes confirmed requirements from proposals and unresolved decisions.

Discuss consequential choices with the user before treating them as requirements. Keep the product document updated with confirmed answers and their rationale. Feature proposals are not authorization to implement them.

## Repository workflow

Use `README.md` for template setup, shared UI conventions, environment handling, and development commands. Consult package manifests for available scripts rather than duplicating them here.

After every change, run `bun run lint:anti-slop` and report remaining diagnostics. For anti-slop updates, read `tooling/anti-slop/UPSTREAM.md` to preserve the pinned source, licenses, local adaptations, and exact Oxlint/plugin compatibility. Keep handwritten Hyori tooling in TypeScript; preserve vendored JavaScript and generated artifacts in their original form.
