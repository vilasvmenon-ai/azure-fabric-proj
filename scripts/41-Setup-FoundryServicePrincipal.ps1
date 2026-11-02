<#
.SYNOPSIS
  Step 41 - Cross-tenant Foundry access: service principal in the FOUNDRY tenant + secret in Rayfin (D-03a).

.DESCRIPTION
  Fabric (org.tenantId) and the existing Foundry project (foundry.tenantId) are in different Entra tenants, so the
  deployed function cannot use the Rayfin AzureAI token. This script, run with an Azure CLI sign-in to the FOUNDRY
  tenant and a Rayfin CLI sign-in to the FABRIC tenant:
    1. finds or creates a single-tenant app registration + service principal (foundry.servicePrincipal.appDisplayName)
    2. assigns ONLY the configured role (default "Foundry Agent Consumer") at the Foundry PROJECT scope
    3. creates a client secret (default 6 months) and pipes it straight into
         rayfin secret set IONOVA_FOUNDRY_CLIENT_SECRET --stdin
       on the deployed App A item. The secret is never printed, logged or written to disk. If storing it fails, the
       new credential is deleted again.
    4. records clientId, objectId and secretExpiryUtc (identifiers only) in config\ionova.<env>.json
  It never reads or changes the agent, its instructions, the model deployment or any other Foundry resource.
  Requirements: Application Administrator (or Global Administrator) in the Foundry tenant and Owner / User Access
  Administrator on the Foundry project; App A deployed at least once (script 30).

.PARAMETER RotateSecret
  Create a new secret and replace the Rayfin secret even if one exists (use before secretExpiryUtc).

.EXAMPLE
  .\scripts\41-Setup-FoundryServicePrincipal.ps1 -WhatIf
  .\scripts\41-Setup-FoundryServicePrincipal.ps1
  .\scripts\41-Setup-FoundryServicePrincipal.ps1 -RotateSecret
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param([string]$Environment = 'dev', [switch]$RotateSecret)

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
$f = $cfg.foundry
if ($f.auth -ne 'servicePrincipal') { throw "foundry.auth is '$($f.auth)'. This script is for servicePrincipal mode; use scripts\40-Grant-FoundryAccess.ps1 for rayfinAppIdentity." }
Assert-Guid $f.tenantId 'foundry.tenantId'
Assert-Guid $f.subscriptionId 'foundry.subscriptionId'
$sp = $f.servicePrincipal
$name = $sp.appDisplayName
$scope = $f.projectResourceId
if ($scope -notmatch '/providers/Microsoft\.CognitiveServices/accounts/[^/]+/projects/[^/]+$') { throw 'foundry.projectResourceId must be the Foundry project scope.' }
$secretName = 'IONOVA_FOUNDRY_CLIENT_SECRET'
$ars = Get-AppDirectory $cfg 'ars'

Write-Step "Azure CLI context: Foundry tenant $($f.tenantId)"
try { Invoke-Native 'az.cmd' @('account', 'set', '--subscription', $f.subscriptionId) } catch { throw "Sign in to the Foundry tenant first: az login --tenant $($f.tenantId)" }
$ctxTenant = (Invoke-Native 'az.cmd' @('account', 'show', '--query', 'tenantId', '-o', 'tsv') -CaptureOutput).Trim()
if ($ctxTenant -ne $f.tenantId) { throw "Azure CLI is in tenant $ctxTenant, expected Foundry tenant $($f.tenantId)." }
Write-Ok 'Azure CLI is in the Foundry tenant.'

Write-Step "App registration '$name'"
$app = (Invoke-Native 'az.cmd' @('ad', 'app', 'list', '--display-name', $name, '--query', '[0].{appId:appId,id:id}', '-o', 'json') -CaptureOutput) | ConvertFrom-Json
$created = $false
if (-not $app) {
  if (-not $PSCmdlet.ShouldProcess($name, 'Create single-tenant app registration and service principal')) { return }
  $app = (Invoke-Native 'az.cmd' @('ad', 'app', 'create', '--display-name', $name, '--sign-in-audience', 'AzureADMyOrg', '--query', '{appId:appId,id:id}', '-o', 'json') -CaptureOutput) | ConvertFrom-Json
  $created = $true
  Write-Ok "Created app registration (clientId $($app.appId))"
} else { Write-Ok "Exists (clientId $($app.appId))" }

$spObj = $null
try { $spObj = (Invoke-Native 'az.cmd' @('ad', 'sp', 'show', '--id', $app.appId, '--query', '{id:id}', '-o', 'json') -CaptureOutput) | ConvertFrom-Json } catch { $spObj = $null }
if (-not $spObj) {
  if (-not $PSCmdlet.ShouldProcess($app.appId, 'Create service principal')) { return }
  $spObj = (Invoke-Native 'az.cmd' @('ad', 'sp', 'create', '--id', $app.appId, '--query', '{id:id}', '-o', 'json') -CaptureOutput) | ConvertFrom-Json
  Write-Ok "Created service principal (objectId $($spObj.id))"
} else { Write-Ok "Service principal objectId $($spObj.id)" }

