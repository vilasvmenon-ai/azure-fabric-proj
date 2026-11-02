<#
.SYNOPSIS
  Step 20 - Read-only readiness checks for the Fabric workspace and capacity (PRD "Readiness record", SET-01/02).

.DESCRIPTION
  Uses read-only Fabric REST GET calls (the coordinate-lookup method recommended by the Rayfin guide):
   - the configured workspace exists, is accessible, and is assigned to the configured capacity
   - the capacity is Active, and its region is not on the Fabric App (preview) unavailable list
   - existing Fabric App items with the configured names (to avoid accidental duplicates)
  Writes an evidence file. Trial expiry, tenant setting and Functions availability are confirmed manually (M-04..M-07).

.EXAMPLE
  .\scripts\20-Test-FabricReadiness.ps1 -Environment dev
#>
[CmdletBinding()]
param([string]$Environment = 'dev')

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
$tenant = $cfg.org.tenantId
$failures = 0
$evidence = [ordered]@{ checkedAtUtc = (Get-Date).ToUniversalTime().ToString('o'); environment = $Environment }

# Regions where "Fabric App (preview)" is listed as NOT available (learn.microsoft.com/fabric/admin/region-availability, checked 26 Oct 2026).
$unsupported = @('Brazil South', 'Canada Central', 'Mexico Central', 'Poland Central', 'Spain Central', 'Switzerland West', 'UK South',
  'Indonesia Central', 'Israel Central', 'Japan West', 'Malaysia West', 'New Zealand North', 'Taiwan North', 'Taiwan Northwest')

Write-Step 'Workspace'
$ws = Invoke-FabricGet "workspaces/$($cfg.fabric.workspaceId)" $tenant
$evidence.workspace = @{ id = $ws.id; displayName = $ws.displayName; capacityId = $ws.capacityId }
if ($ws.displayName -ne $cfg.fabric.workspaceName) { Write-Warn2 "Workspace name is '$($ws.displayName)', config says '$($cfg.fabric.workspaceName)'." } else { Write-Ok "Workspace $($ws.displayName) ($($ws.id))" }
if (-not $ws.capacityId) { Write-Fail 'Workspace has no capacity assigned (M-06).'; $failures++ }
elseif ($ws.capacityId -ne $cfg.fabric.capacityId) { Write-Fail "Workspace capacity $($ws.capacityId) differs from config $($cfg.fabric.capacityId)."; $failures++ }
else { Write-Ok "Assigned capacity $($ws.capacityId)" }

Write-Step 'Capacity'
$caps = Invoke-FabricGet 'capacities' $tenant
$cap = @($caps.value | Where-Object { $_.id -eq $cfg.fabric.capacityId }) | Select-Object -First 1
if (-not $cap) { Write-Fail 'Configured capacity is not visible to you.'; $failures++ }
else {
  $evidence.capacity = @{ id = $cap.id; displayName = $cap.displayName; sku = $cap.sku; region = $cap.region; state = $cap.state }
  Write-Ok "Capacity $($cap.displayName): sku=$($cap.sku) region=$($cap.region) state=$($cap.state)"
  if ($cap.state -ne 'Active') { Write-Fail 'Capacity is not Active.'; $failures++ }
  if ($unsupported -contains $cap.region) { Write-Fail "Fabric App (preview) is not available in $($cap.region) (G-03)."; $failures++ }
  if ($cfg.fabric.capacityRegion -and $cap.region -ne $cfg.fabric.capacityRegion) { Write-Warn2 "Config capacityRegion '$($cfg.fabric.capacityRegion)' differs from actual '$($cap.region)'." }
}

Write-Step 'Existing items (duplicate prevention)'
$items = Invoke-FabricGet "workspaces/$($cfg.fabric.workspaceId)/items" $tenant
$evidence.items = @()
foreach ($appName in $cfg.apps.PSObject.Properties.Name) {
  $a = Get-AppConfig $cfg $appName
  $match = @($items.value | Where-Object { $_.displayName -eq $a.itemName })
  if ($match.Count -gt 1) { Write-Fail "More than one item named $($a.itemName). Resolve manually before deploying."; $failures++ }
  elseif ($match.Count -eq 1) { Write-Ok "$($a.itemName) exists: type=$($match[0].type) id=$($match[0].id) (redeploy will update it)"; $evidence.items += @{ name = $a.itemName; id = $match[0].id; type = $match[0].type } }
  else { Write-Ok "$($a.itemName) not found (first deployment will create it)" }
}
$sqlDbs = @($items.value | Where-Object { $_.type -eq 'SQLDatabase' })
Write-Host "  SQL databases in workspace: $($sqlDbs.Count) (trial allows up to 3)."

Write-Step 'Manual confirmations still required (record them in docs\deployments\<org>-<env>\READINESS.md)'
Write-Host '  R-01 trial expiry/size   R-02 Fabric Apps tenant setting   R-03 Functions availability   R-04 runtime identity'

$file = New-EvidenceFile "readiness-$Environment.json"
Write-JsonFile $file $evidence
Write-Ok "Evidence written to $file"
if ($failures -gt 0) { Write-Fail "$failures readiness check(s) failed. Do not deploy until resolved."; exit 1 }
Write-Ok 'Fabric readiness checks passed. Next: scripts\30-Deploy-App.ps1 -App ars -DryRun'
