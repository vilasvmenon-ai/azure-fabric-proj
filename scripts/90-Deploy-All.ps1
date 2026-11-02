<#
.SYNOPSIS
  Step 90 - Deploy App A and App B end to end with no prompts (for Claude Code or a scheduled operator run).

.DESCRIPTION
  Runs the tested sequence without asking for confirmation:
    preflight -> 00 prerequisites -> 20 readiness -> 30 deploy App A -> (41 check) -> 31 resolve DB -> 32 runtime config
    -> 51 schema check -> 30 deploy App B -> 31 resolve App B DB -> 50 verify -> 52 schema snapshots -> 70 register.
  Every step stops the run on failure. Running it again is safe: rayfin up updates the same items.

  What it never does (these stay with a person, see docs\CLAUDE-CODE-DEPLOY.md):
   - sign in (Azure CLI, Rayfin CLI). Rayfin has no service-principal login (G-10), so a person signs in first;
   - create credentials: if the Foundry service principal or its Rayfin secret is missing, the run deploys App A,
     then stops with exit code 2 and asks for scripts\41-Setup-FoundryServicePrincipal.ps1 (run by a person);
   - create or change the Foundry agent (script 42 is not called), use --force, delete anything, or push to Git;
   - the first in-app sign-in (Become the first app administrator, Seed, Diagnostics, Probe) - browser only.

  Exit codes: 0 done; 1 a step failed; 2 blocked on a human step (message says which).

.EXAMPLE
  .\scripts\90-Deploy-All.ps1 -Environment dev -PreflightOnly
  .\scripts\90-Deploy-All.ps1 -Environment dev -ChangedBy ops@contoso.com -Reason "Redeploy main"
