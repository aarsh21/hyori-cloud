# Hyori Cloud

## Product direction

Build a Nextcloud alternative with React and TanStack Start, SurrealDB as the application backend and database, and RustFS for file/object storage. Use shadcn/ui and Tailwind CSS for the interface. SurrealDB and RustFS are intended integrations, not capabilities already implemented by the template.

## Design is a core requirement

Aim for Emil Kowalski's level of design engineering: restrained visuals, excellent defaults, precise typography and spacing, and cohesive interactions. Polish is part of feature completion, not a later pass.

- Use shared shadcn/ui primitives and Tailwind design tokens so improvements carry across the app.
- Design loading, empty, error, success, focus, hover, and pressed states alongside the happy path.
- Make keyboard and touch interactions first-class; preserve accessible semantics, visible focus, and reduced-motion preferences.
- Motion must clarify state or provide feedback. Keep frequent actions immediate, keyboard-triggered actions unanimated, and occasional transitions short and interruptible. Prefer transform and opacity for motion.
- For interface implementation or review, use the `emil-design-eng` skill when available.

## Performance is a core requirement

Optimize both measured and perceived speed. A polished interface must remain responsive as libraries and transfers grow.

- Define representative workloads and measurable performance budgets before making performance claims; agree on target devices and deployment conditions.
- Bound work: paginate data access, virtualize large rendered collections where needed, index actual query patterns, and avoid N+1 requests.
- Keep file transfers and expensive processing off the UI's critical path. Prefer streaming and bounded concurrency over whole-file buffering or unbounded parallel work.
- Give immediate feedback. Use optimistic updates only with explicit failure recovery and reconciliation.
- Load expensive previews and secondary features on demand; evaluate dependency and bundle costs.
- Profile affected user journeys when changing a hot path. Report measured results and remaining bottlenecks rather than calling unmeasured code fast.
- Preserve authorization, data integrity, and durability while optimizing.

## Architecture: Fernando Rojo's product engineering

Architecture decisions must follow Fernando Rojo's product-engineering approach. For architecture, API/SDK design, or React feature boundaries, load `fernando-product-engineering` and follow its adoption contract and affected references before implementation. Report an unavailable skill rather than silently skipping its requirements.

- **Consumer-first contracts:** Design the public API/SDK call site before the UI. Define runtime schemas once in the owning feature; derive types, RPC, SDK, and Query consumption rather than maintaining parallel contracts.
- **Server-owned behavior:** Keep authorization, domain rules, and orchestration behind documented product operations. UI and SDK consumers must not reconstruct backend workflows.
- **Owned boundaries:** Inject narrow capabilities at their composition owner, encapsulate vendor dependencies, and consume packages through deliberate public exports. Keep vanilla core/SDK code separate from React and host adapters.
- **Composable React:** Apps own bootstrap and shared infrastructure; features compose owned state, hooks, and design-system components. Follow the skill's cache, provider, effect, and state-rendering requirements.
- **Vertical-slice completion:** Implement only the foundation needed by the current outcome, then verify its real end-to-end path. Enforce affected architecture rules with executable checks and report functional and architecture evidence separately.

## Feature discovery

For scope, feature planning, or architecture decisions, read `docs/product.md`. It distinguishes confirmed requirements from proposals and unresolved decisions.

Discuss consequential choices with the user before treating them as requirements. Keep the product document updated with confirmed answers and their rationale. Feature proposals are not authorization to implement them.

## Repository workflow

Use `README.md` for template setup, shared UI conventions, environment handling, and development commands. Consult package manifests for available scripts rather than duplicating them here.
