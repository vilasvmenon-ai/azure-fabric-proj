# Numbered setup and deployment steps (SET-01 to SET-08)

Each step lists its **purpose**, the exact **action** (command or portal path), the **expected result**, how to **verify** it, and **common errors**. Run the steps in order. Steps marked **[Portal]** have no supported automation; they are not replaced with invented commands.

Who runs them:

- **Tenant/Fabric admin**: M-02 to M-08.
- **Project admin / item owner**: everything else.
- **Foundry project owner**: M-15, if the project admin can't assign roles.

Nobody gives credentials to the code generator or puts them in this repository.

Microsoft portal labels change. If a label differs, follow the linked Microsoft page in [DECISIONS.md](DECISIONS.md#sources-checked-26-oct-2026).

---

## Part A: Prerequisites and readiness

### M-01 Install local tools
- **Purpose:** Get the tools the scripts use.
- **Action:**
  - Node.js 20 or later (tested with **24.22.1**): `winget install OpenJS.NodeJS.LTS`
  - Git: `winget install Git.Git`
  - Azure CLI (tested with **2.91.0**): `winget install Microsoft.AzureCLI`
  - Optional, for local function debugging only: `npm install --global azure-functions-core-tools@4`
- **Expected:** A new PowerShell window shows `node --version`, `git --version` and `az --version`.
- **Common errors:** `npx`/`node` not recognised: open a new terminal so PATH refreshes.

### M-02 Confirm the organization record (ORG-01) [Portal]
- **Two tenants (this deployment):** **Fabric** runs in the ioNova tenant and needs a **work or school account**; a personal Microsoft account such as gmail or outlook gets HTTP 401 from Fabric. The **existing Foundry** project stays in its own tenant. Record both tenant IDs: `org.tenantId` for Fabric, `foundry.tenantId` for Foundry.
- **Purpose:** Pin the tenant, its administrators and the subscription.
- **Action:** In the Microsoft Entra admin center, go to **Overview** and copy the **Tenant ID**. Name a primary and a backup administrator. In the Azure portal, go to **Subscriptions** and copy the subscription ID that pays for Foundry usage.
- **Expected:** All values recorded in `config/ionova.dev.json` (M-09) and [READINESS.md](READINESS.md) R-00.

### M-03 Find the tenant home region [Portal]
- **Action:** Fabric portal, then **?** (Help), then **About Fabric**, then **Your data is stored in**.
- **Verify:** Check that the region is not on the Fabric App unavailable list in DECISIONS.md G-03.

### M-04 Start or confirm the Fabric trial and record expiry, size and region (R-01) [Portal]
- **Purpose:** The PRD requires validating the trial before implementation.
- **Action:** Fabric portal, then **Account manager** (profile photo), then **Start trial**. Choose a **supported region** (G-03) in the region drop-down, then select **Activate**. Then go to **OneLake catalog**, then **Govern**, then **Capacities**, then **Trial**, and record the **days left**, **size** (4 or 64 CU) and **region**.
- **Expected:** An active trial capacity in a region that supports Fabric App (preview).
- **Common errors:** No **Start trial** button means trials are disabled, or the tenant has reached its trial limit (see the Fabric trial FAQ). A wrong region means you must cancel the trial and start a new one, which deletes the Fabric items in it.

### M-05 Enable the Fabric Apps (preview) tenant setting (R-02) [Portal, tenant admin]
- **Action:** Fabric **Admin portal**, then **Tenant settings**, then **Fabric Apps (preview)**. Set it to **Enabled**, apply it to **specific security groups**: `sg-ionova-ai-lab-authors` (from M-07), then select **Apply**.
- **Expected:** After a few minutes, authors can create **App (preview)** items.
- **Verify:** In the workspace, **New item** lists **App (preview)**.

### M-06 Create the project workspace on the trial capacity (PRJ-01) [Portal]
- **Action:** Fabric portal, then **Workspaces**, then **New workspace**. Set **Name** `ws-ionova-ai-lab-dev`, then under **Advanced**, set **License mode** to **Trial** (or the trial capacity), then select **Apply**. Record the workspace ID from the URL (`/groups/<workspace-id>/`) and the capacity ID (**Admin portal**, then **Capacity settings**, then **Trial**, then the capacity).
- **Verify:** `scripts\20-Test-FabricReadiness.ps1` (M-12) confirms the workspace, capacity, state and region.

### M-07 Create Entra security groups (ORG-02, PRJ-03) [Portal]
- **Action:** Entra admin center, then **Groups**, then **New group** (Security). Create these groups:

  | Group | Purpose |
  | --- | --- |
  | `sg-ionova-ai-lab-authors` | Project staff with workspace authoring access |
  | `sg-ionova-ai-lab-ars-user` | Fabric item Run access to App A |
  | `sg-ionova-ai-lab-ars-reviewer` | Fabric item Run access to App A |
  | `sg-ionova-ai-lab-ars-auditor` | Fabric item Run access to App A |
  | `sg-ionova-ai-lab-isob-user` | Fabric item Run access to App B |

  Record who approved and who applied each membership change (ORG-03).
- **Note:** Groups grant Fabric item access only. Business roles inside the app are granted in-app (M-19), because Rayfin sessions don't carry group claims (G-05).

### M-08 Workspace access (ACC-01) [Portal]
- **Action:** Workspace, then **Manage access**, then add `sg-ionova-ai-lab-authors` as **Contributor** and the project admin as **Admin**. **Don't add end users or the app user groups to the workspace.** Workspace members automatically get Run access to every app (G-06).
- **Verify:** **Manage access** lists only project staff.

### M-09 Fill in the configuration file
- **Action:** `Copy-Item config\ionova.dev.example.json config\ionova.dev.json`, then edit it. Supply every `<...>` value. Leave values marked `GENERATED` for the scripts to fill.

  | Supplied by you | Generated by deployment or scripts |
  | --- | --- |
  | Tenant, subscription, workspace, capacity (ID, region, SKU, expiry), Foundry endpoint, Foundry project resource ID, agent name and optional version label, runtime identity (UPN and object ID), groups, bootstrap admin emails | Fabric App item IDs, app and backend URLs, SQL server and database, SQL database item ID |

- **Get the object ID:** `az ad user show --id <owner-upn> --query id -o tsv`
- **Verify:** `scripts\00-Test-Prerequisites.ps1` reports *config is complete*.

### M-10 Choose the item owner (runtime identity) (AI-03, G-04)
- **Purpose:** Deployed Functions call Foundry **as the Fabric App item owner**. The account that first runs `rayfin up` becomes the owner, and only the owner can publish Functions.
- **Action:** Use one named, supported account (not a personal or temporary one) for M-13 to M-17. Record it in `runtimeIdentity`.
- **Verify:** After M-13, the Fabric portal shows the App item **Owner** as that account.

### M-11 Install locked dependencies and run the prerequisite check
```powershell
cd apps\ars; npm ci; cd ..\isolation-b; npm ci; cd ..\..
.\scripts\00-Test-Prerequisites.ps1 -Environment dev
```
- **Expected:** `All prerequisite checks passed.`

### M-12 Sign in and run the readiness checks
```powershell
.\scripts\10-Connect-Tenant.ps1 -Environment dev
.\scripts\20-Test-FabricReadiness.ps1 -Environment dev
```
- **Expected:** The workspace, capacity (Active, supported region) and item names are checked, and an evidence file is written to `evidence\`.
- **Common errors:** HTTP 401 means you need to rerun M-12 sign-in. HTTP 403 means you need workspace access (M-08).

---

## Part B: Deploy and connect

### M-13 Deploy App A (Address Structuring Lab)
```powershell
.\scripts\30-Deploy-App.ps1 -App ars -DryRun     # build, test, secret scan and rayfin --dry-run only
.\scripts\30-Deploy-App.ps1 -App ars             # asks for confirmation, then rayfin up
```
- **Expected:** Rayfin creates the item `app-ionova-ai-lab-ars-dev` with child **SQL database**, **Authentication** and **Static content** services, applies the schema, deploys Functions and the React build, and prints the **App URL**.
- **Verify:** The item and its child items appear in the workspace, and `evidence\*status-ars-dev.json` exists.
- **Common errors:**
  - *Capacity or permission*: see M-06 and M-08.
  - *Schema conflict*: never edit the database in the portal.
  - *Publish cooldown*: wait 2 minutes between Functions publishes.
  - *Popup blocked at sign-in*: allow popups for the app URL.

### M-14 Confirm the existing Foundry agent (AI-01, SET-04) [Portal, read-only]
- **Action:**
  1. In the Foundry portal (new experience), open the existing project, then **Agents**, and select the address agent. Record its **name** and **version**, and confirm its model deployment and instructions. **Change nothing.**
  2. Copy the **project endpoint** from the project overview.
  3. In the Azure portal, open the Foundry resource, then its **Project**, then **JSON view**, and copy the **Resource ID** (`.../accounts/<resource>/projects/<project>`).
- **Verify:** The input and output contract matches the reference: `fields`, `evidence` and `notes`, with six fields (see `apps/ars/packages/functions/src/contract.ts`). If the agent's contract differs, stop and report it. The app is built to the existing contract and won't change the agent.

### M-15 Give the deployed app access to the existing Foundry project (AI-03, D-03a)
Fabric (the ioNova tenant) and Foundry (its own tenant) are **different tenants**, so the deployed function reaches Foundry through a dedicated service principal in the **Foundry** tenant. Run this after App A has been deployed once (M-13).

You need an Azure CLI sign-in to the **Foundry tenant**, and a Rayfin CLI sign-in to the **Fabric tenant**.

```powershell
az login --tenant <foundry.tenantId>
.\scripts\41-Setup-FoundryServicePrincipal.ps1 -WhatIf
.\scripts\41-Setup-FoundryServicePrincipal.ps1
```

- **What it does:**
  - Creates (or reuses) `sp-ionova-ai-lab-ars-foundry-dev` and assigns **Foundry Agent Consumer** on the Foundry **project** only.
  - Creates a 6-month client secret and pipes it into `rayfin secret set IONOVA_FOUNDRY_CLIENT_SECRET --stdin`. The secret is never displayed or saved to a file.
  - Records the client ID, object ID and expiry in config.
- **Expected:** `rayfin secret list` (in `apps\ars`) shows `IONOVA_FOUNDRY_CLIENT_SECRET`, and an evidence file is written.
- **Manual alternative [Portal]:**
  1. In the Foundry tenant, go to Entra admin center, then **App registrations**, then **New registration** (single tenant).
  2. Under **Certificates & secrets**, create a new client secret.
  3. In your own terminal, run `npx rayfin secret set IONOVA_FOUNDRY_CLIENT_SECRET` in `apps\ars` and paste the secret at the masked prompt.
  4. In the Azure portal, go to the Foundry **project**, then **Access control (IAM)**, then **Add role assignment**. Choose **Foundry Agent Consumer**, then the app, then **Review + assign**.
- **Common errors:**
  - `Insufficient privileges`: you need Application Administrator in the Foundry tenant.
  - `AuthorizationFailed`: you need Owner or User Access Administrator on the project.
  - *No remote endpoint*: deploy App A first.
  - The role can take a few minutes to propagate.
- **Same-tenant setups only:** set `foundry.auth` to `rayfinAppIdentity` and use `scripts\40-Grant-FoundryAccess.ps1` instead.

### M-16 Connect App A to its database and store the runtime configuration
```powershell
.\scripts\31-Resolve-AppDatabase.ps1 -App ars
.\scripts\32-Set-RuntimeConfig.ps1 -App ars -WhatIf
.\scripts\32-Set-RuntimeConfig.ps1 -App ars
.\scripts\51-Test-AppSchema.ps1
```
- **Expected:** The SQL coordinates are saved in config, `rayfin secret list` shows `IONOVA_RUNTIME_CONFIG`, and the schema check passes (R-09).
- **Common errors:**
  - *Could not identify exactly one SQL database*: rerun with `-SqlDatabaseItemId <id>`, taken from the SQL database child item URL.
  - *Schema mismatch*: change only `sqlNames.ts`, then redeploy Functions with `npx rayfin up functions deploy` in `apps\ars`.

### M-17 Deploy App B (isolation test app)
```powershell
.\scripts\30-Deploy-App.ps1 -App isob -DryRun
.\scripts\30-Deploy-App.ps1 -App isob
```

### M-18 First sign-in, bootstrap the administrator, seed sample data
- **Action:** Open the App A URL as a bootstrap admin (`apps.ars.bootstrapAdminEmails`) and sign in with Microsoft. On the **No access to this app yet** page, select **Become the first app administrator**. Then go to **Administration**, then **Seed sample data**, then **Run diagnostics**, then **Probe existing Foundry agent**.
- **Expected:**
  - Diagnostics: every table shows ✔.
  - Probe: *reachable, contract valid* (V-05). This is the first proof that the **deployed backend** reaches Foundry with the runtime identity.
- **Common errors:**
  - Probe *auth (HTTP 401/403)*: wait for the role to propagate, then recheck M-15 and the owner identity.
  - *not_found (404)*: wrong endpoint or agent name; fix config, then rerun M-16.

### M-19 Grant business roles in the app (ACC-02, ACC-03)
- **Action:** In App A, go to **Administration**, then **App membership**, then grant roles **by sign-in email**: `app_user`, `reviewer`, `auditor`, `audit_exporter` and, for a second administrator, `app_admin`. Record the approval reason.
- **Note:** You can't grant roles to yourself. App administrators get no record or audit access unless they also hold those roles.

### M-20 Share each Fabric App item with its users only (ACC-01, PRJ-03) [Portal]
- **Action:** In the workspace, open the item's **…** menu, then **Manage permissions** (or **Share**). Add the group or user with **Run and interact** (Read and execute) only.
  - App A: `sg-ionova-ai-lab-ars-*`.
  - App B: `sg-ionova-ai-lab-isob-user`.
  - Don't grant **Edit** or **Reshare**.
- **Verify:** The access-separation tests V-20 to V-26.

### M-21 Verify the deployment
```powershell
.\scripts\50-Verify-Deployment.ps1 -Environment dev
```
Then run every runtime test in [VERIFICATION.md](VERIFICATION.md) with real test users, and record the results in [STATUS.md](STATUS.md).

### M-22 Update the application register (AC-01)
```powershell
.\scripts\70-Update-Register.ps1 -Environment dev -ChangedBy <your-upn> -Reason "Initial dev deployment"
```

### M-23 Monitoring, alerts and cost (LOG-02) [Portal]
- **App Metrics:** Open the App item, then **Manage app**, then **Metrics**. It shows sign-ins, app loads, GraphQL query count, errors and duration.
- **Function invocation logs:** Open the Functions child item, then **Logs**. They're kept for 30 days. Search by `correlationId`.
- **Capacity:** Install the *Microsoft Fabric Capacity Metrics* app and watch the trial capacity's CU use.
- **Foundry cost:** Azure portal, then **Cost Management**, then **Budgets**, then create a budget on the Foundry resource group with alert emails to the cost owner. A budget alert isn't a hard spending cap.
- **Trial expiry:** Put a calendar reminder 14 days before `trialExpiryUtc`. `00-Test-Prerequisites.ps1` also warns inside 14 days.

### M-24 Before the trial expires (DATA-04)
```powershell
.\scripts\60-Export-AppData.ps1 -Environment dev
```
Then decide on an authorized paid capacity (reassign the workspace to an F SKU before expiry), or an orderly shutdown (see [SUPPORT.md](SUPPORT.md), section *Shutdown*).

---

## Fault-injection procedure for AC-05 (dev only)

1. In `config/ionova.dev.json`, set `apps.ars.faultInjection` to `auditWrite`, `storageWrite` or `aiTimeout`.
2. Run `.\scripts\32-Set-RuntimeConfig.ps1 -App ars`. No redeploy is needed. A red **TEST MODE** banner appears in the app.
3. Run the matching V-1x test.
4. Set `faultInjection` back to `none` and rerun step 2. Confirm the banner is gone.

The server ignores fault injection when `environment` isn't `dev`.
