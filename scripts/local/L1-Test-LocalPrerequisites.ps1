<#
.SYNOPSIS
  Local step L1 - Check everything the Rayfin Docker local stack needs. Read-only.

.DESCRIPTION
  Docker Desktop running, Azure Functions Core Tools 4, Node 20+, Azure CLI signed in to the tenant,
  config\ionova.local.json complete, app dependencies installed, and (optional) that YOUR account has a
  role on the existing Foundry project - locally, functions call Foundry as the signed-in developer.

.EXAMPLE
  .\scripts\local\L1-Test-LocalPrerequisites.ps1
#>
[CmdletBinding()]
param()

Import-Module (Join-Path (Split-Path -Parent $PSScriptRoot) 'IonovaDeploy.psm1') -Force
Update-SessionPath
$failures = 0
function Fail([string]$m) { Write-Fail $m; $script:failures++ }

Write-Step 'Tools'
if (Get-Command docker -ErrorAction SilentlyContinue) {
  $info = & docker info --format '{{.ServerVersion}}' 2>$null
  if ($LASTEXITCODE -eq 0 -and $info) { Write-Ok "Docker engine $info is running" } else { Fail 'Docker is installed but the engine is not running. Start Docker Desktop.' }
  & docker compose version 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Ok 'Docker Compose available' } else { Fail 'Docker Compose not available.' }
} else { Fail 'Docker not found. Install Docker Desktop (docs\LOCAL-TESTING.md step 1).' }

if (Get-Command func -ErrorAction SilentlyContinue) {
  $v = (& func --version 2>$null | Select-Object -First 1)
  if ($v -match '^4\.') { Write-Ok "Azure Functions Core Tools $v" } else { Fail "Azure Functions Core Tools 4.x required (found $v)." }
} else { Fail 'Azure Functions Core Tools not found: npm install --global azure-functions-core-tools@4' }

$node = (& node --version 2>$null)
if ($node -match '^v(\d+)\.' -and [int]$Matches[1] -ge 20) { Write-Ok "Node.js $node" } else { Fail 'Node.js 20+ required.' }

Write-Step 'Local configuration'
$cfgPath = Join-Path (Get-RepoRoot) 'config\ionova.local.json'
$cfg = $null
if (-not (Test-Path $cfgPath)) { Fail 'Missing config\ionova.local.json (copy config\ionova.local.example.json).' }
else {
  $cfg = Read-JsonFile $cfgPath
  $missing = @(Find-Placeholders $cfg)
  if ($missing.Count) { Fail "config\ionova.local.json placeholders: $($missing -join ', ')" } else { Write-Ok 'config\ionova.local.json complete' }
}

Write-Step 'Azure sign-in (used by the local Functions host for Foundry tokens)'
$acct = $null
try { $acct = (& az.cmd account show -o json 2>$null) | ConvertFrom-Json } catch { $acct = $null }
if (-not $acct) { Fail 'Azure CLI is not signed in: az login --tenant <tenant-id>' }
else {
  Write-Ok "Signed in as $($acct.user.name) (tenant $($acct.tenantId))"
  if ($cfg -and $cfg.org.tenantId -notmatch '<' -and $acct.tenantId -ne $cfg.org.tenantId) { Fail "Azure CLI tenant $($acct.tenantId) differs from config $($cfg.org.tenantId)." }
  if ($cfg -and $cfg.foundry.projectResourceId -notmatch '<') {
    $me = (& az.cmd ad signed-in-user show --query id -o tsv 2>$null)
    $roles = (& az.cmd role assignment list --assignee $me --scope $cfg.foundry.projectResourceId --include-inherited --query '[].roleDefinitionName' -o json 2>$null) | ConvertFrom-Json
    if ($roles) { Write-Ok "Your roles on the Foundry project: $($roles -join ', ')" }
    else { Write-Warn2 'No role found for your account on the Foundry project (or no permission to read assignments). Local agent calls will return 401/403 until you have "Azure AI User" there.' }
  }
}

Write-Step 'App dependencies'
$ars = Join-Path (Get-RepoRoot) 'apps\ars'
if (Test-Path (Join-Path $ars 'node_modules\@microsoft\rayfin-cli')) { Write-Ok 'apps\ars dependencies installed' } else { Fail 'Run: cd apps\ars; npm ci' }

if ($failures) { Write-Fail "$failures local prerequisite(s) missing."; exit 1 }
Write-Ok 'Ready. Next: .\scripts\local\L2-Start-LocalStack.ps1'
