# Set up a new environment from this repository

This guide is for a team that wants its own copy of the platform: a Fabric workspace with App A (Address Structuring Lab) and App B (isolation test), their Fabric SQL databases, and a Foundry project with the address-structuring agent.
It follows the order that worked for the ioNova dev deployment (see [deployments/ionova-dev/STATUS.md](deployments/ionova-dev/STATUS.md)). [MANUAL-STEPS.md](MANUAL-STEPS.md) has the detail for each step (purpose, expected result, common errors).

**What is in Git, and what is not**

| Piece | In Git | Created by |
| --- | --- | --- |
| App source (frontend, functions, entities), tests, lockfiles | ✅ `apps/` | `npm ci` |
| Database schema | ✅ as **entities** (`apps/*/packages/data/src`); reference DDL in [schema/](schema/) | `rayfin up` creates and migrates the tables. Don't run the DDL yourself. |
| Foundry agent definition | ✅ `foundry/agent/` (instructions, model, SHA-256) | Script 42, only in a **new** Foundry project |
| Deployment configuration | Template only: `config/ionova.dev.example.json` | You copy it to `config/ionova.<env>.json` (git-ignored) |
| Credentials | ❌ never | One service principal secret, stored only in the Rayfin secret store by script 41 |
| Environment records (register, status, readiness) | ✅ per deployment in `docs/deployments/<org>-<env>/` | Script 70 and you |
| Data | ❌ | Seeded in the app; exports (script 60) stay in git-ignored `exports/` |

## 0. Before you start

| Requirement | Why |
| --- | --- |
| A **work or school** Entra account for Fabric | Fabric rejects personal Microsoft accounts (gmail, outlook) with HTTP 401 (`idp=live.com`). |
| A Fabric capacity: trial (FTL4/F64) or a paid F SKU, in a region that supports Fabric App (preview) | Fabric Apps and Rayfin Functions run only there (DECISIONS G-03). |
| Tenant setting **Fabric Apps (preview)** enabled for your authors | Without it, **New item** doesn't offer **App (preview)**. |
| An Azure subscription with a Foundry resource and project, or rights to create one | The agent and its model deployment live there. |
| Windows with PowerShell 5.1 or 7, Node.js 24 (`.nvmrc`), Git, Azure CLI 2.91 or later | The scripts were tested with these. |
| Rights in the **Foundry** tenant: Application Administrator (to create the service principal) and Owner or User Access Administrator on the Foundry project (to assign the role) | Script 41. |

**One tenant or two?** Fabric and Foundry may be in the same Entra tenant or in different ones. The ioNova deployment uses two tenants: Fabric in the company tenant, Foundry in another. The default `foundry.auth = servicePrincipal` works for both cases. `rayfinAppIdentity` (the Fabric App item identity, with no secret) works only when both are in the same tenant (D-03, D-03a).

## 1. Get the code and check the tools

```powershell
git clone https://github.com/<owner>/<repo>.git ionova-ai-lab
cd ionova-ai-lab
cd apps\ars; npm ci; cd ..\isolation-b; npm ci; cd ..\..
```

Then follow [DEVELOPMENT.md](DEVELOPMENT.md) to build and test locally. No Azure access is needed for that.

## 2. Fabric: capacity, workspace, groups (portal)

MANUAL-STEPS M-02 to M-08. Record the tenant ID, workspace ID, capacity ID, region, SKU and trial expiry. If you want different names, change `org.code`, `project.code`, `fabric.workspaceName` and each `apps.*.itemName` in your config. The scripts use whatever the config says.

## 3. Foundry: project, model deployment and agent

- **The agent already exists** (as in ioNova): confirm it read-only (M-14). Change nothing.
- **New project**:
  1. Create the Foundry resource and project in the portal.
  2. Deploy the model named in `foundry/agent/agent.json` (`gpt-5-mini`, version 2025-08-07, GlobalStandard) under the deployment name `foundry.modelDeployment`.
  3. Run `az login --tenant <foundry tenant>`, then:

     ```powershell
     .\scripts\42-Create-FoundryAgent.ps1 -WhatIf
     .\scripts\42-Create-FoundryAgent.ps1
     ```

     The script checks the instructions file against its SHA-256 and stops without changes if an agent with that name exists. It creates the agent, reads it back and compares the instructions.

Record the project endpoint and the project resource ID (M-14 steps 2 and 3).

## 4. Configuration

```powershell
Copy-Item config\ionova.dev.example.json config\ionova.dev.json
```

Fill every `<...>` value (M-09). Leave the `GENERATED` values for the scripts. Useful settings:
- `apps.ars.bootstrapAdminEmails`: who may become the first app admin.
- `apps.ars.superUserEmails` (dev and uat only): who may claim `super_user` to test alone (D-57).
- `foundry.rbacRole`: keep **Foundry Agent Consumer**.

