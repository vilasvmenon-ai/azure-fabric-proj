# Readiness record (PRD §3 "Readiness record", §10 "Decisions to close")

Fill this in during readiness, before building is accepted. Every row needs **evidence** and an **owner**. A row marked *VERIFY* in [DECISIONS.md](../../DECISIONS.md) passes only after the deployed test shown here passes.

| ID | Item | How to confirm | Result | Evidence | Owner | Date |
| --- | --- | --- | --- | --- | --- | --- |
| R-00 | Tenant ID, organization, primary and backup admin, subscription | MANUAL-STEPS M-02 | | | | |
| R-01 | Trial expiry, capacity size (F4/F64), capacity region, tenant home region | M-03, M-04, and `20-Test-FabricReadiness.ps1` | **Pass**: FTL4 trial, Central India, Active; expiry 2026-12-22 (estimated); home region Central India (G-17 cross-region accepted) | `evidence/20261026T101517Z-readiness-dev.json` | vilas@ionova.ai | 2026-10-26 |
| R-02 | Fabric Apps (preview) tenant setting enabled for authors | M-05; **App (preview)** appears in **New item** | **Pass**: App (preview) listed for vilas@ionova.ai | user confirmation | vilas@ionova.ai | 2026-10-26 |
| R-03 | Fabric Apps **Functions** work on this trial capacity and region | M-13 deploy succeeds *with* functions, then V-05 probe returns | **Pass**: 18 functions deployed; bootstrap, seed and probe ran on Fabric | `evidence/20261026T102821Z-deploy-ars-dev.log`, audit #1-#14 | vilas@ionova.ai | 2026-10-26 |
| R-04a | Cross-tenant Foundry access: the service principal exists in the Foundry tenant with only Foundry Agent Consumer on the project, and `IONOVA_FOUNDRY_CLIENT_SECRET` is set in Rayfin | `41-Setup-FoundryServicePrincipal.ps1` evidence, `rayfin secret list`, then the V-05 probe | **Pass**: probe SUCCESS 11:47:47 UTC after Foundry Agent Consumer was assigned. Foundry Project Runtime User alone gave 403. | audit #14 (corr `a9b44321-bbe5-472f-8c62-fb9ef98682b8`), `evidence/20261026T110253Z-foundry-sp-dev.json` | vilas@ionova.ai | 2026-10-26 |
| R-04 | Runtime identity = Fabric App item owner (used for the app SQL database); owner recorded | Item **Owner** in the portal matches `runtimeIdentity.ownerUpn`. V-05 succeeds only after M-15 | | | | |
| R-05 | Existing Foundry endpoint, agent name/version, API style (Agents API, agent endpoint `…/agents/{name}/endpoint/protocols/openai/responses?api-version=v1`) | M-14 and V-05 | **Pass**: `address-structuring-lab` v1 (prompt, gpt-5-mini) reached through the agent endpoint route | `evidence/20261026T101144Z-foundry-agent-check-dev.json`, audit #14 | vilas@ionova.ai | 2026-10-26 |
| R-06 | The agent returns the reference contract (`fields`/`evidence`/`notes`) | V-05 *contract valid*, V-07 | **Pass (probe)**: contractValid true; instructions identical to the reference. V-07 evaluation still to run | audit #14 | vilas@ionova.ai | 2026-10-26 |
| R-07 | Caller identity verified in functions: a tampered or expired token is rejected | V-23 with an edited `Authorization` header returns UNAUTHENTICATED, or the platform rejects it first | | | | |
| R-08 | Server-only entities aren't readable or writable through the generated data API | DevTools: replay a `/api/graphql` (or `/graphql`) request to query `AuditEvent` / `AppMembership`, then try a mutation. Expect no rows or a denial | | | | |
| R-09 | Physical table and column names match `sqlNames.ts` | `51-Test-AppSchema.ps1` and the **Diagnostics** button | **Pass** after the fix: Rayfin pluralises table names, so `sqlNames.ts` was updated. All 7 tables and every column match; no `NVARCHAR(MAX)` | `evidence/20261026T103857Z-schema-dev.csv` | vilas@ionova.ai | 2026-10-26 |
| R-10 | Protected audit destination: append-only through the app, hash chain verifiable | V-30; residual risk G-15 accepted by the project owner | **Pass (chain)**: 23 of 23 events verified, seq 1–23, intact. Data-API exposure (R-08) still to test | check-5 output (26 Oct 11:59 UTC) | vilas@ionova.ai | 2026-10-26 |
| R-11 | Trusted role mapping: in-app membership; no self-assignment | V-03, V-24 | | | | |
| R-12 | Sample data approved (synthetic only) | Review `apps/ars/packages/functions/src/samples.ts` | | | | |
| R-13 | Acceptance thresholds (performance, AI response target, evaluation expectations) agreed | V-07, V-33 | | | | |
| R-14 | Cost owner and usage limits for Foundry recorded; budget alert set | M-23 | | | | |

**Go/no-go:** If R-02 or R-03 fails, Fabric Apps or Functions aren't usable on this trial. Report it as a blocker with the resolution path: a supported region or a paid F capacity, which is an approved scope change. Do not substitute another host (PRD §10).
