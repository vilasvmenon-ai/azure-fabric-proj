# Implementation decisions, gaps and unsupported requirements

PRD: *ioNova Microsoft Fabric and Foundry Application Platform*, Draft v1.2 (26 Oct 2026).
Microsoft documentation re-checked on **26 October 2026** (sources at the end).
Toolchain verified on npm the same day: Rayfin SDK/CLI **1.36.2** (all `@microsoft/rayfin-*` and
`@microsoft/fabric-user-data-functions` packages).

Each decision has an ID (`D-nn`). Gaps and blockers have `G-nn` IDs. Items marked **VERIFY** are
assumptions that only a deployed tenant can confirm; each one has a readiness test in
[READINESS.md](READINESS.md).

---

## 1. Platform and tooling

| ID | Decision | Reason / PRD link |
| --- | --- | --- |
| D-01 | Host frontend, backend functions and app database on **Microsoft Fabric Apps (preview)**, built with the **Rayfin SDK 1.36.2**. No other host is used or substituted. | PRD §1, §10 "do not substitute another application host". |
| D-02 | **All Fabric-side operations use the Rayfin CLI/SDK**: `rayfin login`, `rayfin up` (create item, schema, functions, static hosting), `rayfin up db apply`, `rayfin up functions deploy`, `rayfin up staticapp deploy`, `rayfin up status/list/switch`, Rayfin data models/policies, Rayfin data client, Rayfin Fabric SSO and Rayfin Functions. | User instruction; DEL-03 "supported CLIs". |
| D-03 | **Foundry is called only from Rayfin Functions**, never from the browser. Same-tenant mode (`foundry.auth = rayfinAppIdentity`) uses the Rayfin-issued `ctx.Tokens.AzureAI` application token. | AI-02, AI-03. |
| D-03a | **Approved by the user on 26 Oct 2026: Fabric and Foundry are in different tenants.** Fabric uses the ioNova tenant (work account). The existing Foundry project stays in its current tenant (`26919914-…`, resource `address-lab-resource`, project `vilasvmenon-3809`) and is not moved or recreated. Rayfin issues `ctx.Tokens.AzureAI` in the Fabric tenant, and Foundry rejects those tokens. So the function gets a Foundry-tenant token through the OAuth client-credentials grant of a **dedicated single-tenant service principal** in the Foundry tenant. That principal holds only **Foundry Agent Consumer at the Foundry project scope** (data action `AIServices/endpoints/interact/action`, which is what the agent endpoint call needs). Verified 26 Oct 2026: *Foundry Project Runtime User* (`AIServices/responses/*`) returned HTTP 403 for the agent endpoint. It is still assigned and harmless; *Foundry User* (formerly *Azure AI User*) is a broader fallback that was not needed (`foundryToken.ts`). Its **client secret is a Rayfin function secret** (`IONOVA_FOUNDRY_CLIENT_SECRET`, set by `41-Setup-FoundryServicePrincipal.ps1` through `rayfin secret set --stdin`). It is never in source, config, logs or the browser, and it expires after 6 months (rotate with `-RotateSecret`). Tokens are cached per worker until 5 minutes before expiry. The default `foundry.auth` is `servicePrincipal`. | AI-02, AI-03, user decision. |
| D-04 | Actions that Rayfin cannot perform are **numbered manual portal steps** or the official `az` CLI: enabling the *Fabric Apps (preview)* tenant setting, starting the trial, item sharing (Run and interact), Entra security groups, and the Foundry RBAC role assignment. Nothing is invented. | DEL-03. |
| D-05 | Dependencies are **pinned to exact versions** and a `package-lock.json` is committed per package. | §9 "Pin dependencies". |
| D-06 | Each app is a **separate Rayfin project** in `apps/<app>/`, deployed as a separate Fabric App item with its own SQL database, auth service, config and register entry. App B (`apps/isolation-b`) is intentionally minimal. | PRJ-03, ACC-04, Minimum demonstration. |

## 2. Identity and authorization

