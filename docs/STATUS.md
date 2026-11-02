# Delivery status (DEL-07)

Report date: **26 October 2026**. Environment: a local Windows 10 workstation, with Node.js 24.22.1, npm 11.19.1, Azure CLI 2.91.0 and Rayfin CLI 1.36.2.
**Tenant access was not used.** Nothing has been deployed to Microsoft Fabric or called in Microsoft Foundry.

## Status summary

| Component | Generated | Built | Locally tested | Deployed | Runtime-verified |
| --- | --- | --- | --- | --- | --- |
| App A data model and row-level policies (7 entities) | ✅ | ✅ `tsc -b` | ✅ type-checked; policies **not** exercised (needs the Rayfin data API) | ❌ | ❌ R-08 |
| App A Functions (18) incl. existing-agent adapter, SQL store, audit chain | ✅ | ✅ | ✅ 62 unit tests (store and agent are test doubles) | ❌ | ❌ R-03 to R-07, R-09, V-05 to V-15 |
| App A generated function schema (`types.ts`) | ✅ via the Rayfin CLI generator | ✅ | ✅ `validate:functions` ok (18/18, 0 casts) | n/a | n/a |
| App A React frontend | ✅ | ✅ Vite production build (423 kB JS) | ✅ 44 tests (backend mocked) | ❌ | ❌ V-01, V-20 to V-34 |
| App B (isolation) data model and React frontend | ✅ | ✅ | ✅ 42 tests | ❌ | ❌ V-20, V-21 |
| PowerShell scripts (13 files) | ✅ | ✅ all parse (PS 5.1), ASCII-only | ⚠️ `00-Test-Prerequisites.ps1` and the helper functions were run locally; scripts 10 to 80 need tenant access and were **not run** | ❌ | ❌ |
| Configuration templates and register | ✅ | n/a | ✅ placeholder detection tested | n/a | ❌ AC-01 |
| Documentation (decisions, readiness, manual steps, verification, support) | ✅ | n/a | n/a | n/a | n/a |

Legend: ✅ done, with evidence below. ⚠️ partial. ❌ not done, which requires tenant access.

## Deployment progress, 26 Oct 2026 (dev, ioNova tenant)

