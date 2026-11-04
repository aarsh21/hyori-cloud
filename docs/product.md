# Hyori Cloud: product discovery

Status: discovery. Only the confirmed requirements below are commitments; proposed features and architecture remain open.

## Confirmed requirements

- Build a Nextcloud alternative on the existing template.
- Use React and TanStack Start for the web application, SurrealDB as the application backend and database, and RustFS for file/object storage. The authorization model and division of responsibilities between SurrealDB and TanStack Start server functions remain to be designed.
- Use shadcn/ui and Tailwind CSS.
- Ship self-hosted only for now. A managed service is a possible future offering, not a v1 commitment.
- Treat Emil Kowalski-inspired design craftsmanship and exceptional performance as core product requirements. Implementation guidance lives in `../AGENTS.md`.

## Starting point

The template already provides React, TanStack Start/Router/Query, and shared shadcn/ui components with Tailwind CSS. It does not yet establish the product's file model, SurrealDB integration, or RustFS integration.

See `../README.md` for development setup.

## Confirmed first-release scope

- Google Drive-style files and folders that can be shared directly. Use item-level sharing rather than introducing a separate shared-space concept for v1.
- Support both account-specific sharing and anyone-with-the-link access. Keep access restricted by default; link sharing is explicitly enabled.
- Configure each account-specific share or public link using exactly three roles: **Viewer** (view/download), **Contributor** (view/download and upload new files), and **Editor** (Contributor capabilities plus modifying existing files). Public links may use any of these roles.
- These roles are the permission controls, not presets over a custom permission system. Do not introduce a Custom mode or per-capability toggles. Deletion is owner-only: no sharing role, including Editor, grants permission to delete. Moves and resharing still need role-level policies.
- Shared-folder permissions apply recursively to existing contents, subfolders, and future uploads. Inheritance applies to both account-specific shares and public links and does not grant deletion rights. How inherited access combines with direct item shares remains to be defined.
- New files uploaded into a shared folder belong to that folder's owner, not the contributor. Record upload attribution separately from ownership: identify the uploader when authenticated, and mark anonymous link uploads as anonymous rather than inventing an account identity. Uploading does not confer deletion rights.
- A dedicated Photos view over the same underlying file library, not a separate storage/import system. Files and Photos reference the same originals and preserve the same ownership and access rules. Photo sources use the confirmed folder-selection model below; organization and presentation remain to be defined.
- Browser-based document editing in v1 through all four selected ArtCraft apps: **WordCraft**, **GridCraft**, **DeckCraft**, and **PdfCraft** (https://getartcraft.com/apps). One-person-at-a-time editing is sufficient; simultaneous co-editing is not a launch requirement. Browser integration and supported formats must be validated for each app. Locking or conflict handling must prevent silent overwrites; the exact mechanism remains open.

This establishes the product areas, not their detailed feature contracts or implementation feasibility. Calendars, contacts, and a general third-party app ecosystem have not been requested for v1.

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

### Candidate file workflows — details awaiting approval

- File and folder browsing, navigation, sorting, and basic metadata search.
- Uploads and downloads with visible progress, cancellation, and explicit failure/retry behavior.
- Rename, move, trash, and restore workflows.
- Useful previews for agreed file types.
- Authentication and ownership/permission enforcement appropriate to the chosen audience.
- Sharing only after its audience and access rules are agreed.

Potential later branches, not excluded or committed: desktop/mobile sync, WebDAV compatibility, calendars and contacts, and third-party applications.

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

## Decision queue

Discuss one consequential decision at a time. For each answer, record the choice, rationale, and resulting scope changes here before moving on.

1. **Audience — confirmed:** The first release must serve individual self-hosters, families/small private groups, and teams/organizations. Required capabilities for each audience remain to be defined.
2. **Product boundary — confirmed:** Files, sharing, Photos, and shared document editing belong in v1. Photos uses the same underlying file library and source-selection rules above; timeline browsing, albums, and a full-screen photo/video viewer are sufficient for v1. Still define detailed album/timeline behavior and media formats. Integrate WordCraft, GridCraft, DeckCraft, and PdfCraft in the browser; one-person-at-a-time editing is sufficient initially. Still validate per-app integration, exact file-format support, and the locking/conflict policy.
3. **Deployment — direction confirmed:** Self-hosted only for now; a managed service is a possible later offering. Still define supported hardware, installation, upgrades, and operational burden. Future managed hosting does not itself require SaaS billing or multi-tenant infrastructure in v1.
4. **Access and trust — core sharing rules confirmed:** Share files and folders directly, Google Drive-style, rather than using separate shared spaces. Support account-specific and anyone-with-the-link access, restricted by default, through exactly Viewer, Contributor, or Editor. Deletion is owner-only. Folder access extends recursively to existing contents and future uploads. New uploads belong to the destination folder's owner, with separate uploader attribution. Still define combined direct/inherited access, moves, resharing, link controls, instance administration, authentication, and encryption guarantees.
5. **File workload:** Expected library size, files per folder, largest file, simultaneous transfers, and target devices/network conditions?
6. **Compatibility:** Must existing Nextcloud clients, WebDAV clients, or migration workflows work at launch?
7. **Reliability:** Required upload resume behavior, version history, trash retention, backups, and recovery expectations?
8. **Speed criteria:** Which browsing, search, preview, and transfer journeys will define the initial benchmark and acceptance budgets?

## Architecture questions to validate after scope

- How do SurrealDB metadata and RustFS objects stay consistent across interrupted transfers, retries, moves, and deletion?
- Which operations pass through the application server, and which can use narrowly authorized direct object-storage transfers?
- What background processing is necessary for previews, indexing, cleanup, and integrity checks?

Validate capabilities against the selected versions and official documentation before committing to a design. In particular, do not assume complete S3 compatibility, resumable-upload behavior, or cross-system transaction guarantees.

## Decision log

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

### 2026-11-04: four ArtCraft apps in the browser and SurrealDB backend

- **Decision:** V1 uses WordCraft, GridCraft, DeckCraft, and PdfCraft in the browser. SurrealDB is the application backend and database, not merely an incidental data store; RustFS remains the file/object store.
- **Rationale:** The user explicitly named all four browser apps and reaffirmed SurrealDB's backend/database role.
- **Scope consequence:** Plan browser integration for each selected editor while validating its actual interfaces and formats. Design around SurrealDB without assuming an additional backend framework. Authentication, authorization, server-function boundaries, and editor save/locking behavior remain architecture work, not capabilities already implemented.
