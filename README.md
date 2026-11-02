# ioNova AI Lab: Fabric Apps + existing Foundry agent

This repository implements the **ioNova Microsoft Fabric and Foundry Application Platform PRD v1.2**:

- **App A, Address Structuring Lab:** React + TypeScript frontend, Rayfin (Fabric Apps) TypeScript Functions and an app-owned Fabric SQL database, all hosted on **Microsoft Fabric Apps (preview)**. At runtime it calls the **existing** Microsoft Foundry address-structuring agent.
- **App B, isolation test app:** a minimal, separately permissioned Fabric App. It exists to prove that code, data and access stay separate.

Everything Fabric-side uses the **Rayfin CLI/SDK 1.36.2**. Foundry is called only from Rayfin Functions. Fabric (the ioNova tenant) and the existing Foundry project are in **different tenants**, so the function authenticates to Foundry with a dedicated service principal in the Foundry tenant. Its secret is held only as a Rayfin function secret (D-03a). The existing agent, its instructions and its model deployment are never created or modified.

> **Status:** source generated, built and tested locally. **Not yet deployed or verified at runtime** (no tenant access was used). See [docs/STATUS.md](docs/STATUS.md).

## Repository layout

```text
ionova-ai-lab/
├── apps/
│   ├── ars/                          App A (Rayfin project, scaffolded with rayfin init + packs)
│   │   ├── rayfin/rayfin.yml         Fabric App services: Fabric SSO auth, SQL data, functions, protected static hosting
│   │   ├── packages/data/            Rayfin entities (schema + row-level policies)
│   │   ├── packages/shared/          Browser-safe contracts (records, API types)
│   │   ├── packages/functions/       Rayfin Functions: auth/roles, Foundry adapter, SQL store, audit, tests
│   │   ├── packages/frontend/        React + Vite app (Fabric SSO, routing, screens, tests)
│   │   └── scripts/functions-typegen.mjs   Rayfin CLI type generator (offline)
│   └── isolation-b/                  App B (Rayfin project)
├── config/                           Configuration templates and application register (no credentials)
├── scripts/                          PowerShell setup, deployment, verification, export, rollback
└── docs/                             Decisions, readiness, manual steps, verification, support, status
```

## Exact execution order

| # | Step | Command or document | Who |
| --- | --- | --- | --- |
| 1 | Read the decisions and gaps | [docs/DECISIONS.md](docs/DECISIONS.md) | Everyone |
| 2 | Install tools | [M-01](docs/MANUAL-STEPS.md#m-01-install-local-tools) | Operator |
| 3 | Tenant, trial, tenant setting, workspace, groups, access | [M-02 to M-08](docs/MANUAL-STEPS.md) | Tenant/Fabric admin |
| 4 | Fill in configuration | `config\ionova.dev.json` ([M-09](docs/MANUAL-STEPS.md#m-09-fill-in-the-configuration-file)) | Project admin |
| 5 | Choose the item owner (runtime identity) | [M-10](docs/MANUAL-STEPS.md#m-10-choose-the-item-owner-runtime-identity-ai-03-g-04) | Project admin |
| 6 | Prerequisites | `.\scripts\00-Test-Prerequisites.ps1` | Item owner |
| 7 | Sign in | `.\scripts\10-Connect-Tenant.ps1` | Item owner |
| 8 | Readiness (read-only) | `.\scripts\20-Test-FabricReadiness.ps1` | Item owner |
| 9 | Deploy App A | `.\scripts\30-Deploy-App.ps1 -App ars -DryRun`, then without `-DryRun` | Item owner |
| 10 | Confirm the existing agent (read-only) | [M-14](docs/MANUAL-STEPS.md#m-14-confirm-the-existing-foundry-agent-ai-01-set-04-portal-read-only) | Item owner |
| 11 | Cross-tenant Foundry access: service principal plus Rayfin secret (D-03a) | `.\scripts\41-Setup-FoundryServicePrincipal.ps1 -WhatIf`, then without `-WhatIf` | Foundry tenant admin, with Rayfin signed in to Fabric |
| 12 | Database coordinates and runtime config | `31-Resolve-AppDatabase.ps1`, `32-Set-RuntimeConfig.ps1`, `51-Test-AppSchema.ps1` | Item owner |
| 13 | Deploy App B | `.\scripts\30-Deploy-App.ps1 -App isob` | Item owner |
| 14 | Bootstrap the admin, seed, probe Foundry | [M-18](docs/MANUAL-STEPS.md#m-18-first-sign-in-bootstrap-the-administrator-seed-sample-data) | Bootstrap admin |
| 15 | In-app roles, then item sharing | [M-19](docs/MANUAL-STEPS.md#m-19-grant-business-roles-in-the-app-acc-02-acc-03), [M-20](docs/MANUAL-STEPS.md#m-20-share-each-fabric-app-item-with-its-users-only-acc-01-prj-03-portal) | App admin / project admin |
| 16 | Verify | `.\scripts\50-Verify-Deployment.ps1`, then every runtime test in [docs/VERIFICATION.md](docs/VERIFICATION.md) | Testers |
| 17 | Register | `.\scripts\70-Update-Register.ps1 -ChangedBy … -Reason …` | Project admin |
| 18 | Monitoring, cost, expiry | [M-23](docs/MANUAL-STEPS.md#m-23-monitoring-alerts-and-cost-log-02-portal), [M-24](docs/MANUAL-STEPS.md#m-24-before-the-trial-expires-data-04) | Support owner |

Ongoing operations, rollback, export and shutdown: [docs/SUPPORT.md](docs/SUPPORT.md).

## Build and test locally (no Azure needed)

```powershell
cd apps\ars
npm ci
npm run typecheck; npm run lint; npm test; npm run build
```

Repeat in `apps\isolation-b`. After changing any `udf.func()` signature, run `npm run functions:typegen`, then `npm run validate:functions`.

## Security notes

- There's one credential: the Foundry service principal secret. It lives only in the Rayfin secret store, expires after 6 months, and is rotated with `41-Setup-FoundryServicePrincipal.ps1 -RotateSecret`. Everything else uses Fabric SSO for users, the Rayfin application token for SQL, and your own `az` sign-in for admin scripts.
- Business roles are enforced on the server from the app database. The UI only hides actions the server would refuse.
- Audit events are written only by server code, in the same transaction as the business change, and are hash-chained.
- The frontend bundle is scanned for tokens and backend endpoints before every deployment (`30-Deploy-App.ps1`).
