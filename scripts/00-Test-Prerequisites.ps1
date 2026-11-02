<#
.SYNOPSIS
  Step 00 - Check local tools, versions and the configuration file (SET-01). Read-only.

.DESCRIPTION
  Verifies Node.js >= 20, npm, Git, Azure CLI, Azure Functions Core Tools (optional, local debugging only),
  installed Rayfin CLI version in each app, and that config\ionova.<env>.json has no placeholders
  (GENERATED values are allowed before the first deployment).

.EXAMPLE
  .\scripts\00-Test-Prerequisites.ps1 -Environment dev
#>
[CmdletBinding()]
param([string]$Environment = 'dev')

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$failures = 0

function Test-Tool([string]$Name, [string]$Command, [string[]]$VersionArgs, [string]$MinMajor, [switch]$Optional) {
  $cmd = Get-Command $Command -ErrorAction SilentlyContinue
  if (-not $cmd) {
    if ($Optional) { Write-Warn2 "$Name not found (optional)."; return }
    Write-Fail "$Name not found. Install it (docs\MANUAL-STEPS.md M-01)."; $script:failures++; return
  }
  $v = (& $Command @VersionArgs 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match '\d+\.\d+' } | Select-Object -First 1) -replace '\s+', ' '
  if ($MinMajor -and ($v -match '(\d+)\.')) {
    if ([int]$Matches[1] -lt [int]$MinMajor) { Write-Fail "$Name $v is older than $MinMajor.x"; $script:failures++; return }
  }
  Write-Ok "$Name $v"
}

Write-Step 'Local tools'
Test-Tool 'Node.js' 'node' @('--version') '20'
Test-Tool 'npm' 'npm.cmd' @('--version') ''
Test-Tool 'Git' 'git' @('--version') ''
Test-Tool 'Azure CLI' 'az.cmd' @('--version') '2'
Test-Tool 'Azure Functions Core Tools (local function debugging only)' 'func' @('--version') '4' -Optional

Write-Step 'Configuration'
try {
  $cfg = Read-IonovaConfig $Environment
  Assert-NoPlaceholders $cfg "config\ionova.$Environment.json"
  Assert-Guid $cfg.org.tenantId 'org.tenantId'
  Assert-Guid $cfg.fabric.workspaceId 'fabric.workspaceId'
  Assert-Guid $cfg.fabric.capacityId 'fabric.capacityId'
  Assert-Guid $cfg.runtimeIdentity.ownerObjectId 'runtimeIdentity.ownerObjectId'
  Assert-Guid $cfg.foundry.tenantId 'foundry.tenantId'
  Assert-Guid $cfg.foundry.subscriptionId 'foundry.subscriptionId'
  if ($cfg.foundry.auth -eq 'servicePrincipal') {
    Write-Ok "Foundry access: service principal in tenant $($cfg.foundry.tenantId) (Fabric tenant $($cfg.org.tenantId))"
    $exp = $cfg.foundry.servicePrincipal.secretExpiryUtc
    if ($exp -and $exp -notlike 'GENERATED*') {
      $left = ([datetime]::ParseExact($exp, 'yyyy-MM-dd', $null) - (Get-Date).ToUniversalTime().Date).Days
      if ($left -lt 0) { Write-Fail "Foundry service principal secret expired on $exp. Run 41-Setup-FoundryServicePrincipal.ps1 -RotateSecret."; $failures++ }
      elseif ($left -lt 30) { Write-Warn2 "Foundry service principal secret expires in $left day(s); rotate with 41-Setup-FoundryServicePrincipal.ps1 -RotateSecret." }
    }
  } elseif ($cfg.foundry.tenantId -ne $cfg.org.tenantId) {
    Write-Fail 'foundry.auth = rayfinAppIdentity requires Foundry in the Fabric tenant; use servicePrincipal (D-03a).'; $failures++
  }
  if ($cfg.foundry.projectEndpoint -notmatch '^https://[A-Za-z0-9.-]+/api/projects/[A-Za-z0-9_.-]+/?$') { throw 'foundry.projectEndpoint is not a Foundry project endpoint.' }
  if ($cfg.foundry.projectResourceId -notmatch '^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.CognitiveServices/accounts/[^/]+/projects/[^/]+$') {
    throw 'foundry.projectResourceId must be the Foundry project ARM resource id (.../accounts/<resource>/projects/<project>).'
  }
  $expiry = [datetime]::ParseExact($cfg.fabric.trialExpiryUtc, 'yyyy-MM-dd', $null)
  $days = ($expiry - (Get-Date).ToUniversalTime().Date).Days
  if ($days -lt 0) { Write-Fail "Trial capacity expired on $($cfg.fabric.trialExpiryUtc)."; $failures++ }
  elseif ($days -lt 14) { Write-Warn2 "Trial capacity expires in $days day(s) ($($cfg.fabric.trialExpiryUtc)). Plan export (scripts\60-Export-AppData.ps1)." }
  else { Write-Ok "Trial expiry $($cfg.fabric.trialExpiryUtc) ($days days left)" }
  Write-Ok "config\ionova.$Environment.json is complete"
} catch {
  Write-Fail $_.Exception.Message; $failures++
}

Write-Step 'Rayfin CLI per app (project-pinned)'
foreach ($app in @('apps\ars', 'apps\isolation-b')) {
  $dir = Join-Path (Get-RepoRoot) $app
  $pkg = Join-Path $dir 'node_modules\@microsoft\rayfin-cli\package.json'
  if (Test-Path $pkg) { Write-Ok "$app rayfin-cli $((Read-JsonFile $pkg).version)" }
  else { Write-Warn2 "$app dependencies not installed yet (run: npm ci in $app)." }
}

Write-Step 'Unsupported or verify-at-runtime items (see docs\DECISIONS.md section 7)'
Write-Host '  - Fabric Apps is preview; confirm it is enabled for your tenant and available in your capacity region (G-02, G-03).'
Write-Host '  - The Fabric App item OWNER is the runtime identity for the app SQL database (and for Foundry only in same-tenant mode, G-04).'
Write-Host '  - Cross-tenant Foundry uses a service principal secret held in Rayfin; rotate before it expires (D-03a, G-16).'
Write-Host '  - rayfin login --service-principal is not supported (G-10); deployments are interactive.'

if ($failures -gt 0) { Write-Fail "$failures prerequisite check(s) failed."; exit 1 }
Write-Ok 'All prerequisite checks passed.'
