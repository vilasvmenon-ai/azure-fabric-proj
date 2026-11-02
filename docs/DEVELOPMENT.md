# Developer guide

How to build, test and change the code. Deployment is in [SETUP-NEW-ENVIRONMENT.md](SETUP-NEW-ENVIRONMENT.md).

## Toolchain

- Node.js **24** (`.nvmrc`; tested with 24.22.1) and npm 11. Each app is an npm workspace with its own `package-lock.json`: always run `npm ci` from `apps/ars` or `apps/isolation-b`, never inside a package.
- Rayfin SDK and CLI **1.36.2**, pinned by the lockfiles. Don't bump Rayfin package versions by hand. Upgrade with the Rayfin tooling, then rerun every gate and script 52 (schema drift).
- The installed Rayfin docs are authoritative: `apps/ars/node_modules/@microsoft/rayfin-guide/assets/docs/index.md`. Each app's `AGENTS.md` and `.agents/skills/` describe the template conventions.

## Build and test (no Azure needed)

```powershell
cd apps\ars
npm ci
npm run typecheck     # shared build, functions contract validator, functions build, tsc -b
npm run lint
npm test              # functions (vitest, store and Foundry are test doubles) and frontend (vitest + Testing Library)
npm run build:fabric  # the production build that rayfin up deploys
```

Run the gates in that order, one at a time: typecheck and build share TypeScript outputs. Repeat in `apps\isolation-b` (no functions there).
Expected counts at v1.0.0-dev.3: functions 78 tests, ars frontend 44, isob 42.

## Code map (App A)

| Package | What lives there | Notes |
| --- | --- | --- |
| `packages/shared` | Browser-safe contracts (`index.ts`) | Use `type` aliases, not interfaces: the function type generator needs them |
| `packages/data` | Rayfin entities and row-level policies | Every `@text` needs a `max` (NVARCHAR(MAX) breaks the GraphQL layer). Policies support only `.eq` on `claims.sub/email/role`. Rayfin pluralises table names. |
| `packages/functions/src/function_app.ts` | The 19 `udf.func(...)` entry points | Each one goes through `run()`: correlation ID, caller identity, error mapping |
| `functions/src/service.ts` | Business rules: roles, submit, review, audit, admin | Roles come from `AppMemberships`, re-checked on every call |
| `functions/src/sqlStore.ts`, `sqlNames.ts` | SQL access with the Rayfin SQL token; physical table and column names | Change names **only** in `sqlNames.ts`; script 51 checks them against the live database |
| `functions/src/foundry.ts`, `foundryToken.ts`, `contract.ts` | Agent call (Responses protocol, `store:false`), service principal token, output contract validation | The agent itself is never created or modified by app code |
| `functions/src/config.ts` | Runtime config (`IONOVA_RUNTIME_CONFIG` secret) parsing and environment rules | Fault injection and `superUserEmails` are refused in prod |
| `packages/frontend` | React + Vite UI | Calls functions through `src/lib/api.ts`; reads policy-safe data straight from the Rayfin data API |

## Changing things

- **A function signature:** edit `function_app.ts`, then `npm run functions:typegen` (after the shared build), then `npm run validate:functions`. The validator forbids casts on `client.functions`.
- **An entity or column:** edit `packages/data/src`, update `sqlNames.ts` (`TABLES`, `EXPECTED_COLUMNS`), deploy to dev, then run `51-Test-AppSchema.ps1` and `52-Export-SchemaSnapshot.ps1`, and commit `docs/schema/`. Rayfin refuses destructive migrations, and the scripts never pass `--force`.
- **Only function code changed:** `npx rayfin up functions deploy` in `apps\ars` is enough. Wait about 2 minutes between publishes.
- **Runtime settings** (bootstrap or super-user emails, fault injection, Foundry IDs): edit `config/ionova.<env>.json` and rerun `32-Set-RuntimeConfig.ps1`. No redeploy is needed.
- **The agent's instructions:** out of scope for app changes. `foundry/agent/` is a copy for creating the agent in new projects. If the source agent changes, export it again and update the SHA-256.

## PowerShell conventions (Windows PowerShell 5.1 compatible)

- Scripts are ASCII-only and import `scripts/IonovaDeploy.psm1`.
- Run native tools with `Invoke-Native` (it judges success by exit code). Pipe secrets with `Invoke-NativeWithStdin` (no BOM, never echoed).
- Read and write files with `[IO.File]` and UTF-8 without BOM, not `Get-Content`/`Set-Content`.
- Every write to a tenant supports `-WhatIf` or asks for confirmation. Evidence goes to `evidence\` (git-ignored).

## Git

- `main` holds releases. Tag each deployed state (`v<release>-<env>.<n>`, for example `v1.0.0-dev.3`). Never move a tag that has been pushed; create the next number instead. Rollback (script 80) redeploys a tag.
- Never commit `config/ionova.<env>.json`, `evidence/`, `exports/`, `.env*`, `local.settings.json` or `rayfin/.deployments.json`; `.gitignore` covers them. Do commit `docs/deployments/<org>-<env>/`.
