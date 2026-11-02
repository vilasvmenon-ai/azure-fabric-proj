<#
.SYNOPSIS
  Step 10 - Sign in to the Fabric tenant (Rayfin + Azure CLI) and, when different, the Foundry tenant (Azure CLI).

.DESCRIPTION
  Interactive browser sign-ins with YOUR accounts; no credentials are stored by this repository.
   - Rayfin CLI      -> Fabric tenant (org.tenantId), work/school account: every Fabric App deployment action.
   - Azure CLI       -> Fabric tenant: read-only Fabric REST lookups, SQL schema check and export.
   - Azure CLI       -> Foundry tenant (foundry.tenantId), if different: service principal and role setup (script 41).
  The Azure CLI keeps both accounts; scripts pass --tenant / --subscription explicitly.

.EXAMPLE
  .\scripts\10-Connect-Tenant.ps1 -Environment dev
#>
[CmdletBinding()]
param([string]$Environment = 'dev', [switch]$SkipFoundryTenant)

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
Assert-Guid $cfg.org.tenantId 'org.tenantId (Fabric tenant)'
$fabricTenant = $cfg.org.tenantId
$foundryTenant = $cfg.foundry.tenantId

Write-Step "Azure CLI sign-in: Fabric tenant $fabricTenant (work or school account)"
Invoke-Native 'az.cmd' @('login', '--tenant', $fabricTenant, '--allow-no-subscriptions', '--output', 'none')
$token = Get-AzToken 'https://api.fabric.microsoft.com' $fabricTenant
$parts = $token.Split('.'); $p = $parts[1].Replace('-', '+').Replace('_', '/'); while ($p.Length % 4) { $p += '=' }
$claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
if ($claims.idp -eq 'live.com') { throw 'This is a personal Microsoft account. Fabric requires a work or school account in the Fabric tenant.' }
Write-Ok "Fabric tenant account: $($claims.upn)"

if (-not $SkipFoundryTenant -and $foundryTenant -and $foundryTenant -ne $fabricTenant) {
  Assert-Guid $foundryTenant 'foundry.tenantId'
  Write-Step "Azure CLI sign-in: Foundry tenant $foundryTenant"
  Invoke-Native 'az.cmd' @('login', '--tenant', $foundryTenant, '--output', 'none')
  Invoke-Native 'az.cmd' @('account', 'set', '--subscription', $cfg.foundry.subscriptionId)
  $acct = (Invoke-Native 'az.cmd' @('account', 'show', '--query', '{user:user.name, tenant:tenantId, subscription:name}', '-o', 'json') -CaptureOutput) | ConvertFrom-Json
  if ($acct.tenant -ne $foundryTenant) { throw "Azure CLI default is tenant $($acct.tenant), expected $foundryTenant." }
  Write-Ok "Foundry tenant account: $($acct.user) / subscription '$($acct.subscription)' (default context)"
}

Write-Step 'Rayfin CLI sign-in: Fabric tenant (used for all Fabric App deployments)'
$ars = Get-AppDirectory $cfg 'ars'
Invoke-Rayfin $ars @('login', '--tenant', $fabricTenant)
Invoke-Rayfin $ars @('login', 'status')
Write-Ok 'Signed in. Next: scripts\20-Test-FabricReadiness.ps1'