## 5. Sign in and check readiness

```powershell
.\scripts\00-Test-Prerequisites.ps1
.\scripts\10-Connect-Tenant.ps1          # Azure CLI (and the Foundry tenant, if separate) plus the Rayfin CLI sign-in to Fabric
.\scripts\20-Test-FabricReadiness.ps1
```

## 6. Deploy App A, connect Foundry, store the runtime config

```powershell
.\scripts\30-Deploy-App.ps1 -App ars -DryRun
.\scripts\30-Deploy-App.ps1 -App ars                    # creates the item, SQL database, functions and hosting
.\scripts\41-Setup-FoundryServicePrincipal.ps1 -WhatIf  # needs az signed in to the Foundry tenant
.\scripts\41-Setup-FoundryServicePrincipal.ps1          # service principal, role, secret into Rayfin
.\scripts\31-Resolve-AppDatabase.ps1 -App ars
.\scripts\32-Set-RuntimeConfig.ps1 -App ars
.\scripts\51-Test-AppSchema.ps1
```

If the role assignment in script 41 fails, a person with rights runs it in the portal (M-15 manual alternative). Allow up to 15 minutes for the role to propagate.

## 7. First sign-in and checks in the app

Open the App URL that script 30 printed (or that `rayfin up status` shows). Then:
1. Select **Become the first app administrator**.
2. Go to **Administration** and run, in order: **Seed sample data**, **Run diagnostics**, **Probe existing Foundry agent**.
3. Optionally select **Claim super user**, then submit a sample address end to end (M-18, M-19).

## 8. App B, verification, register

```powershell
.\scripts\30-Deploy-App.ps1 -App isob -DryRun
.\scripts\30-Deploy-App.ps1 -App isob
.\scripts\50-Verify-Deployment.ps1
.\scripts\52-Export-SchemaSnapshot.ps1 -App ars          # compare with docs/schema/ars-schema.sql; commit if it changed
.\scripts\70-Update-Register.ps1 -ChangedBy <you> -Reason "Initial <env> deployment"
```

Copy `docs/deployments/_template/STATUS.md` and `docs/READINESS.md` into `docs/deployments/<org>-<env>/`, fill them in, and commit that folder. Share the items with their user groups only (M-20). Then run the runtime tests in [VERIFICATION.md](VERIFICATION.md).

## 9. Data: export and restore

- Export with read-back check: `.\scripts\60-Export-AppData.ps1` (M-24).
- Restore into a **new, empty** App A database: `.\scripts\61-Import-AppData.ps1 -ExportPath <folder>` (dry run), then add `-ResetUserBindings -Apply`. Read the script help first: user subjects are specific to each Fabric App item.

## Known pitfalls (all hit in the ioNova deployment, and handled in code or scripts)

| Symptom | Cause | What handles it |
| --- | --- | --- |
| Fabric returns 401 at sign-in | Personal Microsoft account | Use a work account (step 0) |
| Probe: `auth (HTTP 403)` | Role **Foundry Project Runtime User** lacks the agent `interact` action | Use **Foundry Agent Consumer** (config default) |
| `Role 'Azure AI User' doesn't exist` | The role was renamed | Config default is Foundry Agent Consumer |
| Role assignment goes to the wrong subscription, or the role isn't found | The Azure CLI default account is in the other tenant | `az account set --subscription <foundry subscription>`. Script 41 restores the Fabric default afterwards. |
| `IONOVA_RUNTIME_CONFIG is not valid JSON` | Windows PowerShell adds a BOM to piped stdin | `Invoke-NativeWithStdin` in `IonovaDeploy.psm1`; the functions also strip a BOM (`cleanSecretValue`) |
| "Your session has no email address" | Fabric-hosted tokens put the email in `xms_attr.<appId>.rfn_email` | `identity.ts` reads it |
| Diagnostics: table not found | Rayfin pluralises table names (`AddressRequests`) | `sqlNames.ts` is the single source of names; script 51 checks it |
| npm warnings stop a script | PS 5.1 treats native stderr as an error | `Invoke-Native` judges by exit code only |
| `rayfin.yml` changes after a deployment | `rayfin up` adds the hosting origin to `allowedRedirectUris` | Expected. Don't commit that line; the hosting URL is per environment (D-58). |
| Garbled characters in files after editing in PowerShell | `Get-Content`/`Set-Content` use the ANSI code page | Use `[IO.File]::ReadAllText/WriteAllText` with UTF-8 (no BOM) |

## Clean-up of a test environment

Delete only the items you created (Fabric portal, then the item's **…** menu, then **Delete**). The App item removes its SQL database and functions with it. Never delete a shared Foundry agent or model deployment as part of an app clean-up.
