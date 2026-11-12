# Hyori Cloud: product discovery

Status: v1 scope discovery is complete; implementation is in progress. Confirmed requirements are the target, not a claim that all features are implemented. Use `../README.md`, `../packages/api/README.md`, and `artcraft-integration.md` for coverage and current limitations.

## Confirmed requirements

- Build a Nextcloud alternative on the existing template.
- Use React and TanStack Start for the web application, a Rust application backend with PostgreSQL and Better Auth Rust, and RustFS for file/object storage. This supersedes the original SurrealDB decision; the replacement is in progress, not evidence of completed migration. Preserve existing deployment data until an explicit migration or clean-instance choice is made.
- Use shadcn/ui and Tailwind CSS.
- Offer Light, Dark, and System appearance. Default to the operating system, with an explicit preference remembered locally in the browser; this is not an account-synced setting.
- Ship self-hosted only for now. A managed service is a possible future offering, not a v1 commitment.
- Treat Emil Kowalski-inspired design craftsmanship and exceptional performance as core product requirements. Implementation guidance lives in `../AGENTS.md`.
- Follow Fernando Rojo's product-engineering approach for architecture decisions, as required by the architecture policy in `../AGENTS.md`.

## Starting point

The original template supplied React, TanStack Start/Router/Query, and shared shadcn/ui components with Tailwind CSS. Product behavior, PostgreSQL persistence, and RustFS transfers are being added during v1 implementation; their verified coverage is tracked in the implementation documentation rather than inferred from this scope.

See `../README.md` for development setup.

## Confirmed first-release scope