#>
[CmdletBinding()]
param(
  [string]$Environment = 'dev',
  [string]$ChangedBy,
  [string]$Reason = 'Automated deployment (scripts/90-Deploy-All.ps1)',
  [switch]$SkipTests,
  [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$env:RAYFIN_TELEMETRY_OPTOUT = '1'
$cfg = Read-IonovaConfig $Environment
$ars = Get-AppDirectory $cfg 'ars'
$started = Get-Date
$summary = New-Object System.Collections.Generic.List[string]

function Invoke-Step([string]$Name, [scriptblock]$Body) {
  Write-Host "`n############ $Name" -ForegroundColor Magenta
  $global:LASTEXITCODE = 0
  try { & $Body } catch { Write-Fail "$Name failed: $($_.Exception.Message)"; exit 1 }
  if ($LASTEXITCODE -ne 0) { Write-Fail "$Name failed (exit code $LASTEXITCODE)."; exit 1 }
  $summary.Add("OK   $Name")
}

function Stop-ForHuman([string]$Message) {
  Write-Host "`nBLOCKED - needs a person: $Message" -ForegroundColor Yellow
  Write-Host 'Then run this script again; finished steps are repeated safely.'
  $summary | ForEach-Object { Write-Host "  $_" }
  exit 2
}

# ---- Preflight: everything a person must have done beforehand, checked without prompting.
Write-Step 'Preflight'
$missing = @(Find-Placeholders $cfg)
if ($missing.Count) { Stop-ForHuman "config\ionova.$Environment.json still has placeholders: $($missing -join ', ')" }
Write-Ok "config\ionova.$Environment.json complete"
try { [void](Get-AzToken 'https://api.fabric.microsoft.com' $cfg.org.tenantId); Write-Ok 'Azure CLI token for the Fabric tenant' }
catch { Stop-ForHuman "Azure CLI is not signed in to the Fabric tenant. Run: az login --tenant $($cfg.org.tenantId)" }
$status = (Invoke-Rayfin $ars @('login', 'status', '--json') -CaptureOutput) | ConvertFrom-Json
if ($status.status -ne 'ok' -or $status.tenant -ne $cfg.org.tenantId) { Stop-ForHuman "Rayfin CLI is not signed in to tenant $($cfg.org.tenantId). Run: .\scripts\10-Connect-Tenant.ps1" }
Write-Ok "Rayfin CLI signed in to $($status.tenant)"
if ($PreflightOnly) { Write-Ok 'Preflight passed; nothing deployed (-PreflightOnly).'; exit 0 }

# ---- Deploy.
Invoke-Step '00 Prerequisites' { & (Join-Path $PSScriptRoot '00-Test-Prerequisites.ps1') -Environment $Environment }
Invoke-Step '20 Fabric readiness' { & (Join-Path $PSScriptRoot '20-Test-FabricReadiness.ps1') -Environment $Environment }
Invoke-Step '30 Deploy App A' { & (Join-Path $PSScriptRoot '30-Deploy-App.ps1') -App ars -Environment $Environment -SkipTests:$SkipTests -Confirm:$false }

if ($cfg.foundry.auth -eq 'servicePrincipal') {
  $cfg = Read-IonovaConfig $Environment
  $secrets = Invoke-Rayfin $ars @('secret', 'list') -CaptureOutput
  if ($cfg.foundry.servicePrincipal.clientId -like 'GENERATED*' -or -not ($secrets -match 'IONOVA_FOUNDRY_CLIENT_SECRET')) {
    Stop-ForHuman 'The Foundry service principal or its Rayfin secret is missing. A person with Application Administrator in the Foundry tenant runs: az login --tenant <foundry.tenantId>; .\scripts\41-Setup-FoundryServicePrincipal.ps1'
  }
  $summary.Add('OK   41 Foundry service principal and secret present')
}

Invoke-Step '31 Resolve App A database' { & (Join-Path $PSScriptRoot '31-Resolve-AppDatabase.ps1') -App ars -Environment $Environment }
Invoke-Step '32 Runtime config' { & (Join-Path $PSScriptRoot '32-Set-RuntimeConfig.ps1') -App ars -Environment $Environment -Confirm:$false }
Invoke-Step '51 Schema check' { & (Join-Path $PSScriptRoot '51-Test-AppSchema.ps1') -Environment $Environment }
Invoke-Step '30 Deploy App B' { & (Join-Path $PSScriptRoot '30-Deploy-App.ps1') -App isob -Environment $Environment -SkipTests:$SkipTests -Confirm:$false }
Invoke-Step '31 Resolve App B database' { & (Join-Path $PSScriptRoot '31-Resolve-AppDatabase.ps1') -App isob -Environment $Environment }
Invoke-Step '50 Verify deployment' { & (Join-Path $PSScriptRoot '50-Verify-Deployment.ps1') -Environment $Environment }
Invoke-Step '52 Schema snapshot App A' { & (Join-Path $PSScriptRoot '52-Export-SchemaSnapshot.ps1') -App ars -Environment $Environment }
Invoke-Step '52 Schema snapshot App B' { & (Join-Path $PSScriptRoot '52-Export-SchemaSnapshot.ps1') -App isob -Environment $Environment }
if (-not $ChangedBy) { $ChangedBy = $cfg.runtimeIdentity.ownerUpn }
Invoke-Step '70 Register' { & (Join-Path $PSScriptRoot '70-Update-Register.ps1') -Environment $Environment -ChangedBy $ChangedBy -Reason $Reason }

# ---- Report.
$urls = foreach ($app in 'ars', 'isob') {
  $st = Get-RayfinStatus (Get-AppDirectory $cfg $app)
  "{0}: {1}" -f (Get-AppConfig $cfg $app).itemName, (Find-JsonValue $st @('hostingUrl'))
}
$report = [ordered]@{ environment = $Environment; startedUtc = $started.ToUniversalTime().ToString('o'); finishedUtc = (Get-Date).ToUniversalTime().ToString('o'); steps = @($summary); apps = @($urls) }
$file = New-EvidenceFile "deploy-all-$Environment.json"
Write-JsonFile $file $report
Write-Host "`n############ Done" -ForegroundColor Green
$summary | ForEach-Object { Write-Host "  $_" }
$urls | ForEach-Object { Write-Host "  App URL  $_" }
Write-Host "Evidence: $file"
Write-Host 'Changed files to review and commit: docs\deployments\, docs\schema\. (rayfin.yml now lists the hosting origin; do not commit that line.)'
Write-Host 'First deployment only: a person opens App A, selects Become the first app administrator, then Seed, Diagnostics and Probe.'
exit 0