| Item | State | Evidence |
| --- | --- | --- |
| Workspace `ws-ionova-ai-lab-dev` (`508eaf7a-…`) on the trial `e15ff259-…` (FTL4, Central India) | **Created** | Fabric API create and get |
| App A `app-ionova-ai-lab-ars-dev` (`f29a149f-…`): SQL DB `3e4dca25-…`, 18 functions, protected static hosting | **Deployed** | `evidence/20261026T102821Z-deploy-ars-dev.log`, Fabric item list |
| Schema names (R-09) | **Verified**; table names pluralised, fixed in `sqlNames.ts` | `evidence/20261026T103857Z-schema-dev.csv` |
| Runtime config and Foundry SP secret in Rayfin | **Set** | `50-Verify-Deployment.ps1` evidence |
| Bootstrap admin, seed (6 samples), diagnostics | **Runtime-verified** (browser and DB) | audit #1–#4 |
| Existing Foundry agent called from the **deployed** backend through the cross-tenant SP | **Runtime-verified**: SUCCESS, contract valid, 12.4 s | audit #14, corr `a9b44321-…` |
| Issues found and fixed during deployment | PS 5.1 stderr handling; table pluralisation; BOM on piped secrets; nested email claim in Fabric-hosted tokens (`xms_attr.*.rfn_email`); SP role (Runtime User → Agent Consumer) | this file, DECISIONS D-03a, D-24 |
| Live evaluation (AI-06, V-07) on the deployed backend | 6 of 6 contract valid; 4 of 6 exact match (UAE and injection differ; field detail to be agreed) | audit #15–#20 |
| Audit hash chain (AUD-03) | **Intact**, 23 of 23 events | check 5 |
| Data export and read-back (DATA-04, V-31) | **Pass**: 7 tables, 34 rows, hashes verified | `exports/dev/20261026T120135Z` |
| Application register (AC-01) | App A filled; App B pending; repository pending (no Git) | `config/app-register.json` |
| App B `app-ionova-ai-lab-isob-dev` (`1193d903-…`), SQL DB `c474fba1-…`, protected hosting | **Deployed and runtime-verified** (note created and still there after reload) | `evidence/20261026T123150Z-status-isob-dev.json` |
| `super_user` role (D-57), redeployed 26 Oct 13:14 UTC | **Deployed**; DB check constraint `CK_AppMemberships_role` includes `super_user`; runtime config lists vilas@ionova.ai. **Claimed** 13:3x UTC (audit #24, granted_by `deployment-config`) | `evidence/20261026T131445Z-status-ars-dev.json` |
| **End-to-end flow (V-06, AC-03 submit/structure/save/retrieve)** | **Runtime-verified**: 2 addresses (India sample, plus a custom US address) went through the deployed function to the existing agent and back into the DB. Both COMPLETED, VALID, FIELDS_PRESENT, agent `address-structuring-lab@1`, gpt-5-mini, about 10–11 s. Each has a separate original input, model output and current fields; both survive a reload. Audit #25–#28 hold no address text; the chain is intact (28 of 28) | SQL checks, 26 Oct 13:4x UTC |
| Data separation A/B (PRJ-03, data part) | **Verified**: separate databases on the same Fabric SQL server. App B has only `IsolationNotes` (1 row) and Rayfin `Users`; App A has its 7 tables and no `IsolationNotes` | SQL checks, 26 Oct 12:4x UTC |
| Still to do | A second ioNova test account (end-to-end submit, review, auditor, A-only/B-only access separation, direct-API denial); item sharing; Git repository; agree the UAE/injection evaluation results | VERIFICATION.md |

## Change on 26 Oct 2026: cross-tenant Foundry (D-03a)

- Fabric runs in the **ioNova** tenant with a work account. The gmail personal account was rejected by Fabric (HTTP 401, `idp=live.com`).
- The existing Foundry project stays in tenant `26919914-…` (`address-lab-resource` / `vilasvmenon-3809`, East US 2).
- Functions now get a Foundry-tenant token from a dedicated service principal. Its secret is a Rayfin function secret, set by new script 41 (`foundryToken.ts`, 7 new unit tests; functions tests: **71 passed**).
- Script 41 is written and parse-checked but **not run**. That happens during deployment.

## Command results (clean `npm ci` from the lockfile, then each gate)

| App | Command | Exit | Result |
| --- | --- | --- | --- |
| ars | `npm ci` | 0 | 672 packages from `package-lock.json` |
| ars | `npm run typecheck` | 0 | `validate:functions`: `{"ok": true, "authoredFunctions": 18, "generatedFunctions": 18, "unsafeFunctionCasts": 0}`; `tsc -b` clean |
| ars | `npm run lint` | 0 | No problems |
| ars | `npm test` | 0 | Functions: 4 files, **62 passed**. Frontend: 6 files, **44 passed** |
| ars | `npm run build:fabric` | 0 | Frontend built; bundle secret scan (script 30 patterns): **0 hits** |
| isolation-b | `npm ci` | 0 | 646 packages |
| isolation-b | `npm run typecheck` / `lint` | 0 / 0 | Clean |
| isolation-b | `npm test` | 0 | 5 files, **42 passed** |
| isolation-b | `npm run build:fabric` | 0 | Built; secret scan 0 hits |
| repo | `scripts\00-Test-Prerequisites.ps1` | 1 (expected) | Node, npm, Azure CLI and Rayfin CLI OK. **Git not installed** on this workstation. `config\ionova.dev.json` not created (needs real tenant values) |

## Blockers and remaining tasks

| # | Blocker or task | Needed from | Resolves |
| --- | --- | --- | --- |
| 1 | Tenant, Fabric trial, Fabric Apps tenant setting, workspace and groups | ioNova tenant/Fabric admin (M-02 to M-08) | R-00 to R-02 |
| 2 | Real configuration values: workspace, capacity, existing Foundry endpoint, project resource ID, agent name and version, item owner | Project admin (M-09, M-10, M-14) | Deployment inputs |
| 3 | Deploy App A and App B, then confirm that Functions run on the trial (G-02) | Item owner (M-13, M-17) | R-03 |
| 4 | Foundry role for the app identity at the project scope | Foundry project owner (M-15) | R-04, V-05 |
| 5 | Confirm the assumptions marked VERIFY in DECISIONS.md: Rayfin physical table names (R-09), server-only entity exposure (R-08), token verification behaviour (R-07), agent endpoint route and response shape (R-05, R-06) | Testers after deployment | Runtime acceptance |
| 6 | Runtime tests V-01 to V-34, including access separation, failure injection and performance | Testers with the accounts in VERIFICATION.md | AC-01 to AC-06 |
| 7 | Install Git and put the repository under version control (tags are used for rollback) | Operator | AC-06, V-32 |
| 8 | Dependency advisories reported by `npm audit`. Runtime: 7 high (ars) and 4 high (isob), all **transitive through Microsoft Rayfin packages** (`@azure/msal-node`, `zod` via `@microsoft/rayfin-*` 1.36.2). Not overridden, so the platform's pinned versions stay intact. Review again when Rayfin publishes an update | Project owner | Security hygiene |
| 9 | Optional audit-table DB hardening (G-15) and full tracing (G-08) | Production phase | Not required for the pilot |

## What must not be claimed yet

- That the app runs on Fabric, that the Foundry agent is reachable from the deployed backend, that the access policies work, or that the performance targets are met. None of these has execution evidence.
- Update this file as each runtime test passes. Attach the `evidence\` files the scripts write, and fill in [READINESS.md](READINESS.md).
