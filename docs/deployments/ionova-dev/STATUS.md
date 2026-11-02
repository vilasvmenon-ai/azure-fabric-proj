# Delivery status (DEL-07): ioNova dev

Deployment record for **ioNova / dev** (Fabric in the ioNova tenant, Foundry in a separate tenant, D-03a). Other teams: start from [../_template/STATUS.md](../_template/STATUS.md).

Last updated: **2 November 2026**. Workstation: Windows 10, Node.js 24.22.1, npm 11.19.1, Azure CLI 2.91.0, Rayfin CLI 1.36.2, Git 2.56.
Repository: `github.com/vilasvmenon-ai/azure-fabric-proj` (private), tags `v1.0.0-dev.1` and `v1.0.0-dev.2` (both on the first deployed state, commit `6c5677c`) and `v1.0.0-dev.3` (repository made reusable for new environments).

## Status summary

| Component | Generated | Built | Locally tested | Deployed | Runtime-verified |
| --- | --- | --- | --- | --- | --- |
| App A data model and row-level policies (7 entities) | ✅ | ✅ | ✅ type-checked | ✅ | ⚠️ schema verified (R-09); policies with a second user (R-08, V-2x) not yet tested |
| App A Functions (19) incl. existing-agent adapter, SQL store, audit chain | ✅ | ✅ | ✅ 78 unit tests | ✅ | ✅ bootstrap, seed, diagnostics, probe, evaluation, end-to-end submit, super_user claim, audit chain |
| App A React frontend | ✅ | ✅ | ✅ 44 tests | ✅ | ✅ single-user flows in the browser |
| App B (isolation) | ✅ | ✅ | ✅ 42 tests | ✅ | ✅ note persisted; data separation verified at DB level |
| PowerShell scripts | ✅ | ✅ parse (PS 5.1), ASCII-only | ✅ | n/a | ✅ 10–80 run against this environment (42 only in its refuse-if-exists path; 61 see below) |
| Configuration templates and register | ✅ | n/a | ✅ | n/a | ✅ register filled: [app-register.json](app-register.json) |

Legend: ✅ done, with evidence below. ⚠️ partial. ❌ not done.

## Deployment progress (dev, ioNova tenant)

| Item | State | Evidence |
| --- | --- | --- |
| Workspace `ws-ionova-ai-lab-dev` (`508eaf7a-…`) on the trial `e15ff259-…` (FTL4, Central India) | **Created** | Fabric API create and get |
| App A `app-ionova-ai-lab-ars-dev` (`f29a149f-…`): SQL DB `3e4dca25-…`, functions, protected static hosting | **Deployed** | `evidence/20261026T102821Z-deploy-ars-dev.log`, Fabric item list |
| Schema names (R-09) | **Verified**; table names pluralised, fixed in `sqlNames.ts` | `evidence/20261026T103857Z-schema-dev.csv`; snapshot `docs/schema/ars-schema.sql` (2 Nov) |
| Runtime config and Foundry SP secret in Rayfin | **Set** | `50-Verify-Deployment.ps1` evidence |
| Bootstrap admin, seed (6 samples), diagnostics | **Runtime-verified** (browser and DB) | audit #1–#4 |
| Existing Foundry agent called from the **deployed** backend through the cross-tenant SP | **Runtime-verified**: SUCCESS, contract valid, 12.4 s | audit #14, corr `a9b44321-…` |
| Issues found and fixed during deployment | PS 5.1 stderr handling; table pluralisation; BOM on piped secrets; nested email claim in Fabric-hosted tokens (`xms_attr.*.rfn_email`); SP role (Runtime User → Agent Consumer) | DECISIONS D-03a, D-24; [SETUP-NEW-ENVIRONMENT.md](../../SETUP-NEW-ENVIRONMENT.md) "Known pitfalls" |
| Live evaluation (AI-06, V-07) on the deployed backend | 6 of 6 contract valid; 4 of 6 exact match (UAE and injection differ; field detail to be agreed) | audit #15–#20 |
| Audit hash chain (AUD-03) | **Intact**, 28 of 28 events | SQL check, 26 Oct |
| Data export and read-back (DATA-04, V-31) | **Pass**: 7 tables, 34 rows, hashes verified | `exports/dev/20261026T120135Z` |
| Application register (AC-01) | App A and App B filled | [app-register.json](app-register.json) |
| App B `app-ionova-ai-lab-isob-dev` (`1193d903-…`), SQL DB `c474fba1-…`, protected hosting | **Deployed and runtime-verified** (note created and still there after reload) | `evidence/20261026T123150Z-status-isob-dev.json` |
| `super_user` role (D-57) | **Deployed and claimed** (audit #24, granted_by `deployment-config`) | `evidence/20261026T131445Z-status-ars-dev.json` |
| **End-to-end flow (V-06, AC-03)** | **Runtime-verified**: India sample and a custom US address, both COMPLETED, VALID, agent `address-structuring-lab@1`, gpt-5-mini, about 10–11 s; survive a reload; audit #25–#28 hold no address text | SQL checks, 26 Oct |
| Data separation A/B (PRJ-03, data part) | **Verified**: separate databases on the same Fabric SQL server | SQL checks, 26 Oct |
| Git repository and tags | **Pushed** `main` at `6c5677c` with `v1.0.0-dev.1` and `v1.0.0-dev.2`; `v1.0.0-dev.3` after the clean-rebuild test | GitHub |

## Still to do

| # | Task | Needed from | Resolves |
| --- | --- | --- | --- |
| 1 | A second ioNova test account: review, auditor, A-only/B-only access separation, direct-API denial (R-07, R-08, R-11) | Tenant admin, testers | V-2x, AC-02 |
| 2 | Failure tests with fault injection (dev only) | Testers | V-1x |
| 3 | Agree the UAE and injection evaluation results; set acceptance thresholds (R-13) | Project owner | V-07 |
| 4 | Performance measurement (G-14) | Testers | V-33 |
| 5 | Dependency advisories: transitive through Microsoft Rayfin 1.36.2 packages; not overridden | Project owner | Security hygiene |
| 6 | Cost owner and Foundry budget alert (R-14) | Cost owner | M-23 |

## What must not be claimed yet

- That the access policies separate users correctly (needs the second account), that failure handling works on Fabric, or that the performance targets are met.