- Google Drive-style files and folders that can be shared directly. Use item-level sharing rather than introducing a separate shared-space concept for v1.
- Support both account-specific sharing and anyone-with-the-link access. Keep access restricted by default; link sharing is explicitly enabled.
- Configure each account-specific share or public link using exactly three roles: **Viewer** (view/download), **Contributor** (view/download and upload new files), and **Editor** (Contributor capabilities plus modifying existing files). Public links may use any of these roles.
- These roles are the permission controls, not presets over a custom permission system. Do not introduce a Custom mode or per-capability toggles. Individual file/folder deletion is owner-only: no sharing role, including Editor, grants permission to delete. Admin deletion of an entire account and its owned files is a separate administrative exception, described below. Moves and resharing still need role-level policies.
- Shared-folder permissions apply recursively to existing contents, subfolders, and future uploads. Inheritance applies to both account-specific shares and public links and does not grant deletion rights. How inherited access combines with direct item shares remains to be defined.
- New files uploaded into a shared folder belong to that folder's owner, not the contributor. Record upload attribution separately from ownership: identify the uploader when authenticated, and mark anonymous link uploads as anonymous rather than inventing an account identity. Uploading does not confer deletion rights.
- A dedicated Photos view over the same underlying file library, not a separate storage/import system. Files and Photos reference the same originals and preserve the same ownership and access rules. Photo sources use the confirmed folder-selection model below; organization and presentation remain to be defined.
- Browser-based document editing in v1 through all four selected ArtCraft apps: **WordCraft**, **GridCraft**, **DeckCraft**, and **PdfCraft** (https://getartcraft.com/apps). One-person-at-a-time editing is sufficient; simultaneous co-editing is not a launch requirement. Browser integration and supported formats must be validated for each app. Locking or conflict handling must prevent silent overwrites; the exact mechanism remains open.

This establishes the product areas, not their detailed feature contracts or implementation feasibility. Calendars, contacts, and a general third-party app ecosystem have not been requested for v1.

### Integrated document workspace — confirmed 2026-11-05

- A primary click on a supported document opens its editor directly, in both signed-in files and authorized public shares. Preserve explicit selection checkboxes, modifier/multi-select gestures, keyboard activation, and unsupported-file behavior; do not require finding an editor action in a context menu.
- Opening, reopening, and saving documents must feel immediate and be optimized with measured cold/warm workloads. Separate asset transfer, decompression/compilation, engine initialization, document parsing, serialization, and durable persistence before attributing delays. Keep measured-device/network conditions and proposed performance targets explicit; the existing 2-core/4-GB deployment target is not a capacity guarantee.
- ArtCraft's actual editor chrome and interactions should follow Hyori's design language, including Light/Dark/System, restrained motion, accessible controls, typography, and spacing. Matching only the outer iframe wrapper does not complete this requirement. Preserve document content and formatting rather than changing document styling to match interface tokens.
- Support automatic saving for authorized writable documents, with honest pending/saving/saved/error states tied to backend durability, plus an explicit save/flush action. Do not silently overwrite conflicts, save read-only sources, choose copy/export destinations automatically, or claim automatic saving when an engine cannot provide a reliable native serialization/acknowledgement contract. Preserve recovery bytes and explicit failure recovery.
- Google Office-style automatic saving is the interaction direction, not authorization for simultaneous co-editing or a claim of feature/performance parity. Save/version checkpoint boundaries must preserve useful history without treating every keystroke as a separate full-file historical version.
- Existing open tabs and sessions must remain safe during engine upgrades. New versioned runtime bundles must not silently make an old live editor unable to save; retain bounded verified legacy compatibility or explicitly coordinate a safe transition without discarding work.

### Public-link controls — confirmed

- V1 public links support optional password protection, an optional expiration date, and revocation at any time.
- These controls supplement the link's Viewer, Contributor, or Editor role; they do not introduce additional permission modes.
- Enforce password checks, expiry, and revocation in backend authorization for reads and writes, not merely in the link UI. Successful password entry must not bypass later expiry or revocation.
- Define link-password session handling, expiry/timezone semantics, and the effect on in-progress transfers or already-issued storage URLs during contract design. Revocation cannot retract content already downloaded.

### Deployment target — resource tuning deferred

- Target home NAS/mini PCs, VPSs, and dedicated servers. The default deployment target remains **2 CPU cores and 4 GB total host RAM** for the complete self-hosted stack.
- RustFS is a settled technology choice. The user reports successful use across multiple projects and explicitly asked to proceed with it rather than revisit its selection over general sizing guidance.
- Defer detailed memory budgets, capacity sizing, concurrency tuning, and resource/performance benchmarking until a later implementation stage. These are not blockers to current feature discovery.
- Performance remains a core requirement under `../AGENTS.md`; the target is not a measured capacity guarantee. Supported OS/architectures, storage/network conditions, and workload sizes remain unspecified.

### Authentication — email and password only

- Use local accounts with an email address and password (previously called the master password). PIN sign-in and PIN unlock are outside v1 scope. OIDC/SSO is not required for v1.
- Email verification is not required. Treat an entered email address as unverified, not proof of mailbox ownership; account-specific sharing and recovery must respect that distinction.
- During initial instance setup, the first successfully created user becomes the instance admin. This is a one-time bootstrap rule, not an admin-promotion path for ordinary registration.
- Public registration is disabled by default. After bootstrap, admins can create accounts or issue invite links for additional users.
- Bootstrap must be server-authorized and atomic so concurrent requests cannot create multiple initial admins or let an unauthenticated remote visitor claim an exposed instance. The exact setup-access mechanism still needs design; setup must not reopen automatically just because accounts are deleted.
- Password policy, rate limiting, credential storage, session handling, invite lifecycle, and account recovery still need design. Prioritize memorable strong passwords/passphrases rather than reintroducing a short PIN fallback. See Data protection for the server-readable model and remaining at-rest encryption decisions.

#### Password recovery scope confirmed during production review, 2026-11-12

- Signed-in people can change their own password using their current password. New passwords use the account-creation policy; other sessions end and the current one continues. Wrong-current-password attempts are limited per account.
- Administrators can issue a one-time, limited-lifetime reset link for an active account, shown once for private handoff. The person chooses the password; the administrator does not see or set it. Completing reset ends all account sessions and cancels earlier unused links. No email delivery is required.
- Implementation defaults: reset links last 24 hours; issuing a second link cancels the first immediately. Password change also cancels unused reset links, so an outstanding bearer link cannot undo the change. Change attempts have a separate account-wide 10-attempt/15-minute budget, matching sign-in's window without sharing its counter.
- Individual session listing/revocation and recovery when the only administrator forgets their password remain known gaps outside this slice. The backend and generated consumption are owned separately from the account/Users interface and browser acceptance.
- Rationale: the review lead selected this scope under aarsh's delegated product authority. This records scope and defaults, not completed interface or production acceptance.

### Data protection — E2EE deferred from v1

- Use a server-readable file model for v1; defer end-to-end encryption to prioritize the selected workflows and performance goals.
- E2EE is not inherently slow, but can add client-side processing and change how thumbnails, previews, and browser editors obtain usable content. No measured E2EE slowdown has been established for this application; this is a scope/complexity tradeoff, not a benchmark result.
- Require HTTPS for production browser access and enforce application authorization for files, shares, and recovery. Omitting E2EE does not waive these protections.
- Encryption at rest and its key-management/deployment strategy remain separate design decisions. The server/storage operator is inside the trust boundary; app-level admin restrictions do not protect data against direct infrastructure access.

### Administration and storage limits — confirmed

- Provide an admin-only user-management route where admins can allocate per-user storage quotas and see aggregate storage usage per user.
- Admin status alone does not grant access to another user's file listings, names, previews, downloads, or individual-file deletion. Enforce this at backend operations, not merely by hiding UI. An admin using ordinary file-sharing access remains subject to the same sharing roles and owner-only deletion rules as any other user.
- Admins can delete a user and all files owned by that user through user management. This is an explicit account-level destructive operation, not permission to browse or selectively delete that user's files.
- Account deletion targets owned files, not other users' files merely shared with the deleted account. Under the confirmed upload-ownership rule, contributions to another owner's shared folder belong to that folder owner and are not deleted simply because the contributor's account is deleted.
- Require explicit confirmation for account-and-data deletion. Revoke the deleted account's access and its issued shares, prevent further writes under that account, and track cleanup of metadata, originals, and derived media without granting the admin browsing access.
- Quota accounting/enforcement, quota reductions below current usage, and account-deletion retention/recovery behavior still need design. This is application-level privacy, not protection against direct server/database/storage access; end-to-end encryption is not established by this policy.

### Photos sources — confirmed

- Each user chooses source folders during Photos setup. Suggest an existing `Pictures` folder when present rather than silently including the entire library.
- Include supported images and videos recursively from selected folders and their subfolders. New media uploaded there appears automatically once discovered/processed.
- Let users add or remove source folders later, and offer an explicit **All my files** selection for users who prefer automatic discovery across their own library.
- Source selection is personal presentation configuration, not an access grant. Shared-folder sources expose only media the user is currently authorized to access; revoked access must also disappear from Photos.
- Removing a source only removes its media from that user's Photos view; it does not delete or move the underlying files. Deleting an original affects both Files and Photos and remains owner-only.
- Use the same originals, with derived thumbnails/previews for browsing.

### Photos features — confirmed

V1 includes timeline browsing, albums, and a full-screen photo/video viewer. This is sufficient for the initial Photos release; automatic phone backup, face grouping, and map browsing are not launch requirements.

Detailed timeline ordering, album membership/sharing, and supported media formats remain to be specified. Albums reference the existing media rather than duplicate originals; they must respect the library's authorization rules.

### File recovery — confirmed

- V1 includes both trash/restore and file version history.
- Ordinary file/folder deletion moves owned items to trash so they can be restored before permanent removal. The existing owner-only deletion rule still applies.
- Preserve recoverable previous file contents when existing files are edited or replaced, including changes made through shared editing and the selected browser editors. Define save/version boundaries during editor integration; this is not simultaneous co-editing.
- Recovery must preserve ownership and enforce current authorization; trash and historical versions must not become an alternate way to access revoked or private content.
- Retention durations, version limits, permissions for viewing/restoring history, and how retained content counts toward storage quotas remain to be specified.
- Admin deletion of a user and all owned data remains a separate destructive workflow. Its retention/recovery policy is unresolved; ordinary trash does not automatically make a deleted account recoverable.
- Trash and version history are not substitutes for an independent backup and restore strategy.

### Search — confirmed

- V1 searches file and folder names, with filters for file type, date, and size.
- Return only items the requesting user or share holder is authorized to access. Results, exposed metadata, and filter counts must respect that access scope; search must not reveal private file names or metadata.
- Searching inside document contents and OCR for images/scanned PDFs are deferred beyond v1, without a committed delivery date.
- Exact name-matching behavior, date-field semantics, and sorting/pagination contracts remain to be specified.

### Uploads — confirmed

- V1 includes resumable uploads: interrupted transfers continue from saved progress rather than restarting from zero.
- Provide per-file progress, cancellation, retry for failed transfers, and clear completion/error feedback.
- Apply the existing sharing roles, destination-folder ownership, and storage quotas to uploads. Resume/finalization must respect current authorization rather than relying solely on access granted when the transfer began.
- Incomplete uploads must not appear as successfully stored files. A failed or cancelled replacement must preserve the previously committed file; successful replacements participate in version history.
- Specify the transfer protocol, checkpoint retention/cleanup, and browser reload/restart behavior during contract design. Browser resumption may require the user to reselect a local file; unrestricted background browser access is not assumed.

### Candidate file workflows — details awaiting approval

- File and folder browsing, navigation, and sorting; search scope is confirmed above.
- Downloads with visible progress, cancellation, and explicit failure/retry behavior; upload requirements are confirmed above.
- Rename and move workflows; trash/restore and version history are confirmed above.
- Useful previews for agreed file types.
- Authentication and ownership/permission enforcement appropriate to the chosen audience.
- Sharing only after its audience and access rules are agreed.

### Client compatibility — confirmed

V1 ships Hyori Cloud's own web application. WebDAV, existing Nextcloud-client compatibility, and dedicated desktop/mobile sync clients are deferred beyond v1, without a committed delivery date. Keep the public product API consumable by future clients in accordance with the architecture policy; this does not authorize building those clients now.

Migration/import requirements remain open. Calendars, contacts, and third-party applications are also outside confirmed launch scope.

### ArtCraft integration: evidence and open checks

The [official app directory](https://getartcraft.com/apps), reviewed on 2026-11-04, presents desktop applications and describes browser/WebAssembly support for most apps. Relevant apps include WordCraft, GridCraft, DeckCraft, and PdfCraft. The directory labels the applications early alpha or in development.

The directory does not establish an embeddable editor contract, compatibility with common Office formats, or real-time multi-user editing. Treat these as unverified rather than promised capabilities.

All four apps are confirmed v1 browser-integration requirements. Their selection is approved; technical feasibility is not yet verified. Before promising specific integration capabilities, inspect the relevant sources linked from the directory and validate each selected app:

- Browser build availability, license, supported deployment, and embedding approach.
- Opening documents from Hyori Cloud and safely persisting edits back to its storage.
- Supported file formats and fidelity through open/edit/save round trips.
- Authentication and isolation boundaries for editor access.
- Whether collaboration is provided by ArtCraft or requires another layer, including concurrent-edit and conflict behavior.

ArtCraft is the user's selected integration direction; changing it requires discussion, not a silent substitution.

## Implementation follow-ups

The product-scope grilling is finished. Resolve these follow-ups during contract design and implementation with explicit, reasonable defaults; record the rationale. Ask the user only when a choice materially changes scope, security, or data-loss behavior. Resource sizing remains deferred as agreed.

1. **Audience — confirmed:** The first release must serve individual self-hosters, families/small private groups, and teams/organizations. Required capabilities for each audience remain to be defined.
2. **Product boundary — confirmed:** Files, sharing, Photos, and shared document editing belong in v1. Photos uses the same underlying file library and source-selection rules above; timeline browsing, albums, and a full-screen photo/video viewer are sufficient for v1. Still define detailed album/timeline behavior and media formats. Integrate WordCraft, GridCraft, DeckCraft, and PdfCraft in the browser; one-person-at-a-time editing is sufficient initially. Still validate per-app integration, exact file-format support, and the locking/conflict policy.
3. **Deployment — direction and target confirmed:** Use the Deployment target section above. RustFS is settled, and detailed resource tuning is deferred rather than blocking discovery. Installation, upgrades, and operational burden still need definition. Managed hosting is a possible later offering, not authorization for SaaS infrastructure in v1.
4. **Access and trust — core policies confirmed:** Use the sharing rules, Authentication section, and Administration and storage limits section above as the authoritative requirements. Public links have the password, expiry, and revocation controls specified above. Still define secure bootstrap access, password policy, invite lifecycle, recovery, combined direct/inherited access, moves, resharing, detailed link-session/expiry behavior, quota accounting/enforcement, account-deletion retention, and at-rest encryption/key management. E2EE is deferred as specified in Data protection.
5. **File workload — detailed sizing deferred:** Library size, files per folder, largest file, and simultaneous transfers remain unspecified. Revisit capacity scenarios later; do not block current feature discovery on resource sizing.
6. **Compatibility — client scope confirmed:** Own web application for v1; WebDAV, Nextcloud-client compatibility, and desktop/mobile sync are deferred as specified above. Still define any required migration/import workflows.
7. **Reliability — transfer and recovery features confirmed:** V1 includes resumable uploads with progress/cancel/retry, trash/restore, and file version history as specified above. Still define transfer protocol/reload behavior, retention, version limits, restoration permissions, quota accounting, independent backups, and account-deletion recovery.
8. **Speed criteria — detailed work deferred:** Keep performance as a core requirement and the host target unchanged. Define and measure workload-specific budgets later, not as a prerequisite for finishing feature discovery.

## Architecture questions to validate after scope

- How do PostgreSQL metadata and RustFS objects stay consistent across interrupted transfers, retries, moves, and deletion?
- Which operations pass through the application server, and which can use narrowly authorized direct object-storage transfers?
- What background processing is necessary for previews, indexing, cleanup, and integrity checks?

Validate capabilities against the selected versions and official documentation before committing to a design. In particular, do not assume complete S3 compatibility, resumable-upload behavior, or cross-system transaction guarantees.

## Decision log

### 2026-11-05: GPT-only integration, performance, and automatic saving

- **Decision:** Use GPT models for UI/UX as well as other work; do not use Opus for any further task. This supersedes the earlier Opus-only UI ownership and earlier pause on interface improvements.
- **Rationale:** The owner explicitly requested an integrated, polished, responsive document workspace, direct-click editor opening, substantially faster load/save behavior, Hyori-matched ArtCraft UI, and Google Office-style automatic saving.
- **Scope consequence:** Preserve existing data and authorization while improving the real end-to-end workflow. Measure before claiming speed, implement reliable native save/theme/readiness bridges where necessary rather than relying on focus-stealing keyboard simulation, and ship only versioned/verified assets with retained notices and source evidence. Loading animation alone is not a performance improvement.

### 2026-11-05: continuous Opus 5.5 UI/UX ownership (superseded)

- **Decision:** Use Opus 5.5 for UI/UX across the entire application and throughout backend integration, not only for a final cosmetic pass. Keep backend/research work with the separately selected Astra/Sol models.
- **Rationale:** The owner explicitly emphasized that UI/UX matters throughout the app and named Opus 5.5 for that responsibility.
- **Scope consequence:** Treat each product surface and its loading, empty, error, recovery, permission, keyboard, touch and appearance states as part of completion. Keep `DESIGN.md` and the shared design system authoritative. Mounted/fake-transport checks remain distinct from real Rust-backed browser acceptance; a passing backend suite does not finish the interface.

### 2026-11-05: expose the entire Rust app only after verification

- **Decision:** Finish the Rust-backed entire app before providing the final local-network link. Do not launch a legacy SurrealDB preview as the requested final app.
- **Rationale:** When offered a current working legacy preview versus waiting for the Rust app, the owner explicitly selected finishing Rust first.
- **Scope consequence:** Preserve the no-SurrealDB direction and verify the whole application before handing over its LAN URL. A running UI shell, standalone metadata service, test instance, or incomplete rewrite is not the requested deliverable. Keep production HTTPS/session protections intact when arranging LAN access.

### 2026-11-05: Rust/PostgreSQL rewrite and performance-first completion

- **Decision:** Replace SurrealDB and the TypeScript server implementation with a Rust backend, PostgreSQL, and Better Auth Rust (https://better-auth.rs/docs). Retain the React/TanStack web app and RustFS. Research coollabsio/orbit for backend organization and ethanniser/NextFaster for loading techniques; neither reference establishes Hyori's measured performance.
- **Rationale:** The owner explicitly requested removal of SurrealDB, a Rust backend like Orbit, PostgreSQL authentication, exceptional page/data loading speed, and completion of the confirmed v1 workflows.
- **Scope consequence:** Preserve sharing/ownership, upload durability, quota, recovery, public API/SDK consumption, and application-level admin privacy. Replace Effect-specific cross-language implementation details with mechanically derived contracts, keeping feature-owned schema authority, runtime validation, typed clients, and architecture gates. Do not maintain handwritten parallel Rust and TypeScript wire contracts. Existing database volumes and objects are not authorized for deletion; migration/import policy remains a separate data-safety decision.
- **Design/tooling direction:** Use Astra High Fast and Sol High Fast for research/backend work, and Opus High Fast for UI work. Apply Emil and the directly read taste skill, with Omarchy's restraint as inspiration rather than copying its identity or unlicensed assets. Product images/assets use Codex image generation. Light/Dark/System, shared shadcn controls, and accessibility remain required.
- **Completion evidence:** Real PostgreSQL/RustFS HTTP lifecycle tests, generated SDK/Query/packaging checks, Rust and web quality gates, browser interaction checks, failure recovery, and representative measured workloads are required before claiming production readiness or performance parity.

### 2026-11-05: design language and image tooling policy

- **Decision:** Adopt the restrained language of the owner-supplied Raycats reference for product UI through `../DESIGN.md`, pin the upstream `design-taste-frontend-v2-experimental` skill unchanged and `brandkit` with only a Hyori identity section added, and use the Codex CLI for product images and web assets.
- **Rationale:** The user requested this design material and tooling. Only the source's language fits an application; its dark-only rule, marketing layouts, and decorative artwork do not.
- **Scope consequence:** The user then approved moving the shipped palette, with the source's warm Porcelain scheme for Light and its cold near-black for Dark. Light, Dark, and System remain required; product scope is unchanged.

### 2026-11-05: dark mode with a local appearance preference

- **Decision:** Add Light, Dark, and System appearance, defaulting to System and remembering explicit choices in browser storage. Keep the choice available in the account menu and on setup, sign-in, invite, and public-link screens.
- **Rationale:** The user requested dark mode. System defaults respect the device without an extra setup step; a local override works before authentication and on public links without adding backend/account settings.
- **Scope consequence:** Reuse the shared semantic palettes and an app-mounted, owned browser adapter. No backend/API or account-synchronization changes are required.

### 2026-11-04: serve all three audiences

- **Decision:** Target individual self-hosters, families/small private groups, and teams/organizations in the first release.
- **Rationale:** The user explicitly selected all three rather than narrowing to one audience.
- **Scope consequence:** Evaluate core workflows for personal and multi-user use. Account boundaries, shared access, and administration need discovery; specific roles, enterprise features, and tenancy architecture are not yet approved.

### 2026-11-04: include photos and collaborative documents in v1

- **Decision:** V1 includes files, sharing, a photo library, and collaborative documents. Use ArtCraft Apps for document editing and related capabilities.
- **Rationale:** The user explicitly requested all four areas and supplied the ArtCraft app directory.
- **Scope consequence:** Photo-library and editor integration work are launch scope, not deferred expansions. ArtCraft integration feasibility must be validated before promising specific editing capabilities.

### 2026-11-04: shared editing is sufficient initially

- **Decision:** Shared documents can be edited one person at a time in v1. Real-time simultaneous co-editing is not required for launch.
- **Rationale:** The user explicitly accepted shared editing as the initial collaboration model.
- **Scope consequence:** Define safe locking or conflict handling during editor integration. Real-time co-editing may be added later; it is not a current implementation requirement.

### 2026-11-04: self-hosted first, managed service possible later

- **Decision:** The current release is self-hosted only. A managed service may be added later.
- **Rationale:** The user prioritized self-hosting for now while leaving managed hosting open.
- **Scope consequence:** Focus deployment discovery on self-hosted installation, configuration, upgrades, and recovery. Managed-service operations and commercial features are outside current launch scope; future hosting remains an architectural consideration, not authorization to build a SaaS platform.

### 2026-11-04: Google Drive-style item sharing

- **Decision:** Files and folders can be shared directly, Google Drive-style, instead of introducing separate shared spaces for v1.
- **Rationale:** The user chose shareable files/folders in response to the shared-space question.
- **Scope consequence:** Build discovery around item-level access. The comparison establishes the sharing model, not complete Google Drive feature parity; recipient types and permission semantics are separate discovery decisions.

### 2026-11-04: support both sharing recipient types

- **Decision:** Support both sharing with specific accounts and anyone-with-the-link access. Use restricted access by default and require explicit enablement of link sharing.
- **Rationale:** The user selected both recipient types in response to the sharing recommendation.
- **Scope consequence:** Define authorization for authenticated recipients and link holders. The subsequent configurable-permissions decision establishes write access for links; link controls remain open.

### 2026-11-04: fine-grained permissions, including writable public links

- **Decision:** Share permissions are configurable, including read-only access and permission to edit or upload. Public links support editing and uploads when explicitly enabled, rather than always requiring a signed-in account for writes.
- **Rationale:** The user explicitly requested editing/upload support and fine-grained sharing controls instead of read-only public links.
- **Scope consequence:** Enforce the configured capabilities for both account-specific shares and link access. Do not assume edit permission includes deletion, moving items, or resharing; define those boundaries and inheritance before implementation. Writable links must participate in the document conflict/locking policy.

### 2026-11-04: exactly three sharing roles

- **Decision:** Express sharing permissions only through Viewer, Contributor, and Editor. Viewer can view/download; Contributor additionally uploads new files; Editor additionally modifies existing files. Apply the same roles to account-specific shares and public links.
- **Rationale:** The user limited fine-grained sharing to these three modes after the proposal of presets, a Custom mode, and a separate deletion permission.
- **Scope consequence:** The three roles are fixed permission bundles, not presets with custom overrides. Map remaining actions to a role or owner-only behavior instead of adding independent permission toggles. The subsequent owner-only deletion decision resolves the deletion policy.

### 2026-11-04: owner-only deletion

- **Decision:** Only an item's owner can delete it. Viewer, Contributor, and Editor sharing roles do not grant deletion rights.
- **Rationale:** The user explicitly chose owner-only deletion over allowing Editors to delete.
- **Scope consequence:** Enforce owner-only deletion for both account-specific shares and public links. Editing and uploading must not implicitly authorize deleting existing items; ownership rules for newly uploaded items remain to be defined.

### 2026-11-04: recursive folder-share inheritance

- **Decision:** Sharing a folder applies its permissions to everything inside it, including subfolders and future uploads.
- **Rationale:** The user explicitly approved automatic inheritance rather than configuring each file separately.
- **Scope consequence:** Apply the shared role recursively for both account-specific shares and public links, preserving owner-only deletion. Direct-share interactions remain a separate decision; this decision does not establish child-level overrides. The subsequent upload-ownership decision resolves ownership of contributed files.

### 2026-11-04: shared-folder uploads belong to the folder owner

- **Decision:** New files uploaded into a shared folder belong to that folder's owner. Track who uploaded them separately from ownership.
- **Rationale:** The user explicitly approved this model for predictable ownership and deletion, including anonymous link uploads.
- **Scope consequence:** Attribute authenticated contributions to the uploader's account; represent anonymous uploads honestly without implying a verified identity. Contributors do not gain ownership or deletion rights merely by uploading. This rule concerns new uploads, not ownership transfers for existing files moved into a folder.

### 2026-11-04: one underlying library for Files and Photos

- **Decision:** Photos is a dedicated view over the same underlying file library rather than a separate storage/import system.
- **Rationale:** The user explicitly selected one underlying file library.
- **Scope consequence:** Reference the same original files and preserve their ownership and sharing rules across both views. Photo-specific organization does not duplicate original files or independently grant access. Derived thumbnails/previews are compatible with this model; the subsequent source-selection decision resolves discovery scope, while album behavior and timeline details remain open.

### 2026-11-04: user-selected Photos source folders

- **Decision:** Use the recommended folder picker during Photos setup, suggest an existing `Pictures` folder, include subfolders and future uploads, and allow sources to be changed later. Offer an explicit All my files convenience selection.
- **Rationale:** After the explanation of selected-folder behavior and its tradeoffs, the user explicitly accepted the recommendation.
- **Scope consequence:** Treat sources as per-user view configuration over existing files, preserve current authorization, and distinguish removing a source from deleting originals. The subsequent Photos feature decision establishes the initial presentation scope.

### 2026-11-04: Photos v1 feature boundary

- **Decision:** Timeline browsing, albums, and a full-screen photo/video viewer are sufficient for v1.
- **Rationale:** The user explicitly accepted this baseline as enough for the first release.
- **Scope consequence:** Include these three features in launch planning. Automatic phone backup, face grouping, and map browsing are not launch requirements. Album sharing, timeline ordering, and supported media formats still need detailed contracts.

### 2026-11-04: four ArtCraft apps in the browser and SurrealDB backend (backend choice superseded on 2026-11-05)

- **Decision:** V1 uses WordCraft, GridCraft, DeckCraft, and PdfCraft in the browser. SurrealDB is the application backend and database, not merely an incidental data store; RustFS remains the file/object store.
- **Rationale:** The user explicitly named all four browser apps and reaffirmed SurrealDB's backend/database role.
- **Scope consequence:** Plan browser integration for each selected editor while validating its actual interfaces and formats. Design around SurrealDB without assuming an additional backend framework. Authentication, authorization, server-function boundaries, and editor save/locking behavior remain architecture work, not capabilities already implemented.

### 2026-11-04: local email sign-in without required email verification

- **Decision:** Use local email-based accounts for now; email verification is not required. The requested credential experience involves a six-digit PIN / master password, with their relationship still to be clarified.
- **Rationale:** The user chose normal email-based sign-in instead of the proposed local-account plus optional SSO scope, explicitly waived email verification, and named PIN/master-password credentials.
- **Scope consequence:** Keep SSO outside current launch requirements and preserve unverified-email semantics. The subsequent alternative-credential decision resolves the PIN's intended role; sharing and recovery must not treat an unverified email as proof of identity.

### 2026-11-04: alternative PIN or master-password sign-in (superseded)

- **Decision:** Email + either a six-digit PIN or a master password are alternative sign-in methods, not a password-first/PIN-unlock sequence.
- **Rationale:** The user explicitly selected alternative sign-in, then asked how to improve strength and memorability.
- **Scope consequence:** This option was superseded by the subsequent password-only decision. It is not a current implementation requirement.

### 2026-11-04: remove PIN, use email and password

- **Decision:** Remove the PIN feature and use email plus a password for local sign-in. The existing decision not to require email verification is unchanged.
- **Rationale:** The user accepted password-only authentication to avoid the weakness of a short standalone PIN.
- **Scope consequence:** Do not implement PIN login, PIN unlock, or a PIN fallback for v1. Define a usable strong-password policy and appropriate credential-storage, rate-limiting, session, and recovery protections. Password-only sign-in does not itself establish file-encryption guarantees.

### 2026-11-04: initial admin and controlled account creation

- **Decision:** The first user created during initial server setup becomes admin. Additional accounts are admin-created or admitted through invite links; public registration is disabled by default.
- **Rationale:** The user explicitly selected first-user administration and accepted the recommended admin-controlled registration model.
- **Scope consequence:** Implement a protected, atomic, one-time bootstrap before normal account creation. Define invitation and admin authorization through the owning backend operations; initial-admin status must not depend on a client-side user-count check. The setup-access mechanism and exact admin powers remain open.

### 2026-11-04: adopt Fernando's architecture conventions

- **Decision:** Architecture decisions follow Fernando Rojo's product-engineering approach and the `fernando-product-engineering` skill.
- **Rationale:** The user explicitly requested this policy in `AGENTS.md` and invoked the skill.
- **Scope consequence:** Apply the architecture policy in `../AGENTS.md` and the skill's affected adoption gates to future implementation. This documentation change does not establish an implemented API/SDK, lint profile, or verified vertical slice.

### 2026-11-04: admin quotas and account deletion without file browsing

- **Decision:** Admin user management can set per-user storage limits, show aggregate usage, and delete a user together with all files that user owns. Admin status does not grant browsing or individual-file access/deletion rights.
- **Rationale:** The user accepted the recommended application-level privacy boundary and explicitly added quota management and whole-account/data deletion as admin powers.
- **Scope consequence:** Separate ordinary item authorization from the account-deletion operation. The latter is the explicit administrative exception to owner-only file deletion and needs confirmation and reliable cleanup. Preserve other owners' files and the existing shared-folder upload ownership model; quota and deletion-retention details remain open.

### 2026-11-04: include trash/restore and version history

- **Decision:** Include both trash/restore and file version history in v1.
- **Rationale:** The user accepted the recommendation to include both, particularly to support recovery from edits and uploads through shares.
- **Scope consequence:** Plan recoverable ordinary deletions and previous-content versions while preserving existing access and ownership rules. Retention durations, version limits, quota treatment, and restoration permissions remain open. This decision does not make whole-account deletion recoverable or establish an independent backup system.

### 2026-11-04: web app first, compatibility and sync later

- **Decision:** Launch with Hyori Cloud's own web application. Defer WebDAV, Nextcloud-client compatibility, and dedicated desktop/mobile sync beyond v1.
- **Rationale:** The user accepted the recommendation to prioritize the web app's speed, reliability, and polish and do compatibility/sync later.
- **Scope consequence:** These integrations and clients are not launch dependencies. Preserve the adopted public API/SDK boundaries for future consumers without implementing deferred clients. No delivery date or migration/import feature has been committed.

### 2026-11-04: all three host classes, 2-core / 4-GB default

- **Decision:** Target home NAS/mini PCs, VPSs, and dedicated servers, with 2 CPU cores and 4 GB RAM as the default complete-stack deployment budget.
- **Rationale:** The user explicitly selected all three host classes and specified this baseline.
- **Scope consequence:** Retain this default deployment target. Detailed budgets, capacity scenarios, tuning, and measurement are deferred by the subsequent prioritization decision.

### 2026-11-04: keep RustFS, defer detailed resource planning

- **Decision:** Proceed with RustFS as selected and move detailed memory budgeting, resource tuning, and capacity benchmarking to a later implementation stage.
- **Rationale:** The user has used RustFS successfully in multiple projects and explicitly asked not to focus on sizing now.
- **Scope consequence:** Continue product feature discovery without reopening the object-store choice or repeatedly gating progress on sizing caveats. The 2-core / 4-GB target and performance principles remain in force; no measured support or capacity claim has been established.

### 2026-11-04: name search and metadata filters for v1

- **Decision:** Search file/folder names and filter by file type, date, and size, always within the requester's authorized access scope. Defer document-content search and OCR.
- **Rationale:** The user explicitly accepted the recommended search scope.
- **Scope consequence:** Plan permission-scoped name search and metadata filtering without a document-text extraction or OCR launch dependency. Define detailed matching, date, ordering, and pagination semantics during contract design.

### 2026-11-04: resumable uploads and transfer feedback

- **Decision:** V1 includes resumable uploads, per-file progress, cancellation, retries for failed transfers, and explicit completion/error feedback.
- **Rationale:** The user explicitly approved the recommended upload feature set.
- **Scope consequence:** Design resumable transfer operations around committed file state, current authorization, quotas, and existing ownership/version-history policies. Transfer protocol, checkpoint lifetime, and browser reload/restart behavior remain implementation contracts, not verified capabilities of the current template.

### 2026-11-04: public-link password, expiry, and revocation controls

- **Decision:** Include optional password protection, optional expiration dates, and revocation at any time for public links in v1.
- **Rationale:** The user explicitly approved all three recommended controls alongside the existing sharing roles.
- **Scope consequence:** Enforce these controls for both read and write access without adding permission modes. Define session and in-flight transfer semantics before implementation; do not imply that revocation retracts downloaded content or automatically invalidates previously issued storage URLs.

### 2026-11-04: defer E2EE for the performance-first v1

- **Decision:** Use server-readable files and defer E2EE from v1 under the user's instruction to omit it if it adds performance cost.
- **Rationale:** The user prioritized speed over adding E2EE. It can add client-side work and materially change previews/editor workflows, although no application-specific slowdown has been measured and encryption is not inherently slow.
- **Scope consequence:** Plan the selected server-readable workflows with HTTPS and authorization. Keep at-rest encryption/key management as separate design work, preserve the admin privacy boundary, and do not claim protection against the infrastructure operator.

### 2026-11-12: unfinished-upload recovery

- **Decision:** New owner uploads expire after 24 hours without a successful part transfer; existing uploads keep their original expiry. List an authenticated account's own unfinished uploads and allow cancellation from any browser. Distinguish the 128-reservation limit from a file conflict.
- **Rationale:** The production-readiness lead, acting on aarsh's delegated product decisions, chose bounded idle reservations and account-wide discovery so lost browser checkpoints cannot permanently trap capacity.
- **Scope consequence:** Rust owns the listing and limit-error contracts. The SDK marks which listed uploads have a valid local checkpoint; those still require file reselection to resume. The Opus interface worker owns the list and limit message; this server/SDK change adds neither screens nor new interface copy.

### 2026-11-12: fair upload admission

- **Decision:** Bound upload operations per authenticated account (across sessions) or anonymous visitor, and additionally per applicable public link, inside the sixteen per-process upload slots. The implementation uses two per principal and four per link, matching two concurrent SDK files with serial parts and permitting two visitor queues per link.
- **Rationale:** The production-readiness lead chose separate principal/link budgets so one slow contributor cannot prevent unrelated accounts from uploading. Public grants can be reissued, so grant identity alone is insufficient.
- **Scope consequence:** Begin, part and complete share admission; rejected requests hold no global slot and no server queue. These are per-process budgets, not cluster-wide quotas. Thirty-second body idle and 125-second whole-worker bounds limit slow part lifetimes.
