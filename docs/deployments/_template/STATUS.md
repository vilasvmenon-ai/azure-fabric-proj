# Delivery status (DEL-07): <org> <env>

Copy this folder to `docs/deployments/<org>-<env>/` (for example `contoso-dev`) and keep it up to date as you deploy.
`scripts/70-Update-Register.ps1` writes `app-register.json` into the same folder. Attach evidence file names from `evidence\` (that folder is git-ignored).

Last updated: <date>. Workstation: <OS>, Node.js <version>, Azure CLI <version>, Rayfin CLI <version>.

## Status summary

| Component | Built | Locally tested | Deployed | Runtime-verified |
| --- | --- | --- | --- | --- |
| App A data model and policies | | | | |
| App A Functions | | | | |
| App A frontend | | | | |
| App B (isolation) | | | | |
| Scripts 10–80 | | | | |
| Register (AC-01) | | | | |

## Deployment progress

| Step ([SETUP-NEW-ENVIRONMENT.md](../../SETUP-NEW-ENVIRONMENT.md)) | State | Evidence |
| --- | --- | --- |
| Workspace and capacity | | |
| Foundry agent (existing, or created with script 42) | | |
| Service principal and role (script 41) | | |
| App A deployed (script 30) | | |
| Database resolved and schema checked (scripts 31, 51) | | |
| Runtime config stored (script 32) | | |
| Bootstrap, seed, diagnostics, Foundry probe | | |
| End-to-end submit (V-06) | | |
| App B deployed, data separation | | |
| Audit chain verified | | |
| Export and read-back (script 60) | | |
| Register updated (script 70) | | |

## Still to do

| # | Task | Needed from | Resolves |
| --- | --- | --- | --- |
| | | | |
