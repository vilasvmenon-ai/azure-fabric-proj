# Support, operations and handover guide (SET-08)

| Item | Value |
| --- | --- |
| Support owner | `project.owner` in `config/ionova.dev.json` and the app register |
| Runtime identity (Foundry calls) | Fabric App item owner (`runtimeIdentity`) |
| Trial expiry | `fabric.trialExpiryUtc`; `00-Test-Prerequisites.ps1` warns 14 days ahead |
| Existing Foundry agent | Outside this project's change and cleanup scope. Never modified. |

## 1. Look up a failed request by correlation ID (required by PRD §8)

1. Get the correlation ID. The user's error panel shows *Correlation ID …*, and every record shows its own on the record page.
2. **Business audit:** sign in to App A as an `auditor`, go to **Audit**, enter the ID in *Correlation ID*, then **Apply filters**. You'll see what happened (submitted, processed, processing_failed, access.denied) and its outcome and details (failure kind, HTTP status, attempts).
3. **Operational logs:** in the Fabric portal, open the App item's **Functions** child item, then **Logs** (kept for 30 days), and search for the correlation ID. Lines are JSON (`evt`, `op`, `code`, `failureCategory`, `durationMs`, `aiLatencyMs`). They never contain tokens or addresses.
4. **Record state:** the requester or a reviewer opens the record. `processingStatus` and `Last error` show where it stopped.

Typical causes:

| Code / status | Meaning | Action |
| --- | --- | --- |
| AI_TIMEOUT / FAILED_AI | Foundry didn't answer within the budget (60 s, plus one retry) | User selects **Retry**. If it keeps happening, check Foundry quota or throttling |
| AI_UNAVAILABLE (`auth`, 401/403) | The Foundry service principal secret expired or was revoked, or the role on the project was removed | `41-Setup-FoundryServicePrincipal.ps1 -RotateSecret`, then recheck the role (M-15) |
| CONFIG *service principal secret … not set* | `IONOVA_FOUNDRY_CLIENT_SECRET` is missing on this item (new environment or deleted) | `41-Setup-FoundryServicePrincipal.ps1` |
| AI_UNAVAILABLE (`not_found`, 404) | Wrong endpoint or agent name, or the agent was renamed | Fix config, then `32-Set-RuntimeConfig.ps1` |
| AI_INVALID_OUTPUT / FAILED_VALIDATION | The agent's output broke the contract | A reviewer inspects the saved output. Check whether the agent changed (AI-06) |
| AUDIT_FAILURE / FAILED_AUDIT | The audit insert failed, so the business change was rolled back | Check database health and capacity. Then user selects **Retry** |
| STORAGE_FAILURE | The database was unavailable | Check the capacity state (paused or expired?) and the SQL database item |
| CONFIG | Runtime config missing or invalid | `32-Set-RuntimeConfig.ps1` |
| UNAUTHENTICATED | Session expired or invalid | User signs out and in again |

A request stuck in PROCESSING for more than 5 minutes (for example, the function crashed) becomes retryable automatically.

## 2. Update (new release)

1. Make the change and bump `apps.<app>.release` in config. Commit and tag it (for example `ars-v1.1.0`).
2. `.\scripts\30-Deploy-App.ps1 -App ars -DryRun`, then without `-DryRun`.
3. `.\scripts\50-Verify-Deployment.ps1`, then the relevant VERIFICATION tests.
4. `.\scripts\70-Update-Register.ps1 -ChangedBy … -Reason …`

For frontend-only changes you can run `npx rayfin up staticapp deploy` in the app folder (30 to 60 s). Rayfin refuses schema changes that would lose data; this project never uses `--force`.

## 3. Rollback

```powershell
.\scripts\80-Rollback-App.ps1 -App ars -GitRef <previous-tag> -WhatIf
.\scripts\80-Rollback-App.ps1 -App ars -GitRef <previous-tag>
```

This redeploys code and schema from the previous commit to the same item. Data isn't rolled back. If you must restore data, use the latest export (`exports/…`). `scripts/61-Import-AppData.ps1` restores an export into a **new, empty** App A database only (dry run by default, one transaction, `-ResetUserBindings` for a new item). It never merges into or overwrites a live database. Restoring is an approved operation: record it in the register.

## 3a. Rotate the Foundry service principal secret (every 6 months, D-03a)

1. `00-Test-Prerequisites.ps1` warns 30 days before `foundry.servicePrincipal.secretExpiryUtc`.
2. Sign in to the Foundry tenant (`az login --tenant <foundry.tenantId>`) and to Rayfin in the Fabric tenant. Then run `.\scripts\41-Setup-FoundryServicePrincipal.ps1 -RotateSecret`. The new secret goes straight into Rayfin, and no redeploy is needed.
3. Run **Probe existing Foundry agent** (V-05). Then delete the old secret in Entra: **App registrations**, then **sp-ionova-ai-lab-ars-foundry-dev**, then **Certificates & secrets**.

If the secret leaks: rotate immediately, then delete the leaked secret in Entra. The principal can only call the Foundry project, as Foundry Agent Consumer.

## 4. Access lifecycle (ORG-03)

- **Grant:** add the user to the Entra group or item share (Run and interact), then grant the in-app role (Administration). Record who approved it.
- **Revoke:** revoke the in-app role first (the user's own records are locked immediately), then remove item sharing and group membership. Recheck access afterwards (V-26) and record how long it took.

## 5. Trial expiry and data export

1. At least 14 days before expiry, run `.\scripts\60-Export-AppData.ps1` and store `exports/<env>/<timestamp>/` securely. It contains app data.
2. Decide between:
   - **Continue:** buy an F capacity and reassign the workspace to it before expiry (Workspace settings, then License info).
   - **Shut down:** see section 7.
3. When a trial expires, non-Power BI items become inactive and are kept for 7 days. During that time they can only be recovered by assigning a paid capacity.

## 6. Load test (V-33)

Use a browser-automation tool (for example Playwright) with 10 signed-in test users. One option is to point a loop at the deployed URL with saved storage state. Each user should open the shell, list records and open a record. Seed about 1,000 records via the app first (budget the Foundry cost) or note that record counts were lower. Report p95 for non-AI operations and AI latency separately. These targets are product targets, not Microsoft guarantees.

## 7. Shutdown (destructive: separate, manual, labelled)

**This deletes app data. Export first (section 5) and get approval from the project owner.**

1. Fabric portal: open the workspace, then the App item's **…** menu, then **Delete**. This removes the item and its child SQL database, auth and static content. Repeat for App B.
2. Optional: delete the workspace once it's empty.
3. Optional: remove the Foundry role assignment created by M-15. Go to Azure portal, then the Foundry project, then **Access control (IAM)**, then **Role assignments**, then remove only the assignment for the app identity.
4. **Never** delete the existing Foundry project, agent, model deployment or resource group as part of this cleanup.