| ID | Decision | Reason / PRD link |
| --- | --- | --- |
| D-10 | Deployed sign-in uses **Fabric SSO only** (`services.auth.fabric.enabled: true`, `password.enabled: false`). Rayfin supports no other provider after deployment. | ORG-02. |
| D-11 | **Business roles live in the app database** (`AppMembership`), not in token claims. Rayfin policies can only test `claims.sub`, `claims.email` and `claims.role` with `.eq()`, and Entra group/role claims are not documented as flowing into Rayfin sessions. | ACC-02, ACC-03. |
| D-12 | Roles: `app_user`, `reviewer`, `auditor`, `audit_exporter`, `app_admin`. A person can hold several roles; each is a separate membership row with a recorded reason. `app_admin` gets **no** record or audit access by default. Org admin, project admin and developer are platform roles (Entra/Fabric), not app roles. | §7 role table. |
| D-13 | **Caller identity** comes from the invocation's Rayfin JWT (`ctx.accessToken`, documented). The function decodes `sub`/`email`/`exp` and then **proves the token is live** by making a Rayfin data-client call with it (`identityProbe`). A token that the Rayfin data API rejects is denied. **VERIFY R-07.** | ACC-02 "prove how verified identity reaches policies". |
| D-14 | Admins grant membership **by email**. On a member's first successful call, the server **binds** the row to the Rayfin `sub` (audited). From then on, `sub` must match. This avoids depending on an unknown per-app `sub` format and handles first sign-in. | ORG-03, DATA-02. |
| D-15 | **Self-assignment is impossible**: an `app_admin` cannot grant, change or revoke their own memberships. The first `app_admin` comes from a one-time bootstrap list in deployment config, and bootstrap works only while the app has no active `app_admin`. | ACC-03. |
| D-16 | Revocation flips `owner_status='revoked'` on that user's requests. The owner-read data policy requires `owner_status = 'active'`, so even a still-live session can't read past records through the generated API. Every function call re-checks membership. | ORG-03. |
| D-17 | End users get **item-level "Run and interact"** sharing, never workspace membership (workspace members inherit Run on every app). | ACC-01, Fabric Apps item permissions. |

## 3. Data and database

| ID | Decision | Reason / PRD link |
| --- | --- | --- |
| D-20 | Schema is defined only in **Rayfin TypeScript entities** (`rayfin/data/*.ts`) and applied with `rayfin up` / `rayfin up db apply`. The portal SQL editor is read-only for schema. | DATA-01. |
| D-21 | **Two Rayfin-documented data paths** (user-approved option): (a) **user-scoped reads** through the Rayfin generated data API / data client with owner policies; (b) **privileged server operations** (membership checks, reviewer-wide reads, review updates, audit writes) in Rayfin Functions using the Rayfin-issued **`ctx.Tokens.Sql`** application token with the `mssql` driver, in **SQL transactions**. Rayfin data access runs with the caller's permissions, so (a) alone can't implement an append-only, server-only audit store. | DATA-02, AUD-03, AUD-04, ACC-02. |
| D-22 | Generated-API exposure per entity (enforced by `@role` policies):<br>• `AddressRequest`, `AddressResult`: **read only**, own rows (`creator_sub = claims.sub` AND `owner_status = 'active'`). No create/update/delete for any client role.<br>• `SampleAddress`: read for authenticated users (synthetic inputs only).<br>• `AppConfig`, `AppMembership`, `ReviewHistory`, `AuditEvent`: **no client access**. They're granted only to a reserved role name (`ionova-server-only`) with an unsatisfiable policy, because the data API needs at least one permission entry per entity. **VERIFY R-08.** | DATA-02, AUD-03. |
| D-23 | UUID primary keys (`id`) everywhere. Foreign keys are explicit `@uuid()` columns. **No `@one/@many` navigation decorators**, because generated FK naming and types aren't fully documented and the server writes through SQL. Booleans are avoided (the docs disagree between `@bool` and `@boolean`), so `@set(...)` status columns are used instead. | DATA-01. |
| D-24 | **Verified 26 Oct 2026 on the deployed dev database:** Rayfin 1.36.2 names tables with the **plural** of the entity class (`dbo.AddressRequests`, `dbo.ReviewHistories`, …), and columns equal the property names. The original assumption, the singular class name, was wrong and was corrected in `sqlNames.ts`. *(Original text: assumed physical names: table `dbo.<EntityClassName>`, columns equal to property names.)* All SQL names are in one map (`sqlNames.ts`), and the `diagnostics` function plus `scripts/51-Test-AppSchema.ps1` confirm them before go-live. **VERIFY R-09.** | Risk control. |
| D-25 | The original input (`AddressRequest.original_address`), model output (`AddressResult`, immutable) and human edits (`ReviewHistory` + `AddressRequest.current_fields_json`) are stored separately. | APP-03, AI-04. |
| D-26 | **Idempotency**: the client creates a UUID `clientRequestId` per submission. The server stores the unique key `<creator_sub>:<clientRequestId>`, so a repeat returns the existing request and doesn't call the agent again. The UI disables the button while a request is in flight. | APP-05. |
| D-27 | **Optimistic concurrency**: `AddressRequest.version` (int). A review update runs `UPDATE … WHERE id=@id AND version=@expected`. Zero rows updated means `CONFLICT`, and the user sees the newer version. | DATA-03. |
| D-28 | **Data export** runs as an admin PowerShell script (`60-Export-AppData.ps1`) that reads the app's SQL database with the admin's own Entra token (`az account get-access-token`, .NET `SqlConnection.AccessToken`). It writes JSON, re-reads it and compares row counts and hashes. The export is recorded in the register file. Functions don't expose bulk export. | DATA-04, AC-06. |
| D-29 | **Seed**: the `seedSampleData` function (app_admin) idempotently upserts `AppConfig` and the six synthetic `SampleAddress` rows, using fixed UUIDs. It never seeds results, memberships (apart from bootstrap) or personal data. | DATA-05, DEL-06. |

