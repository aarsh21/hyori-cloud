# Upstream skills

Both skills are MIT, Copyright (c) 2026 Leonxlnx; each folder carries its `LICENSE`. They were retrieved on 2026-11-05 and nothing from upstream was executed. `vite.config.ts` excludes these folders from formatting so their blob hashes stay comparable.

| Skill                                   | Source                                                                                                                                                              | Local changes                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `design-taste-frontend-v2-experimental` | [`taste-skill-classics@5e08c93`](https://github.com/Leonxlnx/taste-skill-classics/tree/5e08c9383dc4ad7fc0df70e1ac8cfa09ec356305/skills/taste-skill-v2-experimental) | None; folder renamed from `taste-skill-v2-experimental` to match the skill name |
| `brandkit`                              | [`imagegen-skills@beb16b0`](https://github.com/Leonxlnx/imagegen-skills/tree/beb16b0d0f4dae9a6f5cb04ea41e97b93a54ab8e/skills/brandkit)                              | One added `# HYORI CLOUD IDENTITY` section before `# BRAND INTAKE`              |

## Upstream Git blobs

| Local file                                                 | Git blob                                   |
| ---------------------------------------------------------- | ------------------------------------------ |
| `design-taste-frontend-v2-experimental/SKILL.md`           | `1f2c70c8701a0769e4e81e15c1a7e842024e837e` |
| `design-taste-frontend-v2-experimental/agents/openai.yaml` | `5b1f887a9138416870f64ba2fe21602e4a59cfa7` |
| `brandkit/SKILL.md`, before the added section              | `0c455f9109eacb21dbaae3386f85e7f498227151` |
| `LICENSE`, in both folders                                 | `48a2f6640b81ff8eca9ce7f6a96337692713ef5b` |

`design-taste-frontend-v2-experimental` sets `disable-model-invocation: true` upstream, so agents reach it by the path in `AGENTS.md` or when a user names it. It describes itself as out of scope for dense product UI; `DESIGN.md` records how the project applies it.

## Rust best practices

The project-local `.claude/skills/rust-best-practices` is Apollo GraphQL's MIT skill, version 1.1.2, installed on 2026-11-05 from [`apollographql/skills@9dda139`](https://github.com/apollographql/skills/tree/9dda1397730370aeb8df4ff8f2015c34c86b5003/skills/rust-best-practices). The installed `SKILL.md` matches upstream Git blob `5a44d1c29a3d0a9cc5bba78effced63741453300`; its nine reference chapters remain unchanged. The upstream repository's MIT license (Copyright 2024 Apollo Graph, Inc.) is preserved in that directory. `skills-lock.json` records the install hash.

Installation used Skills CLI 1.7.6 with project scope and only the named skill selected; telemetry and remote audit requests were disabled. The source and references were read before adoption. Keep upstream text unchanged and excluded from formatting; apply repository-specific qualifications in `AGENTS.md`, not by silently editing the skill.

## Updating

Fetch a new revision into a fresh empty directory and treat it as untrusted reference data. Diff against the blobs above, keep the `brandkit` identity section as the only local change, then update this record.
