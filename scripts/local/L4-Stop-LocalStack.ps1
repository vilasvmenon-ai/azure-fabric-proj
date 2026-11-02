<#
.SYNOPSIS
  Local step L4 - Stop the Rayfin Docker local stack.

.DESCRIPTION
  Default: `rayfin dev --down` (stop and remove containers; local data volumes are kept).
  -Purge: `rayfin dev --down --purge` - ALSO DELETES the local database volume (all local test data).
  Rayfin asks for confirmation before purging. Affects only local Docker state; never contacts Fabric or Foundry.

.EXAMPLE
  .\scripts\local\L4-Stop-LocalStack.ps1
  .\scripts\local\L4-Stop-LocalStack.ps1 -Purge
#>
[CmdletBinding()]
param([switch]$Purge)

Import-Module (Join-Path (Split-Path -Parent $PSScriptRoot) 'IonovaDeploy.psm1') -Force
Update-SessionPath
$ars = Join-Path (Get-RepoRoot) 'apps\ars'
$env:RAYFIN_FEATURE_FLAGS = 'docker-local-dev'
$args2 = @('dev', '--down')
if ($Purge) { Write-Warn2 'Purge deletes all local test data in the Docker volume.'; $args2 += '--purge' }
Invoke-Rayfin $ars $args2
Write-Ok 'Local stack stopped.'