## 4. Foundry integration

| ID | Decision | Reason / PRD link |
| --- | --- | --- |
| D-30 | Reuse the **existing prompt agent by name** (default `address-structuring-lab`, from the reference), with an optional pinned version. The agent, its instructions, model and project are never created, updated or deleted. The repository contains **no agent-management code** (the reference `onboard.py` is deliberately not ported). | AI-01, scope boundary. |
| D-31 | Call shape follows the current Foundry (new) Agents API: `POST {projectEndpoint}/agents/{agentName}/endpoint/protocols/openai/responses?api-version=v1`. The body is `{input:[{role:"user",content:…}], store:false}` with `Authorization: Bearer <ctx.Tokens.AzureAI>`. Each request is independent: there is no conversation, so no cross-user context. The reference Python SDK (`get_openai_client(agent_name=…)` + `responses.create(store=False)`) uses the same API. REST is used instead of `@azure/ai-projects` to keep the 30 MB functions package small. **VERIFY R-05/R-06.** | DEL-05, SET-06. |
| D-32 | The **request text and response contract are preserved exactly** from the reference: input `Extract components from this address data:\n{"address": "..."}`; output `{fields, evidence, notes}` with six fields. The reference validation rules are ported to `contract.ts` (exact keys, evidence must appear in input, supported country aliases, null/evidence pairing, size limits). | DEL-05, AI-04. |
| D-33 | No confidence score is invented. `decision` is `FIELDS_PRESENT` or `NEEDS_REVIEW` (town or country missing), the same as the reference. | AI-04. |
| D-34 | Reliability: per-attempt timeout 60 s; at most **one retry**, only for 429, 5xx or network errors, honouring `Retry-After` (capped at 20 s); total AI budget 150 s, below the 240 s function limit. The AI call is read-only (`store:false`), so retrying it doesn't repeat any write. DB writes are never blindly retried. | AI-05. |
| D-35 | *(Applies only to same-tenant mode; in the chosen cross-tenant mode Foundry access belongs to the service principal, D-03a.)* The deployed app identity is **the Fabric App item owner** (current Microsoft guidance). The script `40-Grant-FoundryAccess.ps1` assigns the **Azure AI User** role on the existing Foundry **project** scope to that identity, only after `-WhatIf` review and explicit confirmation. A laptop success doesn't count as runtime proof: the `probeFoundry` function tests from the deployed backend. **VERIFY R-04.** | AI-03, SET-04. |

## 5. Audit, logging and failure handling

