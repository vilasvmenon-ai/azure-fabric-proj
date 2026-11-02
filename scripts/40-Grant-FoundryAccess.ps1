<#
.SYNOPSIS
  Step 40 - Grant the deployed app identity least-privilege access to the EXISTING Foundry project (AI-03, SET-04).

.DESCRIPTION
  Current Microsoft guidance: deployed Fabric App Functions call external resources as the Fabric App item OWNER.
  This script assigns the configured role (default "Azure AI User"; some tenants show "Foundry User") to
  runtimeIdentity.ownerObjectId at the Foundry PROJECT scope only. It does not touch the agent, its
  instructions, the model deployment or any other Foundry resource.

  Requires permission to create role assignments at that scope (Owner or User Access Administrator).
  Checks for an existing assignment first; -WhatIf shows the exact command without changing anything.
  If you cannot run it, give docs\MANUAL-STEPS.md M-15 to the Foundry project owner.

.EXAMPLE
  .\scripts\40-Grant-FoundryAccess.ps1 -WhatIf
  .\scripts\40-Grant-FoundryAccess.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param([string]$Environment = 'dev')

Import-Module (Join-Path $PSScriptRoot 'IonovaDeploy.psm1') -Force
Update-SessionPath
$cfg = Read-IonovaConfig $Environment
if ($cfg.foundry.auth -eq 'servicePrincipal') {
  Write-Ok 'foundry.auth = servicePrincipal: Foundry access is granted to the service principal by scripts\41-Setup-FoundryServicePrincipal.ps1. Nothing to do here.'
  return
}
Assert-Guid $cfg.runtimeIdentity.ownerObjectId 'runtimeIdentity.ownerObjectId'
$scope = $cfg.foundry.projectResourceId
$role = $cfg.foundry.rbacRole
$assignee = $cfg.runtimeIdentity.ownerObjectId
if ($scope -notmatch '/providers/Microsoft\.CognitiveServices/accounts/[^/]+/projects/[^/]+$') { throw 'foundry.projectResourceId must be the Foundry project scope.' }

Write-Step 'Existing role assignments for the app identity at the Foundry project scope'
$existing = (Invoke-Native 'az.cmd' @('role', 'assignment', 'list', '--assignee', $assignee, '--scope', $scope, '--query', '[].roleDefinitionName', '-o', 'json') -CaptureOutput) | ConvertFrom-Json
if ($existing) { $existing | ForEach-Object { Write-Host "  - $_" } } else { Write-Host '  (none)' }
if ($existing -contains $role) { Write-Ok "'$role' is already assigned. Nothing to do."; return }

$createArgs = @('role', 'assignment', 'create', '--assignee-object-id', $assignee, '--assignee-principal-type', 'User', '--role', $role, '--scope', $scope)
Write-Step 'Planned change'
Write-Host "  az $($createArgs -join ' ')"
if ($PSCmdlet.ShouldProcess("$($cfg.runtimeIdentity.ownerUpn) at $scope", "Assign role '$role'")) {
  Invoke-Native 'az.cmd' $createArgs
  $file = New-EvidenceFile "foundry-rbac-$Environment.json"
  Write-JsonFile $file ([ordered]@{ assignedAtUtc = (Get-Date).ToUniversalTime().ToString('o'); assigneeObjectId = $assignee; assigneeUpn = $cfg.runtimeIdentity.ownerUpn; role = $role; scope = $scope })
  Write-Ok "Assigned. Evidence: $file"
  Write-Host 'Role assignments can take several minutes to propagate. Then run the deployed probe (docs\VERIFICATION.md V-05).'
}
