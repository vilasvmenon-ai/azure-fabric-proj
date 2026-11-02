<#
.SYNOPSIS
  Step 32 - Store the app's non-secret runtime configuration on the deployed item as a Rayfin function secret.

.DESCRIPTION
  Builds the IONOVA_RUNTIME_CONFIG JSON (endpoints, IDs, agent reference, SQL coordinates, bootstrap admins)
  from config\ionova.<env>.json, validates it, shows it, and pipes it to
     rayfin secret set IONOVA_RUNTIME_CONFIG --stdin
  so the value never appears on a command line, in source code or in the frontend (D-50).
  It contains no credentials: all downstream access uses Rayfin-issued tokens.
  Rerun after any change (for example agent version label, fault injection in dev). No redeploy is needed.

.EXAMPLE
  .\scripts\32-Set-RuntimeConfig.ps1 -App ars -WhatIf
  .\scripts\32-Set-RuntimeConfig.ps1 -App ars
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('ars')][string]$App = 'ars',
  [string]$Environment = 'dev'
)

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
$appCfg = Get-AppConfig $cfg $App
Assert-NoPlaceholders $cfg "config\ionova.$Environment.json" -IncludeGenerated:$false
Assert-NoPlaceholders $appCfg.sql "apps.$App.sql" -IncludeGenerated
if ($appCfg.faultInjection -ne 'none' -and $Environment -ne 'dev') { throw 'faultInjection may only be set in dev.' }
if ($Environment -eq 'prod' -and $appCfg.PSObject.Properties['superUserEmails'] -and @($appCfg.superUserEmails).Count -gt 0) { throw 'superUserEmails is not allowed in prod (D-57).' }
if ($cfg.foundry.auth -eq 'servicePrincipal') {
  if ($cfg.foundry.servicePrincipal.clientId -like 'GENERATED*') { throw 'Run scripts\41-Setup-FoundryServicePrincipal.ps1 first (service principal clientId not set).' }
  Assert-Guid $cfg.foundry.servicePrincipal.clientId 'foundry.servicePrincipal.clientId'
}

$runtime = [ordered]@{
  orgId                = $cfg.org.code
  projectId            = $cfg.project.code
  appId                = $appCfg.appId
  appName              = $appCfg.appName
  environment          = $Environment
  release              = $appCfg.release
  ownerEmail           = $cfg.runtimeIdentity.ownerUpn.ToLowerInvariant()
  foundry              = [ordered]@{
    projectEndpoint   = $cfg.foundry.projectEndpoint
    agentName         = $cfg.foundry.agentName
    agentVersionLabel = $cfg.foundry.agentVersionLabel
    apiVersion        = $cfg.foundry.apiVersion
    timeoutMs         = [int]$cfg.foundry.timeoutMs
    maxRetries        = [int]$cfg.foundry.maxRetries
    totalBudgetMs     = [int]$cfg.foundry.totalBudgetMs
    auth              = $cfg.foundry.auth
    servicePrincipal  = $(if ($cfg.foundry.auth -eq 'servicePrincipal') { [ordered]@{ tenantId = $cfg.foundry.tenantId; clientId = $cfg.foundry.servicePrincipal.clientId } } else { $null })
  }
  sql                  = [ordered]@{ server = $appCfg.sql.server; database = $appCfg.sql.database; schema = $appCfg.sql.schema }
  bootstrapAdminEmails = @($appCfg.bootstrapAdminEmails | ForEach-Object { $_.ToLowerInvariant() })
  superUserEmails      = @($(if ($appCfg.PSObject.Properties['superUserEmails']) { $appCfg.superUserEmails } else { @() }) | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() })
  faultInjection       = $appCfg.faultInjection
}
$json = $runtime | ConvertTo-Json -Depth 5 -Compress
if ($json.Length -gt 8000) { throw 'Runtime configuration is unexpectedly large.' }

Write-Step 'Runtime configuration to store (no credentials)'
$runtime | ConvertTo-Json -Depth 5 | Write-Host

$dir = Get-AppDirectory $cfg $App
if ($PSCmdlet.ShouldProcess("IONOVA_RUNTIME_CONFIG on the active Rayfin deployment of $($appCfg.itemName)", 'rayfin secret set --stdin')) {
  $env:RAYFIN_TELEMETRY_OPTOUT = '1'
  # Written to stdin as UTF-8 WITHOUT a BOM (PS 5.1 piping would prefix EF BB BF and break the JSON).
  $code = Invoke-NativeWithStdin 'npx.cmd' @('--no-install', 'rayfin', 'secret', 'set', 'IONOVA_RUNTIME_CONFIG', '--stdin', '--describe=ioNova non-secret runtime configuration (see docs/DECISIONS.md D-50)') $dir $json -ShowOutput
  if ($code -ne 0) { throw "rayfin secret set failed with exit code $code" }
  if ($cfg.foundry.auth -eq 'servicePrincipal') { Write-Ok 'Stored. Next: scripts\50-Verify-Deployment.ps1, then the first sign-in (docs\MANUAL-STEPS.md M-18).' }
  else { Write-Ok 'Stored. Next: scripts\40-Grant-FoundryAccess.ps1 -WhatIf' }
}