| ID | Decision | Reason / PRD link |
| --- | --- | --- |
| D-40 | Audit events are created **only by server code** and stored in `AuditEvent` (no client access, D-22). Each event has the AUD-02 fields, a monotonically increasing `seq`, `prev_hash` and `event_hash` (SHA-256 hash chain). `verifyAuditChain` detects edits, deletions and insertions. | AUD-02, AUD-03. |
| D-41 | A business write and its audit event commit in **one SQL transaction**. If the audit insert fails, the business change rolls back and the request is marked `FAILED_AUDIT` in a separate best-effort transaction. The client gets an error with the correlation ID, never a false success. | AUD-04. |
| D-42 | Address text never goes into audit events or logs. Audit `details` hold field names, a SHA-256 hash of the input, and statuses. | AUD-02, LOG-01. |
| D-43 | Telemetry is structured JSON `console.log` lines (`evt`, `correlationId`, `op`, `durationMs`, `outcome`, `failureCategory`, `aiLatencyMs`, `usage`, `release`). These land in the Functions invocation logs (30-day retention). App Metrics covers GraphQL and sign-in metrics. Fabric Apps has no documented Application Insights integration, so full traces are a **gap** (G-08). | LOG-01, LOG-02. |
| D-44 | Fault injection for AC-05 (`auditWrite`, `storageWrite`, `aiTimeout`) is a config value that is **ignored unless `environment` is `dev`**. It's surfaced in `whoAmI` and shown as a red banner, so it can't be mistaken for normal behaviour. | AUD-04, AC-05. |
| D-46 | The React app uses **hash routing** (`#/records/<id>`). Fabric Apps static hosting does not document an SPA fallback, so deep links on a path route could return 404. | APP-01, APP-06. |
| D-45 | Every function returns `{ok, data | error, correlationId}`. Error codes are a closed set (`VALIDATION`, `ACCESS_DENIED`, `NOT_FOUND`, `CONFLICT`, `DUPLICATE_IN_PROGRESS`, `AI_TIMEOUT`, `AI_UNAVAILABLE`, `AI_INVALID_OUTPUT`, `STORAGE_FAILURE`, `AUDIT_FAILURE`, `CONFIG`, `INTERNAL`). Messages are sanitized. The browser creates the correlation ID and the server validates or replaces it. | §5 API contracts, LOG-01. |

## 6. Configuration and environments

| ID | Decision | Reason / PRD link |
| --- | --- | --- |
| D-50 | Fabric Apps has no documented non-secret settings store for functions. Non-secret runtime values (Foundry endpoint, agent name/version, SQL server/database, IDs, environment, bootstrap admins) go in `config/<env>.json` (git-ignored). `32-Set-RuntimeConfig.ps1` turns that into `rayfin/functions/src/runtime-config.generated.ts` (git-ignored) before `rayfin up`. **This design has no credentials**: all access is token-based. | DEL-04, PRJ-05. |
| D-51 | Only `dev` is deployed during the trial. `uat`/`prod` use separate workspaces and items (`rayfin up --workspace … ; rayfin up switch …`) with separate config files. Fabric Apps ALM isn't supported. | PRJ-05. |
| D-53 | Each app was **scaffolded with the Rayfin CLI** (`rayfin init --template blankapp`, then `npm run pack:add -- data-modeling` and `-- functions`), so its `rayfin.yml`, tsconfig, auth bootstrap (`AuthGate`, Fabric SSO popup/embedded flow) and validators come from the official 1.36.2 template, not from hand-written config. The template's welcome screen was removed. | APP-01, DEL-01. |
| D-54 | `packages/functions/src/types.ts` (the typed `AppFunctionsSchema` for `client.functions.*.invoke`) is generated by the **Rayfin CLI's own type generator**. `rayfin dev` normally runs it but needs a live Fabric backend, so `npm run functions:typegen` calls the same generator from the pinned CLI offline. The file is never hand-edited, the frontend never casts around `client.functions`, and `npm run validate:functions` (template validator) proves authored functions and the generated schema agree. Shared API contracts are `type` aliases so the generated file is self-contained. | DEL-01, AC-02. |
| D-58 | **Reusable repository (2 Nov 2026, v1.0.0-dev.2).** (a) The existing agent's definition is exported read-only to `foundry/agent/` (instructions file plus SHA-256 and model metadata). `scripts/42-Create-FoundryAgent.ps1` creates the agent **only in a new Foundry project**: it stops without changes if an agent with that name exists, so it can never modify the ioNova agent. (b) The app databases are created by `rayfin up` from the entities, not from SQL scripts. `scripts/52-Export-SchemaSnapshot.ps1` writes a reference DDL to `docs/schema/` for review and drift checks. (c) `scripts/61-Import-AppData.ps1` restores a script-60 export into an **empty** database in one transaction; it refuses the source database and non-empty tables. `-ResetUserBindings` clears membership subjects so members re-bind by email. (d) Environment records live in `docs/deployments/<org>-<env>/`; the templates in `docs/` and `config/` stay blank. (e) `rayfin.yml` lists only localhost redirect URIs: `rayfin up` adds the hosting origin itself during deployment (Rayfin guide, hosting "Redirect URI registration"). | Hand-over to other teams; DATA-04. |
| D-57 | **`super_user` role, requested by the owner on 26 Oct 2026** so one person can check the system end to end. Permissions are exactly `app_user` + `app_admin` (no reviewer or audit access). It's claimable only by emails in the deployment config `apps.ars.superUserEmails` (set by the project admin through script 32), via **Claim super user** on Administration. The claim is audited (`membership.super_user_claimed`), happens once per person, and is **refused in prod** by both `config.ts` and script 32. Self-assignment through the membership screen is still forbidden, and other admins may grant it to someone else. Trade-off: it relaxes ACC-03's two-person rule for non-prod testing only; the config change and the claim are both recorded. Multiple roles per user were already supported (one membership row per role). | Owner request; ACC-03 exception for non-prod. |
| D-56 | Optional local Docker stack (`scripts/local`, `docs/LOCAL-TESTING.md`): `environment: local` permits a SQL login to the Rayfin Docker SQL container. `config.ts` rejects SQL logins in dev, uat and prod. The user chose to deploy directly, so this path is unused and kept only as an option. | Local testing. |
| D-55 | Frontend reads that are safe under row-level policy use the **generated Rayfin data API** directly: "My records" (`AddressRequest`, owner policy) and the synthetic sample picker (`SampleAddress`). Everything else goes through functions so membership is re-checked on every call. | APP-04. |
| D-52 | The application register is the version-controlled file `docs/deployments/<org>-<env>/app-register.json` (from `config/app-register.example.json`; one folder per deployment since v1.0.0-dev.2). `70-Update-Register.ps1` fills in generated IDs and URLs from `rayfin up status --json`. | PRJ-02, AC-01. |

