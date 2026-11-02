# Optional: test App A on the Rayfin Docker local stack

> **Status:** optional and **not used** for the current rollout. The user chose to deploy directly to Fabric (26 Oct 2026). These scripts have been written and parse-checked, but **never run** (Docker was not installed). The Rayfin Docker provider is a **preview** feature (`RAYFIN_FEATURE_FLAGS=docker-local-dev`).

## What runs where

| Part | Local |
| --- | --- |
| Rayfin backend (GraphQL data API, auth) and SQL Server | Docker containers started by `rayfin dev --provider docker` |
| Rayfin Functions | Local Azure Functions Core Tools host (port 7071+) |
| React app | Local Vite dev server |
| Foundry | Your **real** existing agent, reached through the configured `foundry.auth` |

## Steps

1. Install Docker Desktop (needs admin rights and WSL2; restart if prompted): `winget install Docker.DockerDesktop`. Then start Docker Desktop.
2. Install Functions Core Tools: `npm install --global azure-functions-core-tools@4`
3. `Copy-Item config\ionova.local.example.json config\ionova.local.json` and fill it in.
4. `.\scripts\local\L1-Test-LocalPrerequisites.ps1`
5. `.\scripts\local\L2-Start-LocalStack.ps1`, and leave it running.
6. In a second terminal, run `.\scripts\local\L3-Set-LocalRuntimeConfig.ps1`. Then stop L2 (Ctrl+C) and start it again.
7. Open the printed local URL, sign in, select **Become the first app administrator**, then **Seed**, then submit an address.
8. When you're done, run `.\scripts\local\L4-Stop-LocalStack.ps1` (add `-Purge` to delete local data).

The local SQL login is accepted only when `environment` is `local` (D-56).
