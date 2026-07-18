# Agent Memory

Before planning or making changes in this repo, read the shared cross-project memory vault at `../Memory` (an Obsidian vault also used by GitHub Copilot):

1. `../Memory/AI/Agent Instructions.md` — standing protocol, vault conventions, session log format. Read this first, every session.
2. `../Memory/Cross-Repo/` — shared conventions, decisions (ADR-012 governs shared-package rules: zero runtime deps, CommonJS, no native modules, structural types), and the Shared Tech Ledger.
3. The 2–3 most recent files in `../Memory/AI/sessions/`.

At the end of the session, write a log to `../Memory/AI/sessions/YYYY-MM-DD-claude[-N]-<slug>.md` per the template in `Agent Instructions.md`.

## Repo-specific constraints

- **No React Native imports, ever.** Everything platform-specific is inverted:
  persistence goes through the injected `KVStorage`, the environment goes
  through the injected `EnvSource`, and `fetch` is injectable for tests. This is
  what lets the same package serve travel/chef/gym and still run under plain
  Node in CI.
- **Zero runtime dependencies.** `zod` is an *optional peer* — `task.ts` types
  its validator structurally (`{ safeParse }`), so any validator works and the
  package never imports zod. Keep it that way.
- **The package never imports domain types.** Prompts and schemas belong to the
  consuming app; `defineAiTask` is parameterised by the app's own schema. If a
  travel/chef/gym concept ever appears in `src/`, the abstraction has leaked.
- **Never ship price data that hasn't been verified.** `ModelInfo.pricing` is
  optional and unset for every seeded model. An absent price suppresses cost
  estimation; it must never be treated as zero. Vendor prices change without
  notice and a stale number displayed as fact is worse than no number.
- **Usage summaries stay shaped by billing model.** `UsageSummary` is a
  discriminated union on purpose — a quota provider and a pay-per-token account
  need different displays. Don't flatten it into one counter with a nullable
  limit.
- **Model ids churn faster than endpoints.** Ids live in `catalog.ts`, endpoints
  in `providers.ts`, deliberately separate. Re-verify ids against the live
  `GET /models` before trusting them; `discoverModels()` + `mergeCatalog()`
  exist for this.

## Verified facts (2026-07-18)

- GitHub Models' catalog is **publicly readable without a token**:
  `curl https://models.github.ai/catalog/models`.
- That catalog carries **no Grok and no GLM**, and its DeepSeek entries are
  **text-only** (no vision). Those models are only reachable through the
  vendors' own APIs — the reason the provider abstraction exists.
- All four bundled providers speak the OpenAI chat-completions wire format with
  bearer auth. That is a property of these providers, not an assumption baked
  into the `Provider` type.

## Workflow

Tests are vitest (`npm test`), matching rn-command-kit. Gates before any tag:
`npm run typecheck && npm test && npm run build`. Consumers pin by tag
(`github:laurenthh/rn-ai-kit#v1`), so a tag is a release — don't move one.