---

## 7. Gaps, unsupported requirements and blockers

| ID | Topic | Finding (documentation, 26 Oct 2026) | Impact and resolution |
| --- | --- | --- | --- |
| G-01 | Preview status | Fabric Apps is **preview**. ALM, workspace outbound access protection and private links are **not supported**. | Acceptable for the pilot, not for production certification (already out of scope). |
| G-02 | Trial | The trial is 60 days, F4 or F64. It **excludes Fabric "AI services / AI functions / Data agent"**. Fabric Apps and Functions on trial capacity aren't explicitly listed as supported or excluded. A trial allows at most **3 SQL databases** (two apps use 2). | **Readiness test R-02/R-03** must deploy on the actual trial before build acceptance. If it fails: request a paid F capacity (an approved scope change). No other host is substituted. |
| G-03 | Regions | Fabric App (preview) is **not available** in, among others, UK South, Canada Central, Brazil South, Poland Central, Spain Central, Switzerland West, Indonesia Central, Japan West, New Zealand North and Taiwan. It **is** available in UAE North, Central India, South India, West Europe, North Europe, East US, East US 2 and others. Functions availability also varies by region and tenant. | Record the trial capacity region in R-01. If it's unsupported, cancel and recreate the trial in a supported region (this deletes Fabric items in that trial). |
| G-04 | App identity | The external-call identity is the **item owner (a user)**, not a managed identity. If that owner leaves or their access changes, Foundry calls fail. | Use a dedicated, documented owner account. Recorded in the register (`runtimeIdentity`). Re-test after any owner change. |
| G-05 | Role claims | Entra group or role claims in Rayfin sessions aren't documented. | Mitigated by D-11/D-14 (server-side membership). |
| G-06 | Default access | All workspace members get Run on every app by default. | D-17. PRJ-03 isolation is valid only for users who **aren't workspace members**. Recorded in the ACC-04 tests. |
| G-07 | Identity verification inside functions | The docs say to "decode the `sub` claim" from `ctx.accessToken`. They don't say whether the host validates the signature before the handler runs. | D-13 adds a live data-API probe with the same token. R-07 confirms that a tampered token is rejected. |
| G-08 | Monitoring | App Metrics shows only sign-ins, app loads and GraphQL metrics. There are no traces or custom logs, and no documented App Insights onboarding. | Functions invocation logs plus structured logs plus correlation IDs (D-43). Full tracing is a remaining task. |
| G-09 | Function limits | 240 s timeout, about 4 MB payload (not verified), 30 MB package, 2-minute publish cooldown, and **only the item owner can publish Functions**. | Budgets in D-34. Deployments must be run by the item owner. |
| G-10 | CI/automation | `rayfin login --service-principal` is listed but **not supported**. | Deployments are interactive and admin-run (PRD §3 "administrator workflow"). |
| G-11 | Physical schema names | Table and column naming for Rayfin-generated SQL isn't documented. | D-24 plus R-09. |
| G-12 | Missing configuration (must be supplied) | Tenant ID; Fabric capacity ID/region/expiry; workspace name/ID; existing **Foundry project endpoint**, **agent name (and version, if pinned)**, Foundry project **resource ID** (RBAC scope); item-owner UPN/object ID; bootstrap admin email(s); security group names/IDs; cost owner. Generated by deployment: item IDs, backend/hosting URLs, SQL server/database. | Collected in `config/dev.json` and the register. `00-Test-Prerequisites.ps1` refuses placeholders. |
| G-13 | Existing agent details | The actual existing agent name, version and project aren't in the supplied files. The reference README uses `address-structuring-lab`. | Confirm in the Foundry portal (manual step M-14). The deployed `probeFoundry` checks reachability and contract conformance. |
| G-14 | Performance targets | The 3 s shell / 2 s p95 targets can only be measured on the deployed app. | Procedure: VERIFICATION.md V-33 and SUPPORT.md *Load test*; result goes in the deployment's `STATUS.md` (docs/deployments/<org>-<env>/). |
| G-16 | Cross-tenant Foundry (found during deployment, 26 Oct 2026) | The Fabric tenant (ioNova) and the Foundry tenant differ. The original operator sign-in (`vilas.v.menon@gmail.com`) is a personal Microsoft account (`idp=live.com`), and Fabric rejects it with HTTP 401. | Fabric is operated with the ioNova work account. Foundry is reached through D-03a. A service principal secret now exists: it is stored only in Rayfin, expires in 6 months, and `00-Test-Prerequisites.ps1` warns 30 days ahead. |
| G-17 | Cross-region data flow (user decision, 26 Oct 2026) | The Fabric trial capacity (`e15ff259-…`, FTL4) is in **Central India**. It was started on 23 Oct 2026, before this project. The existing Foundry agent is in **East US 2**. App records are stored in India; each submitted address is sent to the US for structuring. The extra latency (about 0.2–0.3 s per call) is negligible next to the agent time. | **Accepted for the dev pilot with synthetic data.** Changing region would require cancelling the trial (items deleted, a new trial not guaranteed). Before real data or UAT/prod, confirm residency rules and pick matching regions for the paid capacity and Foundry. |
| G-15 | Audit-store separation | The audit table lives in the app database. The item owner (app identity) could, in principle, alter it outside the app. | The hash chain detects tampering. Optional DB-level hardening (a deny-update/delete trigger) is **not applied**, because it could conflict with `rayfin up db apply`. Listed as a remaining task for production. |

