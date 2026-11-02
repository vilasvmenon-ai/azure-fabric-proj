<#
.SYNOPSIS
  Step 80 - Roll back an app by redeploying a previous, versioned commit (Microsoft-documented rollback method).

.DESCRIPTION
  Fabric Apps rollback = check out the prior git commit and run `rayfin up` again (Fabric Apps FAQ).
  This script creates a temporary git worktree at -GitRef, installs locked dependencies, runs the same gates
  as script 30 and deploys to the SAME item (explicit --workspace-id and --item-name), then removes the worktree.
  Schema note: Rayfin refuses destructive schema changes without --force. If the older commit would drop
  columns, the deploy stops; this script never adds --force. Data is not rolled back - restore from an export
  if needed (docs\SUPPORT.md).

.EXAMPLE
  .\scripts\80-Rollback-App.ps1 -App ars -GitRef v1.0.0 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)][ValidateSet('ars', 'isob')][string]$App,
  [Parameter(Mandatory = $true)][string]$GitRef,
  [string]$Environment = 'dev'
)

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
$appCfg = Get-AppConfig $cfg $App
$root = Get-RepoRoot
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required for rollback.' }
Invoke-Native 'git' @('-C', $root, 'rev-parse', '--verify', "$GitRef^{commit}") -CaptureOutput | Out-Null

$wt = Join-Path ([System.IO.Path]::GetTempPath()) "ionova-rollback-$App-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
if (-not $PSCmdlet.ShouldProcess("$($appCfg.itemName) <- $GitRef", 'Redeploy previous version')) { return }
try {
  Write-Step "Creating worktree at $GitRef"
  Invoke-Native 'git' @('-C', $root, 'worktree', 'add', '--detach', $wt, $GitRef)
  $dir = Join-Path $wt $appCfg.path
  Invoke-Native 'npm.cmd' @('ci', '--no-audit', '--no-fund') $dir
  Invoke-Native 'npm.cmd' @('run', 'typecheck') $dir
  Invoke-Native 'npm.cmd' @('test') $dir
  Invoke-Native 'npm.cmd' @('run', 'build:fabric') $dir
  $upArgs = @('up', '--workspace-id', $cfg.fabric.workspaceId, '--item-name', $appCfg.itemName, '--tenant', $cfg.org.tenantId)
  Invoke-Rayfin $dir ($upArgs + @('--dry-run', '--verbose'))
  Invoke-Rayfin $dir ($upArgs + @('--yes'))
  Write-Ok "Redeployed $GitRef. Run scripts\50-Verify-Deployment.ps1 and record the change with scripts\70-Update-Register.ps1."
} finally {
  if (Test-Path $wt) { Invoke-Native 'git' @('-C', $root, 'worktree', 'remove', '--force', $wt) }
}