Write-Step "Role '$($f.rbacRole)' at the Foundry project scope"
$roles = (Invoke-Native 'az.cmd' @('role', 'assignment', 'list', '--assignee', $spObj.id, '--scope', $scope, '--query', '[].roleDefinitionName', '-o', 'json') -CaptureOutput) | ConvertFrom-Json
if ($roles -contains $f.rbacRole) { Write-Ok 'Already assigned.' }
elseif ($PSCmdlet.ShouldProcess("$name at $scope", "Assign role '$($f.rbacRole)'")) {
  # New service principals can take a short time to replicate; retry a few times.
  $done = $false
  for ($i = 1; $i -le 6 -and -not $done; $i++) {
    try { Invoke-Native 'az.cmd' @('role', 'assignment', 'create', '--assignee-object-id', $spObj.id, '--assignee-principal-type', 'ServicePrincipal', '--role', $f.rbacRole, '--scope', $scope) -CaptureOutput | Out-Null; $done = $true }
    catch { if ($i -eq 6) { throw }; Write-Warn2 "Role assignment attempt $i failed (replication delay?); retrying in 20 s"; Start-Sleep -Seconds 20 }
  }
  Write-Ok 'Assigned.'
}

Write-Step "Rayfin secret $secretName on the deployed App A item (Rayfin CLI signed in to the Fabric tenant)"
$env:RAYFIN_TELEMETRY_OPTOUT = '1'
$existing = Invoke-Rayfin $ars @('secret', 'list') -CaptureOutput
$hasSecret = $existing -match $secretName
if ($hasSecret -and -not $RotateSecret -and -not $created) {
  Write-Ok 'Secret already set. Use -RotateSecret to replace it.'
} elseif ($PSCmdlet.ShouldProcess("$name -> Rayfin secret $secretName", 'Create client secret and store it in Rayfin')) {
  $months = if ($sp.secretMonths) { [int]$sp.secretMonths } else { 6 }
  $end = (Get-Date).ToUniversalTime().AddMonths($months).ToString('yyyy-MM-dd')
  $credName = "rayfin-$Environment-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd'))"
  # stdout only: az writes a "credentials in output" warning to stderr, which must not become part of the secret.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'   # judge native commands by exit code, not stderr (PS 5.1)
  $secret = (& az.cmd ad app credential reset --id $app.appId --append --display-name $credName --end-date $end --query password -o tsv 2>$null)
  $resetCode = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  if ($resetCode -ne 0 -or -not $secret) { throw 'Creating the client secret failed (check Application Administrator rights in the Foundry tenant).' }
  $secret = ([string]$secret).Trim()
  try {
    # Written to stdin as UTF-8 WITHOUT a BOM (PS 5.1 piping would prefix EF BB BF to the secret). Output not shown.
    $code = Invoke-NativeWithStdin 'npx.cmd' @('--no-install', 'rayfin', 'secret', 'set', $secretName, '--stdin', '--describe=Client secret of the Foundry-tenant service principal (D-03a)') $ars $secret
    if ($code -ne 0) { throw "rayfin secret set failed with exit code $code" }
  } catch {
    Write-Fail 'Storing the secret in Rayfin failed; deleting the new credential.'
    $keyId = (Invoke-Native 'az.cmd' @('ad', 'app', 'credential', 'list', '--id', $app.appId, '--query', "[?displayName=='$credName'].keyId | [0]", '-o', 'tsv') -CaptureOutput).Trim()
    if ($keyId) { Invoke-Native 'az.cmd' @('ad', 'app', 'credential', 'delete', '--id', $app.appId, '--key-id', $keyId) }
    throw
  } finally {
    $secret = $null
    [System.GC]::Collect()
  }
  $sp.secretExpiryUtc = $end
  Write-Ok "Secret stored in Rayfin (expires $end). Value was not displayed."
  Write-Host '  Old secrets remain valid until they expire; remove them in Entra (App registrations > Certificates & secrets) after verifying.'
}

$sp.clientId = $app.appId
$sp.objectId = $spObj.id
Save-IonovaConfig $cfg $Environment
$evidence = New-EvidenceFile "foundry-sp-$Environment.json"
Write-JsonFile $evidence ([ordered]@{ atUtc = (Get-Date).ToUniversalTime().ToString('o'); foundryTenant = $f.tenantId; clientId = $app.appId; objectId = $spObj.id; role = $f.rbacRole; scope = $scope; secretExpiryUtc = $sp.secretExpiryUtc })
Write-Ok "Config updated; evidence $evidence"
# Restore the Azure CLI default to the Fabric tenant account (later scripts read Fabric/SQL tokens with --tenant).
try { Invoke-Native 'az.cmd' @('account', 'set', '--subscription', $cfg.org.tenantId) -CaptureOutput | Out-Null; Write-Ok 'Azure CLI default restored to the Fabric tenant.' }
catch { Write-Warn2 "Run: az account set --subscription $($cfg.org.tenantId)  (to make the Fabric tenant account the default again)" }
Write-Host 'Next: scripts\32-Set-RuntimeConfig.ps1 -App ars (includes the service principal identifiers, not the secret).'