## Sources (checked 26 Oct 2026)

1. Fabric Apps overview: https://learn.microsoft.com/en-us/fabric/apps/overview
2. Fabric trial capacity: https://learn.microsoft.com/en-us/fabric/fundamentals/fabric-trial
3. Foundry prompt agent quickstart (agent invocation REST): https://learn.microsoft.com/en-us/azure/foundry/agents/quickstarts/prompt-agent
4. Fabric SSO: https://learn.microsoft.com/en-us/fabric/apps/fabric-authentication
5. Fabric Apps FAQ: https://learn.microsoft.com/en-us/fabric/apps/faq
6. Static hosting: https://learn.microsoft.com/en-us/fabric/apps/hosting
7. Functions: https://learn.microsoft.com/en-us/fabric/apps/functions
8. Functions external resources: https://learn.microsoft.com/en-us/fabric/apps/functions-connect-external-resources
9. Data permissions: https://learn.microsoft.com/en-us/fabric/apps/data-permissions
10. App Metrics: https://learn.microsoft.com/en-us/fabric/apps/app-metrics
11. Region availability: https://learn.microsoft.com/en-us/fabric/admin/region-availability
12. CLI reference: https://learn.microsoft.com/en-us/fabric/apps/cli-reference
13. Project structure: https://learn.microsoft.com/en-us/fabric/apps/project-structure
14. Data models: https://learn.microsoft.com/en-us/fabric/apps/data-models
15. Read/write data: https://learn.microsoft.com/en-us/fabric/apps/read-write-data-graphql
16. Dev/prod workflow: https://learn.microsoft.com/en-us/fabric/apps/dev-prod-workflow
17. Function secrets: https://learn.microsoft.com/en-us/fabric/apps/manage-function-secrets
18. Rayfin docs, calling and writing functions, secrets, local development, Fabric apps: https://rayfin.ai/docs/functions , https://rayfin.ai/docs/deploy/fabric-apps
