# Instructions for Claude Code in this repository

This repository deploys two Microsoft Fabric Apps (Rayfin SDK/CLI 1.36.2): **App A** (`apps/ars`, Address Structuring Lab, which calls an existing Foundry agent) and **App B** (`apps/isolation-b`, isolation test). The requirements are in `docs/prd/`. Deployment prompts are in `docs/CLAUDE-CODE-DEPLOY.md`.

## Deploying

- Deploy both apps with **one** command: `.\scripts\90-Deploy-All.ps1 -Environment <env>`. Run `-PreflightOnly` first. Don't run the numbered scripts one by one unless asked.
- Exit codes: 0 done; 1 a step failed (read the output, fix the cause, run again); 2 blocked on a human step. On 2, stop and report the exact message. Don't work around it.
- Re-running is safe: `rayfin up` updates the same items. Never add `--force`.
- After a run, commit only `docs/deployments/` and `docs/schema/` if they changed. Don't commit the hosting-URL line that `rayfin up` adds to `apps/*/rayfin/rayfin.yml`.
- Report the App URLs and the evidence file that script 90 prints.

## Never

- Sign in, or enter passwords, secrets or tokens. A person runs `az login` and `.\scripts\10-Connect-Tenant.ps1`.
- Create, rotate or print credentials. `scripts/41-Setup-FoundryServicePrincipal.ps1` is run by a person.
- Create, modify or delete the Foundry agent, its instructions or its model deployment. `scripts/42-Create-FoundryAgent.ps1` is for a person setting up a new Foundry project. Never edit `foundry/agent/`.
- Restore data, roll back or delete Fabric items (scripts 61, 80, or the portal) unless the user asks in that session.
- Push to Git or create tags unless the user asks.
- Read or edit `config/ionova.<env>.json` to change tenant, workspace or Foundry values on your own. Those values come from the user.

## Code changes

Follow `docs/DEVELOPMENT.md`. Gates, run serially in each app folder: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:fabric`. Windows PowerShell 5.1: read and write files with `[IO.File]` and UTF-8 (no BOM), keep scripts ASCII-only, and run native tools through `Invoke-Native` in `scripts/IonovaDeploy.psm1`.
