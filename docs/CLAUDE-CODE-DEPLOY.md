# Deploy both apps with Claude Code

Claude Code can deploy App A and App B with no prompts, once a person has done the one-time steps below.
The repository supplies the pieces:

| File | Role |
| --- | --- |
| `scripts/90-Deploy-All.ps1` | Runs the whole tested sequence without confirmations (scripts 00, 20, 30 A, 31, 32, 51, 30 B, 31, 50, 52, 70) |
| `CLAUDE.md` | Rules Claude Code loads automatically: use script 90, stop on exit code 2, never sign in or create credentials |
| `.claude/settings.json` | Pre-approves the deployment scripts and build commands; blocks scripts 41, 42, 61 and 80, `git push`, `git tag`, `--force`, `Remove-Item` and secret commands |

## What can't be automated, and why

| Step | Who | Why it stays with a person |
| --- | --- | --- |
| Fill `config/ionova.<env>.json` | Project admin, once per environment | Tenant, workspace and Foundry IDs are business decisions; Claude Code must not guess them |
| `az login --tenant <Fabric tenant>` and `.\scripts\10-Connect-Tenant.ps1` (Rayfin sign-in) | Operator, before each session (tokens expire) | Rayfin has no service-principal login (G-10); Claude Code never enters passwords |
| `.\scripts\41-Setup-FoundryServicePrincipal.ps1` | Foundry tenant admin, once per environment (and every 6 months to rotate) | It creates a credential and assigns a role |
| `.\scripts\42-Create-FoundryAgent.ps1` | Foundry owner, only for a new Foundry project | It creates the agent |
| First sign-in to App A: **Become the first app administrator**, then **Seed**, **Diagnostics**, **Probe** | Bootstrap admin, first deployment only | Browser sign-in as a real user |

Script 90 checks the sign-ins and config before deploying (preflight). If the service principal secret is missing, it deploys App A and stops with exit code 2. A person runs script 41, then the same prompt again finishes the job.

## Prompts

Open Claude Code in the repository folder (`ionova-ai-lab`). Paste one prompt at a time. Replace `dev` with your environment.

**Prompt 1: preflight (read-only)**
```text
Run .\scripts\90-Deploy-All.ps1 -Environment dev -PreflightOnly and tell me whether I'm ready to deploy. If it reports a blocker, tell me exactly which command I have to run myself. Don't run sign-in commands.
```

**Prompt 2: deploy both apps**
```text
Deploy App A and App B to the dev environment by running .\scripts\90-Deploy-All.ps1 -Environment dev. It runs long (about 15 to 25 minutes), so run it in the background and wait for it to finish. If it exits with code 1, read the output, explain the cause and propose a fix, but don't change config/ionova.dev.json, the Foundry agent or any credential. If it exits with code 2, stop and tell me the human step it names. When it finishes, give me both App URLs, the step summary and the evidence file path.
```

**Prompt 3: record the result**
```text
Show me git status and the diff for docs/deployments/ and docs/schema/. If they changed, commit only those folders with the message "Deployment record: dev <today's date>". Don't commit rayfin.yml changes, don't push and don't tag.
```

**Prompt 4: after a code change (optional)**
```text
Run the gates serially in apps\ars and then apps\isolation-b: npm ci, npm run typecheck, npm run lint, npm test, npm run build:fabric. Report the test counts. If all pass, run Prompt 2.
```

**First deployment only**, after Prompt 2: open the App A URL, select **Become the first app administrator**, then in **Administration** run **Seed sample data**, **Run diagnostics** and **Probe existing Foundry agent**.

## Fully headless (no chat window)

From a PowerShell window in the repository, after the human sign-ins:

```powershell
claude -p "Deploy App A and App B to the dev environment by running .\scripts\90-Deploy-All.ps1 -Environment dev. Stop on exit code 2 and report the human step. Report the App URLs and the evidence file." --output-format text
```

The project `.claude/settings.json` pre-approves the commands this needs. Don't use `--dangerously-skip-permissions`: the deny rules are part of the safety design.

## Without Claude Code

The same thing by hand:

```powershell
.\scripts\90-Deploy-All.ps1 -Environment dev -PreflightOnly
.\scripts\90-Deploy-All.ps1 -Environment dev
```
