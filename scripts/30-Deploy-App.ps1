<#
.SYNOPSIS
  Step 30 - Build, test and deploy one Fabric App with the Rayfin CLI (SET-03, DEL-03, DEL-08).

.DESCRIPTION
  1. npm ci (lockfile), typecheck, functions validator, unit tests, production build - stops on any failure.
  2. Preview with `rayfin up --dry-run` (always).
  3. Unless -DryRun: asks for confirmation, then `rayfin up --workspace-id <id> --item-name <name> --yes`.
     Rayfin creates the Fabric App item on first deploy (with its SQL database, auth and static hosting
     child services), applies the schema from the TypeScript entities, deploys Functions and the React build.
     A repeat run updates the same item (no duplicates: the item name is checked first by script 20).
  Destructive schema changes are refused by Rayfin; this script never passes --force.

.PARAMETER App
  ars (Address Structuring Lab) or isob (App B isolation test app).

.EXAMPLE
  .\scripts\30-Deploy-App.ps1 -App ars -DryRun
  .\scripts\30-Deploy-App.ps1 -App ars
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)][ValidateSet('ars', 'isob')][string]$App,
  [string]$Environment = 'dev',
  [switch]$DryRun,
  [switch]$SkipTests
)

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
Assert-NoPlaceholders $cfg "config\ionova.$Environment.json"
Assert-Guid $cfg.fabric.workspaceId 'fabric.workspaceId'
$appCfg = Get-AppConfig $cfg $App
$dir = Get-AppDirectory $cfg $App
$log = New-EvidenceFile "deploy-$App-$Environment.log"
Start-Transcript -Path $log | Out-Null
try {
  Write-Step "Install locked dependencies ($dir)"
  Invoke-Native 'npm.cmd' @('ci', '--no-audit', '--no-fund') $dir

  if (-not $SkipTests) {
    Write-Step 'Typecheck (includes functions contract validator for ars)'
    Invoke-Native 'npm.cmd' @('run', 'typecheck') $dir
    Write-Step 'Lint'
    Invoke-Native 'npm.cmd' @('run', 'lint') $dir
    Write-Step 'Unit tests'
    Invoke-Native 'npm.cmd' @('test') $dir
  } else {
    Write-Warn2 'Tests skipped by -SkipTests.'
  }

  Write-Step 'Production build'
  Invoke-Native 'npm.cmd' @('run', 'build:fabric') $dir

  Write-Step 'Secret scan of the built frontend bundle'
  $dist = Join-Path $dir 'packages\frontend\dist'
  $patterns = 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}', 'AccountKey=', 'client_secret', 'Password=', 'sk-[A-Za-z0-9]{20,}', 'database\.fabric\.microsoft\.com', 'services\.ai\.azure\.com/api/projects'
  $hits = Get-ChildItem $dist -Recurse -File | Select-String -Pattern $patterns
  if ($hits) { $hits | ForEach-Object { Write-Fail "$($_.Path):$($_.LineNumber) matches a forbidden pattern" }; throw 'Possible secret or backend endpoint in frontend bundle.' }
  Write-Ok 'No credentials, tokens, SQL or Foundry endpoints found in the frontend bundle.'

  $upArgs = @('up', '--workspace-id', $cfg.fabric.workspaceId, '--item-name', $appCfg.itemName, '--tenant', $cfg.org.tenantId)
  Write-Step "Preview: rayfin $($upArgs -join ' ') --dry-run"
  Invoke-Rayfin $dir ($upArgs + @('--dry-run', '--verbose'))

  if ($DryRun) { Write-Ok 'Dry run complete; nothing was deployed.'; return }

  if ($PSCmdlet.ShouldProcess("$($appCfg.itemName) in workspace $($cfg.fabric.workspaceName)", 'Deploy Fabric App with rayfin up')) {
    Write-Step 'Deploy'
    Invoke-Rayfin $dir ($upArgs + @('--yes'))
    Write-Step 'Deployment status'
    $status = Get-RayfinStatus $dir
    $hosting = Find-JsonValue $status @('hostingUrl')
    $item = Find-JsonValue $status @('rayfinItemId', 'itemId', 'fabricItemId')
    Write-Ok "Item id: $item"
    Write-Ok "App URL: $hosting"
    $statusFile = New-EvidenceFile "status-$App-$Environment.json"
    Write-JsonFile $statusFile $status
    Write-Ok "Status evidence: $statusFile"
    if ($App -eq 'ars') { Write-Host "`nNext: scripts\31-Resolve-AppDatabase.ps1 -App ars, then scripts\32-Set-RuntimeConfig.ps1 -App ars" }
    else { Write-Host "`nNext: scripts\70-Update-Register.ps1, then share the item (docs\MANUAL-STEPS.md M-20)." }
  }
} finally {
  Stop-Transcript | Out-Null
  Write-Host "Log: $log"
}
