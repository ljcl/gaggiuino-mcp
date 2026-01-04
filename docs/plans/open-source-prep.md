# Open Source Preparation Plan

## Overview

Prepare gaggiuino-mcp for public release on GitHub. The changes focus on three areas: **decoupling personal/deployment-specific details**, **making data customizable**, and **standard open-source hygiene**.

---

## 1. User-Customizable Data Layer

### Problem

- `prompts.yaml` hardcodes personal equipment: "DF64 grinder" (steps 0-90), "18g IMS Nanotech basket", "Pesado HE Large"
- Profiles are broadly useful community defaults, but users may want to add/remove/override
- No mechanism to customize without editing the shipped files (which makes upgrades painful)

### Solution: `*.local.yaml` Override Pattern

**Profiles:**
- Ship `profiles.yaml` as-is (12 community profiles are great defaults)
- If `profiles.local.yaml` exists in the same directory, deep-merge it on top
- Users can add new profiles, override existing ones, or set a profile's value to `null` to remove it

**Prompts:**
- Extract personal equipment details from `prompts.yaml` into a new optional section
- The prompt template gets a `{user_context}` placeholder
- If `prompts.local.yaml` exists, its `espresso_shot_analyst.user_context` replaces the placeholder
- Default `prompts.yaml` ships with generic text for that section (no specific grinder/basket)

**Loader changes (`loader.ts`):**
- Add a `loadWithOverrides(baseFile, localFile)` helper
- `loadProfiles()` → loads `profiles.yaml`, then merges `profiles.local.yaml` if it exists
- `loadPrompts()` → loads `prompts.yaml`, then merges `prompts.local.yaml` if it exists
- `.gitignore` → add `*.local.yaml`

**User experience:**
```bash
# To customize, create local override files:
cp apps/server/src/data/prompts.example-local.yaml apps/server/src/data/prompts.local.yaml
# Edit prompts.local.yaml with your grinder, basket, etc.
```

**Docker support:**
- Mount a volume for overrides: `-v ./my-data:/app/apps/server/src/data/local/`
- Or use bind mounts for individual files
- Document both approaches

### Files to change

- `apps/server/src/loader.ts` - add merge logic, handle missing local files gracefully
- `apps/server/src/data/prompts.yaml` - genericize personal references, add `{user_context}` placeholder
- `apps/server/src/data/prompts.example-local.yaml` - new file, example with personal equipment details
- `apps/server/src/data/profiles.example-local.yaml` - new file, example showing how to add/override profiles
- `.gitignore` - add `*.local.yaml`
- `apps/server/src/server.ts` - update prompt template interpolation to handle `{user_context}`

---

## 2. Generate YAML Schemas from Zod

### Problem

Both YAML files reference schemas that don't exist:
```yaml
# yaml-language-server: $schema=./prompts.schema.json
# yaml-language-server: $schema=./profiles.schema.json
```

### Solution

- Add `zod-to-json-schema` as a dev dependency
- Create `scripts/generate-schemas.ts` that:
  1. Imports `ProfilesSchema` and `PromptsSchema` from `loader.ts`
  2. Converts to JSON Schema
  3. Writes `apps/server/src/data/profiles.schema.json` and `apps/server/src/data/prompts.schema.json`
- Add `"generate-schemas"` script to `apps/server/package.json`
- Export the Zod schemas from `loader.ts` (currently they're file-scoped `const`s)
- Run once and commit the generated files
- Add Turborepo task if desired (or just document running it manually when schemas change)

### Files to change

- `apps/server/package.json` - add `zod-to-json-schema` dev dep, add script
- `apps/server/src/loader.ts` - export `ProfileSchema`, `ProfilesSchema`, `PromptSchema`, `PromptsSchema`
- `apps/server/scripts/generate-schemas.ts` - new file
- `apps/server/src/data/profiles.schema.json` - generated
- `apps/server/src/data/prompts.schema.json` - generated

---

## 3. README Rewrite (Condensed, Generic)

### Problem

README reads as a personal homelab setup doc: references Proxmox, Tailscale throughout, architecture diagram hardcodes "Docker on Proxmox LXC" and "Tailscale Funnel."

### Solution

Restructure while keeping all content in README (per preference):

**New structure:**
1. **Header + one-liner** - What this is
2. **Features** - Keep current tool list (good as-is)
3. **Quick Start** - Clone, `.env`, `docker compose up` (keep simple)
4. **Configuration** - Env vars table (keep as-is)
5. **Connecting to AI Tools** (replaces "Adding to AI Tools")
   - Short explanation: remote MCP servers need a public HTTPS URL because AI backends connect server-to-server
   - **Option A: Tailscale Funnel** - condensed (remove Proxmox-specific bits)
   - **Option B: Cloudflare Tunnel** - brief setup
   - **Option C: ngrok** - brief setup
   - **Option D: Local network only** - keep existing section
6. **Customization** - new section
   - Customizing profiles (local overrides)
   - Customizing the dial-in prompt (grinder, basket, user context)
7. **Architecture** - Generic diagram (replace Proxmox/Tailscale with generic labels)
8. **Development** - Keep, fix stale path (`ui/shot-graph` → `packages/shot-graph`)
9. **Troubleshooting** - Generalize (not all Tailscale-specific)
10. **License** - Keep

### Changes to make

- Remove "Proxmox" from all generic references (keep as "Docker host" or "your server")
- Architecture diagram: "HTTPS tunnel / reverse proxy" instead of "Tailscale Funnel"
- Fix stale dev path: `cd ui/shot-graph` → `cd packages/shot-graph`
- Prerequisites: "Docker and Docker Compose" + "Network access to Gaggiuino" (remove Proxmox/Tailscale as prereqs)

---

## 4. CLAUDE.md Updates

### Problem

CLAUDE.md references "Docker container on Proxmox LXC, exposed via Tailscale Funnel" - deployment-specific.

### Solution

- Generalize deployment line: "Docker container (any Docker host), exposed via HTTPS tunnel"
- Add note about customizable data layer
- Keep all other content (it's developer-facing, not user-facing)

---

## 5. License File

### Problem

README says "MIT" but no `LICENSE` file exists.

### Solution

- Add `LICENSE` file with standard MIT license text

---

## 6. Git Housekeeping

### Problem

Working tree has staged deletes (docs/fixtures, docs/prompts, .zed/tasks.json) and modifications (README, .env.example) that should be resolved.

### Solution

- Commit the cleanup (deleted fixtures/prompts docs, removed .zed config) before starting open-source work
- Or incorporate into the open-source prep branch

---

## 7. Gitignore Additions

Add to `.gitignore`:
- `*.local.yaml` (user override files)
- `.venv/` (already there but confirm)

---

## Implementation Order

1. **Git housekeeping** - clean working tree
2. **Schema generation** - export Zod schemas, add script, generate JSON schemas
3. **Data layer** - local override support in loader, genericize prompts, create example files
4. **README rewrite** - restructure and generalize
5. **CLAUDE.md updates** - generalize deployment references
6. **LICENSE file** - add MIT license
7. **Final review** - grep for remaining personal/deployment-specific references

---

## Out of Scope (for now)

- GitHub Actions CI (deferred per decision)
- CONTRIBUTING.md (can add later)
- GitHub issue/PR templates (can add later)
- npm publishing (package stays `private: true`)
- Authentication/auth middleware (noted as future enhancement in README)
