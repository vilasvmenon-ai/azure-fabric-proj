<#
.SYNOPSIS
  Local step L2 - Start App A on the Rayfin Docker local stack (preview) and keep it attached.

.DESCRIPTION
  Runs `npx rayfin dev --provider docker` in apps\ars with RAYFIN_FEATURE_FLAGS=docker-local-dev.
  Rayfin starts the backend and SQL containers, applies the schema from the TypeScript entities, builds and starts
  the local Functions host (port 7071+) and the Vite frontend, and prints the local URL.
  This window stays attached; press Ctrl+C to stop (containers are torn down by Rayfin).

  First run: after the containers are healthy, open a SECOND terminal and run L3-Set-LocalRuntimeConfig.ps1,
  then stop this session (Ctrl+C) and start it again so the Functions host loads the new settings.

.EXAMPLE
  .\scripts\local\L2-Start-LocalStack.ps1
#>
[CmdletBinding()]
param([switch]$Verbose2)

Import-Module (Join-Path (Split-Path -Parent $PSScriptRoot) 'IonovaDeploy.psm1') -Force
Update-SessionPath
$ars = Join-Path (Get-RepoRoot) 'apps\ars'
$env:RAYFIN_FEATURE_FLAGS = 'docker-local-dev'
$env:RAYFIN_TELEMETRY_OPTOUT = '1'

Write-Step 'Building workspace packages (shared, data, functions) before the dev session'
Invoke-Native 'npm.cmd' @('run', 'typecheck') $ars

Write-Step 'Starting: npx rayfin dev --provider docker  (Ctrl+C to stop)'
Write-Host '  Data, auth and storage run in Docker; functions and the React app run locally.'
Write-Host '  Functions call the EXISTING Foundry agent with YOUR Azure sign-in (local token identity).'
$args2 = @('--no-install', 'rayfin', 'dev', '--provider', 'docker')
if ($Verbose2) { $args2 += '--verbose' }
Push-Location $ars
try {
  & npx.cmd @args2
} finally {
  Pop-Location
}
