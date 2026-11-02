<#
.SYNOPSIS
  Step 50 - Automated post-deployment checks (DEL-07, SET-07). Read-only.

.DESCRIPTION
  For each app:
   - `rayfin up status --json` reports a deployment with a hosting URL
   - the hosting URL does NOT serve the app anonymously (assetAccess: protected)
   - for ars: IONOVA_RUNTIME_CONFIG is declared on the deployed item (`rayfin secret list`)
  Then prints the runtime tests that need a signed-in browser (docs\VERIFICATION.md V-01..V-30).
  These checks prove deployment state only; they do NOT prove the Foundry call or permissions work at runtime.

.EXAMPLE
  .\scripts\50-Verify-Deployment.ps1 -Environment dev
#>
[CmdletBinding()]
param([string]$Environment = 'dev', [string[]]$Apps = @('ars', 'isob'))

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
$failures = 0
$report = [ordered]@{ checkedAtUtc = (Get-Date).ToUniversalTime().ToString('o'); apps = @() }

foreach ($app in $Apps) {
  $appCfg = Get-AppConfig $cfg $app
  $dir = Get-AppDirectory $cfg $app
  Write-Step "$app ($($appCfg.itemName))"
  $entry = [ordered]@{ app = $app; item = $appCfg.itemName }
  try {
    $status = Get-RayfinStatus $dir
    $hosting = Find-JsonValue $status @('hostingUrl')
    $entry.hostingUrl = $hosting
    $entry.itemId = Find-JsonValue $status @('rayfinItemId', 'itemId', 'fabricItemId')
    if (-not $hosting) { throw 'No hosting URL in rayfin status.' }
    Write-Ok "Deployed. App URL: $hosting"

    try {
      $resp = Invoke-WebRequest -Uri $hosting -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 30 -ErrorAction Stop
      $looksLikeApp = $resp.Content -match '<div id="root">'
      if ($resp.StatusCode -eq 200 -and $looksLikeApp) { Write-Fail 'Hosting URL served the app without sign-in. Check assetAccess: protected.'; $failures++; $entry.protected = $false }
      else { Write-Ok "Anonymous request returned $($resp.StatusCode) without app content (protected)."; $entry.protected = $true }
    } catch {
      $code = $null
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      Write-Ok "Anonymous request was refused or redirected (HTTP $code) - protected."
      $entry.protected = $true
    }

    if ($appCfg.hasRuntimeConfig) {
      # `rayfin secret list` prints nothing when its output is captured (non-TTY); Rayfin also records each stored
      # secret's declaration in rayfin/rayfin.yml, so both sources are checked.
      $secrets = (Invoke-Rayfin $dir @('secret', 'list') -CaptureOutput) + "`n" + (Get-Content (Join-Path $dir 'rayfin\rayfin.yml') -Raw)
      if ($secrets -match 'IONOVA_RUNTIME_CONFIG') { Write-Ok 'IONOVA_RUNTIME_CONFIG is set on the deployed item.'; $entry.runtimeConfig = $true }
      else { Write-Fail 'IONOVA_RUNTIME_CONFIG is not set. Run scripts\32-Set-RuntimeConfig.ps1.'; $failures++; $entry.runtimeConfig = $false }
      if ($cfg.foundry.auth -eq 'servicePrincipal') {
        if ($secrets -match 'IONOVA_FOUNDRY_CLIENT_SECRET') { Write-Ok 'IONOVA_FOUNDRY_CLIENT_SECRET is set (value not readable).'; $entry.foundrySecret = $true }
        else { Write-Fail 'IONOVA_FOUNDRY_CLIENT_SECRET is not set. Run scripts\41-Setup-FoundryServicePrincipal.ps1.'; $failures++; $entry.foundrySecret = $false }
      }
    }
  } catch {
    Write-Fail $_.Exception.Message; $failures++; $entry.error = $_.Exception.Message
  }
  $report.apps += $entry
}

$file = New-EvidenceFile "verify-$Environment.json"
Write-JsonFile $file $report
Write-Ok "Evidence: $file"

Write-Step 'Runtime verification (signed-in browser) - required before claiming runtime success'
Write-Host '  Follow docs\VERIFICATION.md: V-01 sign-in/out, V-03 bootstrap, V-04 seed, V-05 Foundry probe from the DEPLOYED backend,'
Write-Host '  V-06 submit -> agent -> DB -> display, V-10..V-15 failure states, V-20..V-26 access separation, V-30 audit integrity.'
if ($failures -gt 0) { Write-Fail "$failures check(s) failed."; exit 1 }
Write-Ok 'Automated deployment checks passed.'
