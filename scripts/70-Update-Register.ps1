<#
.SYNOPSIS
  Step 70 - Update config\app-register.json with actual resource IDs and URLs (PRJ-02, AC-01).

.DESCRIPTION
  Creates config\app-register.json from the example on first run (filling org/project/environment values
  from config\ionova.<env>.json), then for each deployed app reads `rayfin up status --json` and records
  item id, app URL, backend URL, SQL database item id, deployed version and time. Appends a changeLog entry.
  The register contains identifiers only (no credentials) and is meant to be version-controlled.

.EXAMPLE
  .\scripts\70-Update-Register.ps1 -Environment dev -ChangedBy you@ionova.example -Reason "Initial dev deployment"
#>
[CmdletBinding()]
param(
  [string]$Environment = 'dev',
  [Parameter(Mandatory = $true)][string]$ChangedBy,
  [Parameter(Mandatory = $true)][string]$Reason
)

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
$root = Get-RepoRoot
$regPath = Join-Path $root 'config\app-register.json'
if (-not (Test-Path $regPath)) { Copy-Item (Join-Path $root 'config\app-register.example.json') $regPath }
$reg = Read-JsonFile $regPath

$reg.organization.tenantId = $cfg.org.tenantId
$reg.organization.primaryAdmin = $cfg.org.primaryAdmin
$reg.organization.backupAdmin = $cfg.org.backupAdmin
$proj = $reg.projects | Where-Object { $_.code -eq $cfg.project.code } | Select-Object -First 1
$proj.owner = $cfg.project.owner
$proj.costOwner = $cfg.project.costOwner
$env1 = $proj.environments | Where-Object { $_.name -eq $Environment } | Select-Object -First 1
if (-not $env1) { throw "Register has no environment '$Environment'. Add it from the example structure." }
$env1.fabricWorkspaceName = $cfg.fabric.workspaceName
$env1.fabricWorkspaceId = $cfg.fabric.workspaceId
$env1.capacityId = $cfg.fabric.capacityId
$env1.capacityRegion = $cfg.fabric.capacityRegion
$env1.trialExpiryUtc = $cfg.fabric.trialExpiryUtc
$env1.azureResourceGroup = $cfg.azure.resourceGroup
$env1.foundry.projectEndpoint = $cfg.foundry.projectEndpoint
$env1.foundry.projectResourceId = $cfg.foundry.projectResourceId
$env1.foundry.agentName = $cfg.foundry.agentName
$env1.foundry.agentVersionLabel = $cfg.foundry.agentVersionLabel

$commit = $null
if (Get-Command git -ErrorAction SilentlyContinue) { try { $commit = (Invoke-Native 'git' @('-C', $root, 'rev-parse', '--short', 'HEAD') -CaptureOutput).Trim() } catch { $commit = $null } }

foreach ($a in $env1.applications) {
  $appCfg = Get-AppConfig $cfg $a.code
  $a.owner = $cfg.project.owner
  $a.fabricItemName = $appCfg.itemName
  $a.dataClassification = $appCfg.dataClassification
  if ($a.code -eq 'ars') { $a.runtimeIdentity = "$($cfg.runtimeIdentity.ownerUpn) (Fabric App item owner)"; $a.sqlDatabaseItemId = $appCfg.sql.sqlDatabaseItemId }
  try {
    $status = Get-RayfinStatus (Get-AppDirectory $cfg $a.code)
    $a.fabricItemId = Find-JsonValue $status @('rayfinItemId', 'itemId', 'fabricItemId')
    $a.appUrl = Find-JsonValue $status @('hostingUrl')
    $a.backendUrl = Find-JsonValue $status @('rayfinApiUrl', 'baseUrl', 'backendUrl', 'apiUrl')
    $a.status = 'deployed'
    $a.deployedVersion = "$($appCfg.release)$(if ($commit) { "+$commit" })"
    $a.deployedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    Write-Ok "$($a.code): item $($a.fabricItemId) $($a.appUrl)"
  } catch {
    $a.status = 'not deployed'
    Write-Warn2 "$($a.code): no deployment status ($($_.Exception.Message.Split("`n")[0]))"
  }
}
$reg.changeLog += [ordered]@{ atUtc = (Get-Date).ToUniversalTime().ToString('o'); environment = $Environment; changedBy = $ChangedBy; reason = $Reason; commit = $commit }
Write-JsonFile $regPath $reg
$left = @(Find-Placeholders $reg -IncludeGenerated)
if ($left.Count) { Write-Warn2 "Register still has unresolved values: $($left -join ', ')" } else { Write-Ok 'Register fully resolved (AC-01).' }
Write-Ok "Updated $regPath"
